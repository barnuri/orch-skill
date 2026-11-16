/**
 * Browser side of chat voice: microphone recording with a level meter and end-of-speech detection,
 * the transcription call, and read-aloud through the browser's speechSynthesis.
 *
 * TTS source: the LLM hub has no text-to-speech model (only whisper/parakeet speech-to-text), so replies
 * are read by the browser's own speechSynthesis, with a voice picked for the reply's language.
 */
import { useSyncExternalStore } from "react";
import { authHeaders } from "../api/chats";
import { API_BASE } from "../lib/constants";
import { DEFAULT_SILENCE, SilenceDetector, detectLanguage, pickRecorderMime, pickVoice, recordingFilename, rmsLevel, speakableText, speechChunks, transcribeLanguage } from "../lib/voice-logic";
import type { SilenceOptions } from "../lib/voice-logic";

export type TranscribeOutcome = { ok: true; text: string } | { ok: false; error: string };
/** `language` is a two-letter hint (`he` picks the Hebrew model); undefined means the browser's language. */
export type Transcriber = (clip: Blob, mime: string, language?: string | null) => Promise<TranscribeOutcome>;

/** The browser's language as a hint, or null outside a browser. */
export function browserLanguageHint(): string | null {
  return typeof navigator === "undefined" ? null : transcribeLanguage([], navigator.language || "");
}

/**
 * POST /api/voice/transcribe. The filename's extension follows the recorded container (webm, or mp4 on Safari).
 * Sends a language hint: the caller's, else the browser's.
 */
export const transcribeClip: Transcriber = async (clip, mime, language) => {
  const form = new FormData();
  form.append("file", clip, recordingFilename(mime || clip.type));
  const hint = language === undefined ? browserLanguageHint() : language;
  if (hint !== null) {
    form.append("language", hint);
  }
  try {
    const res = await fetch(`${API_BASE}/voice/transcribe`, { method: "POST", headers: authHeaders(), body: form });
    const body = (await res.json().catch(() => null)) as { text?: unknown; error?: unknown } | null;
    if (res.ok && typeof body?.text === "string") {
      return { ok: true, text: body.text };
    }
    return { ok: false, error: `Transcription failed: ${typeof body?.error === "string" ? body.error : `HTTP ${res.status}`}` };
  } catch {
    return { ok: false, error: "Transcription failed: the server could not be reached." };
  }
};

/** True when this page can record: secure context, getUserMedia and MediaRecorder. */
export function voiceSupported(): boolean {
  return typeof navigator !== "undefined" && typeof navigator.mediaDevices?.getUserMedia === "function" && typeof MediaRecorder !== "undefined";
}

export async function openMic(): Promise<MediaStream> {
  if (!voiceSupported()) {
    throw Object.assign(new Error("no media devices"), { name: "NoMediaDevices" });
  }
  return navigator.mediaDevices.getUserMedia({ audio: { echoCancellation: true, noiseSuppression: true, autoGainControl: true } });
}

export function closeMic(stream: MediaStream | null): void {
  for (const track of stream?.getTracks() ?? []) {
    track.stop();
  }
}

export interface RecordOptions {
  /** Called about 20 times a second with the input level (0..1). */
  onLevel?: (level: number) => void;
  /** Hands-free mode: called once when speech was heard and then ~1.2 s of silence followed. */
  onSpeechEnd?: () => void;
  silence?: SilenceOptions;
}

type AudioContextCtor = typeof AudioContext;

/** One clip from an open microphone stream. `stop()` resolves the recording; `cancel()` drops it. */
export class ClipRecorder {
  readonly mime: string;
  private readonly recorder: MediaRecorder;
  private readonly chunks: Blob[] = [];
  private readonly detector: SilenceDetector;
  private audio: AudioContext | null = null;
  private timer: ReturnType<typeof setInterval> | null = null;
  private done: Promise<Blob>;

  constructor(stream: MediaStream, private readonly options: RecordOptions = {}) {
    const mime = pickRecorderMime((t) => MediaRecorder.isTypeSupported(t));
    this.recorder = mime === "" ? new MediaRecorder(stream) : new MediaRecorder(stream, { mimeType: mime });
    this.mime = this.recorder.mimeType || mime;
    this.detector = new SilenceDetector(options.silence ?? DEFAULT_SILENCE);
    this.recorder.ondataavailable = (e) => {
      if (e.data.size > 0) this.chunks.push(e.data);
    };
    this.done = new Promise<Blob>((resolve) => {
      this.recorder.onstop = () => {
        resolve(new Blob(this.chunks, { type: this.mime || this.chunks[0]?.type || "audio/webm" }));
      };
    });
    // A timeslice makes Safari deliver data reliably; the chunks join into one valid file.
    this.recorder.start(250);
    this.meter(stream);
  }

  get heardSpeech(): boolean {
    return this.detector.heardSpeech;
  }

  private meter(stream: MediaStream): void {
    const Ctor = (globalThis as { AudioContext?: AudioContextCtor; webkitAudioContext?: AudioContextCtor }).AudioContext
      ?? (globalThis as { webkitAudioContext?: AudioContextCtor }).webkitAudioContext;
    if (Ctor === undefined || (this.options.onLevel === undefined && this.options.onSpeechEnd === undefined)) return;
    try {
      const audio = new Ctor();
      this.audio = audio;
      void audio.resume().catch(() => undefined);
      const analyser = audio.createAnalyser();
      analyser.fftSize = 1024;
      audio.createMediaStreamSource(stream).connect(analyser);
      const frame = new Uint8Array(analyser.fftSize);
      // setInterval, not requestAnimationFrame: rAF pauses in a background tab and the loop must keep hearing silence.
      this.timer = setInterval(() => {
        analyser.getByteTimeDomainData(frame);
        const level = rmsLevel(frame);
        this.options.onLevel?.(Math.min(1, level * 4));
        if (this.detector.push(level, performance.now()) === "speech-end") {
          this.options.onSpeechEnd?.();
        }
      }, 50);
    } catch {
      this.audio = null;
    }
  }

  private release(): void {
    if (this.timer !== null) clearInterval(this.timer);
    this.timer = null;
    void this.audio?.close().catch(() => undefined);
    this.audio = null;
  }

  stop(): Promise<Blob> {
    this.release();
    if (this.recorder.state !== "inactive") {
      this.recorder.requestData?.();
      this.recorder.stop();
    }
    return this.done;
  }

  cancel(): void {
    this.release();
    this.recorder.ondataavailable = null;
    if (this.recorder.state !== "inactive") this.recorder.stop();
  }
}

// ---- read aloud (browser speechSynthesis) ----

let speakingKey: string | null = null;
let speakToken = 0;
/** Ends the utterance being awaited: some engines fire neither onend nor onerror after cancel(). */
let interruptCurrent: (() => void) | null = null;
const listeners = new Set<() => void>();

function setSpeaking(key: string | null): void {
  speakingKey = key;
  for (const l of listeners) l();
}

/** Which message is being read aloud, for the per-message speaker buttons. */
export function useSpeakingKey(): string | null {
  return useSyncExternalStore(
    (l) => {
      listeners.add(l);
      return () => listeners.delete(l);
    },
    () => speakingKey,
    () => null,
  );
}

function synth(): SpeechSynthesis | null {
  return typeof window !== "undefined" && "speechSynthesis" in window ? window.speechSynthesis : null;
}

export function speechSupported(): boolean {
  return synth() !== null && typeof SpeechSynthesisUtterance !== "undefined";
}

/**
 * iOS Safari only speaks after a user gesture has spoken once. Call this inside the tap handler, before any await:
 * a silent utterance unlocks speech for the rest of the page's life.
 */
export function primeSpeech(): void {
  const s = synth();
  if (s === null || typeof SpeechSynthesisUtterance === "undefined") return;
  const u = new SpeechSynthesisUtterance(" ");
  u.volume = 0;
  s.speak(u);
}

async function voicesReady(s: SpeechSynthesis): Promise<SpeechSynthesisVoice[]> {
  const now = s.getVoices();
  if (now.length > 0) return now;
  return new Promise((resolve) => {
    const done = (): void => {
      s.removeEventListener("voiceschanged", done);
      resolve(s.getVoices());
    };
    s.addEventListener("voiceschanged", done);
    setTimeout(done, 1000);
  });
}

export function stopSpeaking(): void {
  speakToken += 1;
  synth()?.cancel();
  interruptCurrent?.();
  interruptCurrent = null;
  setSpeaking(null);
}

/**
 * Reads markdown aloud in the reply's language, in short chunks (Chrome cuts a long utterance off).
 * Resolves when it finished or was stopped. A new call stops the one before.
 */
export async function speak(markdown: string, key: string = "speech"): Promise<void> {
  const s = synth();
  const text = speakableText(markdown);
  if (s === null || text === "") return;
  stopSpeaking();
  const token = speakToken;
  setSpeaking(key);
  const lang = detectLanguage(text, typeof navigator !== "undefined" ? navigator.language : "en-US");
  const voice = pickVoice(await voicesReady(s), lang);
  for (const chunk of speechChunks(text)) {
    if (token !== speakToken) return;
    await new Promise<void>((resolve) => {
      interruptCurrent = resolve;
      const u = new SpeechSynthesisUtterance(chunk);
      u.lang = voice?.lang ?? lang;
      if (voice !== null) u.voice = voice;
      u.onend = () => resolve();
      u.onerror = () => resolve();
      s.speak(u);
      // Chrome pauses speech in a background tab without ending it; resume keeps the queue moving.
      if (s.paused) s.resume();
    });
  }
  if (token === speakToken) setSpeaking(null);
}

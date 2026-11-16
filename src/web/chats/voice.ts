/**
 * Browser side of chat voice: microphone recording with a level meter and end-of-speech detection,
 * the transcription call, and read-aloud through the browser's speechSynthesis.
 *
 * TTS source: the LLM hub has no text-to-speech model (only whisper/parakeet speech-to-text), so replies
 * are read by the browser's own speechSynthesis, with a voice picked for the reply's language.
 */
import { useSyncExternalStore } from "react";
import { TtsQueue } from "./tts-queue";
import type { TtsQueueOptions, UtteranceLike } from "./tts-queue";
import { authHeaders } from "../api/chats";
import { API_BASE } from "../lib/constants";
import { detectLanguage, pickRecorderMime, pickVoice, recordingFilename, rmsLevel, speakableText, speechChunks, transcribeLanguage } from "../lib/voice-logic";
import type { Sentence } from "../lib/speech-text";
import { halvesOf, encodeWav, PCM_RATE } from "../lib/voice-pcm";
import { EnergyVad, SegmentPolicy } from "../lib/voice-vad";
import type { VadOptions } from "../lib/voice-vad";

export type { TranscribeOutcome } from "../lib/voice-chunks";
import type { TranscribeOutcome } from "../lib/voice-chunks";
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

/** One recorded piece of a long recording; every piece is a complete file the hub can decode. */
export interface Segment {
  blob: Blob;
  mime: string;
  seconds: number;
  hadSpeech: boolean;
  /** Starts with audio the previous piece ended with (a cut with no pause): the texts are joined by `mergeOverlap`. */
  overlapped: boolean;
}

export interface RecordOptions {
  /** Called about 20 times a second with the input level (0..1). */
  onLevel?: (level: number) => void;
  /** Called once when speech was heard (after the noise floor was measured). */
  onSpeechStart?: () => void;
  /** Hands-free mode: called once when speech was heard and then `vad.endSilenceMs` of quiet followed. Without it, only `stop()` ends a recording. */
  onSpeechEnd?: () => void;
  /** Called with each piece as it completes: at pauses while recording, and the last one on `stop()`. */
  onSegment?: (segment: Segment) => void;
  vad?: Partial<VadOptions>;
}

type AudioContextCtor = typeof AudioContext;

/** Time the old recorder keeps running after a forced cut, so the word at the cut is whole in the next piece too. */
const FORCED_CUT_OVERLAP_MS = 800;

interface Live {
  recorder: MediaRecorder;
  chunks: Blob[];
  startedAt: number;
  hadSpeech: boolean;
  overlapped: boolean;
  stopped: Promise<void>;
}

/**
 * Records from an open microphone stream until `stop()`: nothing else ends it (no timer). Long recordings are cut into
 * pieces, ported from the voice-notes app: at sentence pauses (never mid-word), restart-free (the next MediaRecorder starts
 * before the old one stops) and with an overlap when no pause came for a minute. Each piece is a complete container file.
 */
export class ClipRecorder {
  private mimeType: string = "";
  private live: Live | null = null;
  private readonly vad: EnergyVad;
  private readonly policy = new SegmentPolicy();
  private audio: AudioContext | null = null;
  private timer: ReturnType<typeof setInterval> | null = null;
  private startedSpeech = false;
  private ended = false;
  private cancelled = false;
  private pending: Promise<void>[] = [];

  constructor(private readonly stream: MediaStream, private readonly options: RecordOptions = {}) {
    this.vad = new EnergyVad(options.vad);
    this.mimeType = pickRecorderMime((t) => MediaRecorder.isTypeSupported(t));
    this.live = this.begin(false);
    this.policy.reset(performance.now());
    this.meter(stream);
  }

  get mime(): string {
    return this.live?.recorder.mimeType || this.mimeType || "audio/webm";
  }

  get heardSpeech(): boolean {
    return this.vad.heardSpeech;
  }

  private begin(overlapped: boolean): Live {
    const recorder = this.mimeType === "" ? new MediaRecorder(this.stream) : new MediaRecorder(this.stream, { mimeType: this.mimeType });
    const live: Live = { recorder, chunks: [], startedAt: performance.now(), hadSpeech: false, overlapped, stopped: Promise.resolve() };
    recorder.ondataavailable = (e) => {
      if (e.data.size > 0) live.chunks.push(e.data);
    };
    live.stopped = new Promise<void>((resolve) => {
      recorder.onstop = () => resolve();
    });
    // A timeslice makes Safari deliver data reliably; the pieces join into one valid file.
    recorder.start(1000);
    return live;
  }

  private finish(live: Live): Promise<void> {
    if (live.recorder.state !== "inactive") {
      live.recorder.requestData?.();
      live.recorder.stop();
    }
    return live.stopped.then(() => {
      if (this.cancelled) return;
      const mime = live.recorder.mimeType || this.mimeType || "audio/webm";
      const blob = new Blob(live.chunks, { type: mime });
      if (blob.size === 0) return;
      this.options.onSegment?.({ blob, mime, seconds: (performance.now() - live.startedAt) / 1000, hadSpeech: live.hadSpeech, overlapped: live.overlapped });
    });
  }

  private rotate(forced: boolean): void {
    const old = this.live;
    if (old === null) return;
    this.live = this.begin(forced);
    this.policy.reset(performance.now());
    this.pending.push(forced ? new Promise<void>((r) => setTimeout(r, FORCED_CUT_OVERLAP_MS)).then(() => this.finish(old)) : this.finish(old));
  }

  private meter(stream: MediaStream): void {
    const Ctor = (globalThis as { AudioContext?: AudioContextCtor }).AudioContext ?? (globalThis as { webkitAudioContext?: AudioContextCtor }).webkitAudioContext;
    if (Ctor === undefined) return;
    try {
      const audio = new Ctor();
      this.audio = audio;
      // Safari starts a context suspended: without this the level stays 0 and the recording is never cut or ended.
      void audio.resume().catch(() => undefined);
      const analyser = audio.createAnalyser();
      analyser.fftSize = 1024;
      audio.createMediaStreamSource(stream).connect(analyser);
      const frame = new Uint8Array(analyser.fftSize);
      // setInterval, not requestAnimationFrame: rAF pauses in a background tab and the loop must keep hearing the room.
      this.timer = setInterval(() => this.tick(analyser, frame), 50);
    } catch {
      this.audio = null;
    }
  }

  private tick(analyser: AnalyserNode, frame: Uint8Array<ArrayBuffer>): void {
    analyser.getByteTimeDomainData(frame);
    const level = rmsLevel(frame);
    const now = performance.now();
    this.options.onLevel?.(Math.min(1, level * 4));
    const event = this.vad.push(level, now);
    const loud = !this.vad.calibrating && level >= this.vad.stopThreshold;
    if (loud && this.live !== null) this.live.hadSpeech = true;
    if (event === "speech-start" && !this.startedSpeech) {
      this.startedSpeech = true;
      this.options.onSpeechStart?.();
    }
    if (event === "speech-end" && !this.ended) {
      this.ended = true;
      this.options.onSpeechEnd?.();
      return;
    }
    const cut = this.policy.observe(loud, now);
    if (cut !== "none" && !this.ended) this.rotate(cut === "forced");
  }

  private release(): void {
    if (this.timer !== null) clearInterval(this.timer);
    this.timer = null;
    void this.audio?.close().catch(() => undefined);
    this.audio = null;
  }

  /** Ends the recording; resolves after the last piece went to `onSegment`. */
  async stop(): Promise<void> {
    this.release();
    const last = this.live;
    this.live = null;
    if (last !== null) this.pending.push(this.finish(last));
    await Promise.all(this.pending);
  }

  cancel(): void {
    this.cancelled = true;
    this.release();
    for (const live of [this.live]) {
      if (live !== null && live.recorder.state !== "inactive") {
        live.recorder.ondataavailable = null;
        live.recorder.stop();
      }
    }
    this.live = null;
  }
}

/** Decodes a recorded piece and cuts it into two overlapping 16 kHz wav halves, for a piece the hub refused. */
export async function splitClip(blob: Blob): Promise<[Blob, Blob] | null> {
  const Ctor = (globalThis as { AudioContext?: AudioContextCtor }).AudioContext ?? (globalThis as { webkitAudioContext?: AudioContextCtor }).webkitAudioContext;
  if (Ctor === undefined) return null;
  const ctx = new Ctor({ sampleRate: PCM_RATE });
  try {
    const decoded = await ctx.decodeAudioData(await blob.arrayBuffer());
    const halves = halvesOf(decoded.getChannelData(0), decoded.sampleRate);
    return halves === null ? null : [encodeWav(halves[0], decoded.sampleRate), encodeWav(halves[1], decoded.sampleRate)];
  } finally {
    void ctx.close().catch(() => undefined);
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

// ---- conversation mode speech: a TtsQueue over the browser engine ----


/** The conversation mode's speaker; swappable in tests. */
export interface TtsPort {
  enqueue: (sentence: Sentence) => void;
  stop: () => void;
  readonly speaking: boolean;
}

export interface TtsHandlers {
  onActive: (sentence: Sentence | null) => void;
  onStart: () => void;
  onIdle: () => void;
  onNoVoice: (lang: string) => void;
  voiceFor: (langBase: string) => string | undefined;
  rate: () => number;
}

export function makeBrowserTts(h: TtsHandlers): TtsPort | null {
  const s = synth();
  if (s === null || typeof SpeechSynthesisUtterance === "undefined") return null;
  const options: TtsQueueOptions = {
    synth: s as unknown as TtsQueueOptions["synth"],
    makeUtterance: (text) => new SpeechSynthesisUtterance(text) as unknown as UtteranceLike,
    ...h,
  };
  return new TtsQueue(options);
}

/** Installed voices, for the settings sheet. */
export function installedVoices(): SpeechSynthesisVoice[] {
  return synth()?.getVoices() ?? [];
}

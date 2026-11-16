/** Pure helpers behind chat voice (dictation, hands-free conversation, read aloud). No DOM, so they are unit-tested. */
import type { Message } from "./chat-types";

/**
 * Recorder formats in order of preference. Chrome, Edge and Firefox record webm/opus; Safari (macOS and iOS)
 * records only mp4/aac, so a hard-coded webm would throw there.
 */
const RECORDER_TYPES: readonly string[] = ["audio/webm;codecs=opus", "audio/webm", "audio/mp4;codecs=mp4a.40.2", "audio/mp4", "audio/aac", "audio/ogg;codecs=opus"];

/** The first type `isTypeSupported` accepts, or "" to let the browser choose (MediaRecorder's own default). */
export function pickRecorderMime(isTypeSupported: (type: string) => boolean): string {
  for (const type of RECORDER_TYPES) {
    try {
      if (isTypeSupported(type)) {
        return type;
      }
    } catch {
      // Some engines throw for an unknown type instead of answering false.
    }
  }
  return "";
}

/** A filename whose extension matches the recorded container, so the transcriber's ffmpeg probes the right format. */
export function recordingFilename(mime: string): string {
  const type = (mime.split(";")[0] ?? "").trim().toLowerCase();
  if (type === "audio/mp4" || type === "video/mp4" || type === "audio/x-m4a") return "voice.mp4";
  if (type === "audio/aac") return "voice.aac";
  if (type === "audio/ogg") return "voice.ogg";
  if (type === "audio/wav" || type === "audio/x-wav") return "voice.wav";
  return "voice.webm";
}

/** Recording clock, `m:ss`. */
export function formatElapsed(ms: number): string {
  const total = Math.max(0, Math.floor(ms / 1000));
  return `${Math.floor(total / 60)}:${String(total % 60).padStart(2, "0")}`;
}

/** Root-mean-square level (0..1) of a time-domain frame from AnalyserNode.getByteTimeDomainData (128 is silence). */
export function rmsLevel(frame: ArrayLike<number>): number {
  if (frame.length === 0) return 0;
  let sum = 0;
  for (let i = 0; i < frame.length; i += 1) {
    const v = ((frame[i] ?? 128) - 128) / 128;
    sum += v * v;
  }
  return Math.sqrt(sum / frame.length);
}

/** BCP-47 language of a reply by script: Hebrew, Arabic, Russian, Greek, CJK; else the browser's own language. */
export function detectLanguage(text: string, fallback: string): string {
  const letters = text.replace(/[^\p{L}]/gu, "");
  if (letters === "") return fallback;
  const share = (re: RegExp): number => (letters.match(re)?.length ?? 0) / letters.length;
  if (share(/[\u0590-\u05FF]/g) > 0.3) return "he-IL";
  if (share(/[\u0600-\u06FF]/g) > 0.3) return "ar-SA";
  if (share(/[\u0400-\u04FF]/g) > 0.3) return "ru-RU";
  if (share(/[\u0370-\u03FF]/g) > 0.3) return "el-GR";
  if (share(/[\u3040-\u30FF]/g) > 0.1) return "ja-JP";
  if (share(/[\u4E00-\u9FFF]/g) > 0.3) return "zh-CN";
  if (share(/[\uAC00-\uD7AF]/g) > 0.3) return "ko-KR";
  if (share(/[A-Za-z\u00C0-\u024F]/g) > 0.5) {
    // Latin text: keep the browser language when it is a Latin-script one (fr, de, es…), else English.
    return /^(he|iw|ar|ru|el|ja|zh|ko|fa|uk)\b/i.test(fallback) ? "en-US" : fallback;
  }
  return fallback;
}

/**
 * The two-letter language hint sent with a clip: the last reply's language when there is one (its script wins),
 * else the browser's. `iw` (old Hebrew tag) becomes `he`; anything unusable gives null.
 */
export function transcribeLanguage(messages: readonly Message[], browserLang: string): string | null {
  const last = [...messages].filter((m) => m.role === "assistant" && m.content.trim() !== "").sort((a, b) => (a.id < b.id ? 1 : -1))[0];
  const tag = last === undefined ? browserLang : detectLanguage(last.content, browserLang);
  const base = (tag.split(/[-_]/)[0] ?? "").toLowerCase();
  if (!/^[a-z]{2,3}$/.test(base)) return null;
  return base === "iw" ? "he" : base;
}

export interface VoiceLike {
  lang: string;
  name: string;
  default?: boolean;
  localService?: boolean;
}

/** The best installed voice for a language: exact tag, then same base language (he = iw on old engines), default first. */
export function pickVoice<V extends VoiceLike>(voices: readonly V[], lang: string): V | null {
  const norm = (l: string): string => l.toLowerCase().replace("_", "-").replace(/^iw\b/, "he");
  const want = norm(lang);
  const base = want.split("-")[0] ?? want;
  const exact = voices.filter((v) => norm(v.lang) === want);
  const same = exact.length > 0 ? exact : voices.filter((v) => (norm(v.lang).split("-")[0] ?? "") === base);
  if (same.length === 0) return null;
  return same.find((v) => v.default === true) ?? same.find((v) => v.localService === true) ?? same[0] ?? null;
}

/** Markdown reduced to what is worth saying: no code blocks, links read by their text, no markup characters. */
export function speakableText(markdown: string): string {
  return markdown
    .replace(/```[\s\S]*?(```|$)/g, " (code) ")
    .replace(/`([^`]*)`/g, "$1")
    .replace(/!\[([^\]]*)\]\([^)]*\)/g, "$1")
    .replace(/\[([^\]]*)\]\([^)]*\)/g, "$1")
    .replace(/https?:\/\/\S+/g, " link ")
    .replace(/^\s{0,3}(#{1,6}|>|[-*+]|\d+\.)\s+/gm, "")
    .replace(/[*_~|]+/g, "")
    .replace(/<[^>]+>/g, "")
    .replace(/\s+/g, " ")
    .trim();
}

/**
 * Splits text into utterances of at most `max` characters at sentence ends, then commas, then spaces:
 * Chrome stops a long single utterance after about 15 seconds.
 */
export function speechChunks(text: string, max: number = 220): string[] {
  const out: string[] = [];
  const sentences = text.match(/[^.!?。！？\n]+[.!?。！？]*\s*/g) ?? [];
  let current = "";
  const flush = (): void => {
    if (current.trim() !== "") out.push(current.trim());
    current = "";
  };
  for (const sentence of sentences) {
    if ((current + sentence).length <= max) {
      current += sentence;
      continue;
    }
    flush();
    let rest = sentence;
    while (rest.length > max) {
      const window = rest.slice(0, max);
      const cut = Math.max(window.lastIndexOf(", "), window.lastIndexOf(" "));
      const at = cut > max / 3 ? cut + 1 : max;
      out.push(rest.slice(0, at).trim());
      rest = rest.slice(at);
    }
    current = rest;
  }
  flush();
  return out.filter((c) => c !== "");
}

/** The newest assistant message, by id order (ids are time-sortable). */
export function lastAssistantId(messages: readonly Message[]): string | null {
  let best: string | null = null;
  for (const m of messages) {
    if (m.role === "assistant" && (best === null || m.id > best)) best = m.id;
  }
  return best;
}

/**
 * The reply a voice turn waits for: an assistant message newer than `afterId` that has finished.
 * `done` and `stopped` are read aloud; an `error` reply ends the wait too, with its error as the text.
 */
export function finishedReplyAfter(messages: readonly Message[], afterId: string | null): Message | null {
  const replies = messages.filter((m) => m.role === "assistant" && (afterId === null || m.id > afterId)).sort((a, b) => (a.id < b.id ? 1 : -1));
  const newest = replies[0];
  if (newest === undefined) return null;
  return newest.status === "done" || newest.status === "stopped" || newest.status === "error" ? newest : null;
}

export type ConversationPhase = "off" | "starting" | "listening" | "transcribing" | "sending" | "waiting" | "speaking";

export const PHASE_LABEL: Record<ConversationPhase, string> = {
  off: "",
  starting: "Starting…",
  listening: "Listening…",
  transcribing: "Transcribing…",
  sending: "Sending…",
  waiting: "Waiting for the reply…",
  speaking: "Speaking…",
};

/** A human message for a getUserMedia / MediaRecorder failure. */
export function micErrorMessage(err: unknown): string {
  const name = typeof err === "object" && err !== null && "name" in err ? String((err as { name: unknown }).name) : "";
  if (name === "NotAllowedError" || name === "SecurityError" || name === "PermissionDeniedError") {
    return "Microphone permission was denied. Allow the microphone for this site and try again.";
  }
  if (name === "NotFoundError" || name === "DevicesNotFoundError") return "No microphone was found.";
  if (name === "NotReadableError") return "The microphone is in use by another app.";
  if (name === "NoMediaDevices") return "Voice needs a secure page (https or localhost) and a browser with microphone access.";
  const message = err instanceof Error ? err.message : String(err);
  return `The microphone could not start${message !== "" ? `: ${message}` : "."}`;
}

/** Text to insert into the composer: appended to what is there with one space, or the transcript alone. */
export function appendTranscript(existing: string, transcript: string): string {
  const t = transcript.trim();
  if (t === "") return existing;
  if (existing.trim() === "") return t;
  return /\s$/.test(existing) ? `${existing}${t}` : `${existing} ${t}`;
}

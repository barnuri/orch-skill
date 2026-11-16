import { existsSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { profileEnvSource } from "./options";

/** Largest audio file accepted: the hub buffers multipart bodies up to 25 MB, so a bigger one could never pass. */
export const MAX_AUDIO_BYTES: number = 25 * 1024 * 1024;
/** The whole multipart request: the file plus the form framing and the small fields. */
export const MAX_AUDIO_REQUEST_BYTES: number = MAX_AUDIO_BYTES + 64 * 1024;
export const DEFAULT_STT_MODEL: string = "whisper/whisper-large-v3";
/** Tried in order when ORCH_STT_MODEL is unset: whisper first, parakeet (slow, English only) last. */
export const DEFAULT_STT_MODELS: readonly string[] = [DEFAULT_STT_MODEL, "parakeet/mlx-community/parakeet-tdt-0.6b-v2"];
/** Fine-tuned for Hebrew: faster than whisper and exact on Hebrew speech. Tried first when the client hints `he`. */
export const HEBREW_STT_MODEL: string = "ivrit/ivrit-large-v3-turbo";
/** Floor of the hub wait: the whole clip is decoded and transcribed before the hub answers. */
export const MIN_UPSTREAM_TIMEOUT_MS: number = 120_000;
export const MAX_UPSTREAM_TIMEOUT_MS: number = 600_000;

/**
 * How long to wait for the hub for a clip of `bytes`. A flat 120 s cut off long dictation: a 16 kHz wav is 32 KB per
 * second of speech and a slow model needs about twice that in wall time, so the wait grows with the clip, up to 10 minutes.
 */
export function upstreamTimeoutMs(bytes: number): number {
  const seconds = Math.max(0, bytes) / 32_000;
  return Math.min(MAX_UPSTREAM_TIMEOUT_MS, Math.max(MIN_UPSTREAM_TIMEOUT_MS, Math.round(30_000 + seconds * 2_000)));
}
const MAX_ERROR_CHARS: number = 300;

/** Containers browsers record (webm on Chrome/Edge/Firefox, mp4 on Safari) plus the usual audio files. */
const AUDIO_EXTENSIONS: ReadonlySet<string> = new Set(["webm", "weba", "mp4", "m4a", "aac", "mp3", "mpeg", "mpga", "wav", "ogg", "oga", "opus", "flac", "caf"]);

export class TranscribeError extends Error {
  constructor(readonly status: number, message: string) {
    super(message);
  }
}

export interface TranscribeResult {
  text: string;
  model: string;
}

/** Where the hub is and which models to try, from the process env, then `<home>/env`. The key never leaves this object. */
export interface SttConfig {
  baseUrl: string;
  apiKey: string;
  models: string[];
}

export function sttConfig(home: string): SttConfig | null {
  const vars = profileEnvSource(home, "");
  const baseUrl = (vars.LLM_HUB_BASE_URL ?? vars.LLM_HUB_V1_URL ?? "").trim().replace(/\/+$/, "");
  const apiKey = (vars.LLM_HUB_API_KEY ?? vars.LLM_HUB_KEY ?? "").trim();
  if (baseUrl === "" || apiKey === "") {
    return null;
  }
  // ORCH_STT_MODEL may list fallbacks, comma separated, tried in order when one fails.
  const models = (vars.ORCH_STT_MODEL ?? "").split(",").map((m) => m.trim()).filter((m) => m !== "");
  return { baseUrl, apiKey, models: models.length > 0 ? models : [...DEFAULT_STT_MODELS] };
}

/** The order to try models for one clip: a Hebrew hint (`he`, or the old `iw`) puts the Hebrew model first. */
export function modelOrder(models: readonly string[], language: string | null): string[] {
  if (language !== "he" && language !== "iw") {
    return [...models];
  }
  return [HEBREW_STT_MODEL, ...models.filter((m) => m !== HEBREW_STT_MODEL)];
}

function extensionOf(name: string): string {
  const dot = name.lastIndexOf(".");
  return dot < 0 ? "" : name.slice(dot + 1).toLowerCase();
}

/** True for an audio upload this endpoint forwards: an audio/* (or browser video/webm, video/mp4) type, or a known extension. */
export function isAudioUpload(name: string, mime: string): boolean {
  const type = (mime.split(";")[0] ?? "").trim().toLowerCase();
  return type.startsWith("audio/") || type === "video/webm" || type === "video/mp4" || AUDIO_EXTENSIONS.has(extensionOf(name));
}

/** Reads the body with a hard cap, so a chunked request without Content-Length cannot make the server buffer more. */
async function readCapped(req: Request, max: number): Promise<Uint8Array<ArrayBuffer>> {
  const declared = Number(req.headers.get("content-length") ?? "");
  if (Number.isFinite(declared) && declared > max) {
    throw new TranscribeError(413, `audio is larger than ${MAX_AUDIO_BYTES / (1024 * 1024)} MB`);
  }
  if (req.body === null) {
    return new Uint8Array(new ArrayBuffer(0));
  }
  const chunks: Uint8Array[] = [];
  let total = 0;
  const reader = req.body.getReader();
  for (;;) {
    const { done, value } = await reader.read();
    if (done) {
      break;
    }
    total += value.byteLength;
    if (total > max) {
      await reader.cancel().catch(() => undefined);
      throw new TranscribeError(413, `audio is larger than ${MAX_AUDIO_BYTES / (1024 * 1024)} MB`);
    }
    chunks.push(value);
  }
  const out = new Uint8Array(new ArrayBuffer(total));
  let at = 0;
  for (const c of chunks) {
    out.set(c, at);
    at += c.byteLength;
  }
  return out;
}

interface AudioInput {
  file: File;
  language: string | null;
}

async function audioOf(req: Request): Promise<AudioInput> {
  const type = req.headers.get("content-type") ?? "";
  if (!type.toLowerCase().startsWith("multipart/form-data")) {
    throw new TranscribeError(415, "send the audio as multipart/form-data with a `file` field");
  }
  const bytes = await readCapped(req, MAX_AUDIO_REQUEST_BYTES);
  let form: FormData;
  try {
    form = await new Response(bytes, { headers: { "content-type": type } }).formData();
  } catch {
    throw new TranscribeError(400, "the multipart body could not be read");
  }
  const file = form.get("file");
  if (!(file instanceof File)) {
    throw new TranscribeError(400, "no `file` field with audio");
  }
  if (file.size === 0) {
    throw new TranscribeError(400, "the audio is empty");
  }
  if (file.size > MAX_AUDIO_BYTES) {
    throw new TranscribeError(413, `audio is larger than ${MAX_AUDIO_BYTES / (1024 * 1024)} MB`);
  }
  if (!isAudioUpload(file.name, file.type)) {
    throw new TranscribeError(415, `"${file.name}" is not an audio file`);
  }
  const lang = form.get("language");
  const language = typeof lang === "string" && /^[a-z]{2,3}$/i.test(lang.trim()) ? lang.trim().toLowerCase() : null;
  return { file, language };
}

/** The upstream's own message, short and with the key scrubbed, or the HTTP status. */
function upstreamMessage(status: number, body: string, key: string): string {
  let message = "";
  try {
    const parsed = JSON.parse(body) as { error?: unknown; detail?: unknown; message?: unknown };
    const err = parsed.error;
    const raw = typeof err === "string" ? err : typeof err === "object" && err !== null && "message" in err ? (err as { message: unknown }).message : (parsed.detail ?? parsed.message);
    message = typeof raw === "string" ? raw : "";
  } catch {
    message = body.trim().startsWith("<") ? "" : body.trim();
  }
  message = message.split(key).join("***").slice(0, MAX_ERROR_CHARS);
  return message === "" ? `HTTP ${status}` : message;
}

async function callModel(config: SttConfig, model: string, audio: AudioInput, signal: AbortSignal): Promise<TranscribeResult> {
  const form = new FormData();
  form.append("model", model);
  form.append("file", audio.file, audio.file.name !== "" ? audio.file.name : "audio.webm");
  form.append("response_format", "json");
  if (audio.language !== null) {
    form.append("language", audio.language);
  }
  let res: Response;
  try {
    res = await fetch(`${config.baseUrl}/audio/transcriptions`, {
      method: "POST",
      headers: { Authorization: `Bearer ${config.apiKey}` },
      body: form,
      signal: AbortSignal.any([signal, AbortSignal.timeout(upstreamTimeoutMs(audio.file.size))]),
    });
  } catch (err) {
    const timedOut = err instanceof Error && err.name === "TimeoutError";
    throw new TranscribeError(502, timedOut ? `${model}: timed out` : `${model}: the LLM hub is unreachable`);
  }
  const body = await res.text();
  if (!res.ok) {
    throw new TranscribeError(502, `${model}: ${upstreamMessage(res.status, body, config.apiKey)}`);
  }
  let text: unknown;
  try {
    text = (JSON.parse(body) as { text?: unknown }).text;
  } catch {
    text = body;
  }
  if (typeof text !== "string") {
    throw new TranscribeError(502, `${model}: the answer had no text`);
  }
  return { text: text.trim(), model };
}

/**
 * Transcribes one recorded clip through the LLM hub's OpenAI-compatible `/audio/transcriptions`.
 * Nothing is stored: the audio lives in memory for the request, and the text goes back to the composer.
 */
export async function transcribe(home: string, req: Request): Promise<TranscribeResult> {
  const config = sttConfig(home);
  if (config === null) {
    throw new TranscribeError(503, "speech to text needs LLM_HUB_BASE_URL and LLM_HUB_API_KEY (environment or <home>/env)");
  }
  const audio = await audioOf(req);
  const models = modelOrder(config.models, audio.language);
  const failures: string[] = [];
  const attempt = async (input: AudioInput): Promise<TranscribeResult | null> => {
    for (const model of models) {
      try {
        return await callModel(config, model, input, req.signal);
      } catch (err) {
        if (!(err instanceof TranscribeError)) {
          throw err;
        }
        failures.push(err.message);
      }
    }
    return null;
  };
  const first = await attempt(audio);
  if (first !== null) {
    return first;
  }
  // Only after every model failed (never before the first try, it costs time): some transcribers decode only wav or
  // webm (mlx-audio refuses Safari's mp4/aac), so retry once with a 16 kHz wav.
  if (extensionOf(audio.file.name) !== "wav" && !req.signal.aborted) {
    const wav = await toWav(audio.file);
    if (wav !== null) {
      const second = await attempt({ ...audio, file: wav });
      if (second !== null) {
        return second;
      }
    }
  }
  throw new TranscribeError(502, `transcription failed: ${failures.join("; ")}`);
}

const FFMPEG_CANDIDATES: readonly string[] = ["/opt/homebrew/bin/ffmpeg", "/usr/local/bin/ffmpeg", "/usr/bin/ffmpeg"];

function ffmpegPath(): string | null {
  // A service starts with a minimal PATH, so the usual install places are checked too.
  return Bun.which("ffmpeg") ?? FFMPEG_CANDIDATES.find((p) => existsSync(p)) ?? null;
}

/**
 * The clip as 16 kHz mono wav, or null without ffmpeg or when it cannot decode it. mp4 keeps its index at the end,
 * so ffmpeg reads a scratch copy, not a pipe; the copy is removed at once and nothing else is kept.
 */
export async function toWav(file: File): Promise<File | null> {
  const ffmpeg = ffmpegPath();
  if (ffmpeg === null) {
    return null;
  }
  const dir = mkdtempSync(join(tmpdir(), "orch-voice-"));
  try {
    const input = join(dir, `in.${extensionOf(file.name) || "bin"}`);
    await Bun.write(input, file);
    const proc = Bun.spawn([ffmpeg, "-nostdin", "-loglevel", "error", "-i", input, "-ar", "16000", "-ac", "1", "-f", "wav", "pipe:1"], { stdout: "pipe", stderr: "ignore" });
    const timer = setTimeout(() => proc.kill(), 60_000);
    const bytes = await new Response(proc.stdout).arrayBuffer();
    clearTimeout(timer);
    if ((await proc.exited) !== 0 || bytes.byteLength <= 44) {
      return null;
    }
    return new File([bytes], `${file.name.replace(/\.[^.]*$/, "") || "audio"}.wav`, { type: "audio/wav" });
  } catch {
    return null;
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

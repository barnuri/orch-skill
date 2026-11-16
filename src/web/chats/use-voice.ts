import { useCallback, useEffect, useRef, useState } from "react";
import type { Message } from "../lib/chat-types";
import { finishedReplyAfter, lastAssistantId, micErrorMessage, transcribeLanguage } from "../lib/voice-logic";
import type { ConversationPhase } from "../lib/voice-logic";
import { ClipRecorder, closeMic, openMic, primeSpeech, speak, stopSpeaking, transcribeClip } from "./voice";
import type { RecordOptions, Transcriber } from "./voice";

/** What the hooks need from the browser, swappable in tests. */
export interface VoiceDeps {
  openMic: () => Promise<MediaStream>;
  closeMic: (stream: MediaStream | null) => void;
  record: (stream: MediaStream, options: RecordOptions) => { mime: string; heardSpeech: boolean; stop: () => Promise<Blob>; cancel: () => void };
  transcribe: Transcriber;
  speak: (text: string, key?: string) => Promise<void>;
  stopSpeaking: () => void;
  primeSpeech: () => void;
}

export const browserVoice: VoiceDeps = {
  openMic,
  closeMic,
  record: (stream, options) => new ClipRecorder(stream, options),
  transcribe: transcribeClip,
  speak,
  stopSpeaking,
  primeSpeech,
};

/** Longest clip either mode records before it stops by itself. */
export const MAX_CLIP_MS = 120_000;

export type DictationState = "idle" | "starting" | "recording" | "transcribing";

export interface Dictation {
  state: DictationState;
  startedAt: number | null;
  level: number;
  error: string | null;
  start: () => void;
  /** Stops recording and transcribes; the text goes to `onText`. */
  finish: () => void;
  cancel: () => void;
  clearError: () => void;
}

/** Mode 1: tap to record, tap again to transcribe into the composer. Nothing is sent. */
export function useDictation(onText: (text: string) => void, deps: VoiceDeps = browserVoice): Dictation {
  const [state, setState] = useState<DictationState>("idle");
  const [startedAt, setStartedAt] = useState<number | null>(null);
  const [level, setLevel] = useState(0);
  const [error, setError] = useState<string | null>(null);
  const stream = useRef<MediaStream | null>(null);
  const clip = useRef<ReturnType<VoiceDeps["record"]> | null>(null);
  const limit = useRef<ReturnType<typeof setTimeout> | null>(null);
  const generation = useRef(0);
  const textRef = useRef(onText);
  textRef.current = onText;

  const release = useCallback(() => {
    if (limit.current !== null) clearTimeout(limit.current);
    limit.current = null;
    deps.closeMic(stream.current);
    stream.current = null;
    clip.current = null;
    setLevel(0);
    setStartedAt(null);
  }, [deps]);

  const finish = useCallback(() => {
    const current = clip.current;
    if (current === null) return;
    const gen = generation.current;
    setState("transcribing");
    void current.stop().then(async (blob) => {
      release();
      if (gen !== generation.current) return;
      if (blob.size === 0) {
        setError("Nothing was recorded.");
        setState("idle");
        return;
      }
      const res = await deps.transcribe(blob, current.mime);
      if (gen !== generation.current) return;
      setState("idle");
      if (!res.ok) {
        setError(res.error);
      } else if (res.text.trim() === "") {
        setError("No speech was recognized.");
      } else {
        textRef.current(res.text);
      }
    });
  }, [deps, release]);

  const start = useCallback(() => {
    if (clip.current !== null) return;
    const gen = (generation.current += 1);
    setError(null);
    setState("starting");
    deps.openMic().then(
      (s) => {
        if (gen !== generation.current) {
          deps.closeMic(s);
          return;
        }
        stream.current = s;
        try {
          clip.current = deps.record(s, { onLevel: setLevel });
        } catch (err) {
          release();
          setError(micErrorMessage(err));
          setState("idle");
          return;
        }
        setStartedAt(Date.now());
        setState("recording");
        limit.current = setTimeout(finish, MAX_CLIP_MS);
      },
      (err: unknown) => {
        if (gen !== generation.current) return;
        setError(micErrorMessage(err));
        setState("idle");
      },
    );
  }, [deps, finish, release]);

  const cancel = useCallback(() => {
    generation.current += 1;
    clip.current?.cancel();
    release();
    setState("idle");
  }, [release]);

  useEffect(() => () => {
    generation.current += 1;
    clip.current?.cancel();
    deps.closeMic(stream.current);
    if (limit.current !== null) clearTimeout(limit.current);
  }, [deps]);

  return { state, startedAt, level, error, start, finish, cancel, clearError: () => { setError(null); } };
}

export interface Conversation {
  phase: ConversationPhase;
  level: number;
  error: string | null;
  /** Call from the tap handler: it primes speech synthesis (iOS needs the gesture). */
  start: () => void;
  stop: () => void;
  clearError: () => void;
}

/** One hands-free loop; `wake` ends whatever step is waiting (recording, the reply, speech). */
interface LoopRun {
  cancelled: boolean;
  stream: MediaStream | null;
  clip: ReturnType<VoiceDeps["record"]> | null;
  wake: (() => void) | null;
}

/**
 * Mode 2, hands-free: listen until ~1.2 s of silence after speech, transcribe, send, wait for the reply to
 * finish streaming, read it aloud, listen again. `stop()` ends the loop at any step.
 */
export function useVoiceConversation(
  { messages, send }: { messages: readonly Message[]; send: (text: string) => Promise<string | null> },
  deps: VoiceDeps = browserVoice,
): Conversation {
  const [phase, setPhase] = useState<ConversationPhase>("off");
  const [level, setLevel] = useState(0);
  const [error, setError] = useState<string | null>(null);
  const messagesRef = useRef(messages);
  const waiters = useRef(new Set<() => void>());
  const run = useRef<LoopRun | null>(null);
  const sendRef = useRef(send);
  sendRef.current = send;

  useEffect(() => {
    messagesRef.current = messages;
    for (const w of [...waiters.current]) w();
  }, [messages]);

  const stop = useCallback(() => {
    const r = run.current;
    run.current = null;
    if (r !== null) {
      r.cancelled = true;
      r.clip?.cancel();
      deps.closeMic(r.stream);
      r.wake?.();
    }
    deps.stopSpeaking();
    setLevel(0);
    setPhase("off");
  }, [deps]);

  const start = useCallback(() => {
    if (run.current !== null) return;
    deps.primeSpeech();
    const r: LoopRun = { cancelled: false, stream: null, clip: null, wake: null };
    run.current = r;
    setError(null);
    setPhase("starting");

    const fail = (message: string): void => {
      if (r.cancelled) return;
      stop();
      setError(message);
    };

    /** Records one utterance; null when stopped. */
    const listen = (stream: MediaStream): Promise<{ blob: Blob; mime: string; heard: boolean } | null> =>
      new Promise((resolve) => {
        let ended = false;
        let clip: ReturnType<VoiceDeps["record"]>;
        const end = (): void => {
          if (ended) return;
          ended = true;
          clearTimeout(timer);
          r.wake = null;
          if (r.cancelled) {
            resolve(null);
            return;
          }
          void clip.stop().then((blob) => resolve(r.cancelled ? null : { blob, mime: clip.mime, heard: clip.heardSpeech }));
        };
        clip = deps.record(stream, { onLevel: setLevel, onSpeechEnd: end });
        r.clip = clip;
        r.wake = end;
        const timer = setTimeout(end, MAX_CLIP_MS);
      });

    const replyAfter = (before: string | null): Promise<Message | null> =>
      new Promise((resolve) => {
        const check = (): void => {
          if (r.cancelled) {
            waiters.current.delete(check);
            resolve(null);
            return;
          }
          const reply = finishedReplyAfter(messagesRef.current, before);
          if (reply !== null) {
            waiters.current.delete(check);
            resolve(reply);
          }
        };
        waiters.current.add(check);
        r.wake = check;
        check();
      });

    void (async () => {
      let stream: MediaStream;
      try {
        stream = await deps.openMic();
      } catch (err) {
        fail(micErrorMessage(err));
        return;
      }
      if (r.cancelled) {
        deps.closeMic(stream);
        return;
      }
      r.stream = stream;
      while (!r.cancelled) {
        setPhase("listening");
        const heard = await listen(stream);
        r.clip = null;
        setLevel(0);
        if (heard === null) return;
        if (!heard.heard || heard.blob.size === 0) continue;
        setPhase("transcribing");
        // The last reply's language is the best hint for what the user answers in (`he` picks the Hebrew model).
        const language = transcribeLanguage(messagesRef.current, typeof navigator === "undefined" ? "" : navigator.language || "");
        const res = await deps.transcribe(heard.blob, heard.mime, language);
        if (r.cancelled) return;
        if (!res.ok) {
          fail(res.error);
          return;
        }
        if (res.text.trim() === "") continue;
        const before = lastAssistantId(messagesRef.current);
        setPhase("sending");
        const failure = await sendRef.current(res.text.trim());
        if (r.cancelled) return;
        if (failure !== null) {
          fail(failure);
          return;
        }
        setPhase("waiting");
        const reply = await replyAfter(before);
        r.wake = null;
        if (reply === null || r.cancelled) return;
        const text = reply.status === "error" ? (reply.error ?? "The reply failed.") : reply.content;
        if (text.trim() !== "") {
          setPhase("speaking");
          r.wake = () => deps.stopSpeaking();
          await deps.speak(text, reply.id);
          r.wake = null;
        }
      }
    })();
  }, [deps, stop]);

  useEffect(() => () => {
    const r = run.current;
    if (r !== null) {
      r.cancelled = true;
      r.clip?.cancel();
      deps.closeMic(r.stream);
      deps.stopSpeaking();
    }
  }, [deps]);

  return { phase, level, error, start, stop, clearError: () => { setError(null); } };
}

import { useCallback, useEffect, useRef, useState } from "react";
import type { Message } from "../lib/chat-types";
import { questionSpeech, SpeechStream } from "../lib/speech-text";
import type { Sentence } from "../lib/speech-text";
import { ChunkTranscriber } from "../lib/voice-chunks";
import type { ClipTranscriber } from "../lib/voice-chunks";
import { matchSpokenOption, ScreenAwake, voiceOriginProblem } from "../lib/voice-env";
import { lastAssistantId, micErrorMessage, transcribeLanguage } from "../lib/voice-logic";
import { IDLE_STATE, reduce } from "../lib/voice-machine";
import type { ConvEffect, ConvEvent, ConvState, ConversationMode } from "../lib/voice-machine";
import { DEFAULT_VOICE_SETTINGS, loadVoiceSettings, saveVoiceSettings } from "../lib/voice-settings";
import type { VoiceSettings } from "../lib/voice-settings";
import { ClipRecorder, closeMic, makeBrowserTts, openMic, primeSpeech, speak, splitClip, stopSpeaking, transcribeClip } from "./voice";
import type { RecordOptions, Segment, Transcriber, TtsHandlers, TtsPort } from "./voice";
import type { QuestionPart } from "../../shared/chat-question";

/** What the hooks need from the browser, swappable in tests. */
export interface VoiceDeps {
  openMic: () => Promise<MediaStream>;
  closeMic: (stream: MediaStream | null) => void;
  record: (stream: MediaStream, options: RecordOptions) => { heardSpeech: boolean; stop: () => Promise<void>; cancel: () => void };
  transcribe: Transcriber;
  split?: (blob: Blob) => Promise<[Blob, Blob] | null>;
  /** The conversation mode's speaker; null when the browser has no speech synthesis. */
  makeTts: (handlers: TtsHandlers) => TtsPort | null;
  /** Per-message read-aloud (the speaker buttons). */
  speak: (text: string, key?: string) => Promise<void>;
  stopSpeaking: () => void;
  primeSpeech: () => void;
  wakeLock: { acquire: () => Promise<boolean>; reacquire: () => Promise<void>; release: () => Promise<void> };
  origin: () => string | null;
  storage: () => Pick<Storage, "getItem" | "setItem"> | null;
}

const awake = new ScreenAwake(typeof navigator === "undefined" ? {} : (navigator as unknown as ConstructorParameters<typeof ScreenAwake>[0]));

export const browserVoice: VoiceDeps = {
  openMic,
  closeMic,
  record: (stream, options) => new ClipRecorder(stream, options),
  transcribe: transcribeClip,
  split: splitClip,
  makeTts: makeBrowserTts,
  speak,
  stopSpeaking,
  primeSpeech,
  wakeLock: awake,
  origin: () =>
    typeof window === "undefined"
      ? null
      : voiceOriginProblem({ isSecureContext: window.isSecureContext, protocol: window.location.protocol, hostname: window.location.hostname, hasMediaDevices: typeof navigator.mediaDevices?.getUserMedia === "function" }),
  storage: () => (typeof localStorage === "undefined" ? null : localStorage),
};

export type DictationState = "idle" | "starting" | "recording" | "transcribing";

export interface Dictation {
  state: DictationState;
  startedAt: number | null;
  level: number;
  error: string | null;
  /** Text of the finished pieces so far: shown live while the recording goes on. */
  partial: string;
  start: () => void;
  /** Stops recording and transcribes; the text goes to `onText`. */
  finish: () => void;
  cancel: () => void;
  clearError: () => void;
}

/**
 * Mode 1: tap to record, tap again to transcribe into the composer. Nothing is sent. Only the tap ends it: there is no
 * time limit; a long recording is cut into pieces at pauses and each piece is transcribed while you keep talking.
 */
export function useDictation(onText: (text: string) => void, deps: VoiceDeps = browserVoice): Dictation {
  const [state, setState] = useState<DictationState>("idle");
  const [startedAt, setStartedAt] = useState<number | null>(null);
  const [level, setLevel] = useState(0);
  const [error, setError] = useState<string | null>(null);
  const [partial, setPartial] = useState("");
  const stream = useRef<MediaStream | null>(null);
  const clip = useRef<ReturnType<VoiceDeps["record"]> | null>(null);
  const chunks = useRef<ChunkTranscriber | null>(null);
  const generation = useRef(0);
  const textRef = useRef(onText);
  textRef.current = onText;

  const release = useCallback(() => {
    deps.closeMic(stream.current);
    stream.current = null;
    clip.current = null;
    setLevel(0);
    setStartedAt(null);
  }, [deps]);

  const finish = useCallback(() => {
    const current = clip.current;
    const transcriber = chunks.current;
    if (current === null || transcriber === null) return;
    const gen = generation.current;
    setState("transcribing");
    void current.stop().then(async () => {
      release();
      const res = await transcriber.finish();
      if (gen !== generation.current) return;
      setState("idle");
      setPartial("");
      if (!res.ok) {
        setError(res.error);
      } else if (res.text.trim() === "") {
        setError("No speech was recognized.");
      } else {
        textRef.current(res.text);
      }
    });
  }, [release]);

  const start = useCallback(() => {
    if (clip.current !== null) return;
    const gen = (generation.current += 1);
    setError(null);
    setPartial("");
    const problem = deps.origin();
    if (problem !== null) {
      setError(problem);
      return;
    }
    setState("starting");
    deps.openMic().then(
      (s) => {
        if (gen !== generation.current) {
          deps.closeMic(s);
          return;
        }
        stream.current = s;
        const transcriber = new ChunkTranscriber(deps.transcribe as ClipTranscriber, { language: browserLanguage(), onPartial: (t) => { if (gen === generation.current) setPartial(t); }, split: deps.split });
        chunks.current = transcriber;
        try {
          clip.current = deps.record(s, { onLevel: setLevel, onSegment: (seg) => transcriber.add(seg) });
        } catch (err) {
          release();
          setError(micErrorMessage(err));
          setState("idle");
          return;
        }
        setStartedAt(Date.now());
        setState("recording");
      },
      (err: unknown) => {
        if (gen !== generation.current) return;
        setError(micErrorMessage(err));
        setState("idle");
      },
    );
  }, [deps, release]);

  const cancel = useCallback(() => {
    generation.current += 1;
    clip.current?.cancel();
    release();
    chunks.current = null;
    setPartial("");
    setState("idle");
  }, [release]);

  useEffect(() => () => {
    generation.current += 1;
    clip.current?.cancel();
    deps.closeMic(stream.current);
  }, [deps]);

  return { state, startedAt, level, error, partial, start, finish, cancel, clearError: () => { setError(null); } };
}

function browserLanguage(): string | null {
  return typeof navigator === "undefined" ? null : transcribeLanguage([], navigator.language || "");
}

export interface ConversationQuestion {
  part: QuestionPart;
  answer: (qid: string, answers: string[][] | null) => Promise<string | null>;
}

export interface Conversation {
  /** The mode's state: listening, thinking, speaking, paused, or off (closed). */
  phase: ConversationMode;
  muted: boolean;
  pushToTalk: boolean;
  level: number;
  /** A clear sentence with the fix when something failed; the mode is closed and the chat is back to text. */
  error: string | null;
  /** Something to know that does not end the mode (no voice for a language, a browser that cannot speak). */
  notice: string | null;
  /** What the user said in the current turn: partial while they talk, final after. */
  heard: string;
  /** Spoken sentences of the assistant's current reply, and the one being said now. */
  reply: Sentence[];
  activeSentence: number | null;
  settings: VoiceSettings;
  updateSettings: (patch: Partial<VoiceSettings>) => void;
  /** Open the mode. Call from the tap handler: it primes speech synthesis (iOS needs the gesture). */
  start: () => void;
  /** End the conversation. */
  stop: () => void;
  pause: () => void;
  resume: () => void;
  toggleMute: () => void;
  /** Tap on the orb: cuts the assistant off while it speaks. */
  tap: () => void;
  /** Stop speaking and listen. */
  stopSpeakingNow: () => void;
  pttDown: () => void;
  pttUp: () => void;
  clearError: () => void;
}

export interface ConversationInput {
  messages: readonly Message[];
  send: (text: string) => Promise<string | null>;
  running?: boolean;
  /** A question card waiting for an answer, with the function that sends it. */
  question?: ConversationQuestion | null;
}

interface Turn {
  before: string | null;
  replyId: string | null;
  stream: SpeechStream | null;
  finished: boolean;
  questionAsked: boolean;
}

/**
 * Mode 2, hands-free voice in and out: listen, end-of-speech, send like a typed message, speak the reply sentence by
 * sentence while it streams, listen again. Speaking the user over cuts the voice at once (barge-in). The state
 * transitions live in `voice-machine.ts`; this hook runs their effects.
 */
export function useVoiceConversation({ messages, send, running, question }: ConversationInput, deps: VoiceDeps = browserVoice): Conversation {
  const [conv, setConv] = useState<ConvState>(IDLE_STATE);
  const [level, setLevel] = useState(0);
  const [heard, setHeard] = useState("");
  const [reply, setReply] = useState<Sentence[]>([]);
  const [active, setActive] = useState<number | null>(null);
  const [settings, setSettings] = useState<VoiceSettings>(() => loadVoiceSettings(deps.storage()));
  const [notice, setNotice] = useState<string | null>(null);
  const state = useRef<ConvState>(IDLE_STATE);
  const settingsRef = useRef(settings);
  settingsRef.current = settings;
  const messagesRef = useRef(messages);
  messagesRef.current = messages;
  const runningRef = useRef(running);
  runningRef.current = running;
  const questionRef = useRef(question ?? null);
  questionRef.current = question ?? null;
  const sendRef = useRef(send);
  sendRef.current = send;
  const stream = useRef<MediaStream | null>(null);
  const recorder = useRef<{ clip: ReturnType<VoiceDeps["record"]>; chunks: ChunkTranscriber; gen: number } | null>(null);
  const generation = useRef(0);
  const tts = useRef<TtsPort | null>(null);
  const turn = useRef<Turn | null>(null);
  const awaiting = useRef<string | null>(null);
  const dispatchRef = useRef<(e: ConvEvent) => void>(() => undefined);

  const language = (): string | null => transcribeLanguage(messagesRef.current, typeof navigator === "undefined" ? "" : navigator.language || "");

  const fail = useCallback((message: string) => dispatchRef.current({ type: "fail", message }), []);

  const dropRecorder = useCallback(() => {
    generation.current += 1;
    recorder.current?.clip.cancel();
    recorder.current = null;
    setLevel(0);
  }, []);

  /** Ends the utterance being recorded, transcribes the rest, and hands the text to the turn. */
  const finishUtterance = useCallback(async () => {
    const rec = recorder.current;
    if (rec === null) return;
    recorder.current = null;
    setLevel(0);
    const gen = rec.gen;
    await rec.clip.stop();
    const res = await rec.chunks.finish();
    if (gen !== generation.current && state.current.phase === "off") return;
    if (state.current.phase !== "listening") return;
    if (!res.ok) {
      fail(res.error);
      return;
    }
    const text = res.text.trim();
    if (text === "") {
      setHeard("");
      dispatchRef.current({ type: "empty" });
      return;
    }
    setHeard(text);
    dispatchRef.current({ type: "utterance" });
    await handleUtterance(text);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [fail]);

  const startRecorder = useCallback(() => {
    const s = stream.current;
    if (s === null || recorder.current !== null) return;
    const gen = generation.current;
    const cfg = settingsRef.current;
    const chunks = new ChunkTranscriber(deps.transcribe as ClipTranscriber, { language: language(), onPartial: (t) => { if (gen === generation.current) setHeard(t); }, split: deps.split });
    const speaking = state.current.phase === "speaking";
    const options: RecordOptions = {
      onLevel: setLevel,
      onSegment: (seg: Segment) => {
        if (seg.hadSpeech || state.current.pushToTalk) chunks.add(seg);
      },
      onSpeechStart: () => {
        if (state.current.phase === "speaking") dispatchRef.current({ type: "speech-start" });
      },
      onSpeechEnd: () => {
        if (state.current.phase === "listening" && !state.current.pushToTalk) void finishUtterance();
      },
      // While the assistant speaks its own voice leaks into the mic: ask for more and longer sound before it counts as the user.
      vad: speaking ? { endSilenceMs: cfg.silenceMs, minSpeechMs: 450, startFactor: 4.5, minStart: 0.03 } : { endSilenceMs: cfg.silenceMs },
    };
    try {
      recorder.current = { clip: deps.record(s, options), chunks, gen };
    } catch (err) {
      fail(micErrorMessage(err));
    }
  }, [deps, fail, finishUtterance]);

  const runEffect = useCallback((effect: ConvEffect) => {
    if (effect === "listen") {
      startRecorder();
    } else if (effect === "stop-listen") {
      void finishUtterance();
    } else if (effect === "drop-recorder") {
      dropRecorder();
    } else if (effect === "stop-tts") {
      tts.current?.stop();
      setActive(null);
    } else {
      deps.closeMic(stream.current);
      stream.current = null;
      void deps.wakeLock.release();
    }
  }, [deps, dropRecorder, finishUtterance, startRecorder]);

  const dispatch = useCallback((event: ConvEvent) => {
    const step = reduce(state.current, event);
    state.current = step.state;
    setConv(step.state);
    for (const effect of step.effects) runEffect(effect);
  }, [runEffect]);
  dispatchRef.current = dispatch;

  /** The speaker, built once per mode; its callbacks read the latest settings. */
  const speaker = (): TtsPort | null => {
    if (tts.current !== null) return tts.current;
    tts.current = deps.makeTts({
      onActive: (s) => setActive(s === null ? null : s.index),
      onStart: () => {
        // Watch for the user talking over the voice with a recorder of its own (stricter thresholds).
        if (!state.current.muted && !state.current.pushToTalk) startRecorder();
        dispatchRef.current({ type: "tts-started" });
      },
      onIdle: () => dispatchRef.current({ type: "tts-idle" }),
      onNoVoice: (lang) => setNotice(`No ${lang.startsWith("he") ? "Hebrew" : lang} voice is installed: that text was read with the default voice. Add one in your system's speech settings.`),
      voiceFor: (base) => settingsRef.current.voices[base],
      rate: () => settingsRef.current.rate,
    });
    return tts.current;
  };
  const say = (sentences: Sentence[]): void => {
    if (sentences.length === 0) return;
    setReply((r) => [...r, ...sentences.map((s, i) => ({ ...s, index: r.length + i }))]);
    if (!settingsRef.current.speak || state.current.skipReply || state.current.phase === "paused") return;
    const speaker_ = speaker();
    if (speaker_ === null) {
      setNotice("This browser cannot speak: the reply is shown as text only.");
      return;
    }
    for (const s of sentences) speaker_.enqueue(s);
  };

  async function handleUtterance(text: string): Promise<void> {
    const asking = questionRef.current;
    if (asking !== null && awaiting.current === asking.part.id) {
      const q = asking.part.questions[0];
      const label = q === undefined ? null : matchSpokenOption(text, q.options);
      const answers = label !== null ? [[label]] : q?.allowCustom === true || (q !== undefined && q.options.length === 0) ? [[text]] : null;
      if (answers !== null) {
        awaiting.current = null;
        setReply([]);
        turn.current = { before: lastAssistantId(messagesRef.current), replyId: null, stream: null, finished: false, questionAsked: false };
        const failure = await asking.answer(asking.part.id, answers);
        if (failure !== null) fail(failure);
        return;
      }
      say([{ index: 0, text: "I did not catch which option. Say its number or its name.", lang: "en-US" }]);
      dispatchRef.current({ type: "reply-done" });
      return;
    }
    setReply([]);
    turn.current = { before: lastAssistantId(messagesRef.current), replyId: null, stream: null, finished: false, questionAsked: false };
    const failure = await sendRef.current(text);
    if (failure !== null) fail(failure);
  }

  // The reply streams in through `messages`: speak each sentence as it completes.
  useEffect(() => {
    const t = turn.current;
    const phase = state.current.phase;
    if (t === null || t.finished || (phase !== "thinking" && phase !== "speaking" && phase !== "listening" && phase !== "paused")) return;
    const candidates = messages.filter((m) => m.role === "assistant" && (t.before === null || m.id > t.before)).sort((a, b) => (a.id < b.id ? -1 : 1));
    const m = candidates[0];
    if (m === undefined) return;
    if (t.replyId !== m.id) {
      t.replyId = m.id;
      t.stream = new SpeechStream(typeof navigator === "undefined" ? "en-US" : navigator.language || "en-US");
    }
    const final = m.status === "done" || m.status === "stopped" || m.status === "error";
    const content = m.status === "error" ? (m.content.trim() !== "" ? m.content : m.error ?? "The reply failed.") : m.content;
    say(t.stream?.push(content, final) ?? []);
    if (!final) return;
    if (running === true) return;
    t.finished = true;
    const asking = questionRef.current;
    if (asking !== null && asking.part.questions.length === 1 && !t.questionAsked) {
      t.questionAsked = true;
      const q = asking.part.questions[0];
      if (q !== undefined) {
        const lang = typeof navigator === "undefined" ? "en-US" : navigator.language || "en-US";
        const spoken = questionSpeech(q.question, q.options.map((o) => o.label), lang);
        awaiting.current = asking.part.id;
        const stream_ = new SpeechStream(lang);
        say(stream_.push(spoken, true));
      }
    } else if (asking !== null && !t.questionAsked) {
      t.questionAsked = true;
      say([{ index: 0, text: "This card has several questions: answer it on the screen.", lang: "en-US" }]);
    }
    dispatchRef.current({ type: "reply-done" });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [messages, running, question]);

  const start = useCallback(() => {
    if (state.current.phase !== "off") return;
    deps.primeSpeech();
    setNotice(null);
    setHeard("");
    setReply([]);
    const problem = deps.origin();
    dispatch({ type: "start", pushToTalk: settingsRef.current.pushToTalk });
    if (problem !== null) {
      fail(problem);
      return;
    }
    void deps.wakeLock.acquire();
    deps.openMic().then(
      (s) => {
        if (state.current.phase !== "starting") {
          deps.closeMic(s);
          return;
        }
        stream.current = s;
        dispatch({ type: "mic-ready" });
      },
      (err: unknown) => fail(micErrorMessage(err)),
    );
  }, [deps, dispatch, fail]);

  const stop = useCallback(() => {
    turn.current = null;
    awaiting.current = null;
    dispatch({ type: "stop" });
  }, [dispatch]);

  useEffect(() => {
    const onVisible = (): void => {
      if (typeof document !== "undefined" && document.visibilityState === "visible" && state.current.phase !== "off") void deps.wakeLock.reacquire();
    };
    if (typeof document !== "undefined") document.addEventListener("visibilitychange", onVisible);
    return () => {
      if (typeof document !== "undefined") document.removeEventListener("visibilitychange", onVisible);
    };
  }, [deps]);

  useEffect(() => () => {
    generation.current += 1;
    recorder.current?.clip.cancel();
    tts.current?.stop();
    deps.closeMic(stream.current);
    void deps.wakeLock.release();
  }, [deps]);

  const updateSettings = useCallback((patch: Partial<VoiceSettings>) => {
    setSettings((prev) => {
      const next = { ...DEFAULT_VOICE_SETTINGS, ...prev, ...patch };
      saveVoiceSettings(next, deps.storage());
      return next;
    });
    if (patch.pushToTalk !== undefined) dispatchRef.current({ type: "set-push-to-talk", on: patch.pushToTalk });
    if (patch.speak === false) {
      tts.current?.stop();
    }
  }, [deps]);

  return {
    phase: conv.phase,
    muted: conv.muted,
    pushToTalk: conv.pushToTalk || (conv.phase === "off" && settings.pushToTalk),
    level,
    error: conv.error,
    notice,
    heard,
    reply,
    activeSentence: active,
    settings,
    updateSettings,
    start,
    stop,
    pause: () => dispatch({ type: "pause" }),
    resume: () => dispatch({ type: "resume" }),
    toggleMute: () => dispatch({ type: state.current.muted ? "unmute" : "mute" }),
    tap: () => dispatch({ type: "tap" }),
    stopSpeakingNow: () => dispatch({ type: "tap" }),
    pttDown: () => dispatch({ type: "ptt-down" }),
    pttUp: () => dispatch({ type: "ptt-up" }),
    clearError: () => { setNotice(null); setConv((c) => ({ ...c, error: null })); state.current = { ...state.current, error: null }; },
  };
}

/** The conversation mode as a pure state machine: events in, next state and effects out. The hook runs the effects. */

export type ConversationMode = "off" | "starting" | "listening" | "thinking" | "speaking" | "paused";

export interface ConvState {
  phase: ConversationMode;
  muted: boolean;
  /** The assistant's reply has finished streaming. */
  replyDone: boolean;
  /** The speech queue has nothing left to say. */
  ttsIdle: boolean;
  /** The user cut the assistant off: the rest of this reply is not spoken. */
  skipReply: boolean;
  /** Push-to-talk: the microphone records only while the key or button is held. */
  pushToTalk: boolean;
  error: string | null;
}

export type ConvEvent =
  | { type: "start"; pushToTalk?: boolean }
  | { type: "mic-ready" }
  | { type: "speech-start" }
  | { type: "utterance" }
  | { type: "empty" }
  | { type: "tts-started" }
  | { type: "tts-idle" }
  | { type: "reply-done" }
  | { type: "tap" }
  | { type: "pause" }
  | { type: "resume" }
  | { type: "mute" }
  | { type: "unmute" }
  | { type: "set-push-to-talk"; on: boolean }
  | { type: "ptt-down" }
  | { type: "ptt-up" }
  | { type: "stop" }
  | { type: "fail"; message: string };

/** `listen`: make sure one recorder runs (idempotent). `drop-recorder`: cancel it. `stop-tts`: silence speech now. `release`: close the mic and the wake lock. */
export type ConvEffect = "listen" | "stop-listen" | "drop-recorder" | "stop-tts" | "release";

export const IDLE_STATE: ConvState = { phase: "off", muted: false, replyDone: false, ttsIdle: true, skipReply: false, pushToTalk: false, error: null };

export interface Step {
  state: ConvState;
  effects: ConvEffect[];
}

const same = (state: ConvState): Step => ({ state, effects: [] });

function listening(s: ConvState): Step {
  return { state: { ...s, phase: "listening", replyDone: false }, effects: s.muted || s.pushToTalk ? [] : ["listen"] };
}

export function reduce(s: ConvState, e: ConvEvent): Step {
  switch (e.type) {
    case "start":
      return s.phase === "off" ? same({ ...IDLE_STATE, phase: "starting", pushToTalk: e.pushToTalk === true }) : same(s);
    case "mic-ready":
      return s.phase === "starting" ? listening(s) : same(s);
    case "fail":
      return { state: { ...IDLE_STATE, error: e.message }, effects: ["stop-tts", "drop-recorder", "release"] };
    case "stop":
      return s.phase === "off" ? same(s) : { state: { ...IDLE_STATE, pushToTalk: s.pushToTalk }, effects: ["stop-tts", "drop-recorder", "release"] };
    case "mute":
      return s.phase === "off" ? same(s) : { state: { ...s, muted: true }, effects: ["drop-recorder"] };
    case "unmute":
      return s.phase === "off" ? same(s) : s.phase === "listening" && !s.pushToTalk ? { state: { ...s, muted: false }, effects: ["listen"] } : same({ ...s, muted: false });
    case "set-push-to-talk":
      if (s.phase === "off") return same({ ...s, pushToTalk: e.on });
      return s.phase === "listening" ? { state: { ...s, pushToTalk: e.on }, effects: e.on ? ["drop-recorder"] : s.muted ? [] : ["listen"] } : same({ ...s, pushToTalk: e.on });
    case "pause":
      return s.phase === "off" || s.phase === "starting" || s.phase === "paused" ? same(s) : { state: { ...s, phase: "paused", skipReply: true }, effects: ["stop-tts", "drop-recorder"] };
    case "resume":
      return s.phase === "paused" ? listening({ ...s, skipReply: true }) : same(s);
    case "ptt-down":
      return s.phase === "listening" && s.pushToTalk && !s.muted ? { state: s, effects: ["listen"] } : s.phase === "speaking" && s.pushToTalk ? { state: { ...s, phase: "listening", skipReply: true, replyDone: false }, effects: ["stop-tts", "listen"] } : same(s);
    case "ptt-up":
      return s.phase === "listening" && s.pushToTalk ? { state: s, effects: ["stop-listen"] } : same(s);
    case "utterance":
      return s.phase === "listening" ? same({ ...s, phase: "thinking", replyDone: false, ttsIdle: true, skipReply: false }) : same(s);
    case "empty":
      return s.phase === "listening" ? listening(s) : same(s);
    case "tts-started":
      return s.phase === "thinking" || s.phase === "speaking" ? same({ ...s, phase: "speaking", ttsIdle: false }) : same(s);
    case "tts-idle": {
      if (s.phase !== "speaking" && s.phase !== "thinking") return same({ ...s, ttsIdle: true });
      const idle = { ...s, ttsIdle: true };
      if (idle.replyDone) {
        const next = listening(idle);
        return { state: next.state, effects: ["drop-recorder", ...next.effects] };
      }
      return same({ ...idle, phase: "thinking" });
    }
    case "reply-done": {
      if (s.phase !== "thinking" && s.phase !== "speaking") return same({ ...s, replyDone: true });
      const done = { ...s, replyDone: true };
      if (done.ttsIdle) {
        const next = listening(done);
        return { state: next.state, effects: ["drop-recorder", ...next.effects] };
      }
      return same(done);
    }
    case "speech-start":
    case "tap":
      if (s.phase === "speaking") {
        // Barge-in: the recorder that watched for speech keeps going, so the first words are not lost.
        return { state: { ...s, phase: "listening", skipReply: true, replyDone: false, ttsIdle: true }, effects: ["stop-tts", "listen"] };
      }
      return same(s);
  }
}

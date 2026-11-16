import { describe, expect, test } from "bun:test";
import { IDLE_STATE, reduce } from "./voice-machine";
import type { ConvEvent, ConvState } from "./voice-machine";

function run(events: ConvEvent[], from: ConvState = IDLE_STATE): { state: ConvState; effects: string[][] } {
  let state = from;
  const effects: string[][] = [];
  for (const e of events) {
    const step = reduce(state, e);
    state = step.state;
    effects.push(step.effects);
  }
  return { state, effects };
}

const toListening: ConvEvent[] = [{ type: "start" }, { type: "mic-ready" }];

describe("conversation state machine", () => {
  test("listening → thinking → speaking → listening", () => {
    const r = run([...toListening, { type: "utterance" }, { type: "tts-started" }, { type: "reply-done" }, { type: "tts-idle" }]);
    expect(r.state.phase).toBe("listening");
    expect(r.effects[0]).toEqual([]);
    expect(r.effects[1]).toEqual(["listen"]);
    expect(r.effects.at(-1)).toEqual(["drop-recorder", "listen"]);
  });

  test("while the reply still streams, silence in speech goes back to thinking, then speaks again", () => {
    const r = run([...toListening, { type: "utterance" }, { type: "tts-started" }, { type: "tts-idle" }]);
    expect(r.state.phase).toBe("thinking");
    expect(run([{ type: "tts-started" }, { type: "reply-done" }, { type: "tts-idle" }], r.state).state.phase).toBe("listening");
  });

  test("barge-in: speech or a tap while speaking stops the voice at once and keeps listening; the rest of the reply is skipped", () => {
    const speaking = run([...toListening, { type: "utterance" }, { type: "tts-started" }]).state;
    for (const e of [{ type: "speech-start" }, { type: "tap" }] as ConvEvent[]) {
      const step = reduce(speaking, e);
      expect(step.state.phase).toBe("listening");
      expect(step.state.skipReply).toBe(true);
      expect(step.effects).toEqual(["stop-tts", "listen"]);
    }
    expect(reduce(run([...toListening]).state, { type: "tap" }).effects).toEqual([]);
  });

  test("pause stops speech and the recorder; resume listens again; a reply that ends while paused is not spoken", () => {
    const speaking = run([...toListening, { type: "utterance" }, { type: "tts-started" }]).state;
    const paused = reduce(speaking, { type: "pause" });
    expect(paused.state.phase).toBe("paused");
    expect(paused.effects).toEqual(["stop-tts", "drop-recorder"]);
    expect(reduce(paused.state, { type: "tts-started" }).state.phase).toBe("paused");
    const back = reduce(paused.state, { type: "resume" });
    expect(back.state.phase).toBe("listening");
    expect(back.effects).toEqual(["listen"]);
  });

  test("end releases everything; a failure ends with the message and falls back to text", () => {
    const live = run([...toListening, { type: "utterance" }]).state;
    expect(reduce(live, { type: "stop" })).toEqual({ state: { ...IDLE_STATE }, effects: ["stop-tts", "drop-recorder", "release"] });
    const failed = reduce(live, { type: "fail", message: "Microphone permission was denied." });
    expect(failed.state.phase).toBe("off");
    expect(failed.state.error).toBe("Microphone permission was denied.");
  });

  test("an empty utterance listens again; mute drops the recorder and unmute listens", () => {
    expect(run([...toListening, { type: "empty" }]).effects.at(-1)).toEqual(["listen"]);
    const muted = reduce(run(toListening).state, { type: "mute" });
    expect(muted.effects).toEqual(["drop-recorder"]);
    expect(reduce(muted.state, { type: "unmute" }).effects).toEqual(["listen"]);
    expect(reduce({ ...IDLE_STATE, phase: "listening", muted: true }, { type: "empty" }).effects).toEqual([]);
  });

  test("push-to-talk records only while held", () => {
    const r = run([{ type: "start", pushToTalk: true }, { type: "mic-ready" }]);
    expect(r.effects[1]).toEqual([]);
    expect(reduce(r.state, { type: "ptt-down" }).effects).toEqual(["listen"]);
    expect(reduce(r.state, { type: "ptt-up" }).effects).toEqual(["stop-listen"]);
    const speaking = run([{ type: "utterance" }, { type: "tts-started" }], r.state).state;
    expect(reduce(speaking, { type: "ptt-down" }).effects).toEqual(["stop-tts", "listen"]);
  });
});

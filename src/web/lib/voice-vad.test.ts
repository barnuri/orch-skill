import { describe, expect, test } from "bun:test";
import { clampEndSilence, EnergyVad, SegmentPolicy } from "./voice-vad";

function run(vad: EnergyVad, plan: Array<[level: number, fromMs: number, toMs: number]>): Array<[number, string]> {
  const events: Array<[number, string]> = [];
  for (const [level, from, to] of plan) {
    for (let t = from; t < to; t += 50) {
      const e = vad.push(level, t);
      if (e !== null) events.push([t, e]);
    }
  }
  return events;
}

describe("EnergyVad", () => {
  test("a 1 s pause inside speech does not end it; 2 s of silence does (default 1.8 s)", () => {
    const vad = new EnergyVad();
    const events = run(vad, [[0.002, 0, 1000], [0.2, 1000, 3000], [0.002, 3000, 4000], [0.2, 4000, 5000], [0.002, 5000, 7000]]);
    expect(events.map((e) => e[1])).toEqual(["speech-start", "speech-end"]);
    expect(events[1]?.[0]).toBeGreaterThanOrEqual(6800);
    expect(events[1]?.[0]).toBeLessThan(7000);
  });

  test("silence before anyone spoke never ends it, and a short click is not speech", () => {
    const vad = new EnergyVad();
    expect(run(vad, [[0.002, 0, 8000], [0.4, 8000, 8100], [0.002, 8100, 20_000]])).toEqual([]);
    expect(vad.heardSpeech).toBe(false);
  });

  test("a steady noisy room (0.03) calibrates as the floor: a fixed 0.02 threshold would never end", () => {
    const vad = new EnergyVad({ endSilenceMs: 1000 });
    const events = run(vad, [[0.03, 0, 1000], [0.25, 1000, 2500], [0.03, 2500, 5000]]);
    expect(events.map((e) => e[1])).toEqual(["speech-start", "speech-end"]);
    expect(vad.noiseFloor).toBeGreaterThan(0.02);
    expect(vad.noiseFloor).toBeLessThan(0.04);
  });

  test("hysteresis: soft speech between the stop and start thresholds keeps the utterance alive", () => {
    const vad = new EnergyVad({ endSilenceMs: 1000 });
    run(vad, [[0.004, 0, 1000], [0.2, 1000, 2000]]);
    expect(vad.stopThreshold).toBeLessThan(vad.startThreshold);
    const soft = (vad.stopThreshold + vad.startThreshold) / 2;
    expect(run(vad, [[soft, 2000, 6000]])).toEqual([]);
    expect(run(vad, [[0.001, 6000, 7200]]).map((e) => e[1])).toEqual(["speech-end"]);
  });

  test("a user who starts talking during calibration does not raise the floor above their voice", () => {
    const vad = new EnergyVad();
    const events = run(vad, [[0.003, 0, 200], [0.3, 200, 2000], [0.003, 2000, 4500]]);
    expect(events.map((e) => e[1])).toEqual(["speech-start", "speech-end"]);
    expect(vad.noiseFloor).toBeLessThan(0.1);
  });

  test("the end silence is clamped to 0.8..4 s", () => {
    expect([clampEndSilence(100), clampEndSilence(1800), clampEndSilence(99_999), clampEndSilence(Number.NaN)]).toEqual([800, 1800, 4000, 1800]);
  });
});

describe("SegmentPolicy (ported from voice-notes SpeechChunker)", () => {
  const cuts = (plan: Array<[loud: boolean, from: number, to: number]>): Array<[number, string]> => {
    const p = new SegmentPolicy();
    p.reset(0);
    const out: Array<[number, string]> = [];
    for (const [loud, from, to] of plan) {
      for (let t = from; t < to; t += 100) {
        const c = p.observe(loud, t);
        if (c !== "none") {
          out.push([t, c]);
          p.reset(t);
        }
      }
    }
    return out;
  };

  test("never cuts before 5 s, then at a 700 ms pause", () => {
    expect(cuts([[true, 0, 3000], [false, 3000, 4500]])).toEqual([]);
    expect(cuts([[true, 0, 6000], [false, 6000, 7000]])).toEqual([[6600, "pause"]]);
  });

  test("a recording with no pause is cut by force only at 60 s, and silence alone never cuts", () => {
    expect(cuts([[true, 0, 70_000]])[0]).toEqual([60_000, "forced"]);
    expect(cuts([[false, 0, 50_000]])).toEqual([]);
  });

  test("after 12 s a short word gap is enough", () => {
    expect(cuts([[true, 0, 13_000], [false, 13_000, 13_400]])).toEqual([[13_200, "pause"]]);
  });
});

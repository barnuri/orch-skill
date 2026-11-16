import { describe, expect, test } from "bun:test";
import { TtsQueue } from "./tts-queue";
import type { SynthLike, UtteranceLike } from "./tts-queue";
import type { Sentence } from "../lib/speech-text";

const voices = [
  { name: "Samantha", lang: "en-US", voiceURI: "samantha", default: true },
  { name: "Carmit", lang: "he-IL", voiceURI: "carmit" },
];

function fake(over: { voices?: typeof voices } = {}) {
  const spoken: Array<{ text: string; lang: string; voice: string | undefined; rate: number }> = [];
  let pending: UtteranceLike | null = null;
  let cancels = 0;
  const synth: SynthLike = {
    speak: (u) => { pending = u; spoken.push({ text: u.text, lang: u.lang, voice: (u.voice as { name?: string } | null)?.name, rate: u.rate }); },
    cancel: () => { cancels += 1; pending = null; },
    getVoices: () => over.voices ?? voices,
  };
  const log: string[] = [];
  const timers: Array<() => void> = [];
  const q = new TtsQueue({
    synth,
    makeUtterance: (text) => ({ text, lang: "", voice: null, rate: 1, onend: null, onerror: null }),
    rate: () => 1.2,
    onActive: (s) => log.push(`active ${s === null ? "none" : s.index}`),
    onStart: () => log.push("start"),
    onIdle: () => log.push("idle"),
    onNoVoice: (l) => log.push(`novoice ${l}`),
    voiceFor: (b) => (b === "en" ? "samantha" : undefined),
    setTimer: (fn) => { timers.push(fn); return timers.length; },
    clearTimer: () => undefined,
  });
  const end = async (): Promise<void> => { const u = pending as UtteranceLike | null; pending = null; u?.onend?.(); await Promise.resolve(); await Promise.resolve(); await Promise.resolve(); };
  return { q, spoken, log, end, cancels: () => cancels, timers };
}
const s = (index: number, text: string, lang: string): Sentence => ({ index, text, lang });

describe("TtsQueue", () => {
  test("speaks sentences in order, one at a time, each in the voice for its language, and reports active and idle", async () => {
    const f = fake();
    f.q.enqueue(s(0, "Hello there.", "en-US"));
    f.q.enqueue(s(1, "שלום לכולם.", "he-IL"));
    expect(f.spoken.map((x) => x.text)).toEqual(["Hello there."]);
    await f.end();
    expect(f.spoken.map((x) => [x.text, x.voice, x.rate])).toEqual([["Hello there.", "Samantha", 1.2], ["שלום לכולם.", "Carmit", 1.2]]);
    await f.end();
    expect(f.log).toEqual(["active 0", "start", "active 1", "active none", "idle"]);
    expect(f.q.speaking).toBe(false);
  });

  test("stop silences the engine at once, drops the queue and ends the wait", async () => {
    const f = fake();
    f.q.enqueue(s(0, "First sentence goes here.", "en-US"));
    f.q.enqueue(s(1, "Second sentence goes here.", "en-US"));
    f.q.stop();
    expect(f.cancels()).toBe(1);
    await Promise.resolve();
    await Promise.resolve();
    expect(f.spoken.length).toBe(1);
    expect(f.log).toContain("active none");
    expect(f.q.speaking).toBe(false);
    f.q.enqueue(s(2, "Fresh start after stopping.", "en-US"));
    expect(f.spoken.at(-1)?.text).toBe("Fresh start after stopping.");
  });

  test("a missing voice for a language is reported once, and the sentence is still spoken with the language tag", async () => {
    const f = fake({ voices: [voices[0] as (typeof voices)[0]] });
    f.q.enqueue(s(0, "שלום לכולם.", "he-IL"));
    await f.end();
    f.q.enqueue(s(1, "עוד משפט אחד.", "he-IL"));
    await f.end();
    expect(f.log.filter((l) => l.startsWith("novoice"))).toEqual(["novoice he-IL"]);
    expect(f.spoken[0]?.lang).toBe("he-IL");
  });

  test("an engine that never fires onend cannot hang the queue: the watchdog moves on", async () => {
    const f = fake();
    f.q.enqueue(s(0, "This one never ends.", "en-US"));
    f.q.enqueue(s(1, "But this one is spoken.", "en-US"));
    f.timers[0]?.();
    await Promise.resolve();
    await Promise.resolve();
    expect(f.spoken.map((x) => x.text)).toEqual(["This one never ends.", "But this one is spoken."]);
  });
});

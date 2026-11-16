import { describe, expect, test } from "bun:test";
import { ChunkTranscriber, mergeOverlap } from "./voice-chunks";
import type { ClipTranscriber, TranscribeOutcome } from "./voice-chunks";
import { encodeWav, halvesOf } from "./voice-pcm";

const blob = (name: string) => new Blob([name], { type: "audio/webm" });
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

describe("ChunkTranscriber", () => {
  test("pieces finish out of order but the text joins in recording order, and partial text never skips ahead", async () => {
    const delays: Record<string, number> = { a: 40, b: 5, c: 20 };
    const t: ClipTranscriber = async (b) => {
      const name = await b.text();
      await sleep(delays[name] ?? 0);
      return { ok: true, text: `text-${name}` };
    };
    const partials: string[] = [];
    const ct = new ChunkTranscriber(t, { language: "en", onPartial: (p) => partials.push(p), concurrency: 3 });
    for (const n of ["a", "b", "c"]) ct.add({ blob: blob(n), mime: "audio/webm" });
    const res = await ct.finish();
    expect(res).toEqual({ ok: true, text: "text-a text-b text-c" });
    expect(partials).toEqual(["text-a text-b text-c"]);
  });

  test("pieces can be added while earlier ones are still running", async () => {
    const t: ClipTranscriber = async (b) => ({ ok: true, text: await b.text() });
    const ct = new ChunkTranscriber(t, { language: null });
    ct.add({ blob: blob("one"), mime: "audio/webm" });
    await sleep(5);
    ct.add({ blob: blob("two"), mime: "audio/webm" });
    expect(await ct.finish()).toEqual({ ok: true, text: "one two" });
  });

  test("an overlapped piece drops the words the previous piece already ended with", async () => {
    const texts: Record<string, string> = { a: "we should ship the new build on friday morning", b: "build on friday morning and then notify the team" };
    const t: ClipTranscriber = async (b) => ({ ok: true, text: texts[await b.text()] ?? "" });
    const ct = new ChunkTranscriber(t, { language: "en" });
    ct.add({ blob: blob("a"), mime: "audio/webm" });
    ct.add({ blob: blob("b"), mime: "audio/webm", overlapped: true });
    expect(await ct.finish()).toEqual({ ok: true, text: "we should ship the new build on friday morning and then notify the team" });
  });

  test("a long piece the hub rejects is split in two halves and joined", async () => {
    const calls: string[] = [];
    const t: ClipTranscriber = async (b, mime) => {
      const name = await b.text();
      calls.push(`${mime}:${name}`);
      if (name === "big") return { ok: false, error: "Transcription failed: HTTP 413" };
      return { ok: true, text: name === "L" ? "first half here" : "second half" };
    };
    const ct = new ChunkTranscriber(t, { language: null, split: async () => [blob("L"), blob("R")] });
    ct.add({ blob: blob("big"), mime: "audio/webm", seconds: 50 });
    expect(await ct.finish()).toEqual({ ok: true, text: "first half here second half" });
    expect(calls).toEqual(["audio/webm:big", "audio/wav:L", "audio/wav:R"]);
  });

  test("a short piece is tried once more; a persistent failure is the error, in order", async () => {
    let n = 0;
    const flaky: ClipTranscriber = async () => (++n === 1 ? { ok: false, error: "boom" } : { ok: true, text: "ok" });
    const a = new ChunkTranscriber(flaky, { language: null });
    a.add({ blob: blob("x"), mime: "audio/webm", seconds: 2 });
    expect(await a.finish()).toEqual({ ok: true, text: "ok" });
    const dead: ClipTranscriber = async (): Promise<TranscribeOutcome> => ({ ok: false, error: "hub down" });
    const b = new ChunkTranscriber(dead, { language: null });
    b.add({ blob: blob("x"), mime: "audio/webm", seconds: 2 });
    expect(await b.finish()).toEqual({ ok: false, error: "hub down" });
  });

  test("finish with no pieces gives empty text", async () => {
    expect(await new ChunkTranscriber(async () => ({ ok: true, text: "" }), { language: null }).finish()).toEqual({ ok: true, text: "" });
  });
});

describe("mergeOverlap and wav", () => {
  test("mergeOverlap ignores case and punctuation and keeps unrelated text", () => {
    expect(mergeOverlap("see you on Friday, morning.", "friday morning works for me")).toBe("works for me");
    expect(mergeOverlap("hello there", "something else")).toBe("something else");
  });

  test("halves overlap so no audio is lost at the cut, and a wav header is valid", async () => {
    const samples = new Int16Array(16_000 * 10).map((_, i) => i % 100);
    const [l, r] = halvesOf(samples, 16_000) as [Int16Array, Int16Array];
    expect(l.length + r.length).toBe(samples.length + 2 * 9_600);
    expect(halvesOf(new Int16Array(16_000), 16_000)).toBeNull();
    const wav = encodeWav(l);
    expect(wav.size).toBe(44 + l.length * 2);
    expect(new TextDecoder().decode((await wav.arrayBuffer()).slice(0, 4))).toBe("RIFF");
  });
});

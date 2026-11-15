import { describe, expect, test } from "bun:test";

import { ACTIVITY_MAX_BYTES, OwnerActivityReader, reduceActivity } from "./owner-activity";

const msg = (id: string, parts: unknown[], role = "assistant") => ({ id, role, time: { created: 1_700_000_000 }, content: parts });
const raw = (...m: unknown[]) => JSON.stringify({ data: m });

describe("reduceActivity", () => {
  test("text, tool and reasoning are reduced and truncated, oldest first", () => {
    const body = reduceActivity(
      raw(
        msg("m2", [{ type: "text", text: "x".repeat(900) }, { type: "tool", tool: "bash", input: { command: "y".repeat(500) } }, { type: "reasoning", text: "z".repeat(500) }, { type: "text", text: "4th" }]),
        msg("m1", [{ type: "text", text: "hi" }], "user"),
      ),
      null,
    );
    expect(body.messages.map((m) => m.id)).toEqual(["m1", "m2"]);
    const parts = body.messages[1]!.parts;
    expect(parts.length).toBe(3);
    expect(parts[0]!.text.length).toBe(400);
    expect(parts[1]).toMatchObject({ kind: "tool", tool: "bash" });
    expect(parts[1]!.text.length).toBe(120);
    expect(parts[2]!.text.length).toBe(160);
    expect(body.next).toBe("m2");
  });
  test("after cursor returns only newer messages", () => {
    const body = reduceActivity(raw(msg("m3", []), msg("m2", []), msg("m1", [])), "m2");
    expect(body.messages.map((m) => m.id)).toEqual(["m3"]);
  });
  test("total stays under 8 KB", () => {
    const many = Array.from({ length: 20 }, (_, i) => msg(`m${i}`, [{ type: "text", text: "a".repeat(400) }, { type: "text", text: "b".repeat(400) }, { type: "text", text: "c".repeat(400) }]));
    const body = reduceActivity(raw(...many), null);
    expect(JSON.stringify(body.messages).length).toBeLessThanOrEqual(ACTIVITY_MAX_BYTES);
    expect(body.messages.length).toBeGreaterThan(0);
  });
  test("garbage is unknown", () => {
    expect(reduceActivity("nope", null).state).toBe("unknown");
  });
});

describe("OwnerActivityReader", () => {
  test("exit codes map to none / gone / unknown, and answers are cached 5 s", async () => {
    let calls = 0;
    let code = 4;
    let t = 0;
    const r = new OwnerActivityReader(async () => { calls += 1; return { code, stdout: raw(msg("m1", [])) }; }, () => t);
    expect((await r.read("run1", "n1", null)).kind).toBe("none");
    expect((await r.read("run1", "n1", null)).kind).toBe("none");
    expect(calls).toBe(1);
    t = 6000; code = 3;
    expect(await r.read("run1", "n1", null)).toMatchObject({ kind: "ok", body: { state: "gone" } });
    t = 12000; code = 1;
    expect(await r.read("run1", "n1", null)).toMatchObject({ body: { state: "unknown" } });
    t = 18000; code = 0;
    expect(await r.read("run1", "n1", null)).toMatchObject({ body: { state: "ok" } });
  });
  test("calls never overlap and bad ids are none", async () => {
    let active = 0; let max = 0;
    const r = new OwnerActivityReader(async () => { active += 1; max = Math.max(max, active); await new Promise((x) => setTimeout(x, 20)); active -= 1; return { code: 0, stdout: raw() }; });
    await Promise.all([r.read("r1", "a", null), r.read("r1", "b", null), r.read("r1", "c", null)]);
    expect(max).toBe(1);
    expect((await r.read("../x", "a", null)).kind).toBe("none");
  });
});

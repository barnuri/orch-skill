import { describe, expect, test } from "bun:test";
import type { RunNode } from "../../shared/types/run-node";
import { nodeWarnings } from "./node-warnings";

const node = (over: Partial<RunNode>): RunNode =>
  ({ id: "n", label: "n", status: "pending", profile: null, adapter: null, job_id: null, started: null, finished: null, error: null, log_tail: [], ...over }) as RunNode;
const codes = (n: RunNode) => nodeWarnings(n).map((w) => w.code);

describe("nodeWarnings", () => {
  test("healthy node has none", () => {
    expect(codes(node({ status: "done", handoff_present: true, result: { verdict: "full", summary: "", follow_up: "none", at: "" } } as Partial<RunNode>))).toEqual([]);
  });
  test("running without owner or job is unowned", () => {
    expect(codes(node({ status: "running" }))).toEqual(["unowned"]);
  });
  test("stale running node is stalled", () => {
    expect(codes(node({ status: "running", owner: "ses_1", stale: true } as Partial<RunNode>))).toEqual(["stalled"]);
  });
  test("done unverified, no handoff and unknown verdict", () => {
    expect(codes(node({ status: "done", unverified: true, handoff_present: false }))).toEqual(["unverified", "no-handoff", "result"]);
  });
  test("partial is amber, blocked is error tone", () => {
    const r = (verdict: string) => ({ verdict, summary: "s", follow_up: "none", at: "" }) as never;
    expect(nodeWarnings(node({ status: "done", handoff_present: true, result: r("partial") }))[0]?.tone).toBe("warn");
    expect(nodeWarnings(node({ status: "done", handoff_present: true, result: r("blocked") }))[0]?.tone).toBe("error");
  });
  test("needs-user, held and error carry their text", () => {
    const w = nodeWarnings(node({ status: "error", error: "boom", needs_user: "pick", hold: "wait" }));
    expect(w.map((x) => x.text)).toEqual(["Needs user: pick", "Held: wait", "Error: boom"]);
  });
});

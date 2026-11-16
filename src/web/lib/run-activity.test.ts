import { describe, expect, test } from "bun:test";
import type { RunEvent } from "../../shared/types/run-event";
import type { RunNode } from "../../shared/types/run-node";
import type { RunState } from "../../shared/types/run-state";
import { AFTER_THE_FACT, lastActivity, nodeFlags, ownerText } from "./node-flags";
import { describeEvent, feedRows, mergeEvents, runUpdatedAt, staleSummary } from "./run-activity";

const NOW = Date.parse("2026-01-01T12:00:00Z");
const ago = (min: number): string => new Date(NOW - min * 60_000).toISOString();
const node = (o: Partial<RunNode>): RunNode => ({ id: "a", label: "A", status: "running", profile: null, adapter: null, job_id: null, started: ago(30), finished: null, error: null, log_tail: [], ...o });
const run = (nodes: RunNode[]): RunState => ({ run_id: "r", title: "", harness_session: "", started: ago(60), finished: null, status: "running", nodes, edges: [] });
const ev = (n: number, o: Partial<RunEvent> = {}): RunEvent => ({ n, at: ago(n), kind: "note", node: "a", from: null, to: null, note: "x", by: null, ...o });

describe("node flags", () => {
  test("unowned needs no owner and no job", () => {
    expect(nodeFlags(node({})).unowned).toBe(true);
    expect(nodeFlags(node({ owner: "coordinator" })).unowned).toBe(false);
    expect(nodeFlags(node({ job_id: "job-1" })).unowned).toBe(false);
  });
  test("stale only while running; after the fact only when backfilled and not running", () => {
    expect(nodeFlags(node({ stale: true })).stale).toBe(true);
    expect(nodeFlags(node({ stale: true, status: "done" })).stale).toBe(false);
    expect(nodeFlags(node({ status: "done", backfilled: true })).afterTheFact).toBe(true);
    expect(AFTER_THE_FACT).toBe("recorded after the fact");
  });
  test("owner text and last activity", () => {
    expect(ownerText(node({}))).toBeNull();
    expect(ownerText(node({ owner: "ses_1" }))).toBe("agent ses_1");
    expect(ownerText(node({ owner: "job-9" }))).toBe("job job-9");
    expect(lastActivity(node({ updated: "u", last_activity: "l" }))).toBe("l");
    expect(lastActivity(node({ status: "done" }))).toBeNull();
  });
});

describe("run activity", () => {
  test("stale summary names the quietest-minimum and the nodes", () => {
    expect(staleSummary(run([node({})]), NOW)).toBeNull();
    const s = staleSummary(run([node({ stale: true, last_activity: ago(12) }), node({ id: "b", label: "B", stale: true, last_activity: ago(20) })]), NOW);
    expect(s?.headline).toBe("2 nodes are running but nothing has changed for 12 min. ");
    expect(s?.detail).toContain("A, B");
    expect(staleSummary(run([node({ stale: true, last_activity: ago(3) })]), NOW)?.headline).toStartWith("1 node is");
  });
  test("run updated is the newest stamp", () => {
    expect(runUpdatedAt(run([node({ updated: ago(2) })]), [ev(1, { at: ago(1) })])).toBe(ago(1));
    expect(runUpdatedAt(run([]), [])).toBe(ago(60));
  });
  test("merge appends only newer events and caps at 200", () => {
    const held = [ev(1), ev(2)];
    expect(mergeEvents(held, [ev(2)])).toBe(held);
    expect(mergeEvents(held, [ev(2), ev(3)]).map((e) => e.n)).toEqual([1, 2, 3]);
    const many = Array.from({ length: 250 }, (_, i) => ev(i + 1));
    expect(mergeEvents([], many)).toHaveLength(200);
  });
  test("feed is newest first and capped at 50", () => {
    const many = Array.from({ length: 80 }, (_, i) => ev(i + 1));
    const rows = feedRows(many);
    expect(rows).toHaveLength(50);
    expect(rows[0]?.n).toBe(80);
  });
  test("describe event", () => {
    expect(describeEvent(ev(1, { kind: "status", from: "waiting", to: "running", note: null }))).toBe("waiting → running");
    expect(describeEvent(ev(1, { kind: "ping", note: "3/10" }))).toBe("progress 3/10");
    expect(describeEvent(ev(1, { kind: "retry" }))).toBe("reset for retry");
    expect(describeEvent(ev(1, { kind: "resumed", note: "early end, resumed session ses_a, 1 of 2" }))).toBe("resumed: early end, resumed session ses_a, 1 of 2");
  });
});

import { describe, expect, test } from "bun:test";

import type { RunNode } from "../../../shared/types/run-node";
import type { RunState } from "../../../shared/types/run-state";
import { focusTarget } from "./focus-target";

function node(id: string, status: RunNode["status"], extra: Partial<RunNode> = {}): RunNode {
  return { id, label: id, status, started: null, finished: null, ...extra } as RunNode;
}

function run(nodes: RunNode[], edges: [string, string][] = []): RunState {
  return { run_id: "r", status: "running", nodes, edges } as unknown as RunState;
}

describe("focusTarget", () => {
  test("a running node wins over everything else", () => {
    const state = run([node("a", "done"), node("b", "running"), node("c", "error"), node("d", "waiting")], [["a", "b"], ["a", "d"]]);
    expect(focusTarget(state)).toMatchObject({ primary: "b", reason: "running" });
  });

  test("with several running, the one that started last is primary and all are listed", () => {
    const state = run([
      node("a", "running", { started: "2026-11-15T10:00:00Z" }),
      node("b", "running", { started: "2026-11-15T10:05:00Z" }),
    ]);
    const target = focusTarget(state);
    expect(target?.primary).toBe("b");
    expect(target?.nodeIds).toEqual(["a", "b"]);
  });

  test("with nothing running, a failed node needs attention before the next ready one", () => {
    const state = run([node("a", "error"), node("b", "waiting")]);
    expect(focusTarget(state)).toMatchObject({ primary: "a", reason: "failed" });
  });

  test("with several failed, the one that failed last is primary", () => {
    const state = run([
      node("a", "error", { finished: "2026-11-15T10:00:00Z" }),
      node("b", "error", { finished: "2026-11-15T10:09:00Z" }),
    ]);
    expect(focusTarget(state)?.primary).toBe("b");
  });

  test("with nothing running or failed, the first node whose dependencies are all done is next", () => {
    const state = run(
      [node("a", "done"), node("b", "waiting"), node("c", "waiting")],
      [["a", "b"], ["b", "c"]],
    );
    expect(focusTarget(state)).toMatchObject({ primary: "b", reason: "next", nodeIds: ["b"] });
  });

  test("a waiting node whose dependency is not done is not ready", () => {
    const state = run([node("a", "waiting"), node("b", "waiting")], [["a", "b"]]);
    expect(focusTarget(state)).toMatchObject({ primary: "a", nodeIds: ["a"] });
  });

  test("a skipped dependency counts as settled", () => {
    const state = run([node("a", "skipped"), node("b", "waiting")], [["a", "b"]]);
    expect(focusTarget(state)?.primary).toBe("b");
  });

  test("a settled run has nothing to follow", () => {
    expect(focusTarget(run([node("a", "done"), node("b", "skipped")], [["a", "b"]]))).toBeNull();
    expect(focusTarget(run([]))).toBeNull();
  });
});

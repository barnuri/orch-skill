import { afterAll, describe, expect, test } from "bun:test";
import { Window } from "happy-dom";

import type { RunNode } from "../../../shared/types/run-node";
import type { RunState } from "../../../shared/types/run-state";

const win = new Window({ url: "http://localhost/" });
const g = globalThis as unknown as Record<string, unknown>;
const saved = { document: g.document, window: g.window };
g.document = win.document;
g.window = win;
afterAll(() => {
  g.document = saved.document;
  g.window = saved.window;
});
const { renderNodePanel } = await import("./node-panel");

function node(over: Partial<RunNode> = {}): RunNode {
  return { id: "n1", label: "first", status: "waiting", profile: null, adapter: null, job_id: null, started: null, finished: null, error: null, log_tail: [], ...over };
}

function why(nodes: RunNode[], edges: [string, string][] = []): { text: string; title: string | null } | null {
  const panel = renderNodePanel({ run_id: "r1", status: "running", harness_session: "", nodes, edges } as unknown as RunState, "n1");
  const dt = Array.from(panel.querySelectorAll("dt")).find((d) => d.textContent === "why");
  const dd = dt?.nextElementSibling ?? null;
  return dd === null ? null : { text: dd.textContent ?? "", title: dd.getAttribute("title") };
}

describe("snapshot node panel wait reason", () => {
  test("says why a waiting node waits, in the card's priority", () => {
    const all = node({ needs_user: "pick a name", hold: "until load < 4" });
    expect(why([all, node({ id: "a", status: "running" }), node({ id: "b" })], [["a", "n1"], ["b", "n1"]])).toEqual({ text: "waiting on a +1", title: "Waiting on: a, b" });
    expect(why([all])?.text).toBe("needs you: pick a name");
    expect(why([node({ hold: "until load < 4" })])).toEqual({ text: "held: until load < 4", title: "Held by the coordinator: until load < 4" });
    expect(why([node()])?.text).toBe("ready, not started");
    expect(why([node({ status: "running", hold: "x" })])).toBeNull();
  });
});

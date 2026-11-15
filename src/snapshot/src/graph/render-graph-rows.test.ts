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
const { renderGraph } = await import("./render-graph");

function node(over: Partial<RunNode> = {}): RunNode {
  return { id: "n1", label: "first", status: "waiting", profile: null, adapter: null, job_id: null, started: null, finished: null, error: null, log_tail: [], ...over };
}

function graph(nodes: RunNode[]): SVGSVGElement {
  return renderGraph({ id: "r1", status: "running", harness_session: "", nodes, edges: [] } as unknown as RunState, null, () => {});
}

describe("snapshot node card rows", () => {
  test("role, tier, usage and cost always show, as muted placeholders when missing", () => {
    const svg = graph([node()]);
    expect(svg.querySelector(".metric.role")?.textContent).toContain("role — · tier —");
    expect(svg.querySelector(".metric.role")?.getAttribute("class")).toContain("missing");
    expect(svg.querySelector(".metric.cost")?.textContent).toContain("usage — · cost —");
    expect(graph([node({ role: "planning", tier: "balance" } as Partial<RunNode>)]).querySelector(".metric.role")?.textContent).toContain("planning · balance");
  });

  test("a needs_user node carries its own needs-you chip with the reason as tooltip", () => {
    const svg = graph([node({ needs_user: "check on your phone" })]);
    const chip = svg.querySelector(".needs-you-chip");
    expect(chip?.textContent).toContain("needs you");
    expect(chip?.querySelector("title")?.textContent).toBe("needs you: check on your phone");
    expect(graph([node()]).querySelector(".needs-you-chip")).toBeNull();
  });
});

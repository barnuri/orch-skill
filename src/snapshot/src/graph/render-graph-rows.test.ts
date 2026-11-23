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

function graph(nodes: RunNode[], edges: [string, string][] = []): SVGSVGElement {
  return renderGraph({ id: "r1", status: "running", harness_session: "", nodes, edges } as unknown as RunState, null, () => {});
}

describe("snapshot node card rows", () => {
  test("a waiting card says why: deps, then the user, then a hold, else ready", () => {
    const st = (svg: SVGSVGElement, id = "n1"): { text: string; title: string } => {
      const card = Array.from(svg.querySelectorAll(".task-node")).find((g) => g.getAttribute("aria-label")?.startsWith(id === "n1" ? "first" : id));
      const el = card?.querySelector(".st");
      return { text: el?.firstChild?.textContent ?? "", title: el?.querySelector("title")?.textContent ?? "" };
    };
    const all = node({ needs_user: "pick a name", hold: "until load < 4" });
    const deps = ["a", "b", "c"].map((id) => node({ id, label: id, status: id === "c" ? "running" : "waiting" }));
    expect(st(graph([all, ...deps], [["a", "n1"], ["b", "n1"], ["c", "n1"]]))).toEqual({ text: "waiting on a +2", title: "Waiting on: a, b, c" });
    expect(st(graph([all, node({ id: "a", label: "a", status: "done" })], [["a", "n1"]]))).toEqual({ text: "needs you: pick a name", title: "Needs you: pick a name" });
    expect(st(graph([node({ hold: "until load < 4" })]))).toEqual({ text: "held: until load < 4", title: "Held by the orchestrator: until load < 4" });
    expect(st(graph([node()])).text).toBe("ready, not started");
    expect(st(graph([node({ hold: "a very long reason that does not fit the card row" })])).text.endsWith("…")).toBe(true);
    expect(st(graph([node({ status: "running", hold: "x" })])).text).toBe("running · attempt 1/5");
  });

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

  test("the card's model row reads alias → actual when the served model differs", () => {
    const svg = graph([node({ model: "hub/smart-auto-balance", actual_model: "copilot/claude-opus-5-5" } as Partial<RunNode>)]);
    expect(svg.querySelector(".model")?.textContent).toContain("smart-a… → claude-opus-5-5");
    expect(graph([node({ model: "sonnet", actual_model: "sonnet" } as Partial<RunNode>)]).querySelector(".model")?.textContent).toContain("sonnet");
  });
});

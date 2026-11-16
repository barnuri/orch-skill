import { afterAll, afterEach, describe, expect, test } from "bun:test";
import type { RunNode } from "../../shared/types/run-node";
import { installDom } from "../test/dom";

const uninstall = installDom();
const { render, cleanup } = await import("@testing-library/react");
const { QueryClient, QueryClientProvider } = await import("@tanstack/react-query");
const { NodeCard } = await import("./GraphSvg");
const { profilePalette } = await import("../lib/profile-color");

afterEach(cleanup);
afterAll(uninstall);

function node(over: Partial<RunNode> = {}): RunNode {
  return { id: "n1", label: "first", status: "waiting", profile: null, adapter: null, job_id: null, started: null, finished: null, error: null, log_tail: [], ...over };
}

function card(n: RunNode, waitingOn: string[] = []) {
  const client = new QueryClient();
  return render(
    <QueryClientProvider client={client}>
      <svg>
        <NodeCard node={n} pos={{ x: 0, y: 0 }} selected={false} isCyclic={false} onSelect={() => {}} palette={profilePalette([])} harnessByProfile={{}} maxAttempts={5} runId="r1" waitingOn={waitingOn} />
      </svg>
    </QueryClientProvider>,
  );
}

describe("NodeCard rows", () => {
  test("model, duration, usage and cost, role and tier always show, as muted placeholders when missing", () => {
    const { container } = card(node());
    expect(container.querySelector(".model")?.textContent).toContain("model not reported");
    expect(container.querySelector(".metric.dur")?.textContent).toContain("not started");
    const cost = container.querySelector(".metric.cost");
    expect(cost?.textContent).toContain("usage — · cost —");
    expect(cost?.getAttribute("class")).toContain("missing");
    const role = container.querySelector(".metric.role");
    expect(role).toBeNull();
    expect(card(node({ model: "hub/smart-auto-balance" } as Partial<RunNode>)).container.querySelector(".metric.role")?.textContent).toContain("role — · tier —");
    expect(container.querySelector(".st")?.textContent).toContain("ready, not started");
    cleanup();
    expect(card(node({ status: "running" })).container.querySelector(".st")?.textContent).toContain("attempt 1/5");
  });

  test("a waiting card says why: deps, then the user, then a hold, else ready", () => {
    const st = (n: RunNode, deps: string[] = []): { text: string; title: string } => {
      const el = card(n, deps).container.querySelector(".st");
      const out = { text: el?.firstChild?.textContent ?? "", title: el?.querySelector("title")?.textContent ?? "" };
      cleanup();
      return out;
    };
    const all = node({ needs_user: "pick a name", hold: "until load < 4" });
    expect(st(all, ["a", "b", "c"])).toEqual({ text: "waiting on a +2", title: "Waiting on: a, b, c" });
    expect(st(all)).toEqual({ text: "needs you: pick a name", title: "Needs you: pick a name" });
    expect(st(node({ hold: "until load < 4" }))).toEqual({ text: "held: until load < 4", title: "Held by the coordinator: until load < 4" });
    expect(st(node({ hold: "  " })).text).toBe("ready, not started");
    expect(st(node({ hold: "a very long reason that does not fit the card row" })).text).toBe("held: a very long reason …");
    expect(st(node({ status: "done", hold: "x" })).text).toBe("done · attempt 1/5");
  });

  test("a set role shows beside the tier placeholder on a smart-auto node only", () => {
    const { container } = card(node({ model: "hub/smart-auto-balance", role: "planning" } as Partial<RunNode>));
    const role = container.querySelector(".metric.role");
    expect(role?.textContent).toContain("planning · tier —");
    expect(role?.getAttribute("class")).not.toContain("missing");
    cleanup();
    expect(card(node({ role: "planning" } as Partial<RunNode>)).container.querySelector(".metric.role")).toBeNull();
  });

  test("the model icon follows the served model on auto nodes and the configured model otherwise", () => {
    const auto = card(node({ model: "hub/smart-auto-balance", actual_model: "copilot/claude-opus-5-5" } as Partial<RunNode>));
    expect(auto.container.querySelector(".model-icon")?.getAttribute("data-family")).toBe("claude");
    cleanup();
    const plain = card(node({ model: "qwen3-coder" } as Partial<RunNode>));
    expect(plain.container.querySelector(".model-icon")?.getAttribute("data-family")).toBe("qwen");
    cleanup();
    expect(card(node({ model: "hub/smart-auto-balance" } as Partial<RunNode>)).container.querySelector(".model-icon")?.getAttribute("data-family")).toBe("fallback");
  });

  test("a needs_user node carries its own needs-you chip, the reason in its tooltip", () => {
    const { container } = card(node({ needs_user: "real iPhone keyboard check" }));
    const chip = container.querySelector(".needs-you-chip");
    expect(chip?.textContent).toContain("needs you");
    expect(chip?.querySelector("title")?.textContent).toBe("needs you: real iPhone keyboard check");
    expect(container.querySelector(".task-node")?.getAttribute("aria-label")).toContain("needs you");
    cleanup();
    expect(card(node()).container.querySelector(".needs-you-chip")).toBeNull();
  });

  test("the model row reads alias → actual when the served model differs", () => {
    const { container } = card(node({ model: "hub/smart-auto-balance", actual_model: "copilot/claude-opus-5-5" } as Partial<RunNode>));
    expect(container.querySelector(".model")?.textContent).toContain("→ claude-opus-");
  });
});

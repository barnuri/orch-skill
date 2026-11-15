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

function card(n: RunNode) {
  const client = new QueryClient();
  return render(
    <QueryClientProvider client={client}>
      <svg>
        <NodeCard node={n} pos={{ x: 0, y: 0 }} selected={false} isCyclic={false} onSelect={() => {}} palette={profilePalette([])} harnessByProfile={{}} maxAttempts={5} runId="r1" />
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
    expect(role?.textContent).toContain("role — · tier —");
    expect(role?.getAttribute("class")).toContain("missing");
    expect(container.querySelector(".st")?.textContent).toContain("attempt 1/5");
  });

  test("a set role shows beside the tier placeholder", () => {
    const { container } = card(node({ role: "planning" } as Partial<RunNode>));
    const role = container.querySelector(".metric.role");
    expect(role?.textContent).toContain("planning · tier —");
    expect(role?.getAttribute("class")).not.toContain("missing");
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
});

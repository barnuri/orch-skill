import { afterAll, afterEach, describe, expect, test } from "bun:test";
import type { HealthSummary, NodeHealth, RunHealth } from "../../shared/types/run-health";
import { installDom } from "../test/dom";

const uninstall = installDom();
const { render, screen, cleanup, fireEvent } = await import("@testing-library/react");
const { HealthBadge, HealthPill, NodeHealthStrip, ReadyNotice, RunHealthSummary, hhmm } = await import("./RunHealth");

afterEach(cleanup);
afterAll(uninstall);

const LAST = "2026-11-15T09:40:00Z";

function node(over: Partial<NodeHealth>): NodeHealth {
  return { id: "a", status: "running", health: "ok", owner_id: "ses_1", last_activity: LAST, idle_min: 20, note: null, ...over };
}

function health(over: Partial<RunHealth> = {}): RunHealth {
  return { run: "r1", at: LAST, max_parallel: 3, running: 1, slots: 2, nodes: [], ready: [], changes: [], ...over };
}

describe("HealthBadge", () => {
  test("stalled is amber and says since when", () => {
    const { container } = render(<HealthBadge node={node({ health: "stalled" })} />);
    const badge = container.querySelector(".chip");
    expect(badge?.className).toContain("health-stalled");
    expect(badge?.textContent).toBe(`stalled · no activity since ${hhmm(LAST)}`);
  });

  test("dead is the only red one; unowned grey; no-report amber; ok has no badge", () => {
    const cls = (h: NodeHealth["health"]): string => {
      const { container } = render(<HealthBadge node={node({ id: h, health: h })} />);
      const out = container.querySelector(".chip")?.className ?? "";
      cleanup();
      return out;
    };
    expect(cls("dead")).toContain("health-dead");
    expect(cls("unowned")).toContain("health-unowned");
    expect(cls("no-report")).toContain("health-no-report");
    expect(cls("ok")).toBe("");
  });

  test("the strip lists only flagged nodes and selects one on click", () => {
    const picked: string[] = [];
    render(<NodeHealthStrip health={health({ nodes: [node({ id: "a", health: "dead" }), node({ id: "b" }), node({ id: "c", health: "unowned" })] })} onSelect={(id) => picked.push(id)} />);
    const items = screen.getAllByRole("listitem");
    expect(items.map((i) => i.textContent)).toEqual(["adead", "cunowned"]);
    fireEvent.click(items[1] as HTMLElement);
    expect(picked).toEqual(["c"]);
  });
});

describe("ReadyNotice", () => {
  test("names the ready nodes when a slot is free", () => {
    render(<ReadyNotice health={health({ ready: ["a", "b"] })} />);
    expect(screen.getByRole("status").textContent).toBe("2 nodes ready to start: a, b");
  });

  test("hidden with no free slot or nothing ready", () => {
    const { container } = render(
      <>
        <ReadyNotice health={health({ ready: ["a"], slots: 0 })} />
        <ReadyNotice health={health({ ready: [] })} />
        <ReadyNotice health={null} />
      </>,
    );
    expect(container.textContent).toBe("");
  });
});

describe("runs list and header", () => {
  test("RunHealthSummary counts each state", () => {
    const { container } = render(<RunHealthSummary health={health({ nodes: [node({ health: "stalled" }), node({ id: "b", health: "stalled" }), node({ id: "c", health: "dead" })], ready: ["d"] })} />);
    expect([...container.querySelectorAll(".chip")].map((c) => c.textContent)).toEqual(["1 dead", "2 stalled", "1 ready"]);
  });

  test("a needs-user node gets its own chip, after the attention states", () => {
    const { container } = render(<RunHealthSummary health={health({ nodes: [node({ health: "needs-user", note: "needs the user: pick a name" }), node({ id: "c", health: "dead" })] })} />);
    expect([...container.querySelectorAll(".chip")].map((c) => c.textContent)).toEqual(["1 dead", "1 needs you"]);
  });

  test("HealthPill shows the summary's flagged count and goes red only for dead", () => {
    const summary = (over: Partial<HealthSummary>): HealthSummary => ({ generated_at: LAST, running_runs: 2, stalled: 0, dead: 0, unowned: 0, no_report: 0, needs_user: 0, ready: 0, flagged_runs: [], ...over });
    const { container, rerender } = render(<HealthPill summary={summary({ stalled: 1, flagged_runs: ["r1"] })} />);
    const pill = container.querySelector("#health-pill");
    expect(pill?.textContent).toBe("1 node needs attention");
    expect(pill?.className).toContain("is-lost");
    expect(pill?.getAttribute("href")).toBe("#/run/r1");
    rerender(<HealthPill summary={summary({ stalled: 1, dead: 1, flagged_runs: ["r1", "r2"] })} />);
    expect(container.querySelector("#health-pill")?.className).toContain("needs-attention");
    expect(container.querySelector("#health-pill")?.getAttribute("href")).toBe("#/");
    rerender(<HealthPill summary={summary({ ready: 3 })} />);
    expect(container.querySelector("#health-pill")).toBeNull();
    rerender(<HealthPill summary={null} />);
    expect(container.querySelector("#health-pill")).toBeNull();
  });
});

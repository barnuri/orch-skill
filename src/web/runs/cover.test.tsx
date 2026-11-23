import { afterAll, afterEach, describe, expect, test } from "bun:test";
import { installDom } from "../test/dom";
import type { RunState } from "../../shared/types/run-state";
import type { RunSummary } from "../../shared/types/run-summary";
import { DEFAULT_RUN_FILTERS, parseRunFilters } from "../lib/run-filters";
import { RUN_STATUSES } from "../../shared/types/run-status";

const counts = { waiting: 1, running: 0, done: 1, error: 0, skipped: 0, covered: 0, stopped: 0 };
const sum = (over: Partial<RunSummary>): RunSummary => ({ run_id: "old", title: "Old run", status: "covered", started: "2026-11-15T10:00:00Z", finished: "2026-11-16T10:00:00Z", harness_session: "", counts, ...over });
const newer = sum({ run_id: "new", title: "New run", status: "running", finished: null });

const uninstall = installDom();
const { render, screen, cleanup } = await import("@testing-library/react");
const { RunRow } = await import("./RunsPage");
const { CoveredByLink, CoversBlock } = await import("./RunCover");
afterEach(cleanup);
afterAll(uninstall);

describe("covered runs", () => {
  test("status vocabulary and filter accept covered", () => {
    expect(RUN_STATUSES).toContain("covered");
    expect(parseRunFilters(JSON.stringify({ age: "all", status: "covered" })).status).toBe("covered");
    expect(DEFAULT_RUN_FILTERS.status).toBe("all");
  });

  test("runs list row shows a Covered chip and a link to the new run", () => {
    const titles = new Map([["new", "New run"]]);
    const { container } = render(<RunRow run={sum({ covered_by: "new" })} titles={titles} />);
    const chip = screen.getByText("Covered");
    expect(chip.className).toContain("covered");
    expect(chip.className).not.toContain("error");
    expect(container.querySelector(".covered-link")?.getAttribute("data-href")).toBe("#/run/new");
    expect(screen.getByText("→ run New run")).toBeTruthy();
  });

  test("run page header link points at the new run", () => {
    const run = { ...sum({}), nodes: [], edges: [], covered_by: "new" } as unknown as RunState;
    render(<CoveredByLink run={run} runs={[newer]} />);
    const a = screen.getByText("→ run New run");
    expect(a.getAttribute("href")).toBe("#/run/new");
  });

  test("the new run lists what it covers, with carried nodes and map", () => {
    const old = sum({ covered_by: "new", covered_nodes: ["b", "c"], covered_map: { b: "gap-b" }, covered_note: "gaps carried" });
    render(<CoversBlock runId="new" runs={[old, newer]} />);
    expect(screen.getByText("Covers")).toBeTruthy();
    expect(screen.getByText("← run Old run").getAttribute("href")).toBe("#/run/old");
    expect(screen.getByText("carried 2: b, c")).toBeTruthy();
    expect(screen.getByText("map: b → gap-b")).toBeTruthy();
  });

  test("no Covers block when nothing was covered", () => {
    const { container } = render(<CoversBlock runId="new" runs={[newer]} />);
    expect(container.innerHTML).toBe("");
  });
});

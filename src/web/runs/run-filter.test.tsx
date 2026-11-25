import { afterAll, afterEach, describe, expect, test } from "bun:test";
import type { RunNode } from "../../shared/types/run-node";
import type { RunState } from "../../shared/types/run-state";
import { installDom } from "../test/dom";

const uninstall = installDom();
const { render, screen, cleanup, fireEvent } = await import("@testing-library/react");
const { EMPTY_FILTER, filterOptions, hashWithFilter, matchesFilter, nodeBucket, parseFilter, runSummary } = await import("./run-filter");
const { LiveIndicator, NodeFilterBar, RunSummaryBar } = await import("./RunToolbar");
const { liveStateOf, runPollMs, OFFLINE_POLL_MS, LIVE_SAFETY_POLL_MS } = await import("./queries");
const { parseRoute, routeKey } = await import("../router/route");
const { POLL_MS } = await import("../lib/constants");

afterEach(cleanup);
afterAll(uninstall);

function node(over: Partial<RunNode>): RunNode {
  return { id: "a", label: "A", status: "waiting", profile: null, adapter: null, job_id: null, started: null, finished: null, error: null, log_tail: [], ...over };
}

function run(nodes: RunNode[], over: Partial<RunState> = {}): RunState {
  return { run_id: "r1", title: "", harness_session: "", started: "2026-11-16T08:00:00Z", finished: null, status: "running", nodes, edges: [], ...over };
}

const NODES = [
  node({ id: "build-api", label: "Build the API", status: "done", profile: "cheap", adapter: "opencode", actual_model: "gpt-x" }),
  node({ id: "ui", label: "Run page UI", status: "running", profile: "hub", model: "smart" }),
  node({ id: "docs", label: "Docs", status: "waiting", hold: "after ui" }),
  node({ id: "tests", label: "Tests", status: "waiting" }),
  node({ id: "lint", label: "Lint", status: "error", profile: "cheap" }),
];

describe("run summary", () => {
  test("counts total, done, running, waiting, paused, blocked-user and error", () => {
    expect(runSummary(run(NODES))).toEqual({ total: 5, done: 1, running: 1, waiting: 1, paused: 1, "blocked-user": 0, error: 1, skipped: 0, covered: 0, stopped: 0 });
  });

  test("a paused run counts its running and waiting nodes as paused", () => {
    const paused = run(NODES, { paused: true });
    expect(nodeBucket(paused, NODES[1] as RunNode)).toBe("paused");
    expect(runSummary(paused)).toMatchObject({ running: 0, waiting: 0, paused: 3 });
  });

  test("the bar renders each count and a click picks that status", () => {
    const picked: string[] = [];
    render(<RunSummaryBar summary={runSummary(run(NODES))} active="" onPick={(b) => picked.push(b)} />);
    expect(screen.getByText("total").parentElement?.textContent).toBe("total5");
    expect(screen.queryByText("skipped")).toBeNull();
    fireEvent.click(screen.getByTitle("Show only error nodes"));
    expect(picked).toEqual(["error"]);
  });
});

describe("node filter", () => {
  const r = run(NODES);
  const ids = (filter: typeof EMPTY_FILTER): string[] => NODES.filter((n) => matchesFilter(r, n, filter, { hub: "claude" })).map((n) => n.id);

  test("filters by status, profile or harness, model and free text", () => {
    expect(ids({ ...EMPTY_FILTER, status: "paused" })).toEqual(["docs"]);
    expect(ids({ ...EMPTY_FILTER, profile: "cheap" })).toEqual(["build-api", "lint"]);
    expect(ids({ ...EMPTY_FILTER, profile: "claude" })).toEqual(["ui"]);
    expect(ids({ ...EMPTY_FILTER, model: "gpt-x" })).toEqual(["build-api"]);
    expect(ids({ ...EMPTY_FILTER, q: "API" })).toEqual(["build-api"]);
    expect(ids({ ...EMPTY_FILTER, q: "ui" })).toEqual(["build-api", "ui"]);
  });

  test("offers the run's profiles, harnesses and models", () => {
    expect(filterOptions(r, { hub: "claude" })).toEqual({ profiles: ["cheap", "claude", "hub", "opencode"], models: ["gpt-x", "smart"] });
  });

  test("round-trips through the run hash and leaves the route id alone", () => {
    const hash = hashWithFilter("#/run/r1", { status: "error", profile: "", model: "", q: "build api", verdict: "" });
    expect(hash).toBe("#/run/r1?status=error&q=build+api");
    expect(parseFilter(hash)).toEqual({ status: "error", profile: "", model: "", q: "build api", verdict: "" });
    expect(parseRoute(hash)).toEqual({ kind: "run", runId: "r1" });
    expect(routeKey(parseRoute(hash))).toBe(routeKey(parseRoute("#/run/r1")));
    expect(hashWithFilter(hash, EMPTY_FILTER)).toBe("#/run/r1");
    expect(parseFilter("#/run/r1?status=bogus").status).toBe("");
  });

  test("the bar reports the shown count and clears", () => {
    const changes: unknown[] = [];
    render(<NodeFilterBar run={r} filter={{ ...EMPTY_FILTER, q: "a" }} harnessByProfile={{}} shown={2} onChange={(f) => changes.push(f)} />);
    expect(screen.getByText("2 of 5 nodes")).toBeTruthy();
    fireEvent.click(screen.getByText("Clear"));
    expect(changes).toEqual([EMPTY_FILTER]);
  });
});

describe("live updates", () => {
  test("polls at the 30 s safety poll while the stream is open and every 5 s once it drops", () => {
    expect(liveStateOf("open")).toBe("live");
    expect(liveStateOf("connecting")).toBe("connecting");
    expect(liveStateOf("reconnecting")).toBe("offline");
    expect(runPollMs("live")).toBe(LIVE_SAFETY_POLL_MS);
    expect(runPollMs("offline")).toBe(OFFLINE_POLL_MS);
    expect(OFFLINE_POLL_MS).toBe(5000);
  });

  test("the indicator shows live or offline", () => {
    const { rerender } = render(<LiveIndicator state="live" />);
    expect(screen.getByRole("status").textContent).toBe("live");
    rerender(<LiveIndicator state="offline" />);
    expect(screen.getByRole("status").className).toContain("is-offline");
  });
});

test("live runs poll only as a 30 s safety net; SSE refreshes are throttled to one per window", async () => {
  const { LIVE_SAFETY_POLL_MS, throttle } = await import("./queries");
  expect(runPollMs("live")).toBe(LIVE_SAFETY_POLL_MS);
  expect(LIVE_SAFETY_POLL_MS).toBe(30_000);
  let calls = 0;
  const t = throttle(() => { calls += 1; }, 40);
  for (let i = 0; i < 10; i += 1) t.call();
  expect(calls).toBe(1);
  await new Promise((r) => setTimeout(r, 80));
  expect(calls).toBe(2);
});

import { afterAll, afterEach, describe, expect, test } from "bun:test";
import type { RunNode } from "../../shared/types/run-node";
import type { RunState } from "../../shared/types/run-state";
import { installDom } from "../test/dom";

const uninstall = installDom();
const { render, screen, cleanup } = await import("@testing-library/react");
const { QueryClient, QueryClientProvider } = await import("@tanstack/react-query");
const { GraphViewport, clearViewStates } = await import("./GraphViewport");
const { GRAPH_SCALE_KEY, GRAPH_MODE_KEY, GRAPH_FOLLOW_KEY } = await import("../lib/constants");

afterEach(() => {
  cleanup();
  clearViewStates();
  localStorage.clear();
});
afterAll(uninstall);

const iso = (msAgo: number): string => new Date(Date.now() - msAgo).toISOString();
const runWithId = (runId: string): RunState => ({
  run_id: runId,
  title: "T",
  harness_session: "",
  started: iso(60_000),
  finished: null,
  status: "running",
  nodes: [
    { id: "a", label: "Node one", status: "running", profile: null, adapter: null, job_id: null, started: iso(1000), finished: null, error: null, log_tail: [] } as RunNode,
    { id: "b", label: "Node two", status: "waiting", profile: null, adapter: null, job_id: null, started: null, finished: null, error: null, log_tail: [] } as RunNode,
  ],
  edges: [["a", "b"]],
});

const withQuery = (child: React.ReactElement) => <QueryClientProvider client={new QueryClient({ defaultOptions: { queries: { retry: false } } })}>{child}</QueryClientProvider>;

const zoomLabel = (): string => document.querySelector(".graph-zoom-label")?.textContent ?? "";

describe("graph view prefs across runs", () => {
  test("two different runs start with the same saved zoom and mode", () => {
    localStorage.setItem(GRAPH_SCALE_KEY, "1.5");
    localStorage.setItem(GRAPH_MODE_KEY, "manual");
    // Follow on would set the scale from the focused node; this test checks the stored zoom only.
    localStorage.setItem(GRAPH_FOLLOW_KEY, "0");

    const first = render(withQuery(<GraphViewport run={runWithId("run-one")} selectedId={null} onSelect={() => undefined} harnessByProfile={{}} maxAttempts={5} />));
    expect(zoomLabel()).toBe("150%");
    first.unmount();

    render(withQuery(<GraphViewport run={runWithId("run-two")} selectedId={null} onSelect={() => undefined} harnessByProfile={{}} maxAttempts={5} />));
    expect(zoomLabel()).toBe("150%");
    expect(screen.getByRole("toolbar", { name: "Graph zoom" })).toBeTruthy();
  });

  test("100% mode starts at exactly 100% even when a scale is stored", () => {
    localStorage.setItem(GRAPH_SCALE_KEY, "2");
    localStorage.setItem(GRAPH_MODE_KEY, "original");
    localStorage.setItem(GRAPH_FOLLOW_KEY, "0");
    render(withQuery(<GraphViewport run={runWithId("run-three")} selectedId={null} onSelect={() => undefined} harnessByProfile={{}} maxAttempts={5} />));
    expect(zoomLabel()).toBe("100%");
  });
});

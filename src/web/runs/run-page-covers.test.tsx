import { afterAll, afterEach, beforeAll, describe, expect, mock, test } from "bun:test";
import { installDom } from "../test/dom";
import type { RunState } from "../../shared/types/run-state";
import type { RunSummary } from "../../shared/types/run-summary";

const uninstall = installDom();

// Real modules load before the mocks, so each override can delegate to the real export.
const realQueries = await import("./queries");
const realApiQueries = await import("../api/queries");
const realGraph = await import("./GraphViewport");

// mock.module is process-wide. The overrides pass through to the real code unless `page.active` is set,
// which only this file does, so other test files keep the real hooks and components.
const page = { active: false };

const counts = { waiting: 0, running: 0, done: 1, error: 0, skipped: 0, "blocked-user": 0, covered: 0, stopped: 0 };
const node = { id: "a", status: "done", profile: "p", goal: "goal a", depends_on: [], attempts: [] };
const current = {
  run_id: "new",
  title: "New run",
  status: "running",
  started: "2026-11-20T10:00:00Z",
  finished: null,
  harness_session: "",
  nodes: [node],
  edges: [],
  counts,
} as unknown as RunState;
const old = { run_id: "old", title: "Old run", status: "covered", started: "2026-11-18T10:00:00Z", finished: "2026-11-19T10:00:00Z", harness_session: "", counts, covered_by: "new", covered_nodes: ["b"], covered_map: { b: "gap-b" }, covered_note: "gaps carried" } as unknown as RunSummary;
const newSummary = { ...current, counts } as unknown as RunSummary;

mock.module("./queries", () => ({
  ...realQueries,
  useRun: (id: string) => (page.active ? { data: { run: current }, isError: false, live: "live" } : realQueries.useRun(id)),
  useRuns: (options?: { poll?: boolean }) => (page.active ? { data: { runs: [old, newSummary] } } : realQueries.useRuns(options)),
  useRunEvents: (...args: Parameters<typeof realQueries.useRunEvents>) => (page.active ? [] : realQueries.useRunEvents(...args)),
  useRunHealth: (...args: Parameters<typeof realQueries.useRunHealth>) => (page.active ? null : realQueries.useRunHealth(...args)),
  useRunProjection: (...args: Parameters<typeof realQueries.useRunProjection>) => (page.active ? null : realQueries.useRunProjection(...args)),
  useWatchdog: () => (page.active ? null : realQueries.useWatchdog()),
  useProfileFacts: () => (page.active ? { harnessByProfile: {}, maxAttempts: 3 } : realQueries.useProfileFacts()),
}));
mock.module("../api/queries", () => ({
  ...realApiQueries,
  useActive: (...args: Parameters<typeof realApiQueries.useActive>) => (page.active ? { data: { items: [] } } : realApiQueries.useActive(...args)),
}));
mock.module("./GraphViewport", () => ({
  ...realGraph,
  GraphViewport: (props: Parameters<typeof realGraph.GraphViewport>[0]) =>
    page.active ? (
      <button type="button" data-testid="graph" onClick={() => props.onSelect("a")}>
        graph
      </button>
    ) : realGraph.GraphViewport(props),
}));

const { QueryClient, QueryClientProvider } = await import("@tanstack/react-query");
const { render, screen, fireEvent, cleanup } = await import("@testing-library/react");
const { ToastProvider } = await import("../components/Toast");
const { ConfirmProvider } = await import("../components/ConfirmDialog");
const { RunPage } = await import("./RunPage");

beforeAll(() => {
  page.active = true;
});
afterEach(cleanup);
afterAll(() => {
  page.active = false;
  uninstall();
});

function mountPage(): HTMLElement {
  const { container } = render(
    <QueryClientProvider client={new QueryClient({ defaultOptions: { queries: { retry: false } } })}>
      <ToastProvider>
        <ConfirmProvider>
          <RunPage runId="new" />
        </ConfirmProvider>
      </ToastProvider>
    </QueryClientProvider>,
  );
  return container;
}

const follows = (a: Element, b: Element): boolean => (a.compareDocumentPosition(b) & Node.DOCUMENT_POSITION_FOLLOWING) !== 0;

describe("covers block position", () => {
  test("the covers block is not in the run header", () => {
    const container = mountPage();
    const header = container.querySelector(".run-page-header");
    expect(header).not.toBeNull();
    expect(header?.querySelector(".covers-block")).toBeNull();
  });

  test("the covers block follows the graph and the node details", () => {
    const container = mountPage();
    fireEvent.click(screen.getByTestId("graph"));
    const covers = container.querySelector(".covers-block");
    const graph = container.querySelector("[data-testid=graph]");
    const details = container.querySelector(".node-panel") ?? container.querySelector("aside");
    expect(covers).not.toBeNull();
    expect(graph).not.toBeNull();
    expect(details).not.toBeNull();
    expect(follows(graph as Element, covers as Element)).toBe(true);
    expect(follows(details as Element, covers as Element)).toBe(true);
  });

  test("the covers block is the last block of the run page", () => {
    const container = mountPage();
    fireEvent.click(screen.getByTestId("graph"));
    const page = container.querySelector(".run-page");
    expect(page?.lastElementChild?.classList.contains("covers-block")).toBe(true);
  });

  test("covered links and the covers block links keep their hrefs", () => {
    const container = mountPage();
    const link = container.querySelector(".covers-block a[href='#/run/old']");
    expect(link?.textContent).toBe("← run Old run");
    expect(container.querySelector(".covers-block .covers-nodes")?.textContent).toBe("carried 1: b");
    expect(container.querySelector(".covers-block .covers-map")?.textContent).toBe("map: b → gap-b");
  });
});

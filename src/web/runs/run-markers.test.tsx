import { afterAll, afterEach, describe, expect, test } from "bun:test";
import type { RunNode } from "../../shared/types/run-node";
import type { RunState } from "../../shared/types/run-state";
import { installDom } from "../test/dom";

const uninstall = installDom();
const { render, screen, cleanup, fireEvent } = await import("@testing-library/react");
const { QueryClient, QueryClientProvider } = await import("@tanstack/react-query");
const { ToastProvider } = await import("../components/Toast");
const { NodeCard } = await import("./GraphSvg");
const { NodePanel } = await import("./NodePanel");
const { profilePalette } = await import("../lib/profile-color");
const { NodeMarkerContext } = await import("./node-marker-context");
const { NodeMenu, MarkerSummary, menuActions } = await import("./NodeMarkers");
const { markerMap, nodeMarkers, markerCounts, idsWithMarker } = await import("../lib/node-markers");
const { statusSegments, shortId } = await import("./NodeStatusLine");

afterEach(cleanup);
afterAll(uninstall);

const now = Date.parse("2026-11-24T12:00:00Z");
const node = (over: Partial<RunNode> = {}): RunNode =>
  ({ id: "n1", label: "first", status: "waiting", profile: null, adapter: null, job_id: null, started: null, finished: null, error: null, log_tail: [], ...over }) as RunNode;
const run = (nodes: RunNode[]): RunState =>
  ({ run_id: "r1", title: "T", harness_session: "", started: "2026-11-24T10:00:00Z", finished: null, status: "running", nodes, edges: [] }) as RunState;

describe("node markers", () => {
  test("long-running, stalled, ready, no-handoff and unowned are detected per node", () => {
    const long = node({ id: "a", status: "running", started: "2026-11-24T11:00:00Z", owner: "agent", job_id: "j" });
    const stalled = node({ id: "b", status: "running", stale: true, owner: "agent", started: "2026-11-24T11:55:00Z" } as Partial<RunNode>);
    const ready = node({ id: "c", status: "waiting" });
    const unowned = node({ id: "d", status: "running", started: "2026-11-24T11:59:00Z" });
    const map = markerMap(run([long, stalled, ready, unowned]), { nowMs: now, ready: new Set(["c"]) }, []);
    expect(map.get("a")?.map((m) => m.code)).toEqual(["long"]);
    expect(map.get("b")?.map((m) => m.code)).toEqual(["stalled"]);
    expect(map.get("c")?.map((m) => m.code)).toEqual(["ready"]);
    expect(map.get("d")?.map((m) => m.code)).toEqual(["unowned"]);
    expect(markerCounts(map).map((c) => `${c.count} ${c.code}`)).toEqual(["1 stalled", "1 long", "1 ready", "1 unowned"]);
    expect([...idsWithMarker(map, "ready")]).toEqual(["c"]);
  });
  test("failed and needs-review nodes carry markers instead of run-level boxes", () => {
    const failed = node({ id: "f", status: "error", error: "exit=1" });
    const review = node({ id: "r", status: "done", finished: "x", unverified: true, result_reason: "node result was not recorded" } as Partial<RunNode>);
    const reviewed = node({ id: "ok", status: "done", finished: "x", unverified: true, reviewed: true } as Partial<RunNode>);
    const map = markerMap(run([failed, review, reviewed]), { nowMs: now, ready: new Set() }, []);
    expect(map.get("f")?.map((m) => `${m.code}:${m.tone}:${m.title}`)).toEqual(["failed:error:exit=1"]);
    expect(map.get("r")?.map((m) => m.code)).toEqual(["review"]);
    expect(map.has("ok")).toBe(false);
    expect(markerCounts(map).map((c) => `${c.count} ${c.code}`)).toEqual(["1 failed", "1 review"]);
  });
  test("a healthy node has no marker", () => {
    expect(nodeMarkers(node({ status: "done", finished: "x" }), { nowMs: now, ready: new Set() })).toEqual([]);
  });
  test("graph card shows the marker word and a menu button", () => {
    const n = node({ id: "c" });
    const markers = markerMap(run([n]), { nowMs: now, ready: new Set(["c"]) }, []);
    const { container } = render(
      <QueryClientProvider client={new QueryClient()}>
        <ToastProvider>
          <NodeMarkerContext.Provider value={markers}>
            <svg>
              <NodeCard node={n} pos={{ x: 0, y: 0 }} selected={false} isCyclic={false} onSelect={() => {}} palette={profilePalette([])} harnessByProfile={{}} maxAttempts={5} runId="r1" />
            </svg>
          </NodeMarkerContext.Provider>
        </ToastProvider>
      </QueryClientProvider>,
    );
    expect(container.querySelector('[data-marker="ready"]')?.textContent).toContain("ready");
    expect(screen.queryByRole("button", { name: "Actions for c" })).not.toBeNull();
  });
});

describe("NodeMenu", () => {
  const ui = (n: RunNode, ready = false) => {
    const markers = ready ? nodeMarkers(n, { nowMs: now, ready: new Set([n.id]) }) : [];
    return render(
      <ToastProvider>
        <NodeMenu runId="r1" node={n} markers={markers} />
      </ToastProvider>,
    );
  };
  test("running node: Cancel, Restart and Tell; Cancel asks again", () => {
    ui(node({ status: "running" }));
    fireEvent.click(screen.getByRole("button", { name: "Actions for n1" }));
    expect(screen.queryByRole("menuitem", { name: "Cancel" })).not.toBeNull();
    expect(screen.queryByRole("menuitem", { name: "Restart" })).not.toBeNull();
    expect(screen.queryByRole("menuitem", { name: "Start" })).toBeNull();
    fireEvent.click(screen.getByRole("menuitem", { name: "Cancel" }));
    expect(screen.queryByRole("menuitem", { name: "Confirm cancel" })).not.toBeNull();
  });
  test("ready node has Start", () => {
    expect(menuActions(node(), nodeMarkers(node(), { nowMs: now, ready: new Set(["n1"]) }))).toEqual(["start", "tell"]);
    ui(node(), true);
    fireEvent.click(screen.getByRole("button", { name: "Actions for n1" }));
    expect(screen.queryByRole("menuitem", { name: "Start" })).not.toBeNull();
  });
  test("Tell opens an inline input", () => {
    ui(node({ status: "running" }));
    fireEvent.click(screen.getByRole("button", { name: "Actions for n1" }));
    fireEvent.click(screen.getByRole("menuitem", { name: "Tell" }));
    expect(screen.queryByLabelText("Message to n1")).not.toBeNull();
  });
});

describe("MarkerSummary", () => {
  test("one thin line; a click picks the filter and a second click clears it", () => {
    const map = markerMap(run([node({ id: "a", status: "running", stale: true, owner: "x", started: "2026-11-24T11:59:00Z" } as Partial<RunNode>), node({ id: "b" })]), { nowMs: now, ready: new Set(["b"]) }, []);
    const picked: string[] = [];
    render(<MarkerSummary map={map} active="" onPick={(c) => picked.push(c)} />);
    expect(screen.getByRole("group").textContent).toContain("1 stalled");
    expect(screen.getByRole("group").textContent).toContain("1 ready");
    fireEvent.click(screen.getByRole("button", { name: /ready/ }));
    expect(picked).toEqual(["ready"]);
  });
  test("renders nothing with no markers", () => {
    const { container } = render(<MarkerSummary map={new Map()} active="" onPick={() => {}} />);
    expect(container.innerHTML).toBe("");
  });
});

describe("node panel: collapsed Details and Selections, terminal status line", () => {
  const sel = [
    { seq: 1, ts: "2026-11-24T11:00:00Z", event: "selected", model: "a" },
    { seq: 2, ts: "2026-11-24T11:05:00Z", event: "selected", model: "b" },
  ];
  const n = node({
    id: "n9",
    label: "Build it",
    status: "running",
    profile: "opencode-smart-auto",
    model_id: "copilot/claude-opus-5-5",
    job_id: "job-1234566720",
    session: "ses_abcdef129205",
    started: new Date().toISOString(),
    cost: { usd: 0, cost_basis: "list", input_tokens: 84000, output_tokens: 19000, cache_read_tokens: 1_900_000, cache_creation_tokens: 0, models: [] },
    selection_history: sel,
  } as unknown as Partial<RunNode>);
  const panel = () =>
    render(
      <QueryClientProvider client={new QueryClient()}>
        <ToastProvider>
          <NodePanel run={run([n])} selectedId="n9" maxAttempts={5} flash={0} />
        </ToastProvider>
      </QueryClientProvider>,
    );
  test("Details and Selections are closed disclosures; the long dl is inside Details", () => {
    const { container } = panel();
    const details = container.querySelector("details.node-details") as HTMLDetailsElement;
    expect(details).not.toBeNull();
    expect(details.open).toBe(false);
    const selections = container.querySelector("details.selections") as HTMLDetailsElement;
    expect(selections.open).toBe(false);
    expect(selections.querySelector("summary")?.textContent).toContain("1 switch");
    expect(container.querySelector(".panel-details > dl")).toBeNull();
    expect(details.querySelector("dl")).not.toBeNull();
  });
  test("status line holds the facts as chips; long ids are shortened with the full value in the title", () => {
    const { container } = panel();
    const line = container.querySelector(".node-statusline");
    expect(line?.textContent).toContain("running");
    expect(line?.textContent).toContain("opencode-smart-auto");
    expect(line?.textContent).toContain("attempt 1/5");
    expect(line?.textContent).toContain("84k in · 19k out · 1.9M cache read · 0 written");
    const job = container.querySelector('[data-seg="job"]');
    expect(job?.textContent).toBe("job …6720");
    expect(job?.getAttribute("title")).toContain("job-1234566720");
  });
  test("statusSegments and shortId are pure", () => {
    expect(shortId("abcdefghij")).toBe("…ghij");
    expect(shortId("abc")).toBe("abc");
    expect(statusSegments(node(), 5, "").map((s) => s.key)).toContain("state");
  });
});

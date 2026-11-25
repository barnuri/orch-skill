import { afterAll, afterEach, describe, expect, test } from "bun:test";
import type { RunNode } from "../../shared/types/run-node";
import type { RunState } from "../../shared/types/run-state";
import type { RunSummary } from "../../shared/types/run-summary";
import { installDom } from "../test/dom";

const uninstall = installDom();
const { render, screen, fireEvent, cleanup, act } = await import("@testing-library/react");
const { QueryClient, QueryClientProvider } = await import("@tanstack/react-query");
const { ToastProvider } = await import("../components/Toast");
const { ConfirmProvider } = await import("../components/ConfirmDialog");
const { RunRow, RunsPage, FilterBar } = await import("./RunsPage");
const { GraphViewport, clearViewStates } = await import("./GraphViewport");
const { NodePanel: RawPanel } = await import("./NodePanel");
const { tickerListeners } = await import("./use-now");
const { DEFAULT_RUN_FILTERS } = await import("../lib/run-filters");

const realFetch = globalThis.fetch;
afterEach(() => {
  cleanup();
  clearViewStates();
  globalThis.fetch = realFetch;
  localStorage.clear();
});
afterAll(uninstall);

const iso = (msAgo: number): string => new Date(Date.now() - msAgo).toISOString();
const counts = { waiting: 0, running: 1, done: 0, error: 0, skipped: 0, "blocked-user": 0, covered: 0, stopped: 0 };
const summary = (over: Partial<RunSummary>): RunSummary => ({ run_id: "r1", title: "T", status: "running", started: iso(5000), finished: null, harness_session: "", counts, ...over });

function node(over: Partial<RunNode>): RunNode {
  return { id: "n1", label: "Node one", status: "waiting", profile: null, adapter: null, job_id: null, started: null, finished: null, error: null, log_tail: [], ...over };
}
const runOf = (nodes: RunNode[], edges: [string, string][] = []): RunState => ({ run_id: "r1", title: "T", harness_session: "", started: iso(60_000), finished: null, status: "running", nodes, edges });

const NodePanel = (props: React.ComponentProps<typeof RawPanel>) => (
  <QueryClientProvider client={new QueryClient()}>
    <ToastProvider>
      <RawPanel {...props} />
    </ToastProvider>
  </QueryClientProvider>
);

describe("run row", () => {
  test("a missing usage is a visible muted placeholder with a tooltip", () => {
    render(<RunRow run={summary({ status: "done", finished: iso(1000) })} />);
    const usage = screen.getByText("no usage reported");
    expect(usage.className).toContain("missing");
    expect(usage.getAttribute("title")?.length).toBeGreaterThan(5);
  });

  test("usd is shown when the summary has it", () => {
    render(<RunRow run={summary({ usd: 1.5 })} />);
    expect(screen.getByText("$1.50").className).not.toContain("missing");
  });

  test("a running run ticks live off one shared ticker", async () => {
    const view = render(
      <>
        <RunRow run={summary({ run_id: "a" })} />
        <RunRow run={summary({ run_id: "b" })} />
      </>,
    );
    expect(tickerListeners()).toBe(2);
    const before = view.container.querySelector(".run-total")?.textContent;
    await act(async () => {
      await new Promise((done) => setTimeout(done, 2300));
    });
    expect(view.container.querySelector(".run-total")?.textContent).not.toBe(before);
    cleanup();
    expect(tickerListeners()).toBe(0);
  });

  test("a finished run shows a static duration and does not subscribe", () => {
    render(<RunRow run={summary({ status: "done", started: iso(65_000), finished: iso(5000) })} />);
    expect(screen.getByText("1m 0s")).toBeDefined();
    expect(tickerListeners()).toBe(0);
  });
});

describe("node session transcript", () => {
  test("ANSI chat text uses terminal spans instead of Markdown escapes", async () => {
    const { ansiSegments } = await import("../lib/ansi");
    const segments = ansiSegments("\u001b[31merror\u001b[0m plain");
    expect(segments.map((segment) => segment.text).join("")).toBe("error plain");
    expect(segments[0]?.style.base).toBe(1);
  });

  test("follow pauses above the bottom and resumes at the bottom", async () => {
    const { isNearBottom, transcriptLines } = await import("./NodePanel");
    expect(isNearBottom(1000, 940, 100)).toBe(true);
    expect(isNearBottom(1000, 700, 100)).toBe(false);
    const lines = Array.from({ length: 205 }, (_, index) => `line ${index + 1}`).join("\n");
    expect(transcriptLines(lines)).toHaveLength(200);
    expect(transcriptLines(lines)[0]).toBe("line 6");
  });
});

describe("node terminal panel", () => {
  test("shows the prompt, colored output, message box, and status line in order", async () => {
    const n = node({ status: "waiting", job_id: null, log_tail: ["\u001b[32mgreen\u001b[0m output"], profile: "test-profile", actual_model: "test-model" });
    render(<NodePanel run={runOf([n])} selectedId="n1" maxAttempts={5} flash={0} />);

    const panel = document.querySelector(".node-terminal") as HTMLElement;
    expect(panel).toBeTruthy();
    expect(panel.querySelector(".node-terminal-prompt")?.textContent).toBe("$ node");
    expect(panel.querySelector(".node-output .ansi-fg-2")?.textContent).toBe("green");

    const messages = panel.querySelector(".node-messages") as HTMLElement | null;
    const status = panel.querySelector(".node-statusline") as HTMLElement | null;
    expect(messages).toBeTruthy();
    expect(status).toBeTruthy();
    expect(messages !== null && status !== null && (messages.compareDocumentPosition(status) & Node.DOCUMENT_POSITION_FOLLOWING)).toBeTruthy();
    expect(status?.getAttribute("aria-label")).toBe("Node status line");
  });
});

describe("node panel placeholders", () => {
  test("every field is shown, missing ones muted with a reason", () => {
    const waiting = node({});
    render(<NodePanel run={runOf([waiting])} selectedId="n1" maxAttempts={5} flash={0} />);
    const row = (key: string) => screen.getByText(key).nextElementSibling as HTMLElement;
    expect(screen.getByText("model not reported").className).toContain("missing");
    expect(row("duration").textContent).toBe("not started");
    expect(row("usage").textContent).toBe("no usage reported");
    expect(row("usage").getAttribute("title")).toContain("inline");
    expect(row("attempt").textContent).toBe("attempt 1/5");
    expect(screen.queryByText("role · tier")).toBeNull();
  });

  test("the panel shows the owner id short and whether a done node left a handoff", () => {
    const owner = "ses_abcdef1234567890";
    const { unmount } = render(<NodePanel run={runOf([node({ status: "done", owner_id: owner, handoff_present: false })])} selectedId="n1" maxAttempts={5} flash={0} />);
    expect((screen.getByText("owner id").nextElementSibling as HTMLElement).textContent).toBe("ses_abcdef12...");
    const missing = screen.getByText("handoff").nextElementSibling as HTMLElement;
    expect(missing.textContent).toBe("done without handoff");
    expect(missing.className).toContain("missing");
    unmount();
    render(<NodePanel run={runOf([node({ status: "done", handoff_present: true })])} selectedId="n1" maxAttempts={5} flash={0} />);
    expect((screen.getByText("handoff").nextElementSibling as HTMLElement).textContent).toBe("handoff present");
    expect((screen.getByText("owner id").nextElementSibling as HTMLElement).textContent).toBe("—");
  });

  test("a run without the handoff field hides the handoff row", () => {
    render(<NodePanel run={runOf([node({ status: "done" })])} selectedId="n1" maxAttempts={5} flash={0} />);
    expect(screen.queryByText("handoff")).toBeNull();
  });

  test("a waiting node's panel says why it waits, in the card's priority", () => {
    const why = (): { text: string; title: string | null } => {
      const dd = screen.getByText("why").nextElementSibling as HTMLElement;
      const out = { text: dd.textContent ?? "", title: dd.getAttribute("title") };
      cleanup();
      return out;
    };
    const held = node({ hold: "until load < 4", needs_user: "pick a name" });
    render(<NodePanel run={runOf([held, node({ id: "a", status: "running" }), node({ id: "b" })], [["a", "n1"], ["b", "n1"]])} selectedId="n1" maxAttempts={5} flash={0} />);
    expect(why()).toEqual({ text: "waiting on a +1", title: "Waiting on: a, b" });
    render(<NodePanel run={runOf([held])} selectedId="n1" maxAttempts={5} flash={0} />);
    expect(why().text).toBe("needs you: pick a name");
    render(<NodePanel run={runOf([node({ hold: "a very long reason that does not fit the card row" })])} selectedId="n1" maxAttempts={5} flash={0} />);
    expect(why().text).toBe("held: a very long reason that does not fit the card row");
    render(<NodePanel run={runOf([node({})])} selectedId="n1" maxAttempts={5} flash={0} />);
    expect(why().text).toBe("ready, not started");
    render(<NodePanel run={runOf([node({ status: "running", hold: "x" })])} selectedId="n1" maxAttempts={5} flash={0} />);
    expect(screen.queryByText("why")).toBeNull();
  });

  test("model precedence: hub actual beats the profile model without duplicating it", () => {
    const hub = { expected: { model: "p/exp-model" }, actual: { model: "p/act-model" }, outcome: null };
    render(<NodePanel run={runOf([node({ model: "profile-model", hub })])} selectedId="n1" maxAttempts={5} flash={0} />);
    expect(screen.queryByText("model")).toBeNull();
    expect(screen.getByText("act-model")).toBeTruthy();
  });

  test("a running node's duration ticks, a finished one stays put", async () => {
    const running = node({ status: "running", started: iso(3000) });
    const view = render(<NodePanel run={runOf([running])} selectedId="n1" maxAttempts={5} flash={0} />);
    const dur = () => (screen.getByText("duration").nextElementSibling as HTMLElement).textContent;
    const first = dur();
    await act(async () => {
      await new Promise((done) => setTimeout(done, 2300));
    });
    expect(dur()).not.toBe(first);
    view.unmount();
    const done = node({ status: "done", started: iso(65_000), finished: iso(5000) });
    render(<NodePanel run={runOf([done])} selectedId="n1" maxAttempts={5} flash={0} />);
    expect(tickerListeners()).toBe(0);
  });
});

describe("graph viewport follow toggle", () => {
  const run = runOf([node({ id: "a", status: "running", started: iso(1000) }), node({ id: "b", label: "Node two" })], [["a", "b"]]);
  const withQuery = (child: React.ReactElement) => <QueryClientProvider client={new QueryClient({ defaultOptions: { queries: { retry: false } } })}>{child}</QueryClientProvider>;
  const mount = () => render(withQuery(<GraphViewport run={run} selectedId={null} onSelect={() => undefined} harnessByProfile={{}} maxAttempts={5} />));

  test("waiting nodes say what they wait on, and Hide done removes finished, skipped and covered nodes", () => {
    const r = runOf([node({ id: "a", status: "done" }), node({ id: "b", status: "running", started: iso(1000) }), node({ id: "c", status: "waiting" }), node({ id: "d", status: "skipped" }), node({ id: "e", status: "covered" })], [["a", "c"], ["b", "c"]]);
    render(withQuery(<GraphViewport run={r} selectedId={null} onSelect={() => undefined} harnessByProfile={{}} maxAttempts={5} />));
    expect(screen.getByText("waiting on b")).toBeTruthy();
    // The orchestrator box is selectable too (data-node-id="__main__"); count task nodes only.
    const tasks = () => document.querySelectorAll('[data-node-id]:not([data-node-id="__main__"])').length;
    expect(tasks()).toBe(5);
    fireEvent.click(screen.getByRole("button", { name: "Hide done nodes" }));
    expect(tasks()).toBe(2);
    expect(document.querySelector('[data-node-id="a"]')).toBeNull();
    expect(document.querySelector('[data-node-id="d"]')).toBeNull();
    expect(document.querySelector('[data-node-id="e"]')).toBeNull();
    expect(screen.getByRole("button", { name: "Hide done nodes" }).textContent).toBe("Show done (3)");
  });

  test("follow is on by default, zooming turns it off and the button turns it back on", () => {
    mount();
    const follow = screen.getByRole("button", { name: /Follow what is running/ });
    expect(follow.getAttribute("aria-pressed")).toBe("true");
    fireEvent.click(screen.getByRole("button", { name: "Zoom in" }));
    expect(follow.getAttribute("aria-pressed")).toBe("false");
    fireEvent.click(follow);
    expect(follow.getAttribute("aria-pressed")).toBe("true");
  });

  test("the user's choice survives a data refresh", () => {
    const view = mount();
    fireEvent.click(screen.getByRole("button", { name: "Fit graph to screen" }));
    view.rerender(withQuery(<GraphViewport run={{ ...run, nodes: [...run.nodes] }} selectedId={null} onSelect={() => undefined} harnessByProfile={{}} maxAttempts={5} />));
    expect(screen.getByRole("button", { name: /Follow what is running/ }).getAttribute("aria-pressed")).toBe("false");
  });

  test("clicking a node selects it", () => {
    const picked: string[] = [];
    render(withQuery(<GraphViewport run={run} selectedId={null} onSelect={(id) => picked.push(id)} harnessByProfile={{}} maxAttempts={5} />));
    fireEvent.click(screen.getByRole("button", { name: /^Node two/ }));
    expect(picked.length).toBe(1);
  });
});

describe("filters", () => {
  test("FilterBar reports the chosen age and offers Clear once filtered", () => {
    const seen: unknown[] = [];
    const view = render(<FilterBar filters={DEFAULT_RUN_FILTERS} onChange={(f) => seen.push(f)} />);
    expect(screen.queryByText("Clear filters")).toBeNull();
    fireEvent.click(screen.getByRole("radio", { name: "Last 7 days" }));
    expect(seen).toEqual([{ age: "7d", status: "all" }]);
    view.rerender(<FilterBar filters={{ age: "7d", status: "error" }} onChange={(f) => seen.push(f)} />);
    fireEvent.click(screen.getByText("Clear filters"));
    expect(seen[1]).toEqual(DEFAULT_RUN_FILTERS);
  });

  test("RunsPage hides old runs by default, persists a widened filter and restores it", async () => {
    const old = summary({ run_id: "old-run", title: "Old one", status: "done", started: iso(3 * 86_400_000), finished: iso(3 * 86_400_000) });
    const fresh = summary({ run_id: "new-run", title: "Fresh one", status: "done", finished: iso(1000) });
    globalThis.fetch = ((url: string) => {
      const body = String(url).endsWith("/api/runs") ? { generated_at: "x", runs: [fresh, old] } : { items: [] };
      return Promise.resolve(new Response(JSON.stringify(body), { status: 200, headers: { "content-type": "application/json" } }));
    }) as unknown as typeof fetch;
    const wrap = (child: React.ReactNode) => (
      <QueryClientProvider client={new QueryClient({ defaultOptions: { queries: { retry: false } } })}>
        <ToastProvider>
          <ConfirmProvider>{child}</ConfirmProvider>
        </ToastProvider>
      </QueryClientProvider>
    );
    const view = render(wrap(<RunsPage />));
    await screen.findByText("Fresh one");
    expect(screen.queryByText("Old one")).toBeNull();
    fireEvent.click(screen.getByRole("radio", { name: "Any age" }));
    expect(screen.getByText("Old one")).toBeDefined();
    expect(JSON.parse(localStorage.getItem("orch-run-filters") ?? "{}").age).toBe("all");
    view.unmount();
    render(wrap(<RunsPage />));
    await screen.findByText("Old one");
  });
});

describe("visibility", () => {
  const { ActivityFeed, StaleBanner } = require("./RunActivity") as typeof import("./RunActivity");
  const quiet = iso(15 * 60_000);

  test("a stale running node shows the word, a tooltip chip and the owner line", () => {
    const n = node({ status: "running", stale: true, last_activity: quiet, owner: "ses_abc", progress: "3/10", notes: [{ at: quiet, text: "hello" }] });
    render(<NodePanel run={runOf([n])} selectedId="n1" maxAttempts={5} flash={0} />);
    expect(screen.getByText("stale")).toBeTruthy();
    expect(screen.getByText("owned by agent ses_abc")).toBeTruthy();
    expect(screen.getByText("last activity 15m ago")).toBeTruthy();
    expect(screen.getByText("3/10")).toBeTruthy();
    expect(screen.getByText(/hello/)).toBeTruthy();
  });

  test("an unowned running node has the chip with its tooltip", () => {
    render(<NodePanel run={runOf([node({ status: "running" })])} selectedId="n1" maxAttempts={5} flash={0} />);
    expect(screen.getByText("unowned").getAttribute("title")).toContain("nothing is recorded");
    expect(screen.getByText("not recorded")).toBeTruthy();
  });

  test("a backfilled done node is tagged recorded after the fact", () => {
    render(<NodePanel run={runOf([node({ status: "done", backfilled: true })])} selectedId="n1" maxAttempts={5} flash={0} />);
    expect(screen.getByText("recorded after the fact")).toBeTruthy();
  });

  test("the banner appears only when a node is stale", () => {
    const { container, rerender } = render(<StaleBanner run={runOf([node({ status: "running" })])} />);
    expect(container.textContent).toBe("");
    rerender(<StaleBanner run={runOf([node({ status: "running", stale: true, last_activity: quiet })])} />);
    expect(container.textContent).toContain("1 node is running but nothing has changed for 15 min.");
  });

  test("the activities panel is collapsed by default and remembers the choice", () => {
    localStorage.removeItem("orch.run.activities.open");
    const { container } = render(<ActivityFeed events={[{ n: 1, at: iso(1000), kind: "note", node: "n1", from: null, to: null, note: "x", by: null } as never]} />);
    expect(container.querySelectorAll(".activity-row").length).toBe(0);
    fireEvent.click(screen.getByRole("button", { name: /Activities/ }));
    expect(localStorage.getItem("orch.run.activities.open")).toBe("1");
    expect(container.querySelectorAll(".activity-row").length).toBe(1);
    localStorage.removeItem("orch.run.activities.open");
  });

  test("the activity feed is newest first and has an empty state", () => {
    const e = (n: number, note: string) => ({ n, at: iso(1000), kind: "note", node: "n1", from: null, to: null, note, by: null });
    const { container, rerender } = render(<ActivityFeed events={[]} />);
    fireEvent.click(screen.getByRole("button", { name: /Activities/ }));
    expect(container.textContent).toContain("No activity recorded yet.");
    rerender(<ActivityFeed events={[e(1, "first"), e(2, "second")]} />);
    const rows = [...container.querySelectorAll(".activity-text")].map((x) => x.textContent);
    expect(rows).toEqual(["second", "first"]);
  });

  test("the activity feed shows the last 5 rows until Show more is clicked", () => {
    const e = (n: number) => ({ n, at: iso(1000), kind: "note", node: "n1", from: null, to: null, note: `item ${n}`, by: null });
    const events = Array.from({ length: 8 }, (_, i) => e(i + 1));
    const { container } = render(<ActivityFeed events={events} />);
    fireEvent.click(screen.getByRole("button", { name: /Activities/ }));
    expect(container.querySelectorAll(".activity-row").length).toBe(5);
    fireEvent.click(screen.getByRole("button", { name: "Show more (3 more)" }));
    expect(container.querySelectorAll(".activity-row").length).toBe(8);
    fireEvent.click(screen.getByRole("button", { name: "Show less" }));
    expect(container.querySelectorAll(".activity-row").length).toBe(5);
  });

  test("the panel shows the node's effort from its newest selection event", () => {
    const sel = (seq: number, confirmed: string | null, requested: string | null) => ({ seq, ts: iso(1000), workflow_key: null, worker_key: null, attempt_key: null, turn_key: null, requested_selector: null, tier: null, role: null, stage: "solver", model: null, state: "selected", reason_code: null, policy_version: null, requested_effort: requested, selected_effort: null, sent_effort: null, confirmed_effort: confirmed, latency_ms: null, usage: null });
    const withEffort = node({ status: "done", selection_history: [sel(1, null, "low"), sel(2, "high", "low")] as RunNode["selection_history"] });
    const { unmount } = render(<NodePanel run={runOf([withEffort])} selectedId="n1" maxAttempts={5} flash={0} />);
    expect(screen.getByText("effort").nextElementSibling?.textContent).toBe("high");
    unmount();
    const { unmount: unmount2 } = render(<NodePanel run={runOf([node({ status: "done", effort: "medium" })])} selectedId="n1" maxAttempts={5} flash={0} />);
    expect(screen.getByText("effort").nextElementSibling?.textContent).toBe("medium");
    unmount2();
    render(<NodePanel run={runOf([node({ status: "done" })])} selectedId="n1" maxAttempts={5} flash={0} />);
    expect(screen.queryByText("effort")).toBeNull();
  });

  test("a run row shows the stale chip and updated, and survives their absence", () => {
    const { container, rerender } = render(<RunRow run={summary({})} />);
    expect(container.textContent).not.toContain("stale");
    rerender(<RunRow run={{ ...summary({}), stale: 2, updated: iso(120_000) } as RunSummary} />);
    expect(container.textContent).toContain("2 stale");
    expect(container.textContent).toContain("updated 2m ago");
  });
});

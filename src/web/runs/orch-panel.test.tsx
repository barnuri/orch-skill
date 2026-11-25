import { afterAll, afterEach, describe, expect, test } from "bun:test";
import type { RunNode } from "../../shared/types/run-node";
import type { RunState } from "../../shared/types/run-state";
import { installDom } from "../test/dom";

const uninstall = installDom();
const { render, screen, cleanup, act, fireEvent } = await import("@testing-library/react");
const { QueryClient, QueryClientProvider } = await import("@tanstack/react-query");
const { ToastProvider } = await import("../components/Toast");
const { NodePanel: RawPanel } = await import("./NodePanel");
const { RunTable } = await import("./RunTable");
const { orchestratorSegments, orchThread, orchAsks } = await import("../lib/orchestrator-node");

const realFetch = globalThis.fetch;
afterEach(() => {
  cleanup();
  globalThis.fetch = realFetch;
});
afterAll(uninstall);

const iso = (msAgo: number): string => new Date(Date.now() - msAgo).toISOString();
const task: RunNode = { id: "n1", label: "n1", status: "running", profile: null, adapter: null, job_id: null, started: iso(5000), finished: null, error: null, log_tail: [] };
const run = (over: Record<string, unknown> = {}): RunState =>
  ({
    run_id: "r1", title: "T", harness_session: "ses_main1234", started: iso(60_000), finished: null, status: "running", nodes: [task], edges: [],
    coordinator: { session_id: "ses_main1234", harness: "opencode", pane_id: "" },
    orchestrator_state: { transport: "session", pane_id: "", session_id: "ses_main1234", harness: "opencode", model: "gpt-x", reachable: true, unreachable_since: null, unreachable_reason: null, pending_asks: 1, last_repoint: null, candidates: [] },
    ...over,
  }) as unknown as RunState;

const messages = [
  { id: "m1", seq: 1, from: "n1", to: "orch", kind: "ask", at: iso(3000), text: "which db?", status: "pending", delivered_at: null, via: null, answer: null },
  { id: "m2", seq: 2, from: "user", to: "orch", kind: "tell", at: iso(2000), text: "use sqlite", status: "delivered", delivered_at: iso(1900), via: "opencode-service" },
];

interface Call { url: string; method: string; body: unknown }
function serve(): Call[] {
  const calls: Call[] = [];
  globalThis.fetch = ((url: string, init?: RequestInit) => {
    const u = String(url);
    calls.push({ url: u, method: init?.method ?? "GET", body: init?.body ? JSON.parse(String(init.body)) : null });
    const body = u.endsWith("/activity")
      ? { state: "ok", next: "a1", context_tokens: 12_345, messages: [{ id: "a1", role: "assistant", time: iso(1000), parts: [{ kind: "text", text: "planning the run" }] }] }
      : u.endsWith("/messages") ? { messages } : { ok: true, output: "m3 coordinator delivered" };
    return Promise.resolve(new Response(JSON.stringify(body), { status: 200, headers: { "content-type": "application/json" } }));
  }) as unknown as typeof fetch;
  return calls;
}
const settle = () => act(async () => { await new Promise((done) => setTimeout(done, 200)); });
const Panel = (props: React.ComponentProps<typeof RawPanel>) => (
  <QueryClientProvider client={new QueryClient()}>
    <ToastProvider><RawPanel {...props} /></ToastProvider>
  </QueryClientProvider>
);

describe("orchestrator panel", () => {
  test("selecting the orchestrator shows its transcript, composer and status line", async () => {
    const calls = serve();
    const view = render(<Panel run={run()} selectedId="__main__" maxAttempts={5} flash={0} />);
    await settle();
    expect(calls.some((c) => c.url.endsWith("/runs/r1/nodes/coordinator/activity"))).toBe(true);
    const text = view.container.textContent ?? "";
    expect(text).toContain("planning the run");
    expect(text).toContain("use sqlite (delivered)");
    expect(view.container.querySelector("details.node-details")).not.toBeNull();
    expect(screen.getByLabelText("Message to the orchestrator")).toBeTruthy();
    const line = view.container.querySelector("footer.node-statusline") as HTMLElement;
    expect(line.getAttribute("aria-label")).toBe("Orchestrator status line");
    expect(line.textContent).toContain("context 12.3k");
  });

  test("send posts a tell to the coordinator target", async () => {
    const calls = serve();
    render(<Panel run={run()} selectedId="__main__" maxAttempts={5} flash={0} />);
    await settle();
    fireEvent.change(screen.getByLabelText("Message to the orchestrator"), { target: { value: "hello orch" } });
    fireEvent.click(screen.getByRole("button", { name: "Send" }));
    await settle();
    const post = calls.find((c) => c.method === "POST");
    expect(post?.url).toContain("/runs/r1/nodes/coordinator/tell");
    expect(post?.body).toEqual({ text: "hello orch" });
  });

  test("a pending ask shows inline and Answer goes to the asking node", async () => {
    const calls = serve();
    render(<Panel run={run()} selectedId="__main__" maxAttempts={5} flash={0} />);
    await settle();
    expect(screen.getByText("n1 asks: which db?")).toBeTruthy();
    fireEvent.change(screen.getByLabelText("Message to the orchestrator"), { target: { value: "postgres" } });
    fireEvent.click(screen.getByRole("button", { name: "Answer" }));
    await settle();
    const post = calls.find((c) => c.method === "POST");
    expect(post?.url).toContain("/runs/r1/nodes/n1/answer");
    expect(post?.body).toEqual({ text: "postgres", ask: "m1" });
  });

  test("the pinned table row selects the orchestrator", () => {
    const picked: string[] = [];
    const view = render(<RunTable run={run()} filter={{ q: "", status: "", profile: "", harness: "", family: "" } as never} harnessByProfile={{}} selectedId={null} onSelect={(id) => picked.push(id)} />);
    fireEvent.click(view.container.querySelector("tr.rt-main") as HTMLElement);
    expect(picked).toEqual(["__main__"]);
  });
});

describe("orchestrator status line and thread", () => {
  test("segments: session, harness, model, context, registered, pending asks", () => {
    const segs = orchestratorSegments(run(), 2_000_000);
    const by = Object.fromEntries(segs.map((s) => [s.key, s.text]));
    expect(by).toMatchObject({ harness: "opencode", model: "gpt-x", context: "context 2.0M tok", link: "registered · session", asks: "1 pending ask", session: "session …1234" });
  });
  test("unreachable and not registered", () => {
    const down = run({ orchestrator_state: { transport: "herdr", pane_id: "1-2", reachable: false, unreachable_since: "x", unreachable_reason: "pane gone", pending_asks: 0, last_repoint: null, candidates: [] } });
    expect(orchestratorSegments(down, null).find((s) => s.key === "link")?.text).toBe("unreachable");
    const none = run({ orchestrator_state: null, coordinator: undefined });
    expect(orchestratorSegments(none, null).find((s) => s.key === "link")?.text).toBe("not registered");
  });
  test("thread skips asks and mirror notes; asks lists only open ones", () => {
    const all = [...messages, { ...messages[1], id: "m9", text: "user -> n1 (delivered): hi" }, { ...messages[0], id: "m4", answer: "done" }] as never[];
    expect(orchThread(all).map((m) => m.id)).toEqual(["m2"]);
    expect(orchAsks(all).map((m) => m.id)).toEqual(["m1"]);
  });
});

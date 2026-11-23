import { afterAll, afterEach, describe, expect, test } from "bun:test";
import type { RunNode } from "../../shared/types/run-node";
import type { RunState } from "../../shared/types/run-state";
import { installDom } from "../test/dom";

const uninstall = installDom();
const { render, screen, cleanup, act } = await import("@testing-library/react");
const { QueryClient, QueryClientProvider } = await import("@tanstack/react-query");
const { ToastProvider } = await import("../components/Toast");
const { NodePanel: RawPanel } = await import("./NodePanel");

const realFetch = globalThis.fetch;
afterEach(() => {
  cleanup();
  globalThis.fetch = realFetch;
});
afterAll(uninstall);

const iso = (msAgo: number): string => new Date(Date.now() - msAgo).toISOString();
const node = (over: Partial<RunNode>): RunNode => ({ id: "n1", label: "Node one", status: "running", profile: null, adapter: null, job_id: null, started: iso(5000), finished: null, error: null, log_tail: [], ...over });
const runOf = (nodes: RunNode[]): RunState => ({ run_id: "r1", title: "T", harness_session: "", started: iso(60_000), finished: null, status: "running", nodes, edges: [] });

const Panel = (props: React.ComponentProps<typeof RawPanel>) => (
  <QueryClientProvider client={new QueryClient()}>
    <ToastProvider>
      <RawPanel {...props} />
    </ToastProvider>
  </QueryClientProvider>
);
const mount = (n: RunNode) => render(<Panel run={runOf([n])} selectedId="n1" maxAttempts={5} flash={0} />);

function serve(body: unknown, status = 200): { urls: string[] } {
  const seen = { urls: [] as string[] };
  globalThis.fetch = ((url: string) => {
    seen.urls.push(String(url));
    return Promise.resolve(new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } }));
  }) as unknown as typeof fetch;
  return seen;
}
const settle = () =>
  act(async () => {
    await new Promise((done) => setTimeout(done, 150));
  });

describe("node activity panel", () => {
  test("live activity shows one line per part, oldest first, tool lines collapsed", async () => {
    const seen = serve({
      state: "ok",
      next: "m2",
      messages: [
        { id: "m1", role: "assistant", time: iso(4000), parts: [{ kind: "text", text: "reading the spec" }] },
        { id: "m2", role: "assistant", time: iso(1000), parts: [{ kind: "tool", tool: "bash", text: "bun test" }] },
      ],
    });
    const view = mount(node({ owner: "ses_live" }));
    await settle();
    expect(seen.urls.some((u) => u.endsWith("/runs/r1/nodes/n1/activity"))).toBe(true);
    const log = view.container.querySelector("[role=log]") as HTMLElement;
    expect(log.textContent).toContain("text  reading the spec");
    expect(log.querySelectorAll("details.chat-tool").length).toBe(1);
    expect(log.querySelector("summary")?.textContent).toContain("tool bash");
    expect(log.textContent?.indexOf("reading the spec")).toBeLessThan(log.textContent?.indexOf("tool bash") ?? 0);
    expect(screen.getByText(/latest activity/)).toBeTruthy();
  });

  test("a gone owner says the session no longer exists", async () => {
    serve({ state: "gone", messages: [], next: null });
    const view = mount(node({ owner: "ses_dead" }));
    await settle();
    expect(view.container.textContent).toContain("The owner session no longer exists.");
    expect(view.container.querySelectorAll("[role=log] .mono").length).toBe(0);
  });

  test("an unknown owner says opencode is unreachable", async () => {
    serve({ state: "unknown", messages: [], next: null });
    const view = mount(node({ owner: "ses_x" }));
    await settle();
    expect(view.container.textContent).toContain("opencode is unreachable");
  });

  test("an inline node lists its notes and never asks for activity", async () => {
    const seen = serve({});
    const view = mount(node({ owner: "coordinator", progress: "2/5", notes: [{ at: iso(2000), text: "wrote the migration" }, { at: iso(1000), text: "ran the checks" }] }));
    await settle();
    expect(seen.urls.some((u) => u.includes("/activity"))).toBe(false);
    const text = view.container.textContent ?? "";
    expect(text).toContain("Done inline by the orchestrator");
    expect(text).toContain("progress 2/5");
    expect(text).toContain("wrote the migration");
    expect(text).toContain("ran the checks");
  });

  test("an inline node without notes says so", async () => {
    serve({});
    const view = mount(node({ owner: null }));
    await settle();
    expect(view.container.textContent).toContain("No notes were recorded.");
  });
});

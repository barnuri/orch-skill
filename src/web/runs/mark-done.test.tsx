import { afterAll, afterEach, describe, expect, test } from "bun:test";
import type { RunNode } from "../../shared/types/run-node";
import type { RunState } from "../../shared/types/run-state";
import { installDom } from "../test/dom";

const uninstall = installDom();
const { render, screen, cleanup, act, fireEvent } = await import("@testing-library/react");
const { ToastProvider } = await import("../components/Toast");
const { MarkDone } = await import("./MarkDone");
const { NodeMenu, menuActions } = await import("./NodeMarkers");
const { nodeMarkers } = await import("../lib/node-markers");

const realFetch = globalThis.fetch;
afterEach(() => {
  cleanup();
  globalThis.fetch = realFetch;
});
afterAll(uninstall);

const node = (over: Partial<RunNode> = {}): RunNode =>
  ({ id: "n1", label: "n1", status: "waiting", profile: null, adapter: null, job_id: null, started: null, finished: null, error: null, log_tail: [], ...over }) as RunNode;
const run = { run_id: "r1", title: "T", harness_session: "", started: "2026-11-24T10:00:00Z", finished: null, status: "running", nodes: [node({ status: "done" })], edges: [] } as unknown as RunState;

interface Call { url: string; method: string; body: unknown }
function serve(verify: { ok: boolean; failures: unknown[] }): Call[] {
  const calls: Call[] = [];
  globalThis.fetch = ((url: string, init?: RequestInit) => {
    const u = String(url);
    calls.push({ url: u, method: init?.method ?? "GET", body: init?.body ? JSON.parse(String(init.body)) : null });
    const body = u.endsWith("/verify") ? verify : { ok: true };
    return Promise.resolve(new Response(JSON.stringify(body), { status: 200, headers: { "content-type": "application/json" } }));
  }) as unknown as typeof fetch;
  return calls;
}
const settle = () => act(async () => { await new Promise((done) => setTimeout(done, 100)); });
const click = (el: HTMLElement) => act(async () => { fireEvent.click(el); });

describe("Mark done (run)", () => {
  test("opens at once, runs no verify, and finishes without a message", async () => {
    const calls = serve({ ok: false, failures: [{ nodes: ["done-gate"], msg: "x", hint: "" }] });
    render(<ToastProvider><MarkDone run={run} /></ToastProvider>);
    await click(screen.getByRole("button", { name: "Mark done" }));
    const confirm = screen.getByRole("button", { name: "Confirm" }) as HTMLButtonElement;
    expect(confirm.disabled).toBe(false);
    await click(confirm);
    await settle();
    expect(calls.some((c) => c.url.endsWith("/verify"))).toBe(false);
    expect(calls.find((c) => c.url.endsWith("/runs/r1/finish"))?.body).toEqual({ reason: "" });
  });

  test("sends the optional message", async () => {
    const calls = serve({ ok: true, failures: [] });
    render(<ToastProvider><MarkDone run={run} /></ToastProvider>);
    await click(screen.getByRole("button", { name: "Mark done" }));
    fireEvent.change(screen.getByPlaceholderText("Optional message"), { target: { value: "checked by hand" } });
    await click(screen.getByRole("button", { name: "Confirm" }));
    await settle();
    expect(calls.find((c) => c.url.endsWith("/runs/r1/finish"))?.body).toEqual({ reason: "checked by hand" });
  });
});

describe("Mark done and reviewed (node)", () => {
  test("menu items by state", () => {
    const m = (n: RunNode) => menuActions(n, nodeMarkers(n, { nowMs: Date.now(), ready: new Set<string>() }));
    expect(m(node({ status: "waiting" }))).toContain("done");
    expect(m(node({ status: "stopped" }))).toContain("done");
    expect(m(node({ status: "error" }))).toContain("done");
    expect(m(node({ status: "running" }))).not.toContain("done");
    expect(m(node({ status: "done" }))).not.toContain("done");
    expect(menuActions(node({ status: "done" }), [{ code: "review", word: "review", tone: "warn", title: "" }])).toContain("reviewed");
    expect(menuActions(node({ status: "done" }), [])).not.toContain("reviewed");
  });

  test("Mark done on an error node takes an optional message and posts it", async () => {
    const calls = serve({ ok: true, failures: [] });
    const n = node({ status: "error" });
    render(<ToastProvider><NodeMenu runId="r1" node={n} markers={[]} /></ToastProvider>);
    await click(screen.getByRole("button", { name: "Actions for n1" }));
    await click(screen.getByRole("menuitem", { name: "Mark done" }));
    const confirm = screen.getByRole("button", { name: "Confirm" }) as HTMLButtonElement;
    expect(confirm.disabled).toBe(false);
    fireEvent.change(screen.getByPlaceholderText("Optional message"), { target: { value: "did it by hand" } });
    await click(confirm);
    await settle();
    const call = calls.find((c) => c.url.endsWith("/nodes/n1/done"));
    expect(call?.body).toEqual({ reason: "did it by hand" });
  });

  test("Mark reviewed on a flagged done node posts to /reviewed", async () => {
    const calls = serve({ ok: true, failures: [] });
    const n = node({ status: "done" });
    render(<ToastProvider><NodeMenu runId="r1" node={n} markers={[{ code: "review", word: "review", tone: "warn", title: "" }]} /></ToastProvider>);
    await click(screen.getByRole("button", { name: "Actions for n1" }));
    await click(screen.getByRole("menuitem", { name: "Mark reviewed" }));
    fireEvent.change(screen.getByPlaceholderText("Why is this done?"), { target: { value: "read the diff" } });
    await click(screen.getByRole("button", { name: "Confirm" }));
    await settle();
    expect(calls.find((c) => c.url.endsWith("/nodes/n1/reviewed"))?.body).toEqual({ reason: "read the diff" });
  });
});

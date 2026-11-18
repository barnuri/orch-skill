import { afterAll, afterEach, describe, expect, test } from "bun:test";
import { installDom } from "../test/dom";

const uninstall = installDom();
const { render, screen, fireEvent, cleanup, waitFor } = await import("@testing-library/react");
const { QueryClientProvider } = await import("@tanstack/react-query");
const { ToastProvider } = await import("../components/Toast");
const { queryClient, dropEtags } = await import("../api/queries");
const { FeedbackPage } = await import("./FeedbackPage");

const realFetch = globalThis.fetch;
afterEach(() => {
  cleanup();
  queryClient.clear();
  dropEtags();
  globalThis.fetch = realFetch;
  localStorage.clear();
});
afterAll(uninstall);

const json = (status: number, body: unknown): Response => new Response(JSON.stringify(body), { status, headers: { "Content-Type": "application/json" } });

const ITEMS = [
  { id: "fb-20261117-1", text: "Run list is slow", source: "ui", kind: "bug", status: "new", created: "2026-11-17T09:00:00Z", updated: "2026-11-17T09:00:00Z" },
  { id: "fb-20261117-2", text: "Add dark mode", source: "chat", kind: "idea", status: "working", created: "2026-11-17T11:00:00Z", updated: "2026-11-17T11:00:00Z", work_run: "feedback-batch-1" },
];

interface Call {
  method: string;
  url: string;
  body: unknown;
}

function serve(): Call[] {
  const calls: Call[] = [];
  globalThis.fetch = ((input: RequestInfo | URL, init?: RequestInit) => {
    const url = String(input);
    const method = init?.method ?? "GET";
    const body = typeof init?.body === "string" ? JSON.parse(init.body) : undefined;
    calls.push({ method, url, body });
    if (url.endsWith("/api/feedback/work")) {
      return Promise.resolve(json(200, { run_id: "feedback-batch-2", items: ["fb-20261117-1"] }));
    }
    if (url.endsWith("/api/feedback")) {
      return Promise.resolve(json(200, { items: ITEMS }));
    }
    if (url.endsWith("/api/runs")) {
      return Promise.resolve(json(200, { generated_at: "2026-11-17T11:00:00Z", runs: [{ run_id: "feedback-batch-1", status: "running" }] }));
    }
    return Promise.resolve(json(404, { error: "no" }));
  }) as typeof fetch;
  return calls;
}

function page() {
  return render(
    <QueryClientProvider client={queryClient}>
      <ToastProvider>
        <FeedbackPage />
      </ToastProvider>
    </QueryClientProvider>,
  );
}

describe("feedback page", () => {
  test("lists items newest first with the work run status", async () => {
    serve();
    page();
    await waitFor(() => expect(screen.getByText("Add dark mode")).toBeTruthy());
    const rows = screen.getAllByRole("row").slice(1);
    expect(rows[0]?.textContent).toContain("Add dark mode");
    expect(rows[1]?.textContent).toContain("Run list is slow");
    await waitFor(() => expect(screen.getByText("running")).toBeTruthy());
  });

  test("Work on all new feedback posts to the work endpoint and reports the run", async () => {
    const calls = serve();
    page();
    await waitFor(() => expect(screen.getByText("Run list is slow")).toBeTruthy());
    fireEvent.click(screen.getByRole("button", { name: /Work on all new feedback/ }));
    await waitFor(() => expect(calls.some((c) => c.method === "POST" && c.url.endsWith("/api/feedback/work"))).toBe(true));
    await waitFor(() => expect(screen.getByText(/Started 1 item\(s\) in run feedback-batch-2/)).toBeTruthy());
  });
});

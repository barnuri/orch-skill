import { afterAll, afterEach, describe, expect, test } from "bun:test";
import type { BuildInfo } from "../../shared/types/build-info";
import { installDom } from "../test/dom";

const uninstall = installDom();
const { render, screen, fireEvent, cleanup, waitFor, act } = await import("@testing-library/react");
const { QueryClient, QueryClientProvider } = await import("@tanstack/react-query");
const { ConfirmProvider } = await import("../components/ConfirmDialog");
const { BuildBanner, confirmBody } = await import("./BuildBanner");
const { buildPollMs } = await import("./use-build");

const realFetch = globalThis.fetch;
afterEach(() => {
  cleanup();
  globalThis.fetch = realFetch;
});
afterAll(uninstall);

const info = (over: Partial<BuildInfo> = {}): BuildInfo => ({
  boot_at: "2026-11-15T10:00:00.000Z",
  boot_head: "a".repeat(40),
  head: "b".repeat(40),
  branch: "master",
  stale: true,
  reasons: ["commits", "files"],
  missing_commits: [{ sha: "b".repeat(40), subject: "Add the thing", date: "2026-11-15T11:00:00Z" }],
  missing_total: 1,
  changed_files: { count: 2, newest: [{ path: "src/server/x.ts", mtime: "2026-11-15T11:00:00Z" }, { path: "src/web/y.tsx", mtime: "2026-11-15T11:01:00Z" }] },
  uncommitted: { count: 3 },
  busy: { chats_streaming: 2, runs_running: 1 },
  error: null,
  ...over,
});

const json = (status: number, body: unknown): Response => new Response(JSON.stringify(body), { status, headers: { "Content-Type": "application/json" } });

function app(props: React.ComponentProps<typeof BuildBanner> = {}) {
  return render(
    <QueryClientProvider client={new QueryClient({ defaultOptions: { queries: { retry: false } } })}>
      <ConfirmProvider>
        <BuildBanner {...props} />
      </ConfirmProvider>
    </QueryClientProvider>,
  );
}

function serve(handler: (url: string, init?: RequestInit) => Response | Promise<Response>): void {
  globalThis.fetch = ((input: RequestInfo | URL, init?: RequestInit) => Promise.resolve(handler(String(input), init))) as typeof fetch;
}

describe("BuildBanner", () => {
  test("not stale renders nothing", async () => {
    serve(() => json(200, info({ stale: false, reasons: [] })));
    const { container } = app();
    await act(() => Bun.sleep(50));
    expect(screen.queryByText("Server out of date")).toBeNull();
    expect(container.querySelector(".build-slot")?.childElementCount).toBe(0);
  });

  test("error shows only a muted unavailable marker", async () => {
    serve(() => json(500, { error: "boom" }));
    app();
    const mark = await screen.findByLabelText("Build check unavailable");
    expect(mark.getAttribute("title")).toContain("Build check unavailable");
    expect(screen.queryByText("Server out of date")).toBeNull();
  });

  test("server-side check failure also reads unavailable", async () => {
    serve(() => json(200, info({ stale: false, reasons: [], error: "git missing" })));
    app();
    expect((await screen.findByLabelText("Build check unavailable")).getAttribute("title")).toContain("git missing");
  });

  test("stale pill opens a panel with commits, files, uncommitted, and closes on Escape", async () => {
    serve(() => json(200, info()));
    app();
    const pill = await screen.findByRole("button", { name: /Server out of date/ });
    expect(pill.getAttribute("aria-expanded")).toBe("false");
    fireEvent.click(pill);
    const panel = await screen.findByRole("dialog", { name: "Server out of date" });
    expect(panel.textContent).toContain("bbbbbbb");
    expect(panel.textContent).toContain("Add the thing");
    expect(panel.textContent).toContain("2 files changed since start");
    expect(panel.textContent).toContain("src/web/y.tsx");
    expect(panel.textContent).toContain("Uncommitted changes in the checkout: 3");
    expect(panel.textContent).toContain("bash scripts/service.sh restart");
    fireEvent.keyDown(document, { key: "Escape" });
    await waitFor(() => expect(screen.queryByRole("dialog", { name: "Server out of date" })).toBeNull());
  });

  test("copy button writes the command", async () => {
    serve(() => json(200, info()));
    app();
    const written: string[] = [];
    Object.defineProperty(navigator, "clipboard", { value: { writeText: (t: string) => { written.push(t); return Promise.resolve(); } }, configurable: true });
    fireEvent.click(await screen.findByRole("button", { name: /Server out of date/ }));
    fireEvent.click(await screen.findByRole("button", { name: "Copy command" }));
    await screen.findByRole("button", { name: "Copied" });
    expect(written).toEqual(["bash scripts/service.sh restart"]);
  });

  test("confirm body states busy numbers and that history is kept", () => {
    const text = confirmBody({ chats_streaming: 2, runs_running: 1 });
    expect(text).toContain("2 chat replies are streaming now and will be cut");
    expect(text).toContain("Chat history is kept");
    expect(text).toContain("1 orch node is running");
    expect(text).toContain("page reloads");
    expect(confirmBody({ chats_streaming: 0, runs_running: 0 })).toContain("No chat reply is streaming");
  });

  test("restart: confirm dialog, then 202, polling through failures, reload on a new boot_at", async () => {
    let builds = 0;
    let posts = 0;
    serve((url, init) => {
      if (init?.method === "POST") {
        posts++;
        return json(202, { ok: true, restart_in_ms: 1000 });
      }
      builds++;
      if (builds === 1) {
        return json(200, info());
      }
      if (builds <= 3) {
        throw new TypeError("connection refused");
      }
      return json(200, info({ boot_at: "2026-11-15T12:00:00.000Z", stale: false }));
    });
    let reloads = 0;
    app({ restartPollMs: 20, restartTimeoutMs: 5000, reload: () => { reloads++; } });
    fireEvent.click(await screen.findByRole("button", { name: /Server out of date/ }));
    fireEvent.click(await screen.findByRole("button", { name: "Restart and update" }));
    const dialog = await screen.findByRole("dialog", { name: "Restart the dashboard server?" });
    expect(dialog.textContent).toContain("2 chat replies are streaming now");
    expect(posts).toBe(0);
    const buttons = dialog.querySelectorAll("button");
    fireEvent.click(buttons[buttons.length - 1] as HTMLElement);
    await screen.findByText("Restarting…");
    await waitFor(() => expect(reloads).toBe(1), { timeout: 3000 });
    expect(posts).toBe(1);
  });

  test("cancelling the confirm does not call the server", async () => {
    let posts = 0;
    serve((_url, init) => {
      if (init?.method === "POST") {
        posts++;
      }
      return json(200, info());
    });
    app();
    fireEvent.click(await screen.findByRole("button", { name: /Server out of date/ }));
    fireEvent.click(await screen.findByRole("button", { name: "Restart and update" }));
    const dialog = await screen.findByRole("dialog", { name: "Restart the dashboard server?" });
    fireEvent.click(screen.getByRole("button", { name: "Cancel" }));
    await waitFor(() => expect(dialog.hasAttribute("open")).toBe(false));
    expect(posts).toBe(0);
  });

  test("restart that never comes back gives up with the manual command", async () => {
    let builds = 0;
    serve((_url, init) => {
      if (init?.method === "POST") {
        return json(202, { ok: true, restart_in_ms: 1000 });
      }
      builds++;
      if (builds === 1) {
        return json(200, info());
      }
      throw new TypeError("down");
    });
    let reloads = 0;
    app({ restartPollMs: 20, restartTimeoutMs: 300, reload: () => { reloads++; } });
    fireEvent.click(await screen.findByRole("button", { name: /Server out of date/ }));
    fireEvent.click(await screen.findByRole("button", { name: "Restart and update" }));
    const dialog = await screen.findByRole("dialog", { name: "Restart the dashboard server?" });
    const buttons = dialog.querySelectorAll("button");
    fireEvent.click(buttons[buttons.length - 1] as HTMLElement);
    const alert = await screen.findByRole("alert", {}, { timeout: 3000 });
    expect(alert.textContent).toContain("did not come back within");
    expect(alert.textContent).toContain("bash scripts/service.sh restart");
    expect(reloads).toBe(0);
  });

  test("not installed shows the manual command from the 409", async () => {
    serve((_url, init) => (init?.method === "POST" ? json(409, { error: "service not installed", command: "x" }) : json(200, info())));
    app();
    fireEvent.click(await screen.findByRole("button", { name: /Server out of date/ }));
    fireEvent.click(await screen.findByRole("button", { name: "Restart and update" }));
    const dialog = await screen.findByRole("dialog", { name: "Restart the dashboard server?" });
    const buttons = dialog.querySelectorAll("button");
    fireEvent.click(buttons[buttons.length - 1] as HTMLElement);
    const alert = await screen.findByRole("alert");
    expect(alert.textContent).toContain("service not installed");
    expect(alert.textContent).toContain("dispatch.sh ui");
  });

  test("poll interval override", () => {
    expect(buildPollMs("")).toBe(30_000);
    expect(buildPollMs("?buildPoll=2000")).toBe(2000);
    expect(buildPollMs("?buildPoll=5")).toBe(30_000);
  });
});

import { afterAll, afterEach, describe, expect, test } from "bun:test";
import { installDom } from "../test/dom";
import type { Chat } from "../lib/chat-types";

const uninstall = installDom();
for (const k of ["location", "history", "sessionStorage", "ResizeObserver", "matchMedia"] as const) {
  const w = window as unknown as Record<string, unknown>;
  if (w[k] !== undefined && (globalThis as Record<string, unknown>)[k] === undefined) {
    Object.defineProperty(globalThis, k, { value: w[k], configurable: true, writable: true });
  }
}
const { render, screen, cleanup, waitFor } = await import("@testing-library/react");
const { QueryClient, QueryClientProvider } = await import("@tanstack/react-query");
const { ToastProvider } = await import("../components/Toast");
const { ConfirmProvider } = await import("../components/ConfirmDialog");
const { chatsApi } = await import("../api/chats");
const { connection } = await import("./../api/status");
const { ChatShell } = await import("./ChatShell");
const { AppShell } = await import("../shell/AppShell");

const realApi = { ...chatsApi };
const realFetch = globalThis.fetch;
afterEach(() => {
  cleanup();
  Object.assign(chatsApi, realApi);
  globalThis.fetch = realFetch;
});
afterAll(uninstall);

const ok = <T,>(body: T) => ({ kind: "ok" as const, body, etag: null });
const chat = { id: "chat-1", project_id: null, title: "Hello", harness: "claude", profile: "main", model_id: null, session_id: null, status: "idle", created_at: "a", updated_at: "b", archived_at: null, cwd: "/Users/me/x", effective_cwd: "/Users/me/x" } as Chat;
const options = { harnesses: [{ id: "claude", label: "claude", enabled: true, available: true, persistent: true, profiles: [{ name: "main", description: "", enabled: true, configured: true, problem: null, models: [{ id: "m", label: "M", slug: "m", description: "", default: true }] }] }], default_harness: null, default_profile: null };

function fake(): void {
  connection.ok();
  Object.assign(chatsApi, {
    options: async () => ok(options),
    chat: async () => ok({ ...chat }),
    chats: async () => ok({ items: [{ ...chat }], next_cursor: null }),
    projects: async () => ok({ items: [], next_cursor: null }),
    messages: async () => ok({ items: [], next_cursor: null }),
    searchChats: async () => ok({ items: [] }),
  });
  globalThis.fetch = (async () => new Response("{}", { status: 200, headers: { "content-type": "application/json" } })) as unknown as typeof fetch;
}

const FEATURES: readonly string[] = ["aside[aria-label='Projects and chats']", "[data-testid=pickers]", "textarea.composer-text", "[data-testid=folder-chip]", ".composer-attach"];

async function featuresOf(node: React.ReactNode): Promise<string[]> {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  const { container } = render(<QueryClientProvider client={client}><ToastProvider><ConfirmProvider>{node}</ConfirmProvider></ToastProvider></QueryClientProvider>);
  await waitFor(() => { expect(container.querySelector("textarea.composer-text")).not.toBeNull(); }, { timeout: 4000 });
  const found = FEATURES.filter((sel) => container.querySelector(sel) !== null);
  const voice = screen.queryAllByRole("button").some((b) => /dictat|voice|mic|speak|talk/i.test(`${b.getAttribute("aria-label") ?? ""} ${b.getAttribute("title") ?? ""}`));
  return voice ? [...found, "voice"] : found;
}

describe("one chat page, two shells", () => {
  test("the thread list, pickers, composer, folder chip, attach and voice controls are the same in both", async () => {
    fake();
    location.hash = "#/chats/chat-1";
    const app = await featuresOf(<AppShell />);
    expect(document.querySelector(".rail, nav.rail")).not.toBeNull();
    cleanup();
    fake();
    const only = await featuresOf(<ChatShell />);
    expect(document.querySelector(".rail, nav.rail")).toBeNull();
    expect(document.querySelector("header.topbar")).toBeNull();
    expect(only).toEqual(app);
    expect(only).toContain("textarea.composer-text");
    expect(only.length).toBeGreaterThanOrEqual(FEATURES.length);
  });
  test("only the dashboard shell offers the chat-only link", async () => {
    fake();
    location.hash = "#/chats/chat-1";
    await featuresOf(<AppShell />);
    expect(screen.queryByText("Open chat-only")).not.toBeNull();
    cleanup();
    fake();
    await featuresOf(<ChatShell />);
    expect(screen.queryByText("Open chat-only")).toBeNull();
  });
});

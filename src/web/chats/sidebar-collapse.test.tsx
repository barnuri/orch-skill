import { afterAll, afterEach, beforeEach, describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { installDom } from "../test/dom";
import type { Chat } from "../lib/chat-types";

const uninstall = installDom();
for (const k of ["location", "history", "sessionStorage", "ResizeObserver", "matchMedia"] as const) {
  const w = window as unknown as Record<string, unknown>;
  if (w[k] !== undefined && (globalThis as Record<string, unknown>)[k] === undefined) {
    Object.defineProperty(globalThis, k, { value: w[k], configurable: true, writable: true });
  }
}
Object.defineProperty(globalThis, "HTMLInputElement", { value: (window as unknown as Record<string, unknown>)["HTMLInputElement"], configurable: true, writable: true });
const { render, screen, fireEvent, cleanup, waitFor } = await import("@testing-library/react");
const { QueryClient, QueryClientProvider } = await import("@tanstack/react-query");
const { ToastProvider } = await import("../components/Toast");
const { ConfirmProvider } = await import("../components/ConfirmDialog");
const { chatsApi } = await import("../api/chats");
const { connection } = await import("../api/status");
const { artifactsApi } = await import("./artifacts/api");
const { ChatShell } = await import("./ChatShell");
const { AppShell } = await import("../shell/AppShell");
const { SIDEBAR_MODE_KEY, readSidebarMode, writeSidebarMode, isSidebarShortcut, toggledMode } = await import("../lib/sidebar-prefs");

const realApi = { ...chatsApi };
const realArtifacts = { ...artifactsApi };
const realFetch = globalThis.fetch;
const realMatchMedia = window.matchMedia;
afterAll(uninstall);

const ok = <T,>(body: T) => ({ kind: "ok" as const, body, etag: null });
const row = (over: Record<string, unknown> = {}): Chat => ({ id: "chat-1", project_id: null, title: "Hello", harness: "claude", profile: "main", model_id: null, session_id: null, status: "idle", created_at: "a", updated_at: "b", archived_at: null, cwd: null, effective_cwd: null, ...over }) as Chat;
const options = { harnesses: [{ id: "claude", label: "claude", enabled: true, available: true, persistent: true, profiles: [{ name: "main", description: "", enabled: true, configured: true, problem: null, models: [{ id: "m", label: "M", slug: "m", description: "", default: true }] }] }], default_harness: null, default_profile: null };

let rows: Chat[] = [];
function fake(): void {
  connection.ok();
  Object.assign(chatsApi, {
    options: async () => ok(options),
    chat: async () => ok(rows[0] ?? row()),
    chats: async () => ok({ items: rows, next_cursor: null }),
    projects: async () => ok({ items: [], next_cursor: null }),
    messages: async () => ok({ items: [], next_cursor: null }),
    search: async () => ok({ items: [] }),
  });
  Object.assign(artifactsApi, { list: async () => ({ items: [], dir: "artifacts" }) });
  globalThis.fetch = (async () => new Response("{}", { status: 200, headers: { "content-type": "application/json" } })) as unknown as typeof fetch;
}

function setWidth(wide: boolean): void {
  (window as unknown as { matchMedia: unknown }).matchMedia = (query: string) => ({
    matches: query.includes("min-width: 900px") ? wide : false,
    media: query,
    addEventListener: () => undefined,
    removeEventListener: () => undefined,
    addListener: () => undefined,
    removeListener: () => undefined,
  });
}

beforeEach(() => {
  rows = [row()];
  localStorage.clear();
  location.hash = "#/chats/new";
  setWidth(true);
  fake();
});
afterEach(() => {
  cleanup();
  Object.assign(chatsApi, realApi);
  Object.assign(artifactsApi, realArtifacts);
  globalThis.fetch = realFetch;
  (window as unknown as { matchMedia: unknown }).matchMedia = realMatchMedia;
  localStorage.clear();
});

const shells: ReadonlyArray<readonly [string, () => React.ReactNode]> = [
  ["dashboard Chat tab", () => <AppShell />],
  ["chat-only shell", () => <ChatShell />],
];

function mount(node: React.ReactNode) {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return render(<QueryClientProvider client={client}><ToastProvider><ConfirmProvider>{node}</ConfirmProvider></ToastProvider></QueryClientProvider>);
}
const layout = (): HTMLElement => document.querySelector(".chats-layout") as HTMLElement;
const key = (init: KeyboardEventInit): void => { fireEvent.keyDown(document, init); };

describe("sidebar preference storage", () => {
  test("one key, defensive read and write", () => {
    expect(readSidebarMode()).toBe("open");
    writeSidebarMode("rail");
    expect(localStorage.getItem(SIDEBAR_MODE_KEY)).toBe("rail");
    expect(readSidebarMode()).toBe("rail");
    localStorage.setItem(SIDEBAR_MODE_KEY, "sideways");
    expect(readSidebarMode()).toBe("open");
    const broken = { getItem: () => { throw new Error("blocked"); }, setItem: () => { throw new Error("full"); } };
    expect(readSidebarMode(broken)).toBe("open");
    expect(() => { writeSidebarMode("hidden", broken); }).not.toThrow();
    expect(readSidebarMode(null)).toBe("open");
  });
  test("the shortcut is Cmd or Ctrl+B alone; it folds an open sidebar and opens a folded one", () => {
    const base = { key: "b", metaKey: false, ctrlKey: false, altKey: false, shiftKey: false };
    expect(isSidebarShortcut({ ...base, metaKey: true })).toBe(true);
    expect(isSidebarShortcut({ ...base, ctrlKey: true })).toBe(true);
    expect(isSidebarShortcut(base)).toBe(false);
    expect(isSidebarShortcut({ ...base, metaKey: true, shiftKey: true })).toBe(false);
    expect(isSidebarShortcut({ ...base, metaKey: true, ctrlKey: true })).toBe(false);
    expect([toggledMode("open"), toggledMode("rail"), toggledMode("hidden")]).toEqual(["rail", "open", "open"]);
  });
});

for (const [name, shell] of shells) {
  describe(`sidebar collapse in the ${name}`, () => {
    test("open by default with the chevron; collapse to the rail and expand again, focus follows", async () => {
      mount(shell());
      await screen.findAllByText("Hello");
      expect(layout().getAttribute("data-side")).toBe("open");
      const collapse = screen.getByRole("button", { name: "Collapse chats sidebar" });
      expect(collapse.getAttribute("aria-expanded")).toBe("true");
      expect(collapse.getAttribute("aria-controls")).toBe("chats-side");
      expect(document.getElementById("chats-side")).not.toBeNull();
      fireEvent.click(collapse);
      expect(layout().getAttribute("data-side")).toBe("rail");
      expect(localStorage.getItem(SIDEBAR_MODE_KEY)).toBe("rail");
      const expand = screen.getByRole("button", { name: "Expand chats sidebar" });
      expect(expand.getAttribute("aria-expanded")).toBe("false");
      expect(document.activeElement).toBe(expand);
      expect(document.querySelector(".side-full")?.hasAttribute("hidden")).toBe(true);
      expect(screen.getByRole("link", { name: "New chat" }).getAttribute("href")).toBe("#/chats/new");
      expect(screen.getByRole("button", { name: "Search chats" })).not.toBeNull();
      fireEvent.click(expand);
      expect(layout().getAttribute("data-side")).toBe("open");
      expect(document.activeElement?.id).toBe("side-collapse");
      expect(document.querySelector(".side-full")?.hasAttribute("hidden")).toBe(false);
      expect(screen.queryByRole("navigation", { name: "Chats (collapsed)" })).toBeNull();
    });

    test("hide completely: a floating menu button brings it back", async () => {
      mount(shell());
      await screen.findAllByText("Hello");
      fireEvent.click(screen.getByRole("button", { name: "Hide chats sidebar" }));
      expect(layout().getAttribute("data-side")).toBe("hidden");
      const float = screen.getByRole("button", { name: "Show chats sidebar" });
      expect(document.activeElement).toBe(float);
      expect(float.getAttribute("aria-expanded")).toBe("false");
      expect(screen.queryByRole("navigation", { name: "Chats (collapsed)" })).toBeNull();
      fireEvent.click(float);
      expect(layout().getAttribute("data-side")).toBe("open");
      expect(screen.queryByRole("button", { name: "Show chats sidebar" })).toBeNull();
    });

    test("the saved state is restored on load", async () => {
      writeSidebarMode("rail");
      const view = mount(shell());
      await screen.findByRole("button", { name: "Expand chats sidebar" });
      expect(layout().getAttribute("data-side")).toBe("rail");
      view.unmount();
      writeSidebarMode("hidden");
      mount(shell());
      await screen.findByRole("button", { name: "Show chats sidebar" });
      expect(layout().getAttribute("data-side")).toBe("hidden");
    });

    test("Cmd+B and Ctrl+B toggle it", async () => {
      mount(shell());
      await screen.findAllByText("Hello");
      key({ key: "b", metaKey: true });
      expect(layout().getAttribute("data-side")).toBe("rail");
      key({ key: "b", ctrlKey: true });
      expect(layout().getAttribute("data-side")).toBe("open");
      key({ key: "b" });
      expect(layout().getAttribute("data-side")).toBe("open");
      expect(readSidebarMode()).toBe("open");
    });

    test("Ctrl+K from the rail opens the sidebar and focuses the search", async () => {
      writeSidebarMode("rail");
      mount(shell());
      await screen.findByRole("button", { name: "Expand chats sidebar" });
      key({ key: "k", ctrlKey: true });
      expect(layout().getAttribute("data-side")).toBe("open");
      await waitFor(() => { expect(document.activeElement?.id).toBe("chat-search"); });
    });

    test("the rail shows an amber dot only while a chat waits for an answer", async () => {
      writeSidebarMode("rail");
      const view = mount(shell());
      await screen.findByRole("button", { name: "Expand chats sidebar" });
      await waitFor(() => { expect(document.querySelector("[data-testid=rail-dot]")).toBeNull(); });
      view.unmount();
      rows = [row({ awaiting_answer: true })];
      mount(shell());
      await waitFor(() => { expect(document.querySelector("[data-testid=rail-dot]")).not.toBeNull(); });
      expect(screen.getByRole("button", { name: /a chat is waiting for your answer/ })).not.toBeNull();
    });

    test("under 900px it stays the drawer: no collapse controls, a saved rail is ignored", async () => {
      setWidth(false);
      writeSidebarMode("rail");
      mount(shell());
      await screen.findAllByText("Hello");
      expect(layout().getAttribute("data-side")).toBe("open");
      expect(screen.queryByRole("button", { name: "Collapse chats sidebar" })).toBeNull();
      expect(screen.queryByRole("button", { name: "Expand chats sidebar" })).toBeNull();
      expect(screen.getAllByRole("button", { name: "Projects and chats" }).length).toBeGreaterThan(0);
      key({ key: "b", metaKey: true });
      expect(layout().hasAttribute("data-drawer")).toBe(true);
      expect(readSidebarMode()).toBe("rail");
    });
  });
}

describe("sidebar collapse styles", () => {
  const css = readFileSync(join(import.meta.dir, "chats-start.css"), "utf8");
  test("a 48px rail, a 150ms width animation, none under reduced motion, wide screens only", () => {
    expect(css).toMatch(/\[data-side="rail"\] \{ grid-template-columns: 48px/);
    expect(css).toMatch(/transition: grid-template-columns 150ms/);
    expect(css).toMatch(/min-width: 900px\) and \(prefers-reduced-motion: reduce\)[\s\S]*transition: none/);
    expect(css).toContain("--wa");
  });
});

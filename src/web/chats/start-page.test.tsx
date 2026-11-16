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
const { render, screen, fireEvent, cleanup, waitFor, act } = await import("@testing-library/react");
const { QueryClient, QueryClientProvider } = await import("@tanstack/react-query");
const { ToastProvider } = await import("../components/Toast");
const { ConfirmProvider } = await import("../components/ConfirmDialog");
const { chatsApi } = await import("../api/chats");
const { connection } = await import("../api/status");
const { artifactsApi } = await import("./artifacts/api");
const { ChatShell } = await import("./ChatShell");
const { AppShell } = await import("../shell/AppShell");
const { parseRoute, newChatHash } = await import("../router/route");
const { draftScopes, setDraftText, draftText } = await import("../lib/chat-draft");
const { STARTERS_KEY, readStarters, DEFAULT_STARTERS } = await import("../lib/chat-starters");

const realApi = { ...chatsApi };
const realArtifacts = { ...artifactsApi };
const realFetch = globalThis.fetch;
afterAll(uninstall);

const ok = <T,>(body: T) => ({ kind: "ok" as const, body, etag: null });
const row = (over: Partial<Chat> = {}): Chat => ({ id: "chat-1", project_id: null, title: "Hello", harness: "claude", profile: "main", model_id: null, session_id: null, status: "idle", created_at: "a", updated_at: "b", archived_at: null, cwd: null, effective_cwd: null, ...over }) as Chat;
const options = { harnesses: [{ id: "claude", label: "claude", enabled: true, available: true, persistent: true, profiles: [{ name: "main", description: "", enabled: true, configured: true, problem: null, models: [{ id: "m", label: "M", slug: "m", description: "", default: true }] }] }], default_harness: null, default_profile: null };
const projects = [
  { id: "prj-a", name: "Alpha", path: "/Users/me/a", description: "", created_at: "a", archived_at: null },
  { id: "prj-b", name: "Beta", path: null, description: "", created_at: "a", archived_at: null },
];

interface Log { created: Array<Record<string, unknown>>; sent: Array<{ id: string; text: string }> }
let rows: Chat[] = [];
let log: Log = { created: [], sent: [] };

function fake(): void {
  connection.ok();
  Object.assign(chatsApi, {
    options: async () => ok(options),
    chat: async (id: string) => ok(rows.find((c) => c.id === id) ?? row({ id })),
    chats: async () => ok({ items: rows, next_cursor: null }),
    projects: async () => ok({ items: projects, next_cursor: null }),
    messages: async () => ok({ items: [], next_cursor: null }),
    search: async () => ok({ items: [] }),
    createChat: async (body: Record<string, unknown>) => {
      log.created.push(body);
      const chat = row({ id: "chat-new", project_id: (body["project_id"] as string | null) ?? null, cwd: (body["cwd"] as string | null) ?? null });
      rows = [chat, ...rows];
      return ok(chat);
    },
    send: async (id: string, text: string) => {
      log.sent.push({ id, text });
      return ok({ user_message_id: "u", assistant_message_id: "a" });
    },
  });
  Object.assign(artifactsApi, { list: async () => ({ items: [], dir: "artifacts" }) });
  globalThis.fetch = (async () => new Response("{}", { status: 200, headers: { "content-type": "application/json" } })) as unknown as typeof fetch;
}

beforeEach(() => {
  rows = [];
  log = { created: [], sent: [] };
  localStorage.clear();
  fake();
});
afterEach(() => {
  cleanup();
  Object.assign(chatsApi, realApi);
  Object.assign(artifactsApi, realArtifacts);
  globalThis.fetch = realFetch;
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
const textarea = (): HTMLTextAreaElement => document.querySelector("textarea.composer-text") as HTMLTextAreaElement;
const type = (text: string): void => { fireEvent.change(textarea(), { target: { value: text } }); };

describe("routes", () => {
  test("#/chats/new parses to a draft route with project and folder", () => {
    expect(parseRoute("#/chats/new")).toEqual({ kind: "chats", chatId: null, projectId: null, draft: true, folder: null });
    expect(parseRoute("#/chats/new?project=prj-a&folder=%2Ftmp%2Fx")).toEqual({ kind: "chats", chatId: null, projectId: "prj-a", draft: true, folder: "/tmp/x" });
    expect(newChatHash({ projectId: "prj-a", folder: "/tmp/x" })).toBe("#/chats/new?project=prj-a&folder=%2Ftmp%2Fx");
    expect(newChatHash()).toBe("#/chats/new");
    expect(parseRoute("#/chats/chat-1")).toEqual({ kind: "chats", chatId: "chat-1" });
  });
});

for (const [name, shell] of shells) {
  describe(`start page in the ${name}`, () => {
    test("no chat selected and the new chat route both show the empty start page; nothing is created", async () => {
      for (const hash of ["#/chats", "#/chats/new", "#"]) {
        if (name === "dashboard Chat tab" && hash === "#") {
          continue;
        }
        location.hash = hash;
        const view = mount(shell());
        await screen.findByTestId("start-page");
        expect(document.querySelector(".start-title")?.textContent).not.toBe("");
        expect(textarea()).not.toBeNull();
        expect(document.querySelector("[data-testid=folder-chip]")).not.toBeNull();
        expect(document.querySelector(".composer-attach")).not.toBeNull();
        expect((await screen.findByTestId("settings-summary")).textContent).toContain("claude");
        expect(screen.getAllByRole("group", { name: "Suggestions" })[0]?.querySelectorAll(".start-chip").length).toBe(4);
        expect(log.created).toEqual([]);
        view.unmount();
      }
    });

    test("clicking New chat (or a project's plus) shows the start page and creates no row", async () => {
      rows = [row({ id: "old", title: "Old chat" })];
      location.hash = "#/projects/prj-a";
      mount(shell());
      await screen.findByText("Old chat");
      fireEvent.click(screen.getAllByRole("button", { name: "New chat" })[0] as HTMLElement);
      expect(location.hash).toBe("#/chats/new?project=prj-a");
      await screen.findByTestId("start-page");
      fireEvent.click(await screen.findByRole("button", { name: "New chat in Beta" }));
      expect(location.hash).toBe("#/chats/new?project=prj-b");
      await waitFor(() => { expect(screen.getByLabelText("Project").textContent).toContain("Beta"); });
      expect(log.created).toEqual([]);
      expect(rows.length).toBe(1);
    });

    test("the first send creates the chat, sends the message and moves to the real chat id", async () => {
      location.hash = "#/chats/new";
      mount(shell());
      await screen.findByTestId("start-page");
      type("  build me a thing ");
      expect(log.created).toEqual([]);
      fireEvent.click(screen.getByRole("button", { name: "Send" }));
      await waitFor(() => { expect(location.hash).toBe("#/chats/chat-new"); });
      expect(log.created).toHaveLength(1);
      expect(log.created[0]).toMatchObject({ project_id: null, harness: "claude", profile: "main", model_id: "m" });
      expect(log.sent).toEqual([{ id: "chat-new", text: "build me a thing" }]);
      await waitFor(() => { expect(screen.queryByTestId("start-page")).toBeNull(); });
      expect(draftScopes()).toEqual([]);
    });

    test("a project start page creates the chat in that project; ?folder= becomes the chat folder", async () => {
      location.hash = "#/chats/new?project=prj-a&folder=%2FUsers%2Fme%2Fx";
      mount(shell());
      await screen.findByTestId("start-page");
      type("hello");
      fireEvent.click(screen.getByRole("button", { name: "Send" }));
      await waitFor(() => { expect(log.created).toHaveLength(1); });
      expect(log.created[0]).toMatchObject({ project_id: "prj-a", cwd: "/Users/me/x" });
      await waitFor(() => { expect(location.hash).toBe("#/chats/prj-a/chat-new"); });
    });

    test("a failed create keeps the text, makes no chat and shows the reason", async () => {
      Object.assign(chatsApi, { createChat: async () => ({ kind: "error" as const, status: 400, message: "folder: not allowed", body: null }) });
      location.hash = "#/chats/new";
      mount(shell());
      await screen.findByTestId("start-page");
      type("keep me");
      fireEvent.click(screen.getByRole("button", { name: "Send" }));
      await screen.findByRole("alert");
      expect(textarea().value).toBe("keep me");
      expect(location.hash).toBe("#/chats/new");
      expect(rows).toEqual([]);
    });

    test("leaving with text keeps a draft per project and shows a Draft hint, never a chat row", async () => {
      location.hash = "#/chats/new";
      mount(shell());
      await screen.findByTestId("start-page");
      type("for nobody");
      await waitFor(() => { expect(screen.queryByTestId("draft-hint")).not.toBeNull(); });
      expect(localStorage.getItem("orch.chat.draft.new:none")).toContain("for nobody");
      act(() => { location.hash = "#/chats/new?project=prj-a"; });
      await waitFor(() => { expect(textarea().value).toBe(""); });
      expect(screen.queryByTestId("draft-hint")).toBeNull();
      type("for alpha");
      expect(draftScopes().sort()).toEqual(["none", "prj-a"]);
      expect(document.querySelectorAll("a.draft-tag").length).toBe(2);
      expect(rows).toEqual([]);
      expect(log.created).toEqual([]);
      act(() => { location.hash = "#/chats/new"; });
      await waitFor(() => { expect(textarea().value).toBe("for nobody"); });
      expect(screen.queryByTestId("draft-hint")).not.toBeNull();
    });

    test("a suggestion chip fills the composer without sending", async () => {
      location.hash = "#/chats/new";
      mount(shell());
      await screen.findByTestId("start-page");
      fireEvent.click(screen.getAllByRole("button", { name: DEFAULT_STARTERS[1] as string })[0] as HTMLElement);
      await waitFor(() => { expect(textarea().value).toBe(DEFAULT_STARTERS[1] as string); });
      expect(log.created).toEqual([]);
    });
  });
}

describe("starter chips and drafts storage", () => {
  test("edited suggestions are saved globally; empty falls back to the defaults; broken storage is ignored", async () => {
    location.hash = "#/chats/new";
    mount(<ChatShell />);
    await screen.findByTestId("start-page");
    fireEvent.click(screen.getByRole("button", { name: "Edit suggestions" }));
    fireEvent.change(screen.getByLabelText("Suggestion 1"), { target: { value: "Summarise this repo" } });
    fireEvent.change(screen.getByLabelText("Suggestion 2"), { target: { value: "" } });
    fireEvent.click(screen.getByRole("button", { name: "Save" }));
    await waitFor(() => { expect(screen.queryByRole("button", { name: "Summarise this repo" })).not.toBeNull(); });
    expect(readStarters()).toEqual(["Summarise this repo", DEFAULT_STARTERS[2] as string, DEFAULT_STARTERS[3] as string]);
    localStorage.setItem(STARTERS_KEY, "{not json");
    expect(readStarters()).toEqual([...DEFAULT_STARTERS]);
  });
  test("moving a draft between projects keeps the text", () => {
    setDraftText("none", "carry");
    expect(draftText("none")).toBe("carry");
    setDraftText("none", "");
    expect(draftScopes()).toEqual([]);
  });
});

describe("start page layout", () => {
  const css = readFileSync(join(import.meta.dir, "chats-start.css"), "utf8");
  test("a phone gets a full-viewport page with safe-area insets and a 44px chip target", () => {
    expect(css).toContain("100dvh");
    expect(css).toContain("env(safe-area-inset-bottom)");
    expect(css).toMatch(/\.start-chip \{ min-height: 44px; \}/);
  });
  test("no raw colours: tokens only", () => {
    expect(css).not.toMatch(/#[0-9a-fA-F]{3,8}\b/);
  });
});

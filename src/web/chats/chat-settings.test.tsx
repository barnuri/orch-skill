import { afterAll, afterEach, beforeEach, describe, expect, test } from "bun:test";
import { installDom } from "../test/dom";
import type { Chat } from "../lib/chat-types";

const uninstall = installDom();
for (const k of ["location", "history", "sessionStorage", "localStorage", "ResizeObserver", "matchMedia"] as const) {
  const w = window as unknown as Record<string, unknown>;
  if (w[k] !== undefined && (globalThis as Record<string, unknown>)[k] === undefined) {
    Object.defineProperty(globalThis, k, { value: w[k], configurable: true, writable: true });
  }
}
const { render, screen, fireEvent, cleanup, waitFor } = await import("@testing-library/react");
const { QueryClient, QueryClientProvider } = await import("@tanstack/react-query");
const { ToastProvider } = await import("../components/Toast");
const { ConfirmProvider } = await import("../components/ConfirmDialog");
const { chatsApi } = await import("../api/chats");
const { workspaceApi } = await import("../api/workspace");
const { connection } = await import("../api/status");
const { ChatShell } = await import("./ChatShell");
const { AppShell } = await import("../shell/AppShell");
const { Sidebar } = await import("./Sidebar");
const { takeStartSeed } = await import("./start-seed");
const { WorkspacePanel } = await import("./WorkspacePanel");
const { CHAT_PREFS_KEY, readChatPrefs } = await import("../lib/chat-prefs");

const realApi = { ...chatsApi };
const realWs = { ...workspaceApi };
const realFetch = globalThis.fetch;
beforeEach(() => {
  localStorage.removeItem(CHAT_PREFS_KEY);
});
afterEach(() => {
  cleanup();
  Object.assign(chatsApi, realApi);
  Object.assign(workspaceApi, realWs);
  globalThis.fetch = realFetch;
});
afterAll(uninstall);

const ok = <T,>(body: T) => ({ kind: "ok" as const, body, etag: null });
const model = { id: "m", label: "M", slug: "m", description: "", default: true };
const profile = { name: "main", description: "", enabled: true, configured: true, problem: null, models: [model] };
const options = {
  harnesses: [
    { id: "claude", label: "claude", enabled: true, available: true, persistent: true, efforts: ["low", "medium", "high", "max"], profiles: [profile] },
    { id: "pi", label: "pi", enabled: true, available: true, persistent: false, efforts: [], profiles: [{ ...profile, name: "pip" }] },
  ],
  default_harness: "claude", default_profile: "main",
};
function chatRow(over: Partial<Chat> = {}): Chat {
  return { id: "chat-1", project_id: null, title: "Hello", harness: "claude", profile: "main", model_id: null, session_id: null, status: "idle", created_at: "a", updated_at: "b", archived_at: null, cwd: "/Users/me/x", effective_cwd: "/Users/me/x", effort: null, ...over } as Chat;
}
function fake(chat: Chat = chatRow(), extra: Record<string, unknown> = {}): void {
  connection.ok();
  Object.assign(chatsApi, {
    options: async () => ok(options),
    chat: async () => ok({ ...chat }),
    chats: async () => ok({ items: [{ ...chat }], next_cursor: null }),
    projects: async () => ok({ items: [], next_cursor: null }),
    messages: async () => ok({ items: [], next_cursor: null }),
    searchChats: async () => ok({ items: [] }),
    ...extra,
  });
  globalThis.fetch = (async () => new Response("{}", { status: 200, headers: { "content-type": "application/json" } })) as unknown as typeof fetch;
}
function mount(node: React.ReactNode) {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return render(<QueryClientProvider client={client}><ToastProvider><ConfirmProvider>{node}</ConfirmProvider></ToastProvider></QueryClientProvider>);
}
const toggle = (): HTMLElement => screen.getByRole("button", { name: "Chat settings" });
const panelOf = (): HTMLElement => document.getElementById(toggle().getAttribute("aria-controls") as string) as HTMLElement;

describe("chat settings fold", () => {
  for (const [name, shell] of [["dashboard shell", () => <AppShell />], ["chat-only shell", () => <ChatShell />]] as const) {
    test(`${name}: closed by default, opens and closes, and the choice outlives a remount and another chat`, async () => {
      fake();
      location.hash = "#/chats/chat-1";
      const first = mount(shell());
      await screen.findByTestId("settings-summary");
      expect(screen.getByTestId("settings-summary").textContent).toBe("claude · main · M");
      expect(toggle().getAttribute("aria-expanded")).toBe("false");
      expect(panelOf().hasAttribute("inert")).toBe(true);
      fireEvent.click(toggle());
      expect(toggle().getAttribute("aria-expanded")).toBe("true");
      expect(panelOf().hasAttribute("inert")).toBe(false);
      expect(panelOf().querySelector("[data-testid=pickers]")).not.toBeNull();
      expect(readChatPrefs().settingsOpen).toBe(true);
      first.unmount();
      cleanup();
      fake(chatRow({ id: "chat-2", title: "Other" }));
      location.hash = "#/chats/chat-2";
      mount(shell());
      await screen.findByTestId("settings-summary");
      expect(toggle().getAttribute("aria-expanded")).toBe("true");
      fireEvent.click(toggle());
      expect(toggle().getAttribute("aria-expanded")).toBe("false");
      expect(readChatPrefs().settingsOpen).toBe(false);
    });
  }

  test("a warning stays on the summary line while closed; a failed reply is an error badge", async () => {
    fake(chatRow({ warning: "Folder /x no longer exists: the agent runs in a scratch folder instead." } as Partial<Chat>));
    location.hash = "#/chats/chat-1";
    mount(<ChatShell />);
    const badge = await screen.findByTestId("settings-badge");
    expect(toggle().getAttribute("aria-expanded")).toBe("false");
    expect(badge.getAttribute("data-tone")).toBe("warn");
    expect(badge.textContent).toContain("no longer exists");
    cleanup();
    fake(chatRow(), {
      messages: async () => ok({ items: [{ id: "msg-1", chat_id: "chat-1", role: "assistant", content: "", status: "error", error: "boom", model_used: null, input_tokens: 0, output_tokens: 0, cost_usd: null, started_at: null, finished_at: null, created_at: "a", context_truncated: 0, warning: null, parts: null, attachments: [] }], next_cursor: null }),
    });
    mount(<ChatShell />);
    await waitFor(() => { expect(screen.getByTestId("settings-badge").getAttribute("data-tone")).toBe("error"); });
  });

  test("a chat whose harness was never set shows an amber badge", async () => {
    fake(chatRow({ harness: "", profile: "" }));
    location.hash = "#/chats/chat-1";
    mount(<ChatShell />);
    const badge = await screen.findByTestId("settings-badge");
    expect(badge.getAttribute("data-tone")).not.toBe(null);
  });
});

describe("effort control", () => {
  test("shown in the summary, offers Auto and the levels, and sends the level with the config", async () => {
    const sent: unknown[] = [];
    fake(chatRow({ effort: "high" }), { configure: async (_id: string, body: unknown) => { sent.push(body); return ok({ chat: chatRow({ effort: "low" }) }); } });
    location.hash = "#/chats/chat-1";
    mount(<ChatShell />);
    await screen.findByTestId("settings-summary");
    expect(screen.getByTestId("settings-summary").textContent).toBe("claude · main · M · high");
    fireEvent.click(toggle());
    const effort = screen.getByTestId("picker-effort");
    fireEvent.click(effort.querySelector("button") as HTMLElement);
    for (const label of ["Auto", "Low", "Medium", "High", "Max"]) {
      expect(screen.getAllByRole("option").map((o) => o.textContent)).toContain(label);
    }
    fireEvent.click(screen.getAllByRole("option").find((o) => o.textContent === "Low") as HTMLElement);
    await waitFor(() => { expect(sent).toEqual([{ harness: "claude", profile: "main", model_id: null, effort: "low" }]); });
  });

  test("a harness without levels shows one line instead of a control", async () => {
    fake(chatRow({ harness: "pi", profile: "pip" }));
    location.hash = "#/chats/chat-1";
    mount(<ChatShell />);
    await screen.findByTestId("settings-summary");
    expect(screen.queryByTestId("picker-effort")).toBeNull();
    expect(screen.getByTestId("effort-hint").textContent).toContain("no effort");
  });
});

describe("new chat from a group header", () => {
  test("every header has a plus button that opens the start page for that project (nothing is created), seeded with the group's harness", async () => {
    const created: unknown[] = [];
    const projects = [
      { id: "prj-a", name: "Alpha", path: "/Users/me/a", description: "", created_at: "a", archived_at: null },
      { id: "prj-b", name: "Beta", path: null, description: "", created_at: "a", archived_at: null },
    ];
    const chats = [chatRow({ id: "c1", project_id: "prj-a", harness: "pi", profile: "pip" }), chatRow({ id: "c2", project_id: null })];
    fake(chatRow(), {
      projects: async () => ok({ items: projects, next_cursor: null }),
      chats: async () => ok({ items: chats, next_cursor: null }),
      createChat: async (body: { project_id: string | null }) => { created.push(body); return ok(chatRow({ id: "chat-new", project_id: body.project_id })); },
    });
    mount(<Sidebar activeChatId={null} activeProjectId={null} options={options as never} onNavigate={() => undefined} />);
    await screen.findByRole("button", { name: "New chat in Alpha" });
    expect(screen.getAllByRole("button", { name: /^New chat in / }).map((b) => b.getAttribute("aria-label"))).toEqual(["New chat in Alpha", "New chat in Beta", "New chat in No project"]);
    expect([...document.querySelectorAll(".group-count")].map((n) => n.textContent)).toEqual(["1", "0", "1"]);
    fireEvent.click(screen.getByRole("button", { name: "New chat in Alpha" }));
    expect(location.hash).toBe("#/chats/new?project=prj-a");
    expect(takeStartSeed()).toEqual({ harness: "pi", profile: "pip", model: null });
    fireEvent.click(screen.getByRole("button", { name: "New chat in Beta" }));
    expect(location.hash).toBe("#/chats/new?project=prj-b");
    expect(takeStartSeed()).toBeNull();
    fireEvent.click(screen.getByRole("button", { name: "New chat in No project" }));
    expect(location.hash).toBe("#/chats/new");
    takeStartSeed();
    expect(created).toEqual([]);
  });
});

describe("workspace panel", () => {
  const file = (name: string) => ({ name, size: 12, modified: "2026-11-15T10:00:00Z", type: "text/plain", preview: "text" as const });
  function fakeWorkspace(): { saves: Array<[string, string]>; infos: string[] } {
    const log = { saves: [] as Array<[string, string]>, infos: [] as string[] };
    Object.assign(workspaceApi, {
      info: async (_id: string, scope: string) => {
        log.infos.push(scope);
        return ok({ scope, path: scope === "chat" ? "/Users/me/x/.orch/chats/chat-1" : "/Users/me/x/.orch/shared", exists: true, has_folder: true, moved_from: scope === "chat" ? "/old/.orch/chats/chat-1" : null, memory_size: 3, files: { knowledge: [file(scope === "chat" ? "notes.md" : "shared.md")], artifacts: [file("out.txt")] } });
      },
      memory: async (_id: string, scope: string) => ok({ content: `${scope} memory`, exists: true, modified: null }),
      saveMemory: async (_id: string, scope: string, content: string) => { log.saves.push([scope, content]); return ok({ content, exists: true, modified: null }); },
    });
    return log;
  }

  test("tabs switch, memory saves, the scope switch reloads the other workspace, and a move note shows", async () => {
    const log = fakeWorkspace();
    mount(<WorkspacePanel chat={chatRow()} onClose={() => undefined} />);
    const text = (await screen.findByTestId("ws-memory-text")) as HTMLTextAreaElement;
    await waitFor(() => { expect(text.value).toBe("chat memory"); });
    expect((await screen.findByTestId("ws-moved")).textContent).toContain("/old/.orch/chats/chat-1");
    const save = screen.getByRole("button", { name: "Save memory" }) as HTMLButtonElement;
    expect(save.disabled).toBe(true);
    fireEvent.change(text, { target: { value: "chat memory\n- new fact" } });
    expect(save.disabled).toBe(false);
    fireEvent.click(save);
    await waitFor(() => { expect(log.saves).toEqual([["chat", "chat memory\n- new fact"]]); });
    fireEvent.click(screen.getByRole("tab", { name: "Knowledge" }));
    expect(await screen.findByText("notes.md")).toBeTruthy();
    expect(screen.getByRole("button", { name: "Upload files" })).toBeTruthy();
    fireEvent.click(screen.getByRole("tab", { name: "Artifacts" }));
    expect(await screen.findByText("out.txt")).toBeTruthy();
    expect(screen.queryByRole("button", { name: "Upload files" })).toBeNull();
    fireEvent.click(screen.getByRole("button", { name: "This folder" }));
    fireEvent.click(screen.getByRole("tab", { name: "Memory" }));
    await waitFor(() => { expect((screen.getByTestId("ws-memory-text") as HTMLTextAreaElement).value).toBe("folder memory"); });
    expect(log.infos).toContain("folder");
    expect(screen.getByText("/Users/me/x/.orch/shared")).toBeTruthy();
    expect(screen.queryByTestId("ws-moved")).toBeNull();
  });

  test("a chat without a folder cannot pick the folder scope", async () => {
    fakeWorkspace();
    mount(<WorkspacePanel chat={chatRow({ cwd: null, effective_cwd: null })} onClose={() => undefined} />);
    await screen.findByTestId("ws-memory-text");
    expect((screen.getByRole("button", { name: "This folder" }) as HTMLButtonElement).disabled).toBe(true);
  });
});

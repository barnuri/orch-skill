import { afterAll, afterEach, describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { installDom } from "../test/dom";
import type { Chat } from "../lib/chat-types";

const uninstall = installDom();
const { render, screen, fireEvent, cleanup, waitFor } = await import("@testing-library/react");
const { QueryClient, QueryClientProvider } = await import("@tanstack/react-query");
const { ToastProvider } = await import("../components/Toast");
const { chatsApi } = await import("../api/chats");
const { Header } = await import("./ChatView");
const { useChat } = await import("./queries");
const { ChatListRow } = await import("./ChatListRow");
const { FolderChip, FolderPicker, folderName } = await import("./FolderPicker");

const realApi = { ...chatsApi };
afterEach(() => {
  cleanup();
  Object.assign(chatsApi, realApi);
});
afterAll(uninstall);

const ok = <T,>(body: T) => ({ kind: "ok" as const, body, etag: null });
const ROOT = "/Users/me/sandbox/private";
const LIST = {
  root: ROOT, roots: [ROOT], truncated: false,
  items: [
    { path: `${ROOT}/zeta`, name: "zeta", last_used_at: "2026-11-15T00:00:00Z" },
    { path: `${ROOT}/alpha`, name: "alpha", last_used_at: null },
    { path: `${ROOT}/orch-skill`, name: "orch-skill", last_used_at: null },
  ],
};

function chatRow(over: Partial<Chat> = {}): Chat {
  return { id: "chat-1", project_id: null, title: "T", harness: "claude", profile: "main", model_id: null, session_id: null, status: "idle", created_at: "a", updated_at: "b", archived_at: null, cwd: null, effective_cwd: null, ...over } as Chat;
}

function wrap(node: React.ReactNode) {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return render(<QueryClientProvider client={client}><ToastProvider>{node}</ToastProvider></QueryClientProvider>);
}

function fakeFolders(accept: (path: string | null) => string | null = () => null) {
  const calls: Array<string | undefined> = [];
  const set: Array<string | null> = [];
  const state = { chat: chatRow() };
  Object.assign(chatsApi, {
    folders: async (root?: string) => { calls.push(root); return ok(LIST); },
    chat: async () => ok({ ...state.chat }),
    chats: async () => ok({ items: [{ ...state.chat }], next_cursor: null }),
    projects: async () => ok({ items: [], next_cursor: null }),
    setChatFolder: async (_id: string, path: string | null) => {
      set.push(path);
      const bad = accept(path);
      if (bad !== null) {
        return { kind: "error" as const, status: 400, body: { error: bad }, etag: null };
      }
      state.chat = { ...state.chat, cwd: path, effective_cwd: path };
      return ok({ chat: { ...state.chat } });
    },
  });
  return { calls, set, state };
}

describe("folder chip", () => {
  test("shows the last folder name with the full path as tooltip, and nothing without a path", () => {
    expect(folderName(`${ROOT}/orch-skill/`)).toBe("orch-skill");
    const { container } = render(<FolderChip path={`${ROOT}/orch-skill`} />);
    const chip = container.querySelector("[data-testid=folder-chip]") as HTMLElement;
    expect(chip.textContent).toContain("orch-skill");
    expect(chip.getAttribute("title")).toBe(`${ROOT}/orch-skill`);
    cleanup();
    expect(render(<FolderChip path={null} />).container.innerHTML).toBe("");
  });

  test("a chat row shows its folder chip, marked as inherited from the project", () => {
    const { container } = wrap(<ChatListRow chat={chatRow({ effective_cwd: `${ROOT}/a`, cwd: null })} href="#/chats/chat-1" meta="claude" />);
    expect(container.querySelector(".thread-meta")?.textContent).toContain("a (project)");
    cleanup();
    const own = wrap(<ChatListRow chat={chatRow({ effective_cwd: `${ROOT}/a`, cwd: `${ROOT}/a` })} href="#/chats/chat-1" meta="claude" />);
    expect(own.container.querySelector(".thread-meta")?.textContent).not.toContain("(project)");
  });
});

describe("folder picker", () => {
  test("lists the folders in server order, filters by search, and picking one calls onPick and closes", async () => {
    fakeFolders();
    const picked: Array<string | null> = [];
    let closed = 0;
    wrap(<FolderPicker title="Folder" current={null} onPick={async (p) => { picked.push(p); return null; }} onClose={() => { closed++; }} />);
    await screen.findByText("zeta");
    expect(Array.from(document.querySelectorAll(".folder-item-name")).map((n) => n.textContent)).toEqual(["zeta", "alpha", "orch-skill"]);
    fireEvent.change(screen.getByRole("searchbox", { name: "Search folders" }), { target: { value: "ORCH" } });
    expect(Array.from(document.querySelectorAll(".folder-item-name")).map((n) => n.textContent)).toEqual(["orch-skill"]);
    fireEvent.click(screen.getByText("orch-skill"));
    await waitFor(() => { expect(closed).toBe(1); });
    expect(picked).toEqual([`${ROOT}/orch-skill`]);
  });

  test("browsing inside a folder asks the server for it; a free path is sent as typed and a server error is shown and keeps the picker open", async () => {
    const f = fakeFolders();
    let closed = 0;
    wrap(<FolderPicker title="Folder" current={null} onClose={() => { closed++; }} onPick={async (p) => (p === "/etc" ? "folder: /etc is outside the allowed roots" : null)} />);
    fireEvent.click(await screen.findByRole("button", { name: "Browse inside alpha" }));
    await waitFor(() => { expect(f.calls).toContain(`${ROOT}/alpha`); });
    fireEvent.change(screen.getByRole("textbox", { name: "Folder path" }), { target: { value: "/etc" } });
    fireEvent.click(screen.getByRole("button", { name: "Use path" }));
    expect((await screen.findByTestId("folder-error")).textContent).toContain("outside the allowed roots");
    expect(closed).toBe(0);
  });

  test("Clear folder sends null when a folder is set", async () => {
    fakeFolders();
    const picked: Array<string | null> = [];
    wrap(<FolderPicker title="Folder" current={`${ROOT}/alpha`} onPick={async (p) => { picked.push(p); return null; }} onClose={() => undefined} />);
    fireEvent.click(await screen.findByRole("button", { name: "Clear folder" }));
    await waitFor(() => { expect(picked).toEqual([null]); });
  });
});

describe("chat header folder", () => {
  function Host() {
    const chat = useChat("chat-1").data;
    return chat === undefined ? null : <Header chat={chat} options={undefined} modelUsed={null} lastReply={null} projects={[]} onOpenDrawer={() => undefined} />;
  }

  test("the chip opens the picker; choosing a folder saves it and the chip shows it", async () => {
    const f = fakeFolders();
    wrap(<Host />);
    fireEvent.click(await screen.findByRole("button", { name: "Choose folder" }));
    fireEvent.click(await screen.findByText("alpha"));
    await waitFor(() => { expect(f.set).toEqual([`${ROOT}/alpha`]); });
    await waitFor(() => { expect(screen.getByTestId("folder-chip").textContent).toContain("alpha"); });
    expect(document.querySelector(".folder-dialog")).toBeNull();
  });

  test("a running chat says the change applies from the next message", async () => {
    fakeFolders().state.chat = chatRow({ status: "running", cwd: `${ROOT}/alpha`, effective_cwd: `${ROOT}/alpha` });
    wrap(<Host />);
    expect((await screen.findByText(/applies from the next message/)).textContent).toBeTruthy();
  });
});

describe("mobile layout", () => {
  const css = readFileSync(join(import.meta.dir, "chats.css"), "utf8");
  test("the picker becomes a full-width bottom sheet with 44px touch targets on phones, and errors are the only red", () => {
    const at = css.indexOf("@media (max-width: 768px), (max-height: 500px) and (pointer: coarse) {\n  .folder-overlay");
    expect(at).toBeGreaterThan(-1);
    const block = css.slice(at, css.indexOf("\n}", at));
    expect(block).toContain("align-items: flex-end");
    expect(block).toContain("min-height: 44px");
    expect(css).toMatch(/\.folder-error \{[^}]*var\(--er\)/);
  });
});

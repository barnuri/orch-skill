import { afterAll, afterEach, describe, expect, test } from "bun:test";
import { installDom } from "../test/dom";
import type { Chat } from "../lib/chat-types";

const uninstall = installDom();
const { render, screen, fireEvent, cleanup, waitFor, act } = await import("@testing-library/react");
const { QueryClient, QueryClientProvider } = await import("@tanstack/react-query");
const { ToastProvider } = await import("../components/Toast");
const { chatsApi } = await import("../api/chats");
const { Header } = await import("./ChatView");
const { useChat } = await import("./queries");
const { Sidebar } = await import("./Sidebar");
const { checkTitle } = await import("./rename");
const { isRenameKey } = await import("./ChatListRow");

const realApi = { ...chatsApi };
afterEach(() => {
  cleanup();
  Object.assign(chatsApi, realApi);
});
afterAll(uninstall);

const ok = <T,>(body: T) => ({ kind: "ok" as const, body, etag: null });
const fail = { kind: "error" as const, status: 500, body: { error: "disk full" }, etag: null };

function chatRow(over: Partial<Chat> = {}): Chat {
  return { id: "chat-1", project_id: null, title: "Old title", harness: "claude", profile: "main", model_id: null, session_id: null, status: "idle", created_at: "2026-11-15T00:00:00Z", updated_at: "2026-11-15T00:00:00Z", archived_at: null, ...over } as Chat;
}

/** A fake server: one chat whose title a rename changes, unless `failRename` is set. */
function fakeServer(opts: { failRename?: boolean } = {}) {
  const state = { chat: chatRow(), renames: [] as string[] };
  Object.assign(chatsApi, {
    chat: async () => ok({ ...state.chat }),
    chats: async () => ok({ items: [{ ...state.chat }], next_cursor: null }),
    projects: async () => ok({ items: [], next_cursor: null }),
    options: async () => ok({ harnesses: [], default_harness: null, default_profile: null }),
    messages: async () => ok({ items: [], next_cursor: null }),
    rename: async (_id: string, title: string) => {
      state.renames.push(title);
      if (opts.failRename === true) {
        return fail;
      }
      state.chat = { ...state.chat, title };
      return ok({ chat: { ...state.chat } });
    },
  });
  return state;
}

/** The header as ChatView mounts it: fed from the chat query, so cache updates show. */
function HeaderHost() {
  const chat = useChat("chat-1").data;
  return chat === undefined ? null : <Header chat={chat} options={undefined} modelUsed={null} lastReply={null} projects={[]} onOpenDrawer={() => undefined} />;
}

function wrap(node: React.ReactNode) {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return render(
    <QueryClientProvider client={client}>
      <ToastProvider>{node}</ToastProvider>
    </QueryClientProvider>,
  );
}

async function openHeaderEdit(): Promise<HTMLInputElement> {
  fireEvent.click(await screen.findByRole("button", { name: "Rename chat" }));
  return screen.getByRole("textbox", { name: "Chat title" }) as HTMLInputElement;
}

const titleButton = () => document.querySelector(".chat-title") as HTMLElement;

describe("title rules", () => {
  test("trims, refuses empty, caps at 200 and spots an unchanged title", () => {
    expect(checkTitle("  New  ", "Old")).toEqual({ kind: "save", title: "New" });
    expect(checkTitle("   ", "Old")).toEqual({ kind: "empty" });
    expect(checkTitle(" Old ", "Old")).toEqual({ kind: "same" });
    expect(checkTitle("y".repeat(250), "Old")).toEqual({ kind: "save", title: "y".repeat(200) });
  });
});

describe("chat header rename", () => {
  test("the pencil and the title both open the editor; Enter saves the trimmed title", async () => {
    const state = fakeServer();
    wrap(<HeaderHost />);
    fireEvent.click(await screen.findByRole("button", { name: "Old title" }));
    expect(screen.getByRole("textbox", { name: "Chat title" })).toBeTruthy();
    fireEvent.keyDown(screen.getByRole("textbox", { name: "Chat title" }), { key: "Escape" });
    const input = await openHeaderEdit();
    fireEvent.change(input, { target: { value: "  Fresh name  " } });
    fireEvent.keyDown(input, { key: "Enter" });
    await waitFor(() => {
      expect(titleButton().textContent).toBe("Fresh name");
    });
    expect(state.renames).toEqual(["Fresh name"]);
  });

  test("Escape cancels without a request", async () => {
    const state = fakeServer();
    wrap(<HeaderHost />);
    const input = await openHeaderEdit();
    fireEvent.change(input, { target: { value: "Something else" } });
    fireEvent.keyDown(input, { key: "Escape" });
    expect(titleButton().textContent).toBe("Old title");
    expect(state.renames).toEqual([]);
  });

  test("an empty title is refused with a toast and no request; an unchanged one sends nothing", async () => {
    const state = fakeServer();
    wrap(<HeaderHost />);
    let input = await openHeaderEdit();
    fireEvent.change(input, { target: { value: "   " } });
    fireEvent.keyDown(input, { key: "Enter" });
    expect(document.querySelector("#toasts")?.textContent).toContain("cannot be empty");
    expect(titleButton().textContent).toBe("Old title");
    input = await openHeaderEdit();
    fireEvent.change(input, { target: { value: " Old title " } });
    fireEvent.blur(input);
    await act(async () => {
      await Promise.resolve();
    });
    expect(state.renames).toEqual([]);
  });

  test("blur saves; a failed rename shows a toast and rolls back to the old title", async () => {
    const state = fakeServer({ failRename: true });
    wrap(<HeaderHost />);
    const input = await openHeaderEdit();
    fireEvent.change(input, { target: { value: "Doomed" } });
    fireEvent.blur(input);
    await waitFor(() => {
      expect(document.querySelector("#toasts")?.textContent).toContain("disk full");
    });
    expect(state.renames).toEqual(["Doomed"]);
    expect(titleButton().textContent).toBe("Old title");
  });
});

describe("chat list rename", () => {
  test("the row menu's Rename edits in place and the list updates", async () => {
    const state = fakeServer();
    wrap(<Sidebar activeChatId={null} activeProjectId={null} options={undefined} onNavigate={() => undefined} />);
    fireEvent.click(await screen.findByRole("button", { name: "Actions for Old title" }));
    fireEvent.click(screen.getByRole("menuitem", { name: "Rename" }));
    const input = screen.getByRole("textbox", { name: "Chat title" }) as HTMLInputElement;
    expect(input.value).toBe("Old title");
    fireEvent.change(input, { target: { value: "From the list" } });
    fireEvent.keyDown(input, { key: "Enter" });
    await screen.findByText("From the list");
    expect(state.renames).toEqual(["From the list"]);
  });

  test("F2 on a focused row starts the rename; Escape puts the link back", async () => {
    const state = fakeServer();
    wrap(<Sidebar activeChatId={null} activeProjectId={null} options={undefined} onNavigate={() => undefined} />);
    const link = (await screen.findByText("Old title")).closest("a") as HTMLAnchorElement;
    link.focus();
    fireEvent.keyDown(link, { key: "F2" });
    const input = screen.getByRole("textbox", { name: "Chat title" });
    fireEvent.keyDown(input, { key: "Escape" });
    expect(screen.getByText("Old title").closest("a")).toBeTruthy();
    expect(state.renames).toEqual([]);
    expect(isRenameKey({ key: "F2", altKey: false, ctrlKey: true, metaKey: false, shiftKey: false })).toBe(false);
  });
});

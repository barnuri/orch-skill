import { afterAll, describe, expect, test } from "bun:test";
import { installDom } from "../test/dom";
import type { Chat, ChatOptions, Message } from "../lib/chat-types";
import { isSearchShortcut, keyboardInset, sortMessages, visibleChats } from "../lib/chat-logic";

const uninstall = installDom();
const { render, screen, fireEvent, cleanup, act } = await import("@testing-library/react");
const { Composer } = await import("./Composer");
const { MessageView } = await import("./MessageView");
const { pickerSummary, sessionNote } = await import("./Pickers");
const { Lightbox } = await import("./Attachments");
const Markdown = (await import("./Markdown")).default;

afterAll(async () => {
  cleanup();
  await new Promise((r) => setTimeout(r, 100));
  uninstall();
});

const row = (over: Partial<Message>): Message => ({ id: "msg-1", chat_id: "c", role: "assistant", content: "", status: "done", error: null, model_used: null, input_tokens: 0, output_tokens: 0, cost_usd: null, started_at: null, finished_at: null, created_at: "", attachments: [], ...over });
const store = () => {
  const data = new Map<string, string>();
  return { getItem: (k: string) => data.get(k) ?? null, setItem: (k: string, v: string) => void data.set(k, v), removeItem: (k: string) => void data.delete(k) } as unknown as Storage;
};
const att = (id: string, name: string) => ({ id, chat_id: "chat-1", message_id: null, filename: name, mime: "text/plain", size: 5, sha256: "", created_at: "" });

describe("model and duration in footer and header", () => {
  test("footer shows the reported model, else the configured one; duration is live then static, also when failed or stopped", () => {
    cleanup();
    const started = "2026-01-01T00:00:00Z";
    const t0 = Date.parse(started);
    const { rerender } = render(<MessageView message={row({ status: "streaming", started_at: started })} now={t0 + 5_000} onOpenImage={() => {}} fallbackModel="HAIKU" />);
    expect(screen.getByTestId("msg-model").textContent).toBe("HAIKU");
    expect(screen.getByTestId("msg-duration").textContent).toBe("5s");
    for (const status of ["error", "stopped", "done"] as const) {
      rerender(<MessageView message={row({ status, started_at: started, finished_at: "2026-01-01T00:01:05Z", model_used: "real-model" })} now={t0 + 9_999_000} onOpenImage={() => {}} fallbackModel="HAIKU" />);
      expect(screen.getByTestId("msg-model").textContent).toBe("real-model");
      expect(screen.getByTestId("msg-duration").textContent).toBe("1m 5s");
    }
  });
  test("summary and session note", () => {
    const chat = { harness: "copilot", profile: "p", model_id: "m1" } as Chat;
    const opts = { harnesses: [
      { id: "copilot", label: "c", enabled: true, available: true, persistent: false, profiles: [{ name: "p", description: "", enabled: true, configured: true, problem: null, models: [{ id: "m1", label: "M1", slug: "m1", description: "", default: true }] }] },
      { id: "claude", label: "cl", enabled: true, available: true, persistent: true, profiles: [] },
    ], default_harness: null, default_profile: null } as unknown as ChatOptions;
    expect(pickerSummary(chat, opts, null)).toBe("copilot · p · M1");
    expect(pickerSummary(chat, opts, "real")).toBe("copilot · p · real");
    expect(sessionNote(chat, opts)).toContain("replays recent history");
    expect(sessionNote({ ...chat, harness: "claude" } as Chat, opts)).toContain("one process, one turn");
    expect(sessionNote(chat, undefined)).toBe("");
  });
});

describe("cursor", () => {
  test("a live markdown message marks the block so the cursor renders inline; a finished one does not", () => {
    cleanup();
    const { container, rerender } = render(<Markdown text={"hello **world**\n\nlast words"} live />);
    expect(container.querySelector(".md.is-live")).not.toBeNull();
    expect(container.querySelector(".md.is-live > p:last-child")?.textContent).toBe("last words");
    rerender(<Markdown text="x" />);
    expect(container.querySelector(".is-live")).toBeNull();
    cleanup();
    render(<MessageView message={row({ status: "streaming", content: "abc", started_at: "2026-01-01T00:00:00Z" })} now={0} onOpenImage={() => {}} />);
    expect(document.querySelector(".cursor")).toBeNull();
  });
});

describe("right-to-left replies", () => {
  test("each text block takes its own direction, and code stays left to right", () => {
    cleanup();
    const { container } = render(<Markdown text={"## המלצות\n\n- מקרר אחד\n- second\n\nplain line\n\n```sh\necho hi\n```"} />);
    for (const sel of ["h2", "ul", "li", "p"]) {
      expect(container.querySelector(`.md ${sel}`)?.getAttribute("dir")).toBe("auto");
    }
    expect(container.querySelector(".code-block")?.getAttribute("dir")).toBeNull();
    cleanup();
  });
});

describe("removing an unsent upload", () => {
  test("× calls the delete endpoint for a stored attachment and aborts a running upload", async () => {
    cleanup();
    const removed: string[] = [];
    let aborted = 0;
    const upload = (_c: string, f: File) => (f.name === "slow.txt"
      ? { abort: () => { aborted += 1; }, promise: new Promise(() => {}) }
      : { abort: () => {}, promise: Promise.resolve({ ok: true as const, attachment: att("att-7", f.name) }) });
    const { container } = render(<Composer chatId="chat-1" blocked={null} running={false} onSend={async () => null} onStop={() => {}} onOpenImage={() => {}} storage={store()} upload={upload as never} removeUpload={async (id) => { removed.push(id); }} />);
    const zone = container.querySelector(".composer") as HTMLElement;
    await act(async () => { fireEvent.drop(zone, { dataTransfer: { files: [new File(["abc"], "done.txt", { type: "text/plain" }), new File(["abc"], "slow.txt", { type: "text/plain" })], types: ["Files"] } }); });
    await screen.findByText("done.txt");
    fireEvent.click(screen.getByRole("button", { name: "Remove slow.txt" }));
    expect(aborted).toBe(1);
    fireEvent.click(screen.getByRole("button", { name: "Remove done.txt" }));
    expect(removed).toEqual(["att-7"]);
    expect(screen.queryByText("done.txt")).toBeNull();
  });
});

describe("thread list and keyboard", () => {
  test("empty chats are hidden unless open or in the archive", () => {
    const list = [{ id: "a", empty: true }, { id: "b", empty: false }, { id: "c" }, { id: "d", empty: true }];
    expect(visibleChats(list, "d", false).map((c) => c.id)).toEqual(["b", "c", "d"]);
    expect(visibleChats(list, null, false).map((c) => c.id)).toEqual(["b", "c"]);
    expect(visibleChats(list, null, true).map((c) => c.id)).toEqual(["a", "b", "c", "d"]);
  });
  test("Ctrl/Cmd+K is the search shortcut, nothing else is", () => {
    const k = { key: "k", ctrlKey: true, metaKey: false, altKey: false, shiftKey: false };
    expect(isSearchShortcut(k)).toBe(true);
    expect(isSearchShortcut({ ...k, ctrlKey: false, metaKey: true, key: "K" })).toBe(true);
    expect(isSearchShortcut({ ...k, ctrlKey: false })).toBe(false);
    expect(isSearchShortcut({ ...k, shiftKey: true })).toBe(false);
    expect(isSearchShortcut({ ...k, key: "j" })).toBe(false);
  });
  test("Esc closes the lightbox", () => {
    cleanup();
    let closed = 0;
    render(<Lightbox attachment={{ id: "att-1", chat_id: "c", message_id: "m", filename: "a.png", mime: "image/png", size: 3, sha256: "", created_at: "" } as never} onClose={() => { closed += 1; }} />);
    fireEvent.keyDown(document, { key: "Escape" });
    expect(closed).toBe(1);
  });
  test("keyboard inset from the visual viewport", () => {
    expect(keyboardInset(800, null)).toBe(0);
    expect(keyboardInset(800, { height: 800, offsetTop: 0 })).toBe(0);
    expect(keyboardInset(800, { height: 500, offsetTop: 0 })).toBe(300);
    expect(keyboardInset(800, { height: 500, offsetTop: 120 })).toBe(180);
    expect(keyboardInset(800, { height: 900, offsetTop: 0 })).toBe(0);
  });
});

describe("display order (F2)", () => {
  test("tool rows of a reply come before its assistant text, which sorts where the reply ended", () => {
    const user = row({ id: "msg-1", role: "user", created_at: "2026-01-01T00:00:00.000Z", finished_at: "2026-01-01T00:00:00.000Z" });
    const assistant = row({ id: "msg-2", role: "assistant", created_at: "2026-01-01T00:00:00.001Z", finished_at: "2026-01-01T00:00:05.000Z" });
    const tool = row({ id: "msg-3", role: "tool", created_at: "2026-01-01T00:00:02.000Z", finished_at: "2026-01-01T00:00:02.000Z" });
    const next = row({ id: "msg-4", role: "user", created_at: "2026-01-01T00:01:00.000Z", finished_at: "2026-01-01T00:01:00.000Z" });
    expect(sortMessages([next, assistant, tool, user]).map((m) => m.id)).toEqual(["msg-1", "msg-3", "msg-2", "msg-4"]);
    const live = row({ id: "msg-2", role: "assistant", status: "streaming", created_at: assistant.created_at });
    expect(sortMessages([live, tool, user]).map((m) => m.id)).toEqual(["msg-1", "msg-3", "msg-2"]);
  });
});

import { afterAll, afterEach, describe, expect, test } from "bun:test";
import { installDom } from "../test/dom";
import type { QueueItem, QueueSnapshot } from "./queue-logic";

const uninstall = installDom();
const { render, screen, fireEvent, cleanup, waitFor, within } = await import("@testing-library/react");
const { QueueBubbles, QueueCounter, QueueTray } = await import("./MessageQueue");
const { Composer } = await import("./Composer");
const { queueApi } = await import("./queue-api");
const { dropped, moved, pausedNotice, preview } = await import("./queue-logic");

const realApi = { ...queueApi };
afterEach(() => {
  cleanup();
  Object.assign(queueApi, realApi);
});
afterAll(uninstall);

const item = (id: string, text: string, position: number, over: Partial<QueueItem> = {}): QueueItem => ({
  id, chat_id: "chat-1", text, attachment_ids: [], position, state: "queued", created_at: "t", edited_at: null, message_id: null, ...over,
});
const snap = (items: QueueItem[], over: Partial<QueueSnapshot> = {}): QueueSnapshot => ({ chat_id: "chat-1", items, paused: false, reason: null, ...over });
const ok = <T,>(body: T) => ({ kind: "ok" as const, body, etag: null });
const conflict = (error: string) => ({ kind: "error" as const, status: 409, body: { error } });
const three = snap([item("que-a", "first waiting message", 1), item("que-b", "second one", 2, { attachment_ids: ["att-1", "att-2"] }), item("que-c", "third", 3)]);

function tray(over: { snapshot?: QueueSnapshot; running?: boolean; onStop?: () => void; onChange?: (s: QueueSnapshot) => void } = {}) {
  return render(<QueueTray chatId="chat-1" snapshot={over.snapshot ?? three} running={over.running ?? true} runningText="the running prompt" onStop={over.onStop ?? (() => {})} onChange={over.onChange ?? (() => {})} />);
}

const row = (index: number): HTMLElement => screen.getAllByTestId("queue-item")[index] as HTMLElement;

describe("queue logic", () => {
  test("preview collapses whitespace and cuts long text", () => {
    expect(preview("a\n\n  b   c")).toBe("a b c");
    expect(preview("x".repeat(300), 20)).toHaveLength(20);
    expect(preview("x".repeat(300), 20).endsWith("…")).toBe(true);
  });
  test("moved and dropped reorder ids, clamped at the ends", () => {
    expect(moved(["a", "b", "c"], "b", -1)).toEqual(["b", "a", "c"]);
    expect(moved(["a", "b", "c"], "a", -1)).toEqual(["a", "b", "c"]);
    expect(moved(["a", "b", "c"], "b", 5)).toEqual(["a", "c", "b"]);
    expect(dropped(["a", "b", "c"], "c", "a")).toEqual(["c", "a", "b"]);
    expect(dropped(["a", "b", "c"], "a", "a")).toEqual(["a", "b", "c"]);
  });
  test("the paused notice names the reason and the count", () => {
    expect(pausedNotice("The reply failed.", 2)).toBe("The reply failed. The queue is paused. 2 messages are waiting.");
    expect(pausedNotice(null, 1)).toBe("The queue is paused. 1 message is waiting.");
  });
});

describe("QueueTray", () => {
  test("lists the running message with Stop, then each queued message with position, preview and file count", () => {
    let stopped = 0;
    tray({ onStop: () => { stopped += 1; } });
    const running = screen.getByTestId("queue-running");
    expect(running.textContent).toContain("the running prompt");
    fireEvent.click(within(running).getByRole("button", { name: "Stop" }));
    expect(stopped).toBe(1);
    expect(screen.getAllByTestId("queue-item")).toHaveLength(3);
    expect(row(0).textContent).toContain("first waiting message");
    expect(row(1).textContent).toContain("2 files");
    expect(within(row(2)).getByLabelText("Position 3")).toBeTruthy();
    expect(screen.getByTestId("queue-tray-count").textContent).toBe("3");
  });

  test("renders nothing while nothing waits, and no running row when no reply runs", () => {
    const { container } = tray({ snapshot: snap([]) });
    expect(container.firstChild).toBeNull();
    cleanup();
    tray({ running: false });
    expect(screen.queryByTestId("queue-running")).toBeNull();
  });

  test("up and down buttons reorder through the API; the ends are disabled", async () => {
    const calls: string[][] = [];
    Object.assign(queueApi, { reorder: async (_c: string, ids: string[]) => { calls.push([...ids]); return ok(snap([])); } });
    const changed: QueueSnapshot[] = [];
    tray({ onChange: (s) => changed.push(s) });
    expect((screen.getByLabelText("Move message 1 up") as HTMLButtonElement).disabled).toBe(true);
    expect((screen.getByLabelText("Move message 3 down") as HTMLButtonElement).disabled).toBe(true);
    fireEvent.click(screen.getByLabelText("Move message 2 up"));
    await waitFor(() => { expect(calls).toEqual([["que-b", "que-a", "que-c"]]); });
    await waitFor(() => { expect(changed).toHaveLength(1); });
  });

  test("dragging a row onto another reorders", async () => {
    const calls: string[][] = [];
    Object.assign(queueApi, { reorder: async (_c: string, ids: string[]) => { calls.push([...ids]); return ok(snap([])); } });
    tray();
    const data = { setData: () => {}, effectAllowed: "" };
    fireEvent.dragStart(row(2), { dataTransfer: data });
    fireEvent.dragOver(row(0), { dataTransfer: data });
    fireEvent.drop(row(0), { dataTransfer: data });
    await waitFor(() => { expect(calls).toEqual([["que-c", "que-a", "que-b"]]); });
  });

  test("Edit opens an inline editor; Esc cancels without a request; Ctrl+Enter and Save send the new text", async () => {
    const edits: Array<[string, unknown]> = [];
    Object.assign(queueApi, {
      edit: async (_c: string, id: string, body: unknown) => { edits.push([id, body]); return ok({ item: item(id, "x", 1) }); },
      read: async () => ok(three),
    });
    tray();
    fireEvent.click(within(row(0)).getByRole("button", { name: "Edit" }));
    let box = screen.getByLabelText("Edit queued message 1") as HTMLTextAreaElement;
    expect(box.value).toBe("first waiting message");
    expect(document.activeElement).toBe(box);
    fireEvent.change(box, { target: { value: "changed" } });
    fireEvent.keyDown(box, { key: "Escape" });
    expect(screen.queryByLabelText("Edit queued message 1")).toBeNull();
    expect(edits).toEqual([]);
    fireEvent.click(within(row(0)).getByRole("button", { name: "Edit" }));
    box = screen.getByLabelText("Edit queued message 1") as HTMLTextAreaElement;
    fireEvent.change(box, { target: { value: "via keys" } });
    fireEvent.keyDown(box, { key: "Enter", ctrlKey: true });
    await waitFor(() => { expect(edits).toEqual([["que-a", { content: "via keys" }]]); });
    await waitFor(() => { expect(screen.queryByLabelText("Edit queued message 1")).toBeNull(); });
    fireEvent.click(within(row(1)).getByRole("button", { name: "Edit" }));
    fireEvent.change(screen.getByLabelText("Edit queued message 2"), { target: { value: "via button" } });
    fireEvent.click(screen.getByRole("button", { name: "Save" }));
    await waitFor(() => { expect(edits[1]).toEqual(["que-b", { content: "via button" }]); });
  });

  test("a message that started while it was edited answers Already started", async () => {
    Object.assign(queueApi, {
      edit: async () => conflict("Already started: this message was already sent to the agent, so it can no longer be changed."),
      read: async () => ok(snap([item("que-b", "second one", 1), item("que-c", "third", 2)])),
    });
    const changed: QueueSnapshot[] = [];
    tray({ onChange: (s) => changed.push(s) });
    fireEvent.click(within(row(0)).getByRole("button", { name: "Edit" }));
    fireEvent.change(screen.getByLabelText("Edit queued message 1"), { target: { value: "late" } });
    fireEvent.click(screen.getByRole("button", { name: "Save" }));
    await waitFor(() => { expect(screen.getByRole("alert").textContent).toBe("Already started"); });
    await waitFor(() => { expect(changed).toHaveLength(1); });
  });

  test("Delete cancels the message; a 409 shows Already started", async () => {
    const cancelled: string[] = [];
    Object.assign(queueApi, {
      cancel: async (_c: string, id: string) => { cancelled.push(id); return id === "que-a" ? ok({ item: item(id, "x", 0, { state: "cancelled" }) }) : conflict("Already started: x"); },
      read: async () => ok(three),
    });
    tray();
    fireEvent.click(within(row(0)).getByRole("button", { name: "Delete" }));
    await waitFor(() => { expect(cancelled).toEqual(["que-a"]); });
    fireEvent.click(within(row(1)).getByRole("button", { name: "Delete" }));
    await waitFor(() => { expect(screen.getByRole("alert").textContent).toBe("Already started"); });
  });

  test("Send now sends on one click while a reply runs, and says it interrupted that reply", async () => {
    const sent: string[] = [];
    Object.assign(queueApi, { sendNow: async (_c: string, id: string) => { sent.push(id); return ok({ ok: true, interrupted: true }); }, read: async () => ok(three) });
    tray();
    fireEvent.click(within(row(1)).getByRole("button", { name: "Send now" }));
    await waitFor(() => { expect(sent).toEqual(["que-b"]); });
    await waitFor(() => { expect(screen.getByTestId("queue-status").textContent).toBe("The running reply was interrupted. This message runs next."); });
    expect(screen.queryByRole("alertdialog")).toBeNull();
  });

  test("with many queued and no reply running, one click on Send now starts the message and says it did not interrupt", async () => {
    const sent: string[] = [];
    Object.assign(queueApi, { sendNow: async (_c: string, id: string) => { sent.push(id); return ok({ ok: true, interrupted: false }); }, read: async () => ok(three) });
    tray({ running: false });
    fireEvent.click(within(row(2)).getByRole("button", { name: "Send now" }));
    await waitFor(() => { expect(sent).toEqual(["que-c"]); });
    await waitFor(() => { expect(screen.getByTestId("queue-status").textContent).toBe("This message is running now."); });
  });

  test("Send now stays a native, focusable button", () => {
    tray();
    const button = within(row(1)).getByRole("button", { name: "Send now" });
    expect(button.tagName).toBe("BUTTON");
    expect(button.hasAttribute("disabled")).toBe(false);
    expect(button.getAttribute("tabindex")).toBeNull();
  });

  test("a paused queue shows why, with Resume", async () => {
    let resumed = 0;
    Object.assign(queueApi, { resume: async () => { resumed += 1; return ok(snap([])); } });
    tray({ snapshot: { ...three, paused: true, reason: "The reply failed." }, running: false });
    expect(screen.getByTestId("queue-paused").textContent).toBe("The reply failed. The queue is paused. 3 messages are waiting.");
    fireEvent.click(screen.getByTestId("queue-resume"));
    await waitFor(() => { expect(resumed).toBe(1); });
    cleanup();
    tray({ running: false });
    expect(screen.queryByTestId("queue-resume")).toBeNull();
  });

  test("the toggle collapses the list but keeps the header and Resume reachable", () => {
    tray({ snapshot: { ...three, paused: true, reason: "The reply was stopped." } });
    fireEvent.click(screen.getByRole("button", { name: /Queue/ }));
    expect(screen.queryAllByTestId("queue-item")).toHaveLength(0);
    expect(screen.getByTestId("queue-resume")).toBeTruthy();
  });
});

describe("pending bubbles and the counter", () => {
  test("queued messages show as quiet bubbles marked Queued; started ones are not shown", () => {
    render(<QueueBubbles items={[item("que-a", "hello there", 1), item("que-b", "with files", 2, { attachment_ids: ["a"], edited_at: "t" }), item("que-r", "running", 0, { state: "running" })]} />);
    const bubbles = document.querySelectorAll("[data-queued]");
    expect(bubbles).toHaveLength(2);
    expect(bubbles[0]?.textContent).toContain("hello there");
    expect(bubbles[0]?.textContent).toContain("Queued");
    expect(bubbles[1]?.textContent).toContain("1 file");
    expect(bubbles[1]?.textContent).toContain("edited");
  });
  test("the header counter says how many wait, and when the queue is paused", () => {
    render(<QueueCounter snapshot={snap([item("a", "x", 1), item("b", "y", 2), item("r", "z", 0, { state: "running" })])} />);
    expect(screen.getByTestId("queue-count").textContent).toBe("2 queued");
    cleanup();
    render(<QueueCounter snapshot={snap([item("a", "x", 1)], { paused: true })} />);
    expect(screen.getByTestId("queue-count").textContent).toBe("1 queued · paused");
    cleanup();
    const { container } = render(<QueueCounter snapshot={snap([])} />);
    expect(container.firstChild).toBeNull();
  });
});

describe("Composer while a reply runs", () => {
  const store = (): Storage => {
    const m = new Map<string, string>();
    return { getItem: (k: string) => m.get(k) ?? null, setItem: (k: string, v: string) => { m.set(k, v); }, removeItem: (k: string) => { m.delete(k); }, clear: () => m.clear(), key: () => null, length: 0 } as Storage;
  };
  test("the box stays enabled, Enter sends (queues), and Stop stays visible next to it", async () => {
    const sent: string[] = [];
    let stopped = 0;
    render(<Composer chatId="c" blocked={null} running onSend={async (t) => { sent.push(t); return null; }} onStop={() => { stopped += 1; }} onOpenImage={() => {}} storage={store()} />);
    const box = screen.getByLabelText("Message") as HTMLTextAreaElement;
    expect(box.disabled).toBe(false);
    fireEvent.change(box, { target: { value: "one more thing" } });
    fireEvent.keyDown(box, { key: "Enter" });
    await waitFor(() => { expect(sent).toEqual(["one more thing"]); });
    await waitFor(() => { expect(box.value).toBe(""); });
    fireEvent.click(screen.getByRole("button", { name: "Stop" }));
    expect(stopped).toBe(1);
    expect((screen.getByRole("button", { name: "Queue" }) as HTMLButtonElement).disabled).toBe(true);
    fireEvent.change(box, { target: { value: "second" } });
    fireEvent.click(screen.getByRole("button", { name: "Queue" }));
    await waitFor(() => { expect(sent).toEqual(["one more thing", "second"]); });
  });
});

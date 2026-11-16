import { afterAll, afterEach, describe, expect, test } from "bun:test";
import type { Chat } from "../lib/chat-types";
import { installDom } from "../test/dom";
import type { QueueItem, QueueSnapshot } from "./queue-logic";

const uninstall = installDom();
const { render, screen, cleanup } = await import("@testing-library/react");
const { QueryClient, QueryClientProvider } = await import("@tanstack/react-query");
const { ToastProvider } = await import("../components/Toast");
const { chatIsWaiting } = await import("../lib/chat-waiting");
const { ChatListRow } = await import("./ChatListRow");
const { QueueTray } = await import("./MessageQueue");
const { WaitingIndicator } = await import("./WorkingIndicator");
const { waitingNotice } = await import("./queue-logic");
const { questionsApi } = await import("../api/chat-questions");

const realQuestions = { ...questionsApi };
afterEach(() => {
  cleanup();
  Object.assign(questionsApi, realQuestions);
});
afterAll(uninstall);

const chat = (over: Partial<Chat> = {}): Chat => ({ id: "chat-1", project_id: null, title: "Pick a colour", harness: "claude", profile: "main", model_id: null, session_id: null, status: "idle", created_at: "2026-11-15T00:00:00Z", updated_at: "2026-11-15T00:00:00Z", archived_at: null, ...over }) as Chat;
const queued = (id: string, text: string, position: number): QueueItem => ({ id, chat_id: "chat-1", text, attachment_ids: [], position, state: "queued", created_at: "t", edited_at: null, message_id: null });
const snap = (over: Partial<QueueSnapshot> = {}): QueueSnapshot => ({ chat_id: "chat-1", items: [queued("que-a", "next one", 1), queued("que-b", "and this", 2)], paused: false, reason: null, waiting_for_answer: false, ...over });

function row(c: Chat) {
  Object.assign(questionsApi, { waiting: async () => ({ kind: "ok" as const, body: { chat_ids: [] }, etag: null }) });
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return render(<QueryClientProvider client={client}><ToastProvider><ChatListRow chat={c} href="#/chat/chat-1" /></ToastProvider></QueryClientProvider>);
}

describe("chat status waiting", () => {
  test("status waiting, or the older awaiting_answer flag, counts as waiting; idle does not", () => {
    expect(chatIsWaiting(chat({ status: "waiting" }))).toBe(true);
    expect(chatIsWaiting({ ...chat(), awaiting_answer: true } as Chat)).toBe(true);
    expect(chatIsWaiting(chat({ status: "running" }))).toBe(false);
    expect(chatIsWaiting(chat())).toBe(false);
  });

  test("the chat list row shows the amber waiting dot for status waiting, none for idle", () => {
    const view = row(chat({ status: "waiting" }));
    expect(screen.getByRole("img", { name: "waiting for your answer" })).not.toBeNull();
    view.unmount();
    row(chat());
    expect(screen.queryByRole("img", { name: "waiting for your answer" })).toBeNull();
  });

  test("the list dot is the amber token, never red", async () => {
    const css = await Bun.file(new URL("./question.css", import.meta.url)).text();
    const rule = css.split("\n").find((l) => l.startsWith(".thread-waiting")) ?? "";
    expect(rule).toContain("var(--wa)");
    expect(rule).not.toContain("var(--er)");
  });

  test("the working indicator reads Waiting for your answer, amber, without Stop", () => {
    render(<WaitingIndicator />);
    expect(screen.getByTestId("working-label").textContent).toBe("Waiting for your answer");
    expect(screen.queryByTestId("working-stop")).toBeNull();
  });

  test("the queue tray says the next messages start after the answer; a pause shows its own notice instead", () => {
    const props = { chatId: "chat-1", running: false, runningText: null, onStop: () => {}, onChange: () => {} };
    const view = render(<QueueTray {...props} snapshot={snap({ waiting_for_answer: true })} />);
    expect(screen.getByTestId("queue-waiting").textContent).toBe(waitingNotice(2));
    expect(waitingNotice(1)).toBe("Waiting for your answer. 1 message starts after you answer or skip the question.");
    expect(screen.queryByTestId("queue-paused")).toBeNull();
    view.rerender(<QueueTray {...props} snapshot={snap({ waiting_for_answer: true, paused: true, reason: "The reply failed." })} />);
    expect(screen.queryByTestId("queue-waiting")).toBeNull();
    expect(screen.getByTestId("queue-paused")).not.toBeNull();
    view.rerender(<QueueTray {...props} snapshot={snap()} />);
    expect(screen.queryByTestId("queue-waiting")).toBeNull();
  });
});

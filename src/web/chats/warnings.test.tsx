import { afterAll, afterEach, describe, expect, test } from "bun:test";
import { installDom } from "../test/dom";

const uninstall = installDom();
afterAll(() => { uninstall(); });
const { render, screen, cleanup } = await import("@testing-library/react");
afterEach(cleanup);
const { MessageView } = await import("./MessageView");
const { applyChatEvent, memoryNote, messageNotes, WARNING_TRUNCATED } = await import("../lib/chat-logic");
import type { Message } from "../lib/chat-types";

const msg = (over: Partial<Message> = {}): Message => ({
  id: "m1", chat_id: "c", role: "assistant", content: "hi", status: "streaming", error: null, model_used: null,
  input_tokens: 0, output_tokens: 0, cost_usd: null, started_at: null, finished_at: null, created_at: "2026-01-01T00:00:00Z", attachments: [], ...over,
}) as Message;

describe("chat warnings logic", () => {
  test("notes from warning and truncation (boolean or 0/1)", () => {
    expect(messageNotes(msg())).toEqual([]);
    expect(messageNotes(msg({ warning: "w", context_truncated: 1 })).map((n) => n.key)).toEqual(["warning", "truncated"]);
    expect(messageNotes(msg({ context_truncated: 0 }))).toEqual([]);
  });
  test("the done event sets both fields", () => {
    const out = applyChatEvent([msg()], { event: "done", data: { message_id: "m1", status: "done", context_truncated: true, warning: "lost" } } as never, "now");
    expect(out[0]?.warning).toBe("lost");
    expect(out[0]?.context_truncated).toBe(true);
  });
  test("memory note per kind, with a fallback for old servers", () => {
    expect(memoryNote({ memory: "session", persistent: false })).toBe("remembers via its own session");
    expect(memoryNote({ memory: "replay", persistent: false })).toBe("replays recent history");
    expect(memoryNote({ memory: "process", persistent: true })).toBe("one process, one turn");
    expect(memoryNote({ persistent: false } as never)).toBe("replays recent history");
    expect(memoryNote(undefined)).toBe("");
  });
});

describe("chat warnings view", () => {
  test("renders both notes under the footer, truncation has a tooltip", () => {
    render(<MessageView message={msg({ status: "done", warning: "session could not be resumed, started a fresh one", context_truncated: 1 })} now={0} onOpenImage={() => undefined} />);
    expect(screen.getByTestId("msg-warning").textContent).toContain("started a fresh one");
    const t = screen.getByTestId("msg-truncated");
    expect(t.textContent).toBe(WARNING_TRUNCATED);
    expect(t.getAttribute("title")).not.toBeNull();
  });
  test("renders no note for a clean reply", () => {
    render(<MessageView message={msg({ status: "done" })} now={0} onOpenImage={() => undefined} />);
    expect(screen.queryByTestId("msg-warning")).toBeNull();
  });
});

import { describe, expect, test } from "bun:test";
import { partsForToolCall, parseParts } from "../../shared/chat-parts";
import { ClaudeParser } from "./sessions/claude-session";
import { OpencodeParser } from "./sessions/opencode-session";
import { PlainParser } from "./sessions/turn-session";

const lines = (...rows: unknown[]): string => `${rows.map((r) => JSON.stringify(r)).join("\n")}\n`;

describe("claude stream-json to typed events", () => {
  test("tool_use, tool_result, thinking and text map to tool, tool-result, reasoning-delta and text-delta", () => {
    const p = new ClaudeParser(null);
    const out = p.feed(lines(
      { type: "system", subtype: "init", session_id: "s1" },
      { type: "stream_event", event: { type: "content_block_delta", delta: { type: "thinking_delta", thinking: "let me look" } } },
      { type: "assistant", message: { model: "m", content: [{ type: "tool_use", id: "tu1", name: "TodoWrite", input: { todos: [{ content: "a", status: "completed", activeForm: "A" }, { content: "b", status: "in_progress" }] } }] } },
      { type: "user", message: { content: [{ type: "tool_result", tool_use_id: "tu1", content: [{ type: "text", text: "ok" }], is_error: false }] } },
      { type: "assistant", message: { content: [{ type: "tool_use", id: "tu2", name: "Bash", input: { command: "false" } }] } },
      { type: "user", message: { content: [{ type: "tool_result", tool_use_id: "tu2", content: "boom", is_error: true }] } },
      { type: "stream_event", event: { type: "content_block_delta", delta: { type: "text_delta", text: "hi" } } },
    ));
    expect(out.map((e) => e.type)).toEqual(["reasoning-delta", "tool", "tool-result", "tool", "tool-result", "text-delta"]);
    expect(out[1]).toMatchObject({ name: "TodoWrite", id: "tu1" });
    expect(out[2]).toEqual({ type: "tool-result", id: "tu1", output: "ok", error: false });
    expect(out[4]).toEqual({ type: "tool-result", id: "tu2", output: "boom", error: true });
  });
});

describe("opencode json events to typed events", () => {
  test("a completed tool_use gives a tool and its result; an errored one gives an error result; reasoning maps", () => {
    const p = new OpencodeParser(null, null);
    const out = p.feed(lines(
      { type: "reasoning", sessionID: "o1", part: { text: "thinking" } },
      { type: "tool_use", part: { callID: "c1", tool: "todowrite", state: { status: "completed", input: { todos: [{ content: "x", status: "pending" }] }, output: "done" } } },
      { type: "tool_use", part: { callID: "c2", tool: "bash", state: { status: "error", input: { command: "ls" }, error: "denied" } } },
      { type: "text", part: { text: "ok" } },
    ));
    expect(out.map((e) => e.type)).toEqual(["reasoning-delta", "tool", "tool-result", "tool", "tool-result", "text-delta"]);
    expect(out[2]).toEqual({ type: "tool-result", id: "c1", output: "done", error: false });
    expect(out[4]).toEqual({ type: "tool-result", id: "c2", output: "denied", error: true });
  });
});

describe("pi and other plain-text harnesses", () => {
  test("have no structured stream: only text events, so their messages carry no parts", () => {
    const p = new PlainParser(null);
    const out = p.feed("hello\n");
    expect(out.every((e) => e.type === "text-delta")).toBe(true);
  });
});

describe("parts built from tool calls", () => {
  test("todowrite and TodoWrite give a todo part with normalized statuses", () => {
    for (const name of ["todowrite", "TodoWrite"]) {
      const parts = partsForToolCall({ id: "1", name, input: { todos: [{ content: "a", status: "completed" }, { content: "b", status: "in_progress" }, { content: "c", status: "pending" }] } });
      const todo = parts.find((x) => x.type === "todo");
      expect(todo).toEqual({ type: "todo", items: [{ text: "a", status: "done" }, { text: "b", status: "in_progress" }, { text: "c", status: "pending" }] });
    }
  });
  test("edit and write give a diff part; other tools do not", () => {
    expect(partsForToolCall({ id: "1", name: "Edit", input: { file_path: "/a.ts", old_string: "x", new_string: "y" } }).some((x) => x.type === "diff")).toBe(true);
    expect(partsForToolCall({ id: "1", name: "edit", input: { filePath: "/a.ts", oldString: "x", newString: "y" } }).some((x) => x.type === "diff")).toBe(true);
    expect(partsForToolCall({ id: "1", name: "bash", input: { command: "ls" } }).length).toBe(1);
  });
  test("parseParts reads JSON, arrays, and falls back to null for old or broken rows", () => {
    expect(parseParts(null)).toBeNull();
    expect(parseParts("not json")).toBeNull();
    expect(parseParts('[{"type":"text","text":"a"}]')).toEqual([{ type: "text", text: "a" }]);
  });
});

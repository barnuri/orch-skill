import { afterAll, describe, expect, test } from "bun:test";
import { installDom } from "../test/dom";
import type { Message } from "../lib/chat-types";
import type { ChatPart } from "../../shared/chat-parts";

const uninstall = installDom();
const { render, screen, fireEvent, cleanup, act } = await import("@testing-library/react");
const { MessageView, ToolsView } = await import("./MessageView");
const { TodoPanel } = await import("./Todos");
const { CopyButton } = await import("./CopyButton");
const { groupThread } = await import("./chat-group");
const { latestTodos, partsForToolCall } = await import("../../shared/chat-parts");
const Markdown = (await import("./Markdown")).default;

afterAll(async () => {
  cleanup();
  await new Promise((r) => setTimeout(r, 100));
  uninstall();
});

const row = (over: Partial<Message>): Message => ({ id: "msg-1", chat_id: "c", role: "tool", content: "", status: "done", error: null, model_used: null, input_tokens: 0, output_tokens: 0, cost_usd: null, started_at: null, finished_at: null, created_at: "", attachments: [], ...over });
const call = (id: string, state: "running" | "done" | "error", extra: Partial<Extract<ChatPart, { type: "tool-call" }>> = {}): Message =>
  row({ id, parts: [{ type: "tool-call", id, name: "bash", summary: "ls -la", state, started_at: "2026-01-01T00:00:00Z", ...extra }] });
const noop = () => {};

describe("tool card", () => {
  test("shows name, summary, state and duration; red state only for error", () => {
    cleanup();
    const t0 = Date.parse("2026-01-01T00:00:00Z");
    const { rerender } = render(<MessageView message={call("msg-1", "running")} now={t0 + 4000} onOpenImage={noop} />);
    expect(screen.getByTestId("tool-card").getAttribute("data-state")).toBe("running");
    expect(screen.getByTestId("tool-state").textContent).toBe("running");
    expect(screen.getByTestId("tool-duration").textContent).toBe("4s");
    expect(document.body.textContent).toContain("ls -la");
    rerender(<MessageView message={call("msg-1", "done", { ended_at: "2026-01-01T00:00:09Z", output: "total 0" })} now={t0 + 99000} onOpenImage={noop} />);
    expect(screen.getByTestId("tool-duration").textContent).toBe("9s");
    expect(screen.queryByTestId("tool-output")).toBeNull();
    fireEvent.click(screen.getByRole("button", { name: /bash/ }));
    expect(screen.getByTestId("tool-output").textContent).toBe("total 0");
    rerender(<MessageView message={call("msg-1", "error", { output: "denied" })} now={t0} onOpenImage={noop} />);
    expect(screen.getByTestId("tool-state").className).toContain("is-error");
  });

  test("a long output is truncated until Show more", () => {
    cleanup();
    const output = "x".repeat(3000);
    render(<MessageView message={call("msg-1", "done", { output })} now={0} onOpenImage={noop} />);
    fireEvent.click(screen.getByRole("button", { name: /bash/ }));
    expect(screen.getByTestId("tool-output").textContent?.length).toBeLessThan(1300);
    fireEvent.click(screen.getByText("Show more"));
    expect(screen.getByTestId("tool-output").textContent).toBe(output);
  });

  test("consecutive calls group; a legacy text-only tool row still renders", () => {
    cleanup();
    const items = groupThread([call("msg-1", "done"), call("msg-2", "running"), row({ id: "msg-3", content: "Bash: ls" }), call("msg-4", "done")]);
    expect(items.map((i) => i.kind)).toEqual(["tools", "message", "tools"]);
    render(<ToolsView messages={items[0] && items[0].kind === "tools" ? items[0].messages : []} now={0} />);
    expect(screen.getByTestId("tool-group").textContent).toContain("2 tool calls");
    expect(screen.getAllByTestId("tool-card").length).toBe(2);
    cleanup();
    render(<MessageView message={row({ id: "msg-3", content: "Bash: ls", parts: null })} now={0} onOpenImage={noop} />);
    expect(document.body.textContent).toContain("Bash");
  });
});

describe("todo panel", () => {
  test("is built from a todowrite payload, with progress count and checkboxes", () => {
    cleanup();
    const parts = partsForToolCall({ id: "1", name: "todowrite", input: { todos: [{ content: "one", status: "completed" }, { content: "two", status: "in_progress" }, { content: "three", status: "pending" }] } });
    const items = latestTodos([row({ parts })]);
    expect(items?.length).toBe(3);
    render(<TodoPanel items={items ?? []} />);
    expect(screen.getByTestId("todo-count").textContent).toBe("1/3");
    expect(screen.queryByTestId("todo-list")).toBeNull();
    expect(document.body.textContent).toContain("two");
    fireEvent.click(screen.getByRole("button", { name: /Tasks/ }));
    const boxes = screen.getAllByRole("checkbox") as HTMLInputElement[];
    expect(boxes.map((b) => b.checked)).toEqual([true, false, false]);
    expect(document.body.textContent).toContain("in progress");
    fireEvent.click(screen.getByRole("button", { name: /Tasks/ }));
    expect(screen.queryByTestId("todo-list")).toBeNull();
  });
  test("latestTodos takes the newest list", () => {
    const a = row({ id: "msg-1", parts: [{ type: "todo", items: [{ text: "old", status: "pending" }] }] });
    const b = row({ id: "msg-2", parts: [{ type: "todo", items: [{ text: "new", status: "done" }] }] });
    expect(latestTodos([a, b])?.[0]?.text).toBe("new");
    expect(latestTodos([row({})])).toBeNull();
  });
});

describe("markdown task lists", () => {
  test("- [ ] and - [x] render as real checkboxes", () => {
    cleanup();
    const { container } = render(<Markdown text={"- [x] done\n- [ ] open\n"} />);
    const boxes = Array.from(container.querySelectorAll<HTMLInputElement>("input[type=checkbox]"));
    expect(boxes.map((b) => b.checked)).toEqual([true, false]);
  });
});

describe("reasoning", () => {
  test("is collapsed by default and opens on click", async () => {
    cleanup();
    render(<MessageView message={row({ parts: [{ type: "reasoning", text: "secret plan" }] })} now={0} onOpenImage={noop} />);
    expect(screen.getByTestId("reasoning")).not.toBeNull();
    expect(document.body.textContent).not.toContain("secret plan");
    await act(async () => {
      fireEvent.click(screen.getByRole("button", { name: /Thought/ }));
      await new Promise((r) => setTimeout(r, 50));
    });
    expect(document.body.textContent).toContain("secret plan");
  });
});

describe("copy", () => {
  test("the copy button writes the text to the clipboard", async () => {
    cleanup();
    const written: string[] = [];
    Object.defineProperty(navigator, "clipboard", { value: { writeText: (t: string) => { written.push(t); return Promise.resolve(); } }, configurable: true });
    render(<CopyButton text="hello" />);
    await act(async () => {
      fireEvent.click(screen.getByTestId("copy-btn"));
    });
    expect(written).toEqual(["hello"]);
    expect(screen.getByTestId("copy-btn").textContent).toBe("Copied");
  });
  test("an assistant reply has Copy, and the newest finished one has Regenerate", () => {
    cleanup();
    let again = 0;
    render(<MessageView message={row({ role: "assistant", content: "answer" })} now={0} onOpenImage={noop} onRegenerate={() => { again++; }} />);
    expect(screen.getByRole("button", { name: "Copy" })).not.toBeNull();
    fireEvent.click(screen.getByTestId("msg-regenerate"));
    expect(again).toBe(1);
  });
});

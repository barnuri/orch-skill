import { afterAll, describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { activityLabel, activityParts, type ChatActivity, summarizeError } from "../../shared/chat-activity";
import { applyChatEvent } from "../lib/chat-logic";
import type { Message } from "../lib/chat-types";
import { installDom } from "../test/dom";

const uninstall = installDom();
const { render, screen, fireEvent, cleanup } = await import("@testing-library/react");
const { WorkingIndicator } = await import("./WorkingIndicator");
const { ErrorNotice } = await import("./ErrorNotice");
const { MessageView } = await import("./MessageView");

afterAll(async () => {
  cleanup();
  await new Promise((r) => setTimeout(r, 100));
  uninstall();
});

const T0 = Date.parse("2026-01-01T00:00:00Z");
const act = (over: Partial<ChatActivity> = {}): ChatActivity => ({ state: "thinking", since: "", last_event_at: "", state_ms: 0, idle_ms: 0, ...over });
const row = (over: Partial<Message> = {}): Message => ({ id: "msg-1", chat_id: "c", role: "assistant", content: "", status: "streaming", error: null, model_used: null, input_tokens: 0, output_tokens: 0, cost_usd: null, started_at: "2026-01-01T00:00:00Z", finished_at: null, created_at: "", attachments: [], ...over });

describe("activity label per state", () => {
  test.each([
    [act({ state: "starting" }), 0, 0, "Starting"],
    [act({ state: "thinking" }), 1000, 1000, "Thinking"],
    [act({ state: "writing" }), 1000, 1000, "Writing"],
    [act({ state: "tool", tool: { id: "t", name: "Bash", started_at: "" } }), 2000, 65_000, "Running Bash · 1:05"],
    [act({ state: "waiting" }), 600_000, 600_000, "Waiting for your answer"],
    [act({ state: "writing" }), 65_000, 65_000, "Still working, no output for 1m 05s"],
  ])("%#", (a, idle, state, label) => {
    expect(activityLabel(a, idle, state)).toBe(label);
  });
  test("stalls at 45 s exactly, never while waiting for an answer", () => {
    expect(activityParts(act(), 44_999, 0).stalled).toBe(false);
    expect(activityParts(act(), 45_000, 0).stalled).toBe(true);
    expect(activityParts(act({ state: "waiting" }), 900_000, 0).stalled).toBe(false);
  });
});

describe("WorkingIndicator", () => {
  test("shows the label, a quiet m:ss clock and the model; no badge text", () => {
    cleanup();
    render(<WorkingIndicator message={row({ activity: act({ state: "writing" }) })} now={T0 + 196_000} fallbackModel="hub-smart" />);
    expect(screen.getByTestId("working-label").textContent).toBe("Writing");
    expect(screen.getByTestId("msg-duration").textContent).toBe("3:16");
    expect(screen.getByTestId("msg-model").textContent).toBe("hub-smart");
    expect(screen.getByTestId("working").textContent).not.toMatch(/streaming/i);
    expect(screen.queryByTestId("working-stop")).toBeNull();
  });
  test("starting without any activity, a running tool counts its own time", () => {
    cleanup();
    const { rerender } = render(<WorkingIndicator message={row()} now={T0 + 1000} />);
    expect(screen.getByTestId("working-label").textContent).toBe("Starting");
    const tool = row({ activity: act({ state: "tool", tool: { id: "t", name: "Read", started_at: "" } }) });
    rerender(<WorkingIndicator message={tool} now={T0 + 2000} />);
    expect(screen.getByTestId("working-label").textContent).toBe("Running Read");
    expect(screen.getByTestId("working-tool-time").textContent).toBe("0:00");
    rerender(<WorkingIndicator message={tool} now={T0 + 9000} />);
    expect(screen.getByTestId("working-tool-time").textContent).toBe("0:07");
  });
  test("waiting for an answer has still dots", () => {
    cleanup();
    render(<WorkingIndicator message={row({ activity: act({ state: "waiting" }) })} now={T0 + 5000} />);
    expect(document.querySelector(".working-dots")?.classList.contains("is-still")).toBe(true);
  });
  test("stall with a fake clock: quiet, then amber with Stop and Check status at 45 s, resets on a new event", () => {
    cleanup();
    const a = act({ state: "writing", idle_ms: 0 });
    const m = row({ activity: a });
    const { rerender } = render(<WorkingIndicator message={m} now={T0 + 1000} />);
    rerender(<WorkingIndicator message={m} now={T0 + 40_000} />);
    expect(screen.queryByTestId("working-stop")).toBeNull();
    rerender(<WorkingIndicator message={m} now={T0 + 66_000} />);
    expect(screen.getByTestId("working-label").textContent).toBe("Still working, no output for 1m 05s");
    expect(screen.getByTestId("working").classList.contains("is-stalled")).toBe(true);
    expect(screen.getByTestId("working-stop").textContent).toBe("Stop");
    expect(screen.getByTestId("working-check").textContent).toBe("Check status");
    rerender(<WorkingIndicator message={row({ activity: act({ state: "writing", idle_ms: 0 }) })} now={T0 + 67_000} />);
    expect(screen.queryByTestId("working-stop")).toBeNull();
  });
});

describe("activity events and the end of a reply", () => {
  test("an activity event is applied to a running reply; done clears it", () => {
    const list = [row()];
    const a = applyChatEvent(list, { event: "activity", data: { message_id: "msg-1", state: "thinking", since: "", last_event_at: "", state_ms: 0, idle_ms: 0 } }, "now");
    expect(a[0]?.activity?.state).toBe("thinking");
    const d = applyChatEvent(a, { event: "done", data: { message_id: "msg-1", status: "error", error: "x" } }, "2026-01-01T00:01:00Z");
    expect(d[0]?.activity).toBeNull();
    const late = applyChatEvent(d, { event: "activity", data: { message_id: "msg-1", state: "writing", since: "", last_event_at: "", state_ms: 0, idle_ms: 0 } }, "now");
    expect(late[0]?.activity).toBeNull();
  });
  test("a failed reply shows the ErrorNotice and never Thinking or streaming", () => {
    cleanup();
    const failed = row({ status: "error", error: "The agent stopped responding (no output for 5 min). Retry, or change the model in chat settings.", finished_at: "2026-01-01T00:05:00Z" });
    let retried = 0;
    const { container } = render(<MessageView message={failed} now={T0 + 999_000} onOpenImage={() => {}} onRetry={() => { retried++; }} />);
    expect(screen.getByTestId("error-notice").textContent).toContain("The agent stopped responding");
    expect(container.textContent).not.toMatch(/Thinking|streaming/);
    expect(container.querySelector(".msg-status")).toBeNull();
    fireEvent.click(screen.getByTestId("error-retry"));
    expect(retried).toBe(1);
  });
  test("a finished reply has a quiet footer with model, duration, tokens and cost, no status badge", () => {
    cleanup();
    render(<MessageView message={row({ status: "done", content: "hi", model_used: "m1", input_tokens: 1200, output_tokens: 300, cost_usd: 0.02, finished_at: "2026-01-01T00:01:05Z" })} now={T0} onOpenImage={() => {}} />);
    const foot = screen.getByTestId("msg-foot");
    expect(foot.querySelector(".msg-status")).toBeNull();
    expect(foot.textContent).toContain("m1");
    expect(foot.textContent).toContain("1m 5s");
    expect(foot.textContent).toContain("$0.02");
  });
});

describe("ErrorNotice content", () => {
  test.each([
    ["The agent stopped responding (no output for 5 min). Retry, or change the model in chat settings.", "The agent stopped responding", "change the model"],
    ["interrupted: the dashboard restarted before this answer was finished", "The reply was interrupted", "retry to continue"],
    ["agent exited with code 3: model gpt-x is unavailable", "The model is unavailable", "another model"],
    ["agent exited with code 1: boom", "The agent crashed", "Retry"],
    ["something odd", "The reply failed", "Retry"],
  ])("%s", (raw, title, fix) => {
    const s = summarizeError(raw);
    expect(s.title).toBe(title);
    expect(s.fix).toContain(fix);
    expect(s.title).toMatch(/^[A-Z][^A-Z]*$|^The [a-z ]+$/);
  });
  test("raw error is expandable, Copy details is offered, Retry only when given", () => {
    cleanup();
    render(<ErrorNotice error="agent exited with code 3: boom" />);
    expect(screen.queryByTestId("error-retry")).toBeNull();
    expect(screen.getByText("Copy details")).toBeTruthy();
    const details = document.querySelector("details.error-raw") as HTMLDetailsElement;
    expect(details.open).toBe(false);
    expect(details.querySelector("pre")?.textContent).toBe("agent exited with code 3: boom");
  });
});

describe("reduced motion and touch targets (css)", () => {
  const css = readFileSync(join(import.meta.dir, "working-indicator.css"), "utf8");
  test("dots stop under prefers-reduced-motion", () => {
    expect(css).toMatch(/@media \(prefers-reduced-motion: reduce\) \{[^}]*\.working-dots i \{ animation: none/);
  });
  test("44px on touch, focus-visible rings, red only on the error notice", () => {
    expect(css).toMatch(/pointer: coarse[\s\S]*min-height: 44px/);
    expect(css).toContain(":focus-visible");
    const red = css.split("\n").filter((l) => /status-error|#[0-9a-f]{3,6}\b/i.test(l));
    expect(red.every((l) => l.startsWith(".error-notice"))).toBe(true);
  });
});

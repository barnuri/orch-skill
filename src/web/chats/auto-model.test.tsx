import { afterAll, describe, expect, test } from "bun:test";
import { installDom } from "../test/dom";
import type { Chat, ChatOptions, Message } from "../lib/chat-types";

const uninstall = installDom();
const { render, screen, cleanup } = await import("@testing-library/react");
const { MessageView } = await import("./MessageView");
const { Pickers, pickerSummary } = await import("./Pickers");

afterAll(async () => {
  cleanup();
  await new Promise((r) => setTimeout(r, 100));
  uninstall();
});

const row = (over: Partial<Message>): Message => ({ id: "msg-1", chat_id: "c", role: "assistant", content: "hi", status: "done", error: null, model_used: null, input_tokens: 0, output_tokens: 0, cost_usd: null, started_at: null, finished_at: null, created_at: "", attachments: [], ...over });
const model = (id: string, slug = id) => ({ id, label: id, slug, description: "", default: true });
const opts = { harnesses: [
  { id: "copilot", label: "c", enabled: true, available: true, persistent: false, efforts: [], memory: "session", profiles: [
    { name: "copilot", description: "", enabled: true, configured: true, problem: null, models: [model("copilot-auto", "auto")] },
    { name: "pinned", description: "", enabled: true, configured: true, problem: null, models: [model("copilot-opus-5.5")] },
  ] },
], default_harness: null, default_profile: null, not_for_chat: {} } as unknown as ChatOptions;
const auto = { harness: "copilot", profile: "copilot", model_id: "copilot-auto" } as Chat;
const pinned = { harness: "copilot", profile: "pinned", model_id: "copilot-opus-5.5" } as Chat;

describe("auto chat labels", () => {
  test("header: auto -> model, tilde while running, not reported when unknown", () => {
    expect(pickerSummary(auto, opts, "claude-opus-5.5")).toBe("copilot · copilot · auto -> claude-opus-5.5");
    expect(pickerSummary(auto, opts, "claude-opus-5.5", true)).toBe("copilot · copilot · auto -> ~claude-opus-5.5");
    expect(pickerSummary(auto, opts, null)).toBe("copilot · copilot · auto (model not reported)");
  });
  test("header of a pinned chat is unchanged", () => {
    expect(pickerSummary(pinned, opts, null)).toBe("copilot · pinned · copilot-opus-5.5");
    expect(pickerSummary(pinned, opts, "real")).toBe("copilot · pinned · real");
  });
  test("footer: auto -> model with the full id in the tooltip, or not reported", () => {
    cleanup();
    const { rerender } = render(<MessageView message={row({ model_used: "hub/claude-sonnet-x" })} now={0} onOpenImage={() => {}} autoChat />);
    expect(screen.getByTestId("msg-model").textContent).toBe("auto -> claude-sonnet-x");
    expect(screen.getByTestId("msg-model").getAttribute("title")).toBe("hub/claude-sonnet-x");
    rerender(<MessageView message={row({})} now={0} onOpenImage={() => {}} autoChat />);
    expect(screen.getByTestId("msg-model").textContent).toBe("auto (model not reported)");
    rerender(<MessageView message={row({ model_used: "real" })} now={0} onOpenImage={() => {}} />);
    expect(screen.getByTestId("msg-model").textContent).toBe("real");
  });
  test("pickers: the model line follows the same labels", () => {
    cleanup();
    const sel = { harness: "copilot", profile: "copilot", model: "copilot-auto" };
    const { rerender } = render(<Pickers options={opts} selection={sel} locked={false} modelUsed="claude-opus-5.5" onChange={() => {}} effort={{ value: null, onChange: () => {} }} />);
    expect(screen.getByTestId("picker-auto-model").textContent).toBe("auto -> claude-opus-5.5");
    rerender(<Pickers options={opts} selection={sel} locked modelUsed="claude-opus-5.5" expected onChange={() => {}} effort={{ value: null, onChange: () => {} }} />);
    expect(screen.getByTestId("picker-auto-model").textContent).toBe("auto -> ~claude-opus-5.5");
    rerender(<Pickers options={opts} selection={sel} locked={false} modelUsed={null} onChange={() => {}} effort={{ value: null, onChange: () => {} }} />);
    expect(screen.getByTestId("picker-auto-model").textContent).toBe("auto (model not reported)");
  });
});

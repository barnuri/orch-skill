import { afterAll, describe, expect, test } from "bun:test";
import { installDom } from "../test/dom";
import type { QuestionPart } from "../../shared/chat-question";
import type { Message } from "../lib/chat-types";

const uninstall = installDom();
const { render, screen, fireEvent, cleanup, waitFor } = await import("@testing-library/react");
const { QuestionCard } = await import("./QuestionCard");
const { MessageView } = await import("./MessageView");
const { pendingQuestion } = await import("./question-hooks");

afterAll(async () => {
  cleanup();
  await new Promise((r) => setTimeout(r, 100));
  uninstall();
});

const AT = new Date().toISOString();
const single: QuestionPart = {
  type: "question", id: "q1", state: "pending", asked_at: AT,
  questions: [{ header: "Pick", question: "Which color?", multiple: false, allowCustom: true, options: [{ label: "Red", description: "warm" }, { label: "Blue", description: "cool" }] }],
};
const multi: QuestionPart = { ...single, questions: [{ ...(single.questions[0] as object), multiple: true, header: "Many" } as QuestionPart["questions"][0]] };
const two: QuestionPart = { ...single, questions: [single.questions[0] as QuestionPart["questions"][0], { header: "Size", question: "Which size?", multiple: false, allowCustom: false, options: [{ label: "S", description: "" }, { label: "L", description: "" }] }] };

function setup(part: QuestionPart, result: string | null = null) {
  cleanup();
  const calls: Array<string[][] | null> = [];
  const view = render(<QuestionCard pinned part={part} onSubmit={async (a) => { calls.push(a); return result; }} />);
  return { calls, view };
}
const send = (): HTMLButtonElement => screen.getByTestId("question-send") as HTMLButtonElement;

describe("QuestionCard", () => {
  test("single choice: options with descriptions, send stays off until one is chosen", async () => {
    const { calls } = setup(single);
    expect(screen.getByText("Which color?")).toBeTruthy();
    expect(screen.getByText("warm")).toBeTruthy();
    expect(screen.getAllByRole("radio").length).toBe(3);
    expect(send().disabled).toBe(true);
    expect(send().textContent).toBe("Send answer");
    fireEvent.click(screen.getByLabelText(/Blue/));
    expect(send().disabled).toBe(false);
    fireEvent.click(send());
    await waitFor(() => expect(calls).toEqual([[["Blue"]]]));
  });

  test("multiple choice sends every checked label", async () => {
    const { calls } = setup(multi);
    expect(screen.getAllByRole("checkbox").length).toBe(3);
    fireEvent.click(screen.getByLabelText(/Red/));
    fireEvent.click(screen.getByLabelText(/Blue/));
    fireEvent.click(send());
    await waitFor(() => expect(calls).toEqual([[["Red", "Blue"]]]));
  });

  test("Other: typing selects it and replaces the radio choice", async () => {
    const { calls } = setup(single);
    fireEvent.click(screen.getByLabelText(/Red/));
    fireEvent.change(screen.getByLabelText("Other answer"), { target: { value: "  Green " } });
    expect((screen.getByLabelText("Other") as HTMLInputElement).checked).toBe(true);
    fireEvent.click(send());
    await waitFor(() => expect(calls).toEqual([[["Green"]]]));
  });

  test("no Other field when custom answers are not allowed", () => {
    setup(two);
    fireEvent.click(screen.getByLabelText(/Red/));
    fireEvent.click(send());
    expect(screen.queryByLabelText("Other answer")).toBeNull();
  });

  test("Skip sends null", async () => {
    const { calls } = setup(single);
    fireEvent.click(screen.getByText("Skip"));
    await waitFor(() => expect(calls).toEqual([null]));
  });

  test("keyboard: a digit picks an option, Enter sends, a digit typed in the Other field does not pick", async () => {
    const { calls, view } = setup(single);
    const card = view.container.querySelector("section") as HTMLElement;
    fireEvent.keyDown(card, { key: "2" });
    expect((screen.getByLabelText(/Blue/) as HTMLInputElement).checked).toBe(true);
    fireEvent.keyDown(screen.getByLabelText("Other answer"), { key: "1" });
    expect((screen.getByLabelText(/Red/) as HTMLInputElement).checked).toBe(false);
    fireEvent.keyDown(screen.getByLabelText(/Blue/), { key: "Enter" });
    await waitFor(() => expect(calls).toEqual([[["Blue"]]]));
  });

  test("keyboard: arrows move focus between checkboxes", () => {
    setup(multi);
    const boxes = screen.getAllByRole("checkbox") as HTMLInputElement[];
    boxes[0]?.focus();
    fireEvent.keyDown(boxes[0] as HTMLElement, { key: "ArrowDown" });
    expect(document.activeElement).toBe(boxes[1] ?? null);
    fireEvent.keyDown(boxes[1] as HTMLElement, { key: "ArrowUp" });
    expect(document.activeElement).toBe(boxes[0] ?? null);
  });

  test("several questions are steps: Next, Back, then Send answer with all answers", async () => {
    const { calls } = setup(two);
    expect(screen.getByTestId("question-step").textContent).toBe("1 of 2");
    expect(send().textContent).toBe("Next");
    fireEvent.click(screen.getByLabelText(/Red/));
    fireEvent.click(send());
    expect(screen.getByText("Which size?")).toBeTruthy();
    expect(send().textContent).toBe("Send answer");
    expect(send().disabled).toBe(true);
    fireEvent.click(screen.getByText("Back"));
    expect(screen.getByText("Which color?")).toBeTruthy();
    expect((screen.getByLabelText(/Red/) as HTMLInputElement).checked).toBe(true);
    fireEvent.click(send());
    fireEvent.click(screen.getByLabelText(/^L/));
    fireEvent.click(send());
    await waitFor(() => expect(calls).toEqual([[["Red"], ["L"]]]));
  });

  test("disabled while sending, and a failure is shown and re-enables it", async () => {
    cleanup();
    let release: (v: string | null) => void = () => {};
    render(<QuestionCard pinned part={single} onSubmit={() => new Promise<string | null>((r) => { release = r; })} />);
    fireEvent.click(screen.getByLabelText(/Red/));
    fireEvent.click(send());
    expect(send().disabled).toBe(true);
    expect(send().textContent).toBe("Sending…");
    expect((screen.getByText("Skip") as HTMLButtonElement).disabled).toBe(true);
    expect((screen.getByLabelText(/Blue/) as HTMLInputElement).disabled).toBe(true);
    release("question already answered");
    await waitFor(() => expect(screen.getByTestId("question-error").textContent).toBe("question already answered"));
    expect(send().disabled).toBe(false);
  });

  test("older than a day: says the agent stopped waiting", () => {
    cleanup();
    render(<QuestionCard pinned part={{ ...single, asked_at: new Date(Date.now() - 25 * 3600_000).toISOString() }} onSubmit={async () => null} />);
    expect(screen.getByTestId("question-stale")).toBeTruthy();
  });

  test("answered is read-only and collapsed; it opens to show the question and the answer", () => {
    cleanup();
    render(<QuestionCard part={{ ...single, state: "answered", answers: [["Blue"]] }} onSubmit={async () => null} />);
    expect(screen.queryByRole("radio")).toBeNull();
    expect(screen.queryByTestId("question-send")).toBeNull();
    expect(screen.getByText("Answered").parentElement?.textContent).toContain("Blue");
    expect(screen.queryByTestId("question-answers")).toBeNull();
    fireEvent.click(screen.getByRole("button"));
    expect(screen.getByTestId("question-answers").textContent).toContain("Which color?");
    expect(screen.getByTestId("question-answers").textContent).toContain("Blue");
  });

  test("skipped is read-only", () => {
    cleanup();
    render(<QuestionCard part={{ ...single, state: "dismissed" }} onSubmit={async () => null} />);
    expect(screen.getByText("Skipped")).toBeTruthy();
    expect(screen.queryByRole("radio")).toBeNull();
  });
});

const row = (id: string, role: Message["role"], parts?: QuestionPart[]): Message =>
  ({ id, chat_id: "c", role, content: "", status: "done", error: null, model_used: null, input_tokens: 0, output_tokens: 0, cost_usd: null, started_at: null, finished_at: null, created_at: "", attachments: [], parts: parts ?? null }) as unknown as Message;

describe("in the thread", () => {
  test("a pending question shows one quiet line (the card is pinned), an answered one is the collapsed card", () => {
    cleanup();
    const { rerender } = render(<MessageView message={row("m1", "tool", [single])} now={0} onOpenImage={() => {}} />);
    expect(screen.getByTestId("question-waiting").textContent).toContain("waiting for your answer");
    expect(screen.queryByRole("radio")).toBeNull();
    rerender(<MessageView message={row("m1", "tool", [{ ...single, state: "answered", answers: [["Red"]] }])} now={0} onOpenImage={() => {}} />);
    expect(screen.getByTestId("question-card").getAttribute("data-state")).toBe("answered");
  });

  test("pendingQuestion finds the newest waiting question with no user message after it", () => {
    const rows = [row("m1", "user"), row("m2", "tool", [single])];
    expect(pendingQuestion(rows)?.part.id).toBe("q1");
    expect(pendingQuestion([...rows, row("m3", "user")])).toBeNull();
    expect(pendingQuestion([row("m1", "tool", [{ ...single, state: "answered", answers: [["Red"]] }])])).toBeNull();
  });
});

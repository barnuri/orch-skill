import { describe, expect, test } from "bun:test";
import { answerPrompt, answerProblem, isQuestionTool, questionPartFromTool } from "./chat-question";

// Recorded: `opencode run --format json` (opencode 2.3.0), tool_use part `state.input` of a question call.
const OPENCODE_INPUT = { questions: [{ question: "Which color?", header: "Pick", options: [{ label: "Red", description: "A warm color" }, { label: "Blue", description: "A cool color" }] }] };
// claude stream-json assistant `tool_use` block input of AskUserQuestion (two questions, one multi-select).
const CLAUDE_INPUT = {
  questions: [
    { question: "Which database?", header: "DB", multiSelect: false, options: [{ label: "SQLite", description: "file" }, { label: "Postgres", description: "server" }] },
    { question: "Which extras?", header: "Extras", multiSelect: true, options: [{ label: "Auth", description: "" }, { label: "Cache", description: "" }] },
  ],
};
const AT = "2026-01-01T00:00:00Z";

describe("question mapping", () => {
  test("opencode question tool", () => {
    const part = questionPartFromTool("question", "toolu_1", OPENCODE_INPUT, AT);
    expect(part).toEqual({
      type: "question", id: "toolu_1", state: "pending", asked_at: AT,
      questions: [{ header: "Pick", question: "Which color?", multiple: false, allowCustom: true, options: [{ label: "Red", description: "A warm color" }, { label: "Blue", description: "A cool color" }] }],
    });
  });

  test("claude AskUserQuestion with two questions, multiSelect", () => {
    const part = questionPartFromTool("AskUserQuestion", "toolu_2", CLAUDE_INPUT, AT);
    expect(part?.questions.map((q) => [q.header, q.multiple])).toEqual([["DB", false], ["Extras", true]]);
  });

  test("custom: false turns the Other field off", () => {
    const part = questionPartFromTool("question", "x", { questions: [{ question: "q", options: [{ label: "a" }], custom: false }] }, AT);
    expect(part?.questions[0]?.allowCustom).toBe(false);
  });

  test("other tools and empty input are not questions", () => {
    expect(isQuestionTool("bash")).toBe(false);
    expect(isQuestionTool("ask_user_question")).toBe(true);
    expect(questionPartFromTool("bash", "x", OPENCODE_INPUT, AT)).toBeNull();
    expect(questionPartFromTool("question", "x", { questions: [] }, AT)).toBeNull();
    expect(questionPartFromTool("question", "x", null, AT)).toBeNull();
  });
});

describe("answers", () => {
  const part = questionPartFromTool("AskUserQuestion", "t", CLAUDE_INPUT, AT)!;
  test("validation", () => {
    expect(answerProblem(part, [["SQLite"], ["Auth", "Cache"]])).toBeNull();
    expect(answerProblem(part, [["SQLite"]])).toContain("expected 2");
    expect(answerProblem(part, [["SQLite", "Postgres"], ["Auth"]])).toContain("only one");
    expect(answerProblem(part, [[], ["Auth"]])).toContain("choose or type");
    expect(answerProblem(part, [["Oracle"], ["Auth"]])).toBeNull();
    const closed = questionPartFromTool("question", "t", { questions: [{ question: "q", options: [{ label: "a" }], custom: false }] }, AT)!;
    expect(answerProblem(closed, [["b"]])).toContain("not one of the options");
  });

  test("prompt carries the answers, skip says so", () => {
    expect(answerPrompt(part, [["SQLite"], ["Auth", "Cache"]])).toBe("[Answer to your question]\n- DB: Which database? → SQLite\n- Extras: Which extras? → Auth, Cache");
    expect(answerPrompt(part, null)).toContain("skipped");
  });
});

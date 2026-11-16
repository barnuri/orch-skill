/** The agent's question tool as a chat message part. Bun-free: used by the server (mapping, answers) and the web (card). */

export type QuestionState = "pending" | "answered" | "dismissed";

export type QuestionOption = { label: string; description: string };

export type QuestionItem = {
  header: string;
  question: string;
  options: QuestionOption[];
  /** More than one option may be chosen. */
  multiple: boolean;
  /** An answer that is not one of the options (the "Other" field) is allowed. */
  allowCustom: boolean;
};

export type QuestionPart = {
  type: "question";
  /** The harness tool call id. */
  id: string;
  state: QuestionState;
  questions: QuestionItem[];
  /** One list of chosen labels (or typed text) per question; set once answered. */
  answers?: string[][];
  asked_at: string;
  settled_at?: string;
};

/** A question left unanswered this long may be dismissed from the UI. */
export const QUESTION_DISMISS_AFTER_MS = 24 * 60 * 60 * 1000;

const rec = (v: unknown): Record<string, unknown> => (typeof v === "object" && v !== null && !Array.isArray(v) ? (v as Record<string, unknown>) : {});
const str = (v: unknown): string => (typeof v === "string" ? v : "");

/** opencode `question` and claude `AskUserQuestion`. */
export function isQuestionTool(name: string): boolean {
  const n = name.toLowerCase().replace(/[^a-z]/g, "");
  return n === "question" || n === "askuserquestion";
}

/**
 * The question items of a tool input. opencode: `{questions:[{question, header, options:[{label, description}], multiple?, custom?}]}`
 * (custom answers allowed unless `custom` is false). claude: `{questions:[{question, header, options, multiSelect}]}` (the UI
 * always offers "Other"). Returns null when the input has no usable question.
 */
export function questionItemsFromInput(input: unknown): QuestionItem[] | null {
  const raw = rec(input).questions;
  if (!Array.isArray(raw)) {
    return null;
  }
  const items: QuestionItem[] = [];
  for (const q of raw) {
    const r = rec(q);
    const question = str(r.question).trim();
    if (question === "") {
      continue;
    }
    const options = (Array.isArray(r.options) ? r.options : []).flatMap((o): QuestionOption[] => {
      const label = typeof o === "string" ? o : str(rec(o).label);
      return label === "" ? [] : [{ label, description: typeof o === "string" ? "" : str(rec(o).description) }];
    });
    items.push({
      header: str(r.header).trim(), question, options,
      multiple: r.multiple === true || r.multiSelect === true,
      allowCustom: r.custom !== false,
    });
  }
  return items.length === 0 ? null : items;
}

export function questionPartFromTool(name: string, id: string, input: unknown, at: string): QuestionPart | null {
  if (!isQuestionTool(name)) {
    return null;
  }
  const questions = questionItemsFromInput(input);
  return questions === null ? null : { type: "question", id, state: "pending", questions, asked_at: at };
}

/** The user message that carries an answer back to a harness that has no live channel for it. */
export function answerPrompt(part: Pick<QuestionPart, "questions">, answers: string[][] | null): string {
  if (answers === null) {
    return "[Answer to your question] I skipped your question. Continue with your best judgement and say what you assumed.";
  }
  const lines = part.questions.map((q, i) => `- ${q.header === "" ? q.question : `${q.header}: ${q.question}`} → ${(answers[i] ?? []).join(", ") || "(no answer)"}`);
  return `[Answer to your question]\n${lines.join("\n")}`;
}

/** Why `answers` is not valid for `part`, or null. */
export function answerProblem(part: Pick<QuestionPart, "questions">, answers: string[][]): string | null {
  if (answers.length !== part.questions.length) {
    return `answers: expected ${part.questions.length} list(s), got ${answers.length}`;
  }
  for (const [i, q] of part.questions.entries()) {
    const list = answers[i] ?? [];
    if (list.length === 0 || list.some((a) => a.trim() === "")) {
      return `answers[${i}]: choose or type an answer`;
    }
    if (!q.multiple && list.length > 1) {
      return `answers[${i}]: only one answer is allowed`;
    }
    const known = new Set(q.options.map((o) => o.label));
    const custom = list.filter((a) => !known.has(a));
    if (custom.length > 0 && !q.allowCustom) {
      return `answers[${i}]: "${custom[0]}" is not one of the options`;
    }
  }
  return null;
}

/** Typed parts of a chat message. Bun-free: used by the server (mapping from harness streams) and by the web (rendering). */

import type { QuestionPart } from "./chat-question";

export type ToolState = "running" | "done" | "error";
export type TodoStatus = "pending" | "in_progress" | "done";
export interface TodoItem { text: string; status: TodoStatus }

export type ChatPart =
  | { type: "text"; text: string }
  | { type: "reasoning"; text: string }
  | { type: "tool-call"; id: string; name: string; summary: string; input?: unknown; state: ToolState; output?: string; started_at?: string; ended_at?: string }
  | { type: "todo"; items: TodoItem[] }
  | { type: "file"; name: string; mime: string; url?: string }
  | { type: "diff"; path: string; before: string; after: string }
  | AutomationPart
  | QuestionPart;

/** A block a schedule, loop or monitor posts into a chat (the text itself is the message `content`). */
export type AutomationPart = {
  type: "automation";
  kind: "schedule" | "loop" | "monitor";
  level: "result" | "error" | "info";
  title: string;
  item_id?: string;
  /** Link to the full run (a dashboard path). */
  link?: string;
  /** Quiet counter, e.g. `iteration 3`. */
  counter?: string;
};

const rec = (v: unknown): Record<string, unknown> => (typeof v === "object" && v !== null && !Array.isArray(v) ? (v as Record<string, unknown>) : {});
const str = (v: unknown): string => (typeof v === "string" ? v : "");

export function isTodoTool(name: string): boolean {
  const n = name.toLowerCase();
  return n === "todowrite" || n === "todo_write";
}

function todoStatus(v: unknown): TodoStatus {
  const s = str(v).toLowerCase().replace("-", "_");
  return s === "completed" || s === "done" ? "done" : s === "in_progress" ? "in_progress" : "pending";
}

/** Items of an opencode `todowrite` or claude `TodoWrite` input (`{ todos: [{ content, status }] }`), or null when it is not one. */
export function todoItemsFromInput(input: unknown): TodoItem[] | null {
  const todos = rec(input).todos;
  if (!Array.isArray(todos)) {
    return null;
  }
  return todos.map((t) => {
    const r = rec(t);
    return { text: str(r.content) || str(r.text) || str(r.activeForm), status: todoStatus(r.status) };
  });
}

/** A before/after pair of a file edit tool call (claude Edit/Write, opencode edit/write), or null. */
export function diffFromToolInput(name: string, input: unknown): Extract<ChatPart, { type: "diff" }> | null {
  const r = rec(input);
  const path = str(r.file_path) || str(r.filePath) || str(r.path);
  const n = name.toLowerCase();
  if (path === "") {
    return null;
  }
  if (n === "edit" || n === "multiedit") {
    const before = str(r.old_string) || str(r.oldString);
    const after = str(r.new_string) || str(r.newString);
    return before === "" && after === "" ? null : { type: "diff", path, before, after };
  }
  if (n === "write") {
    const after = str(r.content);
    return after === "" ? null : { type: "diff", path, before: "", after };
  }
  return null;
}

export function summarizeToolInput(input: unknown): string {
  const r = rec(input);
  for (const key of ["command", "file_path", "filePath", "path", "pattern", "url", "description", "query"]) {
    if (typeof r[key] === "string") {
      return (r[key] as string).slice(0, 200);
    }
  }
  return "";
}

/** The parts a tool call produces: the call itself, plus a todo checklist or a diff when its input carries one. */
export function partsForToolCall(call: { id: string; name: string; input: unknown; state?: ToolState; output?: string; at?: string }): ChatPart[] {
  const parts: ChatPart[] = [
    {
      type: "tool-call", id: call.id, name: call.name, summary: summarizeToolInput(call.input), input: call.input, state: call.state ?? "running",
      ...(call.output === undefined ? {} : { output: call.output }), ...(call.at === undefined ? {} : { started_at: call.at }),
    },
  ];
  const todos = isTodoTool(call.name) ? todoItemsFromInput(call.input) : null;
  if (todos !== null) {
    parts.push({ type: "todo", items: todos });
  }
  const diff = diffFromToolInput(call.name, call.input);
  if (diff !== null) {
    parts.push(diff);
  }
  return parts;
}

/** Parses the stored `parts` column; null or broken JSON gives null, so the caller falls back to the plain text. */
export function parseParts(raw: unknown): ChatPart[] | null {
  if (Array.isArray(raw)) {
    return raw as ChatPart[];
  }
  if (typeof raw !== "string" || raw === "") {
    return null;
  }
  try {
    const v: unknown = JSON.parse(raw);
    return Array.isArray(v) ? (v as ChatPart[]) : null;
  } catch {
    return null;
  }
}

/** The newest todo list in a thread's parts, for the pinned checklist panel. */
export function latestTodos(messages: ReadonlyArray<{ parts?: unknown }>): TodoItem[] | null {
  for (let i = messages.length - 1; i >= 0; i--) {
    const parts = parseParts(messages[i]?.parts);
    const todo = parts === null ? undefined : [...parts].reverse().find((p) => p.type === "todo");
    if (todo !== undefined && todo.type === "todo") {
      return todo.items;
    }
  }
  return null;
}

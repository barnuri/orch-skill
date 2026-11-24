import type { RunMessage } from "../../shared/types/run-message";

/** Statuses whose node can still read a message: running now, or waiting (pending messages join its prompt). */
const MESSAGEABLE: ReadonlySet<string> = new Set(["running", "waiting"]);

export function canMessage(status: string): boolean {
  return MESSAGEABLE.has(status);
}

/** The node's unanswered asks, oldest first. */
export function openAsks(messages: readonly RunMessage[], nodeId: string): RunMessage[] {
  return messages.filter((m) => m.kind === "ask" && m.from === nodeId && (m.answer === null || m.answer === undefined));
}

/** Messages to or from the node, newest last, at most `limit`. */
export function nodeThread(messages: readonly RunMessage[], nodeId: string, limit: number = 8): RunMessage[] {
  return messages.filter((m) => m.to === nodeId || m.from === nodeId).slice(-limit);
}

/** One line for the thread: `user → a: text` with the delivery state for pending ones. */
export function messageLine(m: RunMessage): string {
  const head = m.kind === "ask" ? `${m.from} asks` : `${m.from} → ${m.to}`;
  const tail = m.kind === "ask" && typeof m.answer === "string" ? ` (answered: ${m.answer})` : ` (${m.status})`;
  return `${head}: ${m.text}${tail}`;
}

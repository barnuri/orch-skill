import type { ChatToolCall } from "../../../shared/types/chat-tool-call";
import type { ChatTurn } from "../../../shared/types/chat-turn";
import { el } from "../dom/el";
import { fmtTime } from "../dom/format";

const ROLE_LABELS: Readonly<Record<ChatTurn["role"], string>> = {
  user: "user",
  assistant: "assistant",
};

function toolRow(tool: ChatToolCall): HTMLElement {
  const row = el("div", { class: "chat-tool" }, [el("span", { class: "chat-tool-name", text: tool.name })]);
  if (tool.summary !== "") {
    row.appendChild(el("span", { class: "chat-tool-summary mono", text: tool.summary }));
  }
  return row;
}

function turnElement(turn: ChatTurn): HTMLElement {
  const article = el("article", { class: `chat-turn is-${turn.role}` });
  const head = el("div", { class: "chat-turn-head" }, [
    el("span", { class: `chat-role is-${turn.role}`, text: ROLE_LABELS[turn.role] }),
  ]);
  if (turn.timestamp !== null) {
    head.appendChild(el("span", { class: "chat-time", text: fmtTime(turn.timestamp) }));
  }
  article.appendChild(head);
  if (turn.text !== "") {
    // `pre` + textContent: the transcript is prose and code, never markup to parse.
    article.appendChild(el("pre", { class: "chat-text", text: turn.text }));
  }
  if (turn.tools.length > 0) {
    const tools = el("div", { class: "chat-tools" });
    for (const tool of turn.tools) {
      tools.appendChild(toolRow(tool));
    }
    article.appendChild(tools);
  }
  return article;
}

/**
 * Display order: newest first. The wire order is chronological — reversing for display is this
 * view's job, so the newest turn is the one you land on without scrolling. Kept separate from
 * the DOM so the ordering itself is testable.
 */
export function orderedForDisplay(turns: readonly ChatTurn[]): ChatTurn[] {
  return [...turns].reverse();
}

/** The session as a conversation, newest turn first. */
export function renderChatTurns(turns: readonly ChatTurn[], truncated: boolean): HTMLElement {
  const list = el("div", { class: "chat-turns" });
  if (truncated) {
    list.appendChild(
      el("p", { class: "hint chat-truncated", text: "Older turns were dropped — transcript too long." }),
    );
  }
  if (turns.length === 0) {
    list.appendChild(el("p", { class: "hint", text: "The transcript holds no turns yet." }));
    return list;
  }
  for (const turn of orderedForDisplay(turns)) {
    list.appendChild(turnElement(turn));
  }
  return list;
}

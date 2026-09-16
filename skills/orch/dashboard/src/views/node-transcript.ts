import type { ChatEnvelope } from "../../../shared/types/chat-envelope";
import type { JobLogEnvelope } from "../../../shared/types/job-log-envelope";
import type { RunNode } from "../../../shared/types/run-node";
import { ApiClient } from "../api/api-client";
import { el } from "../dom/el";
import { render } from "../render";
import { toast } from "../ui/toast";
import { renderChatTurns } from "./chat-turns";

const api = new ApiClient();

const CHAT_LIST_ID: string = "node-chat-list";

type SessionView = "chat" | "output";

interface TranscriptState {
  jobId: string | null;
  loading: boolean;
  envelope: JobLogEnvelope | null;
  error: string | null;
  chat: ChatEnvelope | null;
  chatChecked: boolean;
  view: SessionView;
  /** Turn count at the last scroll-to-newest, so a repaint does not yank a reader back. */
  scrolledTurns: number;
}

const state: TranscriptState = {
  jobId: null,
  loading: false,
  envelope: null,
  error: null,
  chat: null,
  chatChecked: false,
  view: "chat",
  scrolledTurns: -1,
};

function fmtBytes(bytes: number): string {
  if (bytes < 1024) {
    return `${bytes} B`;
  }
  if (bytes < 1024 * 1024) {
    return `${(bytes / 1024).toFixed(1)} KB`;
  }
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}

/**
 * Fetched on demand rather than on every 2 s poll: a transcript is large, only the open node's
 * matters, and it does not change once the job has exited.
 */
function load(jobId: string): void {
  state.jobId = jobId;
  state.loading = true;
  state.envelope = null;
  state.error = null;
  state.chat = null;
  state.chatChecked = false;
  state.view = "chat";
  state.scrolledTurns = -1;
  void api
    .getJobLog(jobId, null)
    .then((result) => {
      // The user may have selected another node while this was in flight.
      if (state.jobId !== jobId) {
        return;
      }
      state.loading = false;
      if (result.kind === "ok") {
        state.envelope = result.body;
      } else if (result.kind === "error" && result.status === 404) {
        state.error = "No transcript on disk — the job log may have been pruned.";
      } else {
        state.error = "Could not read the transcript.";
      }
      render();
    })
    .catch(() => {
      if (state.jobId !== jobId) {
        return;
      }
      state.loading = false;
      state.error = "Could not read the transcript.";
      render();
    });
  loadChat(jobId);
}

/**
 * Only a claude node has a session transcript to show, and a 404 is the normal answer for every
 * other adapter — so a failure here is not surfaced as an error, it just leaves Output as the
 * only view.
 */
function loadChat(jobId: string): void {
  void api
    .getJobChat(jobId, null)
    .then((result) => {
      if (state.jobId !== jobId) {
        return;
      }
      state.chatChecked = true;
      if (result.kind === "ok") {
        state.chat = result.body;
      } else {
        state.view = "output";
      }
      render();
    })
    .catch(() => {
      if (state.jobId !== jobId) {
        return;
      }
      state.chatChecked = true;
      state.view = "output";
      render();
    });
}

/**
 * Only claude is resumable by an id orch chose: `cursor-agent --resume` takes a chatId minted by
 * its own `create-chat`, so for anything else the honest offer is the log, not a resume.
 */
function resumeCommand(node: RunNode, session: string | null): string | null {
  if (session === null || session === "") {
    return null;
  }
  if (node.adapter !== "claude") {
    return null;
  }
  return `claude --resume ${session}`;
}

function copyButton(command: string): HTMLButtonElement {
  const button = el("button", { class: "btn copy-cmd", type: "button", title: "Copy to clipboard" });
  button.append(el("span", { class: "mono copy-cmd-text", text: command }), el("span", { text: "copy" }));
  button.addEventListener("click", () => {
    void navigator.clipboard
      .writeText(command)
      .then(() => {
        toast("ok", "Command copied");
      })
      .catch(() => {
        toast("error", "Could not copy — select the text instead");
      });
  });
  return button;
}

// Falls back to the tail already in run state: better a short session than an error where the
// job log has been pruned but state.json still remembers the last lines.
function outputBody(node: RunNode): HTMLElement {
  if (state.loading) {
    return el("p", { class: "hint", text: "Reading the session…" });
  }
  const envelope = state.envelope;
  if (envelope !== null) {
    return el("pre", { class: "transcript", text: envelope.text });
  }
  if (node.log_tail.length > 0) {
    return el("pre", { class: "transcript", text: node.log_tail.join("\n") });
  }
  const hint = state.error ?? "Log tail appears after the next run sync.";
  return el("p", { class: "hint", text: hint });
}

function chatBody(): HTMLElement {
  const chat = state.chat;
  if (chat === null) {
    const hint = state.chatChecked
      ? "No session chat for this node — only claude records one orch can read."
      : "Reading the session chat…";
    return el("p", { class: "hint", text: hint });
  }
  const list = renderChatTurns(chat.turns, chat.truncated);
  list.setAttribute("id", CHAT_LIST_ID);
  return list;
}

function viewButton(view: SessionView, label: string, enabled: boolean): HTMLButtonElement {
  const button = el("button", {
    class: `btn session-tab${state.view === view ? " is-active" : ""}`,
    type: "button",
    "aria-pressed": state.view === view ? "true" : "false",
  });
  button.textContent = label;
  if (!enabled) {
    button.setAttribute("disabled", "disabled");
    return button;
  }
  button.addEventListener("click", () => {
    state.view = view;
    render();
  });
  return button;
}

function headingText(node: RunNode): string {
  if (state.view === "chat") {
    const chat = state.chat;
    if (chat === null) {
      return "Session";
    }
    const turns = chat.turns.length;
    return `Session — ${turns} turn${turns === 1 ? "" : "s"}, newest first`;
  }
  const envelope = state.envelope;
  if (envelope === null) {
    return node.log_tail.length > 0 ? `Session — last ${node.log_tail.length} lines` : "Session";
  }
  const lines = envelope.text === "" ? 0 : envelope.text.split("\n").length;
  const size = fmtBytes(envelope.bytes);
  return envelope.truncated ? `Session — last ${size} of ${lines} lines` : `Session — ${lines} lines, ${size}`;
}

/**
 * The newest turn sits at the top of a newest-first list, so landing on it means scrolling the
 * list home. Done only when the turn count changed, so a repaint cannot pull a reader who has
 * scrolled back up to older turns.
 */
function scrollToNewest(turns: number): void {
  if (state.scrolledTurns === turns) {
    return;
  }
  state.scrolledTurns = turns;
  requestAnimationFrame(() => {
    const list = document.getElementById(CHAT_LIST_ID);
    if (list !== null) {
      list.scrollTop = 0;
    }
  });
}

/**
 * The whole session for one node: the conversation its harness had (default) or the raw output
 * its adapter printed, plus the command to reopen it.
 */
export function renderNodeTranscript(node: RunNode): HTMLElement {
  const jobId = node.job_id;
  if (jobId !== null && jobId !== "" && state.jobId !== jobId) {
    load(jobId);
  }
  if (jobId === null || jobId === "") {
    state.jobId = null;
    state.envelope = null;
    state.chat = null;
    state.chatChecked = true;
    state.view = "output";
    state.error = "Not dispatched yet — no session to show.";
  }
  const section = el("section", { class: "node-session", "aria-label": "Node session" });
  const head = el("div", { class: "node-session-head" }, [
    el("h3", { class: "panel-log-title", text: headingText(node) }),
  ]);
  const tabs = el("div", { class: "session-tabs", role: "group", "aria-label": "Session view" }, [
    viewButton("chat", "Chat", state.chat !== null),
    viewButton("output", "Output", true),
  ]);
  head.appendChild(tabs);
  const command = resumeCommand(node, state.envelope?.session ?? node.session ?? null);
  if (command !== null) {
    head.appendChild(copyButton(command));
  }
  section.append(head, state.view === "chat" ? chatBody() : outputBody(node));
  if (state.view === "chat" && state.chat !== null) {
    scrollToNewest(state.chat.turns.length);
  }
  return section;
}

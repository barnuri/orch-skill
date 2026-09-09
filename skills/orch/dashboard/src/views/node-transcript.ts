import type { JobLogEnvelope } from "../../../shared/types/job-log-envelope";
import type { RunNode } from "../../../shared/types/run-node";
import { ApiClient } from "../api/api-client";
import { el } from "../dom/el";
import { render } from "../render";
import { toast } from "../ui/toast";

const api = new ApiClient();

interface TranscriptState {
  jobId: string | null;
  loading: boolean;
  envelope: JobLogEnvelope | null;
  error: string | null;
}

const state: TranscriptState = { jobId: null, loading: false, envelope: null, error: null };

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
function transcriptBody(node: RunNode): HTMLElement {
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

function headingText(node: RunNode): string {
  const envelope = state.envelope;
  if (envelope === null) {
    return node.log_tail.length > 0 ? `Session — last ${node.log_tail.length} lines` : "Session";
  }
  const lines = envelope.text === "" ? 0 : envelope.text.split("\n").length;
  const size = fmtBytes(envelope.bytes);
  return envelope.truncated ? `Session — last ${size} of ${lines} lines` : `Session — ${lines} lines, ${size}`;
}

/**
 * The whole session for one node: the transcript its harness wrote, plus the command to reopen
 * it. Returns null for a node that was never dispatched — there is no session to show.
 */
export function renderNodeTranscript(node: RunNode): HTMLElement {
  const jobId = node.job_id;
  if (jobId !== null && jobId !== "" && state.jobId !== jobId) {
    load(jobId);
  }
  if (jobId === null || jobId === "") {
    state.jobId = null;
    state.envelope = null;
    state.error = "Not dispatched yet — no session to show.";
  }
  const section = el("section", { class: "node-session", "aria-label": "Node session" });
  const head = el("div", { class: "node-session-head" }, [
    el("h3", { class: "panel-log-title", text: headingText(node) }),
  ]);
  const command = resumeCommand(node, state.envelope?.session ?? node.session ?? null);
  if (command !== null) {
    head.appendChild(copyButton(command));
  }
  section.append(head, transcriptBody(node));
  return section;
}

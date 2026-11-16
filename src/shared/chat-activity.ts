/** What a running reply is doing right now, and how a failed one is described. Shared by the server (heartbeat) and the page. Bun-free. */

export type ActivityState = "starting" | "thinking" | "writing" | "tool" | "waiting";

export const STALL_MS = 45_000;
export const DEAD_MS = 5 * 60_000;

export interface ChatActivity {
  state: ActivityState;
  /** ISO time the current state began. */
  since: string;
  /** ISO time of the last event of any kind from the agent. */
  last_event_at: string;
  /** Age of `since` and of `last_event_at` when this was measured, so a client with a skewed clock can still count. */
  state_ms: number;
  idle_ms: number;
  tool?: { id: string; name: string; started_at: string } | null;
}

export function formatClock(ms: number): string {
  const total = Number.isFinite(ms) && ms > 0 ? Math.floor(ms / 1000) : 0;
  return `${Math.floor(total / 60)}:${String(total % 60).padStart(2, "0")}`;
}

function span(ms: number): string {
  const total = Math.max(0, Math.floor(ms / 1000));
  const m = Math.floor(total / 60);
  return m === 0 ? `${total}s` : `${m}m ${String(total % 60).padStart(2, "0")}s`;
}

export function isStalled(activity: Pick<ChatActivity, "state">, idleMs: number): boolean {
  return activity.state !== "waiting" && idleMs >= STALL_MS;
}

/** The label next to the dots and, for a running tool, its elapsed time. `idleMs` and `stateMs` are already advanced to now. */
export function activityParts(activity: ChatActivity, idleMs: number, stateMs: number): { label: string; time: string | null; stalled: boolean } {
  if (isStalled(activity, idleMs)) {
    return { label: `Still working, no output for ${span(idleMs)}`, time: null, stalled: true };
  }
  switch (activity.state) {
    case "thinking": return { label: "Thinking", time: null, stalled: false };
    case "writing": return { label: "Writing", time: null, stalled: false };
    case "waiting": return { label: "Waiting for your answer", time: null, stalled: false };
    case "tool": return { label: `Running ${activity.tool?.name ?? "a tool"}`, time: formatClock(stateMs), stalled: false };
    default: return { label: "Starting", time: null, stalled: false };
  }
}

export function activityLabel(activity: ChatActivity, idleMs: number, stateMs: number): string {
  const p = activityParts(activity, idleMs, stateMs);
  return p.time === null ? p.label : `${p.label} · ${p.time}`;
}

export function silentMessage(idleMs: number): string {
  const minutes = Math.round(idleMs / 60_000);
  const how = idleMs >= 60_000 ? `${String(minutes)} min` : `${String(Math.round(idleMs / 1000))} s`;
  return `The agent stopped responding (no output for ${how}). Retry, or change the model in chat settings.`;
}

export const EXITED_MESSAGE = "The agent process ended without a result. Retry, or change the model in chat settings.";

export interface ErrorSummary { kind: "silent" | "interrupted" | "model" | "crash" | "generic"; title: string; fix: string }

/** Sentence-case title and one sentence naming the fix, from the raw error text. */
export function summarizeError(raw: string | null): ErrorSummary {
  const text = raw ?? "";
  if (/stopped responding|ended without a result/i.test(text)) {
    return { kind: "silent", title: "The agent stopped responding", fix: "Retry, or change the model in chat settings." };
  }
  if (/^interrupted:/i.test(text)) {
    return { kind: "interrupted", title: "The reply was interrupted", fix: "The dashboard restarted mid-reply; retry to continue, the partial answer is kept." };
  }
  if (/model[^.\n]{0,60}(not found|unavailable|unknown|not supported|does not exist|overloaded)|no such model|unknown model|invalid model|rate.?limit|\b(404|429|503)\b/i.test(text)) {
    return { kind: "model", title: "The model is unavailable", fix: "Pick another model in chat settings, then retry." };
  }
  if (/exited with code|exit code|crash|spawn|could not start/i.test(text)) {
    return { kind: "crash", title: "The agent crashed", fix: "Retry; if it keeps failing, check the harness in settings." };
  }
  return { kind: "generic", title: "The reply failed", fix: "Retry, or change the model in chat settings." };
}

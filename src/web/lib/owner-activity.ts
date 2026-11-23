export interface ActivityPart {
  kind: "text" | "tool" | "reasoning";
  text: string;
  tool?: string;
}

export interface ActivityMessage {
  id: string;
  role: string;
  time: string | null;
  parts: ActivityPart[];
}

export interface ActivityEnvelope {
  state: "ok" | "gone" | "unknown";
  messages: ActivityMessage[];
  next: string | null;
}

export interface ActivityLine {
  key: string;
  time: string | null;
  kind: string;
  text: string;
}

export const AGENT_SESSION_EMPTY = "This node's owner is an agent session. Its activity is read from the session, not from a job log.";
export const INLINE_EMPTY = "Done inline by the orchestrator: no job log. See notes below";

/** Every part becomes one `time  kind  text` line, oldest first. */
export function activityLines(body: ActivityEnvelope): ActivityLine[] {
  const lines: ActivityLine[] = [];
  for (const m of body.messages) {
    m.parts.forEach((p, i) => {
      lines.push({ key: `${m.id}:${i}`, time: m.time, kind: p.kind === "tool" ? `tool ${p.tool ?? ""}`.trim() : p.kind, text: p.text });
    });
  }
  return lines;
}

/** The newest tool or text line, truncated: the card tooltip. */
export function latestActivityLine(body: ActivityEnvelope | undefined | null, max = 100): string | null {
  if (!body) {
    return null;
  }
  const lines = activityLines(body).filter((l) => l.kind !== "reasoning" && l.text !== "");
  const last = lines[lines.length - 1];
  if (!last) {
    return null;
  }
  const text = `${last.kind}: ${last.text}`;
  return text.length > max ? `${text.slice(0, max - 1)}…` : text;
}

/** Owner is an opencode session and nothing was dispatched: the activity comes from the session. */
export function usesSessionActivity(node: { owner?: string | null; owner_kind?: string | null; job_id: string | null }): boolean {
  const owner = node.owner ?? "";
  const session = node.owner_kind === "session" || /^(agent[\s:]+)?ses_[A-Za-z0-9]+$/.test(owner);
  return session && (node.job_id === null || node.job_id === "");
}

/** No owner (or the coordinator) and no job: the work was done inline. */
export function isInline(node: { owner?: string | null; job_id: string | null; status: string }): boolean {
  const none = (node.owner ?? "") === "" || node.owner === "coordinator";
  return none && (node.job_id === null || node.job_id === "") && node.status !== "waiting";
}

import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";

export { isAutoSelector } from "../../shared/auto-model";

/**
 * The model copilot really used in one turn, read from its session log (`events.jsonl`): the last
 * `assistant.message` model at or after `sinceMs`, else the last `session.model_change` away from `auto`.
 * Null when the log names no model for the turn.
 */
export function copilotServedModel(jsonl: string, sinceMs: number): string | null {
  let message: string | null = null;
  let change: string | null = null;
  for (const line of jsonl.split("\n")) {
    if (!line.includes("\"model\"") && !line.includes("newModel")) {
      continue;
    }
    let ev: { type?: string; timestamp?: string; data?: { model?: unknown; newModel?: unknown } };
    try {
      ev = JSON.parse(line);
    } catch {
      continue;
    }
    const at = ev.timestamp === undefined ? Number.NaN : Date.parse(ev.timestamp);
    if (Number.isFinite(at) && at < sinceMs) {
      continue;
    }
    if (ev.type === "assistant.message" && typeof ev.data?.model === "string" && ev.data.model !== "" && ev.data.model !== "auto") {
      message = ev.data.model;
    } else if (ev.type === "session.model_change" && typeof ev.data?.newModel === "string" && ev.data.newModel !== "" && ev.data.newModel !== "auto") {
      change = ev.data.newModel;
    }
  }
  return message ?? change;
}

/** Reads copilot's session log for `sessionId` and returns the model of the turn that started at `sinceMs`. */
export function readCopilotServedModel(sessionId: string, sinceMs: number, env: Record<string, string | undefined> = process.env): string | null {
  const root = env.COPILOT_HOME ?? join(env.HOME ?? "", ".copilot");
  const file = join(root, "session-state", sessionId, "events.jsonl");
  if (!existsSync(file)) {
    return null;
  }
  try {
    return copilotServedModel(readFileSync(file, "utf8"), sinceMs);
  } catch {
    return null;
  }
}

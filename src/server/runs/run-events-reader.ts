import { readFileSync } from "node:fs";
import { join } from "node:path";

import type { RunEvent, RunEventsEnvelope } from "../../shared/types/run-event";
import type { OrchPaths } from "../types/orch-paths";
import { isRunId } from "./run-id";

export const EVENTS_MAX: number = 200;

function parseLine(line: string, n: number): RunEvent | null {
  try {
    const v = JSON.parse(line) as Partial<RunEvent>;
    if (typeof v.at !== "string" || typeof v.kind !== "string") {
      return null;
    }
    return { n, at: v.at, kind: v.kind, node: v.node ?? null, from: v.from ?? null, to: v.to ?? null, note: v.note ?? null, by: v.by ?? null };
  } catch {
    return null;
  }
}

/** Events after line `after` (1-based numbers), oldest first, capped at the newest EVENTS_MAX. `null` = bad run id. */
export function readEvents(paths: OrchPaths, id: string, after: number): RunEventsEnvelope | null {
  if (!isRunId(id)) {
    return null;
  }
  let text = "";
  try {
    text = readFileSync(join(paths.runs, id, "events.jsonl"), "utf8");
  } catch {
    return { events: [], next: after };
  }
  const lines = text.split("\n").filter((l) => l !== "");
  const events: RunEvent[] = [];
  for (let i = Math.max(0, after); i < lines.length; i += 1) {
    const e = parseLine(lines[i] ?? "", i + 1);
    if (e !== null) {
      events.push(e);
    }
  }
  return { events: events.slice(-EVENTS_MAX), next: lines.length };
}

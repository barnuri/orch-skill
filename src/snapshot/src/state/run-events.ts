import type { RunEvent } from "../../../shared/types/run-event";

/** The activity feed of the run page that is open; `runId` guards against a feed from another run. */
export const runEvents: { runId: string; events: RunEvent[] } = { runId: "", events: [] };

export function eventsFor(runId: string): RunEvent[] {
  return runEvents.runId === runId ? runEvents.events : [];
}

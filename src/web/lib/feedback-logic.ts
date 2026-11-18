import type { FeedbackItem, FeedbackKind, FeedbackStatus } from "../../shared/types/feedback";
import { FEEDBACK_KINDS, FEEDBACK_STATUSES } from "../../shared/types/feedback";

export const ALL_STATUSES = "all" as const;
export type StatusFilter = FeedbackStatus | typeof ALL_STATUSES;

export type RowAction = "queue" | "wontfix" | "reopen";

/** The row actions a status allows: new can be queued or wontfix; queued and working can be wontfix; done and wontfix can be reopened. */
export function actionsFor(status: FeedbackStatus): { action: RowAction; target: FeedbackStatus; label: string }[] {
  switch (status) {
    case "new":
      return [
        { action: "queue", target: "queued", label: "Queue" },
        { action: "wontfix", target: "wontfix", label: "Mark wontfix" },
      ];
    case "queued":
    case "working":
      return [{ action: "wontfix", target: "wontfix", label: "Mark wontfix" }];
    case "done":
    case "wontfix":
      return [{ action: "reopen", target: "new", label: "Reopen" }];
  }
}

/** Newest first by created time, then by id, so two items in the same second keep a stable order. */
export function sortNewestFirst(items: readonly FeedbackItem[]): FeedbackItem[] {
  return [...items].sort((a, b) => (a.created === b.created ? b.id.localeCompare(a.id) : b.created.localeCompare(a.created)));
}

export function filterByStatus(items: readonly FeedbackItem[], status: StatusFilter): FeedbackItem[] {
  return status === ALL_STATUSES ? [...items] : items.filter((item) => item.status === status);
}

/** The ids of the items that "Work on all new feedback" would start. */
export function newIds(items: readonly FeedbackItem[]): string[] {
  return items.filter((item) => item.status === "new").map((item) => item.id);
}

/** Keeps only the selected ids that are still in the list, so a filtered-out or removed row cannot stay selected. */
export function pruneSelection(selected: ReadonlySet<string>, items: readonly FeedbackItem[]): Set<string> {
  const present = new Set(items.map((item) => item.id));
  return new Set([...selected].filter((id) => present.has(id)));
}

export function statusOptions(): { value: StatusFilter; label: string }[] {
  return [{ value: ALL_STATUSES, label: "All statuses" }, ...FEEDBACK_STATUSES.map((s) => ({ value: s, label: s }))];
}

export function kindOptions(): { value: FeedbackKind; label: string }[] {
  return FEEDBACK_KINDS.map((k) => ({ value: k, label: k }));
}

/** The link target of a row's chat or run, or null when the item has neither. */
export function linkFor(item: FeedbackItem): { href: string; label: string } | null {
  if (item.chat_id !== undefined && item.chat_id !== "") {
    return { href: `#/chats/${encodeURIComponent(item.chat_id)}`, label: `chat ${item.chat_id}` };
  }
  if (item.run_id !== undefined && item.run_id !== "") {
    return { href: `#/run/${encodeURIComponent(item.run_id)}`, label: `run ${item.run_id}` };
  }
  return null;
}

/** The status of the batch run an item is in, from the loaded run list; null when the item has no run or the run is not listed. */
export function workRunStatus(item: FeedbackItem, runStatus: ReadonlyMap<string, string>): string | null {
  if (item.work_run === undefined || item.work_run === "") {
    return null;
  }
  return runStatus.get(item.work_run) ?? null;
}

export function workSummary(count: number, runId: string | null): string {
  return runId === null ? "No new feedback to work on" : `Started ${count} item(s) in run ${runId}`;
}

import type { RunStatus } from "../../../shared/types/run-status";
import type { RunSummary } from "../../../shared/types/run-summary";
import { RUN_FILTERS_KEY } from "../constants";

/** `all` keeps every run; the rest are max-age cutoffs in days. */
export const RUN_AGE_VALUES = ["1d", "7d", "30d", "all"] as const;

export type RunAge = (typeof RUN_AGE_VALUES)[number];

export const ALL_STATUSES = "all";

export interface RunFilters {
  age: RunAge;
  status: RunStatus | typeof ALL_STATUSES;
}

// The list is a working view, not an archive: yesterday's runs are what you came for.
export const DEFAULT_RUN_FILTERS: RunFilters = { age: "1d", status: ALL_STATUSES };

// Widest possible view. The default filters can themselves hide every run, and resetting to
// them would then be a no-op — the way out of an empty list has to widen, not reset.
export const SHOW_ALL_RUN_FILTERS: RunFilters = { age: "all", status: ALL_STATUSES };

const MS_PER_DAY: number = 86_400_000;
const AGE_DAYS: Record<RunAge, number | null> = { "1d": 1, "7d": 7, "30d": 30, all: null };

export const AGE_LABELS: Record<RunAge, string> = {
  "1d": "Last 24 hours",
  "7d": "Last 7 days",
  "30d": "Last 30 days",
  all: "Any age",
};

function isRunAge(value: unknown): value is RunAge {
  return typeof value === "string" && (RUN_AGE_VALUES as readonly string[]).includes(value);
}

function isStatusFilter(value: unknown): value is RunFilters["status"] {
  return value === ALL_STATUSES || value === "running" || value === "done" || value === "error";
}

/** Unknown or half-written stored JSON falls back to the default field by field. */
export function parseRunFilters(raw: string | null): RunFilters {
  if (raw === null) {
    return { ...DEFAULT_RUN_FILTERS };
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return { ...DEFAULT_RUN_FILTERS };
  }
  if (typeof parsed !== "object" || parsed === null) {
    return { ...DEFAULT_RUN_FILTERS };
  }
  const record = parsed as Record<string, unknown>;
  return {
    age: isRunAge(record["age"]) ? record["age"] : DEFAULT_RUN_FILTERS.age,
    status: isStatusFilter(record["status"]) ? record["status"] : DEFAULT_RUN_FILTERS.status,
  };
}

export function runFiltersActive(filters: RunFilters): boolean {
  return filters.age !== DEFAULT_RUN_FILTERS.age || filters.status !== DEFAULT_RUN_FILTERS.status;
}

/**
 * A running run is never aged out — active work stays on screen however long it has been
 * going. Everything else ages from when it finished, falling back to when it started.
 */
export function matchesRunFilters(run: RunSummary, filters: RunFilters, nowMs: number): boolean {
  if (filters.status !== ALL_STATUSES && run.status !== filters.status) {
    return false;
  }
  const days = AGE_DAYS[filters.age];
  if (days === null || run.status === "running") {
    return true;
  }
  const stamp = Date.parse(run.finished ?? run.started);
  // An unparseable timestamp must not silently hide a run.
  return Number.isNaN(stamp) || nowMs - stamp <= days * MS_PER_DAY;
}

export function loadRunFilters(): RunFilters {
  try {
    return parseRunFilters(localStorage.getItem(RUN_FILTERS_KEY));
  } catch {
    return { ...DEFAULT_RUN_FILTERS };
  }
}

export function saveRunFilters(filters: RunFilters): void {
  try {
    localStorage.setItem(RUN_FILTERS_KEY, JSON.stringify(filters));
  } catch {
    // A blocked or full localStorage must not break filtering for the session.
  }
}

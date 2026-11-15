const EM_DASH: string = "—";
const ELLIPSIS: string = "…";
const SECONDS_PER_MINUTE = 60;
const MINUTES_PER_HOUR = 60;
const JUST_NOW_SECONDS = 2;

export function fmtTime(iso: string | null): string {
  if (!iso) {
    return EM_DASH;
  }
  const date = new Date(iso);
  return Number.isNaN(date.getTime()) ? iso : date.toLocaleString(undefined, { hour12: false });
}

export function fmtDur(startIso: string | null, endIso?: string | null): string {
  if (!startIso) {
    return EM_DASH;
  }
  const end = endIso ? new Date(endIso).getTime() : Date.now();
  const ms = end - new Date(startIso).getTime();
  if (Number.isNaN(ms) || ms < 0) {
    return EM_DASH;
  }
  const totalSeconds = Math.round(ms / 1000);
  if (totalSeconds < SECONDS_PER_MINUTE) {
    return `${totalSeconds}s`;
  }
  const totalMinutes = Math.floor(totalSeconds / SECONDS_PER_MINUTE);
  const seconds = totalSeconds - totalMinutes * SECONDS_PER_MINUTE;
  if (totalMinutes < MINUTES_PER_HOUR) {
    return `${totalMinutes}m ${seconds}s`;
  }
  const hours = Math.floor(totalMinutes / MINUTES_PER_HOUR);
  const minutes = totalMinutes - hours * MINUTES_PER_HOUR;
  return `${hours}h ${minutes}m`;
}

export function ago(epochMs: number): string {
  const seconds = Math.max(0, Math.round((Date.now() - epochMs) / 1000));
  return seconds < JUST_NOW_SECONDS ? "just now" : `${seconds}s ago`;
}

const USD_DECIMALS = 2;
/** Below this, two decimals would round a real charge to $0.00 and read as free. */
const USD_MIN_SHOWN = 0.01;

/**
 * A node's cost, compact enough for a graph node. Anything above a cent gets two decimals; a
 * smaller non-zero amount is shown as a bound rather than rounded away to nothing.
 */
export function fmtUsd(usd: number): string {
  if (!Number.isFinite(usd) || usd < 0) {
    return EM_DASH;
  }
  if (usd === 0) {
    return "$0.00";
  }
  if (usd < USD_MIN_SHOWN) {
    return `<$${USD_MIN_SHOWN.toFixed(USD_DECIMALS)}`;
  }
  return `$${usd.toFixed(USD_DECIMALS)}`;
}

export function truncate(text: string, max: number): string {
  return text.length > max ? `${text.slice(0, max - 1)}${ELLIPSIS}` : text;
}

// Second precision, matching the `ts` format `memory add` writes (validated by the server).
export function nowIso(): string {
  return new Date().toISOString().replace(/\.\d{3}Z$/, "Z");
}

const SECONDS_PER_DAY = 86400;
const MS = 1000;

/** "3m ago", "2h ago", "5d ago": the age of an ISO timestamp, for lists where the clock matters less. */
export function rel(iso: string | null): string {
  if (!iso) {
    return EM_DASH;
  }
  const then = new Date(iso).getTime();
  if (Number.isNaN(then)) {
    return iso;
  }
  const seconds = Math.max(0, Math.round((Date.now() - then) / MS));
  if (seconds < JUST_NOW_SECONDS) {
    return "just now";
  }
  if (seconds < SECONDS_PER_MINUTE) {
    return `${seconds}s ago`;
  }
  const minutes = Math.floor(seconds / SECONDS_PER_MINUTE);
  if (minutes < MINUTES_PER_HOUR) {
    return `${minutes}m ago`;
  }
  const hours = Math.floor(minutes / MINUTES_PER_HOUR);
  return seconds < SECONDS_PER_DAY ? `${hours}h ago` : `${Math.floor(seconds / SECONDS_PER_DAY)}d ago`;
}

/** Time left until an epoch-seconds moment: "4m 12s", "now" once it has passed. */
export function until(epochSeconds: number): string {
  const seconds = Math.round(epochSeconds - Date.now() / MS);
  if (seconds <= 0) {
    return "now";
  }
  if (seconds < SECONDS_PER_MINUTE) {
    return `${seconds}s`;
  }
  const minutes = Math.floor(seconds / SECONDS_PER_MINUTE);
  if (minutes < MINUTES_PER_HOUR) {
    return `${minutes}m ${seconds - minutes * SECONDS_PER_MINUTE}s`;
  }
  const hours = Math.floor(minutes / MINUTES_PER_HOUR);
  return hours < 48 ? `${hours}h ${minutes - hours * MINUTES_PER_HOUR}m` : `${Math.floor(hours / 24)}d`;
}

/** An interval in seconds as a short label: 30 -> "30s", 900 -> "15m", 0 -> "stream". */
export function everyLabel(seconds: number): string {
  if (seconds <= 0) {
    return "stream";
  }
  if (seconds < SECONDS_PER_MINUTE) {
    return `${seconds}s`;
  }
  return seconds < 3600 ? `${Math.round(seconds / SECONDS_PER_MINUTE)}m` : `${Math.round(seconds / 3600)}h`;
}

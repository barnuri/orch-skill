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

export function truncate(text: string, max: number): string {
  return text.length > max ? `${text.slice(0, max - 1)}${ELLIPSIS}` : text;
}

// Second precision, matching the `ts` format `memory add` writes (validated by the server).
export function nowIso(): string {
  return new Date().toISOString().replace(/\.\d{3}Z$/, "Z");
}

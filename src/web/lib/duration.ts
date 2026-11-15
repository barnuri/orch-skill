const MS = 1000;
const SECOND_PER_MINUTE = 60;
const MINUTE_PER_HOUR = 60;
const HOUR_PER_DAY = 24;

/** "45s", "2m 19s", "1h 3m", "2d 4h": the two largest units of a span in milliseconds. */
export function formatDuration(ms: number): string {
  const total = Number.isFinite(ms) && ms > 0 ? Math.round(ms / MS) : 0;
  if (total < SECOND_PER_MINUTE) {
    return `${total}s`;
  }
  const minutes = Math.floor(total / SECOND_PER_MINUTE);
  if (minutes < MINUTE_PER_HOUR) {
    return `${minutes}m ${total - minutes * SECOND_PER_MINUTE}s`;
  }
  const hours = Math.floor(minutes / MINUTE_PER_HOUR);
  if (hours < HOUR_PER_DAY) {
    return `${hours}h ${minutes - hours * MINUTE_PER_HOUR}m`;
  }
  const days = Math.floor(hours / HOUR_PER_DAY);
  return `${days}d ${hours - days * HOUR_PER_DAY}h`;
}

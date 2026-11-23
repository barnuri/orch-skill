import { useEffect, useState } from "react";

/** How long a first fetch may take before the loader admits it is slow and offers a way out. */
export const SLOW_LOAD_MS = 8000;

/** True once `pending` has lasted `ms`. Resets when pending ends. */
export function useSlowLoad(pending: boolean, ms: number = SLOW_LOAD_MS): boolean {
  const [slow, setSlow] = useState(false);
  useEffect(() => {
    if (!pending) {
      setSlow(false);
      return;
    }
    const timer = setTimeout(() => setSlow(true), ms);
    return () => clearTimeout(timer);
  }, [pending, ms]);
  return slow;
}

/** Shown under any loader that runs longer than SLOW_LOAD_MS: says so, and offers a retry or a reload. */
export function SlowLoadNote({ onRetry }: { onRetry?: () => void }) {
  return (
    <div className="loader-slow" role="status">
      <span>Still loading. The server is slow or busy.</span>
      <button className="btn" type="button" onClick={onRetry ?? (() => location.reload())}>
        {onRetry === undefined ? "Reload" : "Retry"}
      </button>
    </div>
  );
}

/** Placeholder rows with the height of the real ones, shown while the first fetch is in flight. */
export function Skeleton({ rows, onRetry, slowMs }: { rows: number; onRetry?: () => void; slowMs?: number }) {
  const slow = useSlowLoad(true, slowMs);
  return (
    <div className="runs" aria-busy="true" aria-label="Loading">
      {Array.from({ length: rows }, (_, index) => (
        <div key={index} className="skeleton-row" />
      ))}
      {slow ? <SlowLoadNote {...(onRetry === undefined ? {} : { onRetry })} /> : null}
    </div>
  );
}

/** Whole-page loader: used where a page has no rows to imitate (route chunks, a run that has not arrived). */
export function PageLoader({ label, onRetry, slowMs }: { label: string; onRetry?: () => void; slowMs?: number }) {
  const slow = useSlowLoad(true, slowMs);
  return (
    <div className="page-loader" role="status" aria-busy="true" aria-live="polite">
      <div className="page-loader-spinner" aria-hidden="true" />
      <p>{label}</p>
      <div className="skeleton-row" />
      <div className="skeleton-row" />
      {slow ? <SlowLoadNote {...(onRetry === undefined ? {} : { onRetry })} /> : null}
    </div>
  );
}

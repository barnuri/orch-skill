/** Placeholder rows with the height of the real ones, shown while the first fetch is in flight. */
export function Skeleton({ rows }: { rows: number }) {
  return (
    <div className="runs" aria-busy="true" aria-label="Loading">
      {Array.from({ length: rows }, (_, index) => (
        <div key={index} className="skeleton-row" />
      ))}
    </div>
  );
}

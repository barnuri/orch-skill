import type { ReactNode } from "react";

interface EmptyStateProps {
  title: string;
  children: ReactNode;
  action?: ReactNode;
}

/** A 600-weight title and one sentence that names the fix, with an optional action. */
export function EmptyState({ title, children, action }: EmptyStateProps) {
  return (
    <div className="empty-state">
      <div className="empty-title">{title}</div>
      <div className="empty-text">{children}</div>
      {action === undefined ? null : <div className="empty-actions">{action}</div>}
    </div>
  );
}

import type { ReactNode } from "react";

interface PanelProps {
  title?: string;
  onClose?: () => void;
  profile?: boolean;
  children: ReactNode;
}

/** The side panel: sticky on desktop, in the flow on a phone. */
export function Panel({ title, onClose, profile = false, children }: PanelProps) {
  return (
    <aside className={profile ? "panel profile-panel" : "panel"}>
      {title === undefined ? null : (
        <h2>
          <span>{title}</span>
          {onClose === undefined ? null : (
            <button className="panel-close" type="button" title="Close editor (Esc)" aria-label="Close editor" onClick={onClose}>
              ✕
            </button>
          )}
        </h2>
      )}
      {children}
    </aside>
  );
}

/** A bordered surface for a list or ledger. */
export function PanelBox({ className, children }: { className?: string; children: ReactNode }) {
  return <section className={className === undefined ? "panel-box" : `panel-box ${className}`}>{children}</section>;
}

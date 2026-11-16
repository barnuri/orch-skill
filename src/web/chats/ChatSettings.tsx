import { useId, useState } from "react";
import type { ReactNode } from "react";
import { readChatPrefs, writeChatPrefs } from "../lib/chat-prefs";

export interface SettingsBadge {
  tone: "warn" | "error";
  text: string;
}

/**
 * The harness, profile, model and effort row, folded into one summary line. The open or closed choice is global (all chats).
 * Anything that needs attention stays on the summary line as a badge, so folding never hides a problem.
 */
export function ChatSettings({ summary, badge, children }: { summary: string; badge: SettingsBadge | null; children: ReactNode }) {
  const [open, setOpen] = useState(() => readChatPrefs().settingsOpen);
  const panel = useId();
  const toggle = (): void => {
    const next = !open;
    setOpen(next);
    writeChatPrefs({ settingsOpen: next });
  };
  return (
    <div className="chat-settings" data-open={open} data-testid="chat-settings">
      <button type="button" className="settings-toggle" aria-expanded={open} aria-controls={panel} aria-label="Chat settings" title="Chat settings" onClick={toggle}>
        <span className="settings-summary mono" data-testid="settings-summary">{summary}</span>
        {badge === null ? null : (
          <span className="settings-badge" data-tone={badge.tone} data-testid="settings-badge" role={badge.tone === "error" ? "alert" : "status"}>{badge.text}</span>
        )}
        <svg className="settings-chevron" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true"><path d="m6 9 6 6 6-6" /></svg>
      </button>
      <div id={panel} className="settings-panel" role="group" aria-label="Chat settings" inert={!open}>
        <div className="settings-panel-inner">{children}</div>
      </div>
    </div>
  );
}

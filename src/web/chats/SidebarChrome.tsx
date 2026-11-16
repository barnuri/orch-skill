import { useCallback, useEffect, useRef, useState } from "react";
import { newChatHash } from "../router/route";
import { isSidebarShortcut, readSidebarMode, SIDEBAR_WIDE_QUERY, toggledMode, writeSidebarMode } from "../lib/sidebar-prefs";
import type { SidebarMode } from "../lib/sidebar-prefs";

export const SIDE_PANEL_ID = "chats-side";

function matchesWide(): boolean {
  try {
    return typeof window.matchMedia === "function" ? window.matchMedia(SIDEBAR_WIDE_QUERY).matches : true;
  } catch {
    return true;
  }
}

/** True from 900 px wide; below it the sidebar is the drawer and cannot collapse. */
export function useWideSidebar(): boolean {
  const [wide, setWide] = useState(matchesWide);
  useEffect(() => {
    if (typeof window.matchMedia !== "function") {
      return undefined;
    }
    const list = window.matchMedia(SIDEBAR_WIDE_QUERY);
    const onChange = (): void => { setWide(list.matches); };
    onChange();
    list.addEventListener?.("change", onChange);
    return () => { list.removeEventListener?.("change", onChange); };
  }, []);
  return wide;
}

const FOCUS_ID: Readonly<Record<SidebarMode, string>> = { open: "side-collapse", rail: "side-expand", hidden: "side-float" };

/**
 * The sidebar's open, rail or hidden state: saved globally, restored on load, toggled by Cmd or Ctrl+B (wide screens only).
 * A change the person makes moves focus to the control that undoes it, so the keyboard never lands on a hidden element.
 */
export function useSidebarMode(onNarrowToggle: () => void): { mode: SidebarMode; wide: boolean; change: (next: SidebarMode) => void } {
  const wide = useWideSidebar();
  const [mode, setMode] = useState<SidebarMode>(() => readSidebarMode());
  const refocus = useRef(false);
  const change = useCallback((next: SidebarMode): void => {
    refocus.current = true;
    setMode(next);
    writeSidebarMode(next);
  }, []);
  useEffect(() => {
    if (refocus.current) {
      refocus.current = false;
      document.getElementById(FOCUS_ID[mode])?.focus();
    }
  }, [mode]);
  const modeRef = useRef(mode);
  modeRef.current = mode;
  useEffect(() => {
    const onKey = (e: KeyboardEvent): void => {
      if (!isSidebarShortcut(e)) {
        return;
      }
      e.preventDefault();
      if (wide) {
        change(toggledMode(modeRef.current));
      } else {
        onNarrowToggle();
      }
    };
    document.addEventListener("keydown", onKey);
    return () => { document.removeEventListener("keydown", onKey); };
  }, [wide, change, onNarrowToggle]);
  return { mode, wide, change };
}

const Icon = ({ d }: { d: string }) => (
  <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true"><path d={d} /></svg>
);

/** Header of the open sidebar: the chevron folds it to the rail, the second button hides it. */
export function SideHead({ onChange }: { onChange: (next: SidebarMode) => void }) {
  return (
    <div className="side-head">
      <span className="side-head-title">Chats</span>
      <button type="button" id="side-hide" className="icon-btn" aria-label="Hide chats sidebar" title="Hide chats sidebar" aria-expanded="true" aria-controls={SIDE_PANEL_ID} onClick={() => { onChange("hidden"); }}>
        <Icon d="M4 5h16v14H4zM9 5v14" />
      </button>
      <button type="button" id="side-collapse" className="icon-btn" aria-label="Collapse chats sidebar" title="Collapse chats sidebar (Ctrl+B)" aria-expanded="true" aria-controls={SIDE_PANEL_ID} onClick={() => { onChange("rail"); }}>
        <Icon d="m15 6-6 6 6 6" />
      </button>
    </div>
  );
}

/** The 48 px rail: expand, new chat, search. An amber dot says a chat waits for an answer. */
export function SideRail({ waiting, projectId, onChange, onNavigate }: { waiting: boolean; projectId: string | null; onChange: (next: SidebarMode) => void; onNavigate: () => void }) {
  return (
    <nav className="side-rail" aria-label="Chats (collapsed)">
      <button type="button" id="side-expand" className="icon-btn" aria-label={waiting ? "Expand chats sidebar, a chat is waiting for your answer" : "Expand chats sidebar"} title="Expand chats sidebar (Ctrl+B)" aria-expanded="false" aria-controls={SIDE_PANEL_ID} onClick={() => { onChange("open"); }}>
        <Icon d="m9 6 6 6-6 6" />
        {waiting ? <span className="rail-dot" data-testid="rail-dot" aria-hidden="true" /> : null}
      </button>
      <a className="icon-btn" href={newChatHash({ projectId })} aria-label="New chat" title="New chat" onClick={onNavigate}>
        <Icon d="M12 5v14M5 12h14" />
      </a>
      <button
        type="button"
        className="icon-btn"
        aria-label="Search chats"
        title="Search chats (Ctrl+K)"
        onClick={() => {
          onChange("open");
          setTimeout(() => { document.getElementById("chat-search")?.focus(); }, 0);
        }}
      >
        <Icon d="m21 21-4.3-4.3M10.5 18a7.5 7.5 0 1 1 0-15 7.5 7.5 0 0 1 0 15z" />
      </button>
    </nav>
  );
}

/** Shown when the sidebar is hidden: brings it back. */
export function SideFloat({ onChange }: { onChange: (next: SidebarMode) => void }) {
  return (
    <button type="button" id="side-float" className="icon-btn side-float" aria-label="Show chats sidebar" title="Show chats sidebar (Ctrl+B)" aria-expanded="false" aria-controls={SIDE_PANEL_ID} onClick={() => { onChange("open"); }}>
      <Icon d="M4 6h16M4 12h16M4 18h16" />
    </button>
  );
}

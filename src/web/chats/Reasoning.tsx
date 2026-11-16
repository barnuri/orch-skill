import { useEffect, useLayoutEffect, useRef, useState } from "react";
import { formatDuration } from "../lib/duration";
import { observeThought, useThinkingId } from "./thread-live";

interface Props {
  text: string;
  /** Forces the live look (tests); otherwise the thread says which thought is streaming. */
  live?: boolean | undefined;
  id?: string | undefined;
  startedAt?: string | null | undefined;
  finishedAt?: string | null | undefined;
}

const spanMs = (a: string | null | undefined, b: string | null | undefined): number | null => {
  const s = a == null ? NaN : Date.parse(a);
  const e = b == null ? NaN : Date.parse(b);
  return Number.isNaN(s) || Number.isNaN(e) ? null : e - s;
};

/** A model's thinking. Live: quiet gray text streams under "Thinking" in a capped, fading box. Done: one muted line "Thought for 12s" that expands. */
export function Reasoning({ text, live, id, startedAt, finishedAt }: Props) {
  const thinking = useThinkingId();
  const isLive = live ?? (id !== undefined && id === thinking);
  const [open, setOpen] = useState(false);
  const box = useRef<HTMLDivElement>(null);
  const watched = id === undefined ? null : observeThought(id, text.length, Date.now());
  const stored = spanMs(startedAt, finishedAt);
  const ms = stored !== null && stored >= 1000 ? stored : watched !== null && watched >= 1000 ? watched : null;
  const showText = isLive || open;
  const hasText = text.trim() !== "";

  useLayoutEffect(() => {
    const el = box.current;
    if (el !== null && isLive && !open) {
      el.scrollTop = el.scrollHeight;
    }
  }, [text, isLive, open]);
  useEffect(() => { if (!isLive) { setOpen(false); } }, [isLive]);

  const label = isLive ? "Thinking" : ms === null ? "Thought" : `Thought for ${formatDuration(ms)}`;
  return (
    <div className={`reasoning${isLive ? " is-live" : ""}`} data-testid="reasoning" data-live={isLive}>
      <button type="button" className="reasoning-toggle" aria-expanded={open} disabled={!hasText && isLive} onClick={() => { setOpen(!open); }}>
        <span className="reasoning-label">{label}</span>
        {isLive ? <span className="working-dots" aria-hidden="true"><i /><i /><i /></span> : null}
        {hasText || !isLive ? <svg className="reasoning-chev" viewBox="0 0 16 16" width="12" height="12" aria-hidden="true"><path d="m4 6 4 4 4-4" fill="none" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" strokeLinejoin="round" /></svg> : null}
      </button>
      {showText && hasText ? (
        <div ref={box} className={`reasoning-body${isLive && !open ? " is-capped" : ""}`} dir="auto" data-testid="reasoning-body" tabIndex={isLive && !open ? 0 : undefined} aria-label={isLive && !open ? "Thoughts so far" : undefined}>{text}</div>
      ) : null}
    </div>
  );
}

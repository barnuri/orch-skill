import { Suspense, lazy, useState } from "react";

const Markdown = lazy(() => import("./Markdown"));

/** A model's thinking: collapsed by default, so the answer stays the focus. */
export function Reasoning({ text, live }: { text: string; live: boolean }) {
  const [open, setOpen] = useState(false);
  return (
    <div className="reasoning" data-testid="reasoning">
      <button type="button" className="reasoning-toggle" aria-expanded={open} onClick={() => { setOpen(!open); }}>
        <span className="tool-caret" aria-hidden="true">{open ? "▾" : "▸"}</span>
        <span>{live ? "Thinking…" : "Thought"}</span>
      </button>
      {open ? (
        <div className="reasoning-body">
          <Suspense fallback={<p className="user-text">{text}</p>}>
            <Markdown text={text} live={live} />
          </Suspense>
        </div>
      ) : null}
    </div>
  );
}

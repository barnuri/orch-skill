import { lazy, type ReactNode, Suspense, useEffect, useRef } from "react";
import type { ArtifactsState } from "./use-artifacts";

const ArtifactPanel = lazy(() => import("./ArtifactPanel"));

/** The thread (children) with the artifact panel beside it. The panel's code loads when it is first opened. */
export function ArtifactLayout({ state, children }: { state: ArtifactsState; children: ReactNode }) {
  const everOpened = useRef(false);
  if (state.open) {
    everOpened.current = true;
  }
  useEffect(() => {
    document.body.classList.toggle("art-open", state.open);
    return () => { document.body.classList.remove("art-open"); };
  }, [state.open]);
  return (
    <div className={state.open ? "art-split is-open" : "art-split"}>
      <div className="art-main">{children}</div>
      {state.open ? (
        <Suspense fallback={<aside className="art-panel" aria-busy="true"><p className="art-note">Loading…</p></aside>}>
          <ArtifactPanel state={state} />
        </Suspense>
      ) : null}
    </div>
  );
}

/** Above the composer: the panel toggle, the @ menu and one chip per reference attached to the next message. */
export function ArtifactBar({ state }: { state: ArtifactsState }) {
  const { items, refs, open } = state;
  const menu = useRef<HTMLDetailsElement | null>(null);
  if (items.length === 0 && refs.length === 0) {
    return null;
  }
  return (
    <div className="art-bar" data-testid="art-bar">
      <button type="button" className="art-btn" aria-pressed={open} data-testid="art-toggle" onClick={() => { state.setOpen(!open); }}>
        Artifacts <span className="art-count">{items.length}</span>
      </button>
      <details className="art-at" ref={menu}>
        <summary className="art-btn" aria-label="Mention an artifact" data-testid="art-at">@</summary>
        <ul className="art-at-list">
          {items.map((a) => (
            <li key={a.name}>
              <button type="button" className="art-btn art-menu-item" onClick={() => { state.addRef({ name: a.name, version: a.version, hash: a.hash }); menu.current?.removeAttribute("open"); }}>@{a.name}</button>
            </li>
          ))}
        </ul>
      </details>
      {refs.map((r, i) => (
        <span key={`${r.name}-${i}`} className="art-chip" data-testid="art-chip">
          <span className="art-chip-text" title={r.quote ?? r.name}>
            @{r.name} v{r.version}{r.lines === undefined ? "" : r.lines[0] === r.lines[1] ? ` L${r.lines[0]}` : ` L${r.lines[0]}-${r.lines[1]}`}{r.quote === undefined ? "" : ` “${r.quote.length > 40 ? `${r.quote.slice(0, 40)}…` : r.quote}”`}
          </span>
          <button type="button" className="art-chip-x" aria-label={`Remove the reference to ${r.name}`} onClick={() => { state.removeRef(i); }}>×</button>
        </span>
      ))}
    </div>
  );
}

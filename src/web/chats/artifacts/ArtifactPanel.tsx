import { lazy, Suspense, useCallback, useEffect, useMemo, useRef, useState } from "react";
import { type ArtifactInfo, type ArtifactKind, type ArtifactRef, type ArtifactVersion, extOf, isTextKind, kindOf } from "../../../shared/artifacts";
import { CopyButton } from "../CopyButton";
import { artifactsApi } from "./api";
import { SelectionComment } from "./selection";
import type { ArtifactsState } from "./use-artifacts";

const CodeView = lazy(() => import("./CodeView"));
const MarkdownView = lazy(() => import("./MarkdownView"));
const Table = lazy(() => import("./Table"));
const MermaidView = lazy(() => import("./MermaidView"));
const DiffView = lazy(() => import("../DiffView"));

type Mode = "preview" | "code" | "diff" | "edit";

const KIND_LABEL: Record<ArtifactKind, string> = {
  html: "HTML", markdown: "Markdown", svg: "SVG", image: "Image", mermaid: "Mermaid", csv: "Table", json: "JSON", pdf: "PDF", tsx: "React", code: "Code", text: "Text", unknown: "File",
};
const HAS_PREVIEW = new Set<ArtifactKind>(["html", "markdown", "svg", "image", "mermaid", "csv", "json", "pdf"]);
const LANG: Record<string, string> = { tsx: "typescript", jsx: "javascript", mmd: "markdown", mermaid: "markdown", csv: "plaintext", tsv: "plaintext", htm: "html", txt: "plaintext", log: "plaintext" };
export const langOf = (name: string): string => LANG[extOf(name)] ?? extOf(name);

interface Content {
  text: string | null;
  blob: Blob | null;
  url: string | null;
  error: string | null;
  loading: boolean;
  /** Line numbers of the new text that differ from the text it replaced (live update only). */
  changed: ReadonlySet<number>;
}
const EMPTY: ReadonlySet<number> = new Set();

/** The bytes of one artifact version. The old content stays on screen while a new one loads, so a live update does not flash. */
function useContent(chatId: string, name: string, version: number | null, hash: string, kind: ArtifactKind): Content {
  const [state, setState] = useState<Content>({ text: null, blob: null, url: null, error: null, loading: true, changed: EMPTY });
  const last = useRef<{ key: string; text: string | null }>({ key: "", text: null });
  useEffect(() => {
    let live = true;
    if (name === "") {
      return;
    }
    const key = `${name}@${version ?? "cur"}`;
    void (async () => {
      try {
        const blob = await artifactsApi.content(chatId, name, version);
        if (!live) {
          return;
        }
        const text = isTextKind(kind) ? await blob.text() : null;
        const url = text === null || kind === "svg" ? URL.createObjectURL(blob) : null;
        let changed: ReadonlySet<number> = EMPTY;
        const before = last.current.key === key ? last.current.text : null;
        if (text !== null && before !== null && before !== text) {
          const { diffLines } = await import("diff");
          const set = new Set<number>();
          let line = 1;
          for (const part of diffLines(before, text)) {
            if (part.removed === true) {
              continue;
            }
            for (let i = 0; i < (part.count ?? 0); i++) {
              if (part.added === true) {
                set.add(line);
              }
              line++;
            }
          }
          changed = set;
        }
        if (!live) {
          return;
        }
        last.current = { key, text };
        setState((old) => {
          if (old.url !== null) {
            URL.revokeObjectURL(old.url);
          }
          return { text, blob, url, error: null, loading: false, changed };
        });
      } catch (err) {
        if (live) {
          setState((old) => ({ ...old, error: err instanceof Error ? err.message : "could not load", loading: false }));
        }
      }
    })();
    return () => {
      live = false;
    };
  }, [chatId, name, version, hash, kind]);
  useEffect(() => {
    if (state.changed.size === 0) {
      return;
    }
    const t = setTimeout(() => { setState((s) => ({ ...s, changed: EMPTY })); }, 2500);
    return () => { clearTimeout(t); };
  }, [state.changed]);
  return state;
}

function useVersions(chatId: string, name: string, hash: string): ArtifactVersion[] {
  const [list, setList] = useState<ArtifactVersion[]>([]);
  useEffect(() => {
    let live = true;
    if (name === "") {
      return;
    }
    void artifactsApi.versions(chatId, name).then((r) => { if (live) { setList(Array.isArray(r.items) ? r.items : []); } }, () => undefined);
    return () => { live = false; };
  }, [chatId, name, hash]);
  return list;
}

function HtmlFrame({ chatId, name, version, hash }: { chatId: string; name: string; version: number | null; hash: string }) {
  const [src, setSrc] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  useEffect(() => {
    let live = true;
    void artifactsApi.view(chatId, name, version).then(
      (r) => { if (live) { setSrc(`${r.url}?h=${hash}`); setError(null); } },
      (e: unknown) => { if (live) { setError(e instanceof Error ? e.message : "could not open"); } },
    );
    return () => { live = false; };
  }, [chatId, name, version, hash]);
  if (error !== null) {
    return <p className="art-note" role="alert">{error}</p>;
  }
  return src === null ? <p className="art-note">Loading…</p> : <iframe className="art-frame" data-testid="art-frame" title={name} src={src} sandbox="allow-scripts" referrerPolicy="no-referrer" />;
}

function Body({ chatId, info, version, mode, content, onComment, draft, setDraft, versions }: {
  chatId: string; info: ArtifactInfo; version: number | null; mode: Mode; content: Content;
  onComment: (ref: Omit<ArtifactRef, "name" | "version" | "hash">) => void; draft: string; setDraft: (s: string) => void; versions: ArtifactVersion[];
}) {
  const ref = useRef<HTMLDivElement | null>(null);
  const kind = info.kind;
  if (content.error !== null && content.text === null && content.url === null) {
    return <p className="art-note" role="alert" data-testid="art-error">{content.error}</p>;
  }
  if (kind === "unknown") {
    return <p className="art-note">This file type has no preview. Use Download.</p>;
  }
  if (mode === "edit") {
    return <textarea className="art-edit mono" data-testid="art-edit" aria-label={`Edit ${info.name}`} value={draft} spellCheck={false} onChange={(e) => { setDraft(e.target.value); }} />;
  }
  if (mode === "diff") {
    const cur = version ?? versions.at(-1)?.n ?? 1;
    return <DiffPane chatId={chatId} name={info.name} version={cur} text={content.text ?? ""} />;
  }
  if (content.text === null && content.url === null) {
    return <p className="art-note">Loading…</p>;
  }
  const text = content.text ?? "";
  let inner;
  if (kind === "tsx" || (mode === "code" && isTextKind(kind))) {
    inner = (
      <>
        {kind === "tsx" ? <p className="art-note" data-testid="art-tsx-note">No bundler is available in the browser here, so React code is shown as code.</p> : null}
        <CodeView text={text} lang={langOf(info.name)} changed={content.changed} />
      </>
    );
  } else if (kind === "html") {
    inner = <HtmlFrame chatId={chatId} name={info.name} version={version} hash={info.hash} />;
  } else if (kind === "markdown") {
    inner = <MarkdownView text={text} />;
  } else if (kind === "svg" || kind === "image") {
    inner = content.url === null ? <CodeView text={text} lang="xml" changed={content.changed} /> : <img className="art-img" data-testid="art-img" src={content.url} alt={info.name} />;
  } else if (kind === "pdf") {
    inner = content.url === null ? null : <iframe className="art-frame" data-testid="art-pdf" title={info.name} src={content.url} />;
  } else if (kind === "mermaid") {
    inner = <MermaidView text={text} />;
  } else if (kind === "csv" || kind === "json") {
    inner = <Table text={text} kind={kind} name={info.name} />;
  } else {
    inner = <CodeView text={text} lang={langOf(info.name)} changed={content.changed} />;
  }
  return (
    <div className="art-scroll" ref={ref} data-testid="art-body">
      <Suspense fallback={<p className="art-note">Loading…</p>}>{inner}</Suspense>
      {isTextKind(kind) && kind !== "html" || mode === "code" ? <SelectionComment containerRef={ref} onComment={(s) => { onComment({ ...(s.lines === null ? {} : { lines: s.lines }), quote: s.quote }); }} /> : null}
    </div>
  );
}

function DiffPane({ chatId, name, version, text }: { chatId: string; name: string; version: number; text: string }) {
  const [before, setBefore] = useState<string | null>(null);
  useEffect(() => {
    let live = true;
    if (version <= 1) {
      setBefore("");
      return;
    }
    void artifactsApi.content(chatId, name, version - 1).then((b) => b.text()).then((t) => { if (live) { setBefore(t); } }, () => { if (live) { setBefore(""); } });
    return () => { live = false; };
  }, [chatId, name, version]);
  return before === null ? <p className="art-note">Loading…</p> : <div className="art-scroll"><Suspense fallback={null}><DiffView path={`${name} v${Math.max(1, version - 1)} to v${version}`} before={before} after={text} /></Suspense></div>;
}

const WIDTH_KEY = "orch.artifacts.width";
const readWidth = (): number => {
  try {
    const n = Number(localStorage.getItem(WIDTH_KEY));
    return n >= 320 ? n : 560;
  } catch {
    return 560;
  }
};

export interface PanelProps {
  state: ArtifactsState;
}

/** The artifact panel: a split view beside the thread on desktop, a full-screen sheet on a phone. */
export default function ArtifactPanel({ state }: PanelProps) {
  const { chatId, items, active, select, setOpen, addRef, hashes } = state;
  const info = items.find((a) => a.name === active) ?? null;
  const [mode, setMode] = useState<Mode>("preview");
  const [version, setVersion] = useState<number | null>(null);
  const [full, setFull] = useState(false);
  const [width, setWidth] = useState(readWidth);
  const [draft, setDraft] = useState("");
  const [saveError, setSaveError] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);
  const [menu, setMenu] = useState(false);
  const name = info?.name ?? "";
  const kind = info?.kind ?? kindOf(name);
  const hash = hashes[name] ?? info?.hash ?? "";
  const versions = useVersions(chatId, name, hash);
  const latest = versions.at(-1)?.n ?? info?.version ?? 1;
  const shown = version ?? latest;
  const content = useContent(chatId, name, version, hash, kind);

  useEffect(() => {
    setVersion(null);
    setMode(HAS_PREVIEW.has(kind) ? "preview" : "code");
    setSaveError(null);
  }, [name, kind]);
  useEffect(() => {
    const onKey = (e: KeyboardEvent): void => {
      if (e.key === "Escape" && full) {
        setFull(false);
      }
    };
    document.addEventListener("keydown", onKey);
    return () => { document.removeEventListener("keydown", onKey); };
  }, [full]);

  const effectiveMode: Mode = mode === "preview" && !HAS_PREVIEW.has(kind) ? "code" : mode;
  const startEdit = (): void => {
    setDraft(content.text ?? "");
    setSaveError(null);
    setMode("edit");
  };
  const save = async (): Promise<void> => {
    setSaving(true);
    setSaveError(null);
    try {
      await artifactsApi.save(chatId, name, draft, hash);
      setMode(HAS_PREVIEW.has(kind) ? "preview" : "code");
      setVersion(null);
    } catch (e) {
      setSaveError(e instanceof Error ? e.message : "could not save");
    } finally {
      setSaving(false);
    }
  };
  const restore = async (): Promise<void> => {
    try {
      await artifactsApi.restore(chatId, name, shown);
      setVersion(null);
    } catch (e) {
      setSaveError(e instanceof Error ? e.message : "could not restore");
    }
  };
  const download = (): void => {
    if (content.blob === null) {
      return;
    }
    const url = URL.createObjectURL(content.blob);
    const a = document.createElement("a");
    a.href = url;
    a.download = name;
    a.click();
    setTimeout(() => { URL.revokeObjectURL(url); }, 1000);
  };
  const openTab = async (): Promise<void> => {
    if (kind === "html" || kind === "svg") {
      const r = await artifactsApi.view(chatId, name, version);
      window.open(r.url, "_blank", "noopener,noreferrer");
    } else if (content.blob !== null) {
      const typed = isTextKind(kind) ? new Blob([content.blob], { type: "text/plain" }) : content.blob;
      window.open(URL.createObjectURL(typed), "_blank", "noopener,noreferrer");
    }
  };
  const ask = (extra: Partial<ArtifactRef> = {}): void => {
    if (info === null) {
      return;
    }
    addRef({ name: info.name, version: shown, hash: content.blob === null ? hash : hash, ...extra });
    document.querySelector<HTMLTextAreaElement>(".composer-text")?.focus();
  };
  const startDrag = useCallback((e: React.PointerEvent<HTMLDivElement>) => {
    e.preventDefault();
    const startX = e.clientX;
    const startW = width;
    const move = (ev: PointerEvent): void => {
      setWidth(Math.min(Math.max(320, startW + (startX - ev.clientX)), Math.floor(window.innerWidth * 0.75)));
    };
    const up = (): void => {
      document.removeEventListener("pointermove", move);
      document.removeEventListener("pointerup", up);
    };
    document.addEventListener("pointermove", move);
    document.addEventListener("pointerup", up);
  }, [width]);
  useEffect(() => {
    try {
      localStorage.setItem(WIDTH_KEY, String(width));
    } catch {
      // not persisted
    }
  }, [width]);
  const widthStyle = useMemo(() => ({ "--art-w": `${width}px` }) as React.CSSProperties, [width]);

  const tab = (m: Mode, label: string, disabled = false): React.ReactNode => (
    <button type="button" role="tab" aria-selected={effectiveMode === m} className="art-seg" data-testid={`art-mode-${m}`} disabled={disabled} onClick={() => { if (m === "edit") { startEdit(); } else { setMode(m); } }}>
      {label}
    </button>
  );

  return (
    <aside className={full ? "art-panel is-full" : "art-panel"} style={widthStyle} aria-label="Artifacts" data-testid="art-panel">
      <div className="art-grip" role="separator" aria-orientation="vertical" aria-label="Resize the artifact panel" aria-valuenow={width} tabIndex={0} onPointerDown={startDrag}
        onKeyDown={(e) => { if (e.key === "ArrowLeft") { setWidth((w) => Math.min(w + 24, Math.floor(window.innerWidth * 0.75))); } else if (e.key === "ArrowRight") { setWidth((w) => Math.max(320, w - 24)); } }} />
      <div className="art-head">
        <div className="art-title-row">
          <select className="art-switch" aria-label="Artifact" data-testid="art-switch" value={active ?? ""} onChange={(e) => { select(e.target.value); }}>
            {items.map((a) => <option key={a.name} value={a.name}>{a.name}</option>)}
          </select>
          <h2 className="art-title" title={name}>{name || "Artifacts"}</h2>
          {info !== null ? <span className="art-badge" data-testid="art-badge">{KIND_LABEL[kind]}</span> : null}
          <span className="art-spacer" />
          <button type="button" className="art-btn" aria-label={full ? "Exit fullscreen" : "Fullscreen"} data-testid="art-full" onClick={() => { setFull((f) => !f); }}>{full ? "Exit full" : "Fullscreen"}</button>
          <button type="button" className="art-btn" aria-label="Close the artifact panel" data-testid="art-close" onClick={() => { setOpen(false); }}>Close</button>
        </div>
        {items.length > 1 ? (
          <div className="art-tabs" role="tablist" aria-label="Artifacts" data-testid="art-tabs">
            {items.map((a) => (
              <button key={a.name} type="button" role="tab" aria-selected={a.name === active} className="art-tab" onClick={() => { select(a.name); }}>{a.name}</button>
            ))}
          </div>
        ) : null}
        {info !== null ? (
          <div className="art-tools">
            <div className="art-segs" role="tablist" aria-label="View">
              {HAS_PREVIEW.has(kind) ? tab("preview", "Preview") : null}
              {isTextKind(kind) ? tab("code", "Code") : null}
              {isTextKind(kind) && shown > 1 ? tab("diff", "Diff") : null}
              {isTextKind(kind) && version === null ? tab("edit", "Edit") : null}
            </div>
            <select className="art-version" aria-label="Version" data-testid="art-version" value={shown} onChange={(e) => { const n = Number(e.target.value); setVersion(n === latest ? null : n); setMode((m) => (m === "edit" ? "preview" : m)); }}>
              {versions.length === 0 ? <option value={shown}>v{shown}</option> : versions.map((v) => <option key={v.n} value={v.n}>{`v${v.n}${v.n === latest ? " (latest)" : ""} · ${v.author}`}</option>)}
            </select>
            {version !== null ? <button type="button" className="art-btn" data-testid="art-restore" onClick={() => void restore()}>Restore this version</button> : null}
            <span className="art-spacer" />
            <button type="button" className="art-btn art-ask" data-testid="art-ask" onClick={() => { ask(); }}>Ask about this</button>
            <div className="art-more">
              <button type="button" className="art-btn" aria-haspopup="menu" aria-expanded={menu} data-testid="art-more" onClick={() => { setMenu((m) => !m); }}>More</button>
              {menu ? (
                <div className="art-menu" role="menu" onClick={() => { setMenu(false); }}>
                  {content.text !== null ? <CopyButton text={content.text} label="Copy" className="art-btn art-menu-item" /> : null}
                  <button type="button" role="menuitem" className="art-btn art-menu-item" data-testid="art-download" onClick={download}>Download</button>
                  <button type="button" role="menuitem" className="art-btn art-menu-item" data-testid="art-newtab" onClick={() => void openTab()}>Open in new tab</button>
                  <label className="art-menu-item art-check"><input type="checkbox" checked={state.autoOpen} onChange={(e) => { state.setAutoOpen(e.target.checked); }} /> Open automatically</label>
                </div>
              ) : null}
            </div>
          </div>
        ) : null}
      </div>
      {info === null ? (
        <p className="art-note" data-testid="art-empty">No artifacts yet. Files the agent saves in the chat's artifacts folder show up here.</p>
      ) : (
        <div className="art-bodywrap">
          {saveError !== null ? <p className="art-note is-error" role="alert" data-testid="art-save-error">{saveError}</p> : null}
          <Body chatId={chatId} info={{ ...info, hash }} version={version} mode={effectiveMode} content={content} versions={versions} draft={draft} setDraft={setDraft}
            onComment={(r) => { ask(r); }} />
          {effectiveMode === "edit" ? (
            <div className="art-editbar">
              <button type="button" className="art-btn art-primary" data-testid="art-save" disabled={saving || draft === content.text} onClick={() => void save()}>{saving ? "Saving…" : "Save as new version"}</button>
              <button type="button" className="art-btn" onClick={() => { setMode(HAS_PREVIEW.has(kind) ? "preview" : "code"); }}>Cancel</button>
            </div>
          ) : null}
        </div>
      )}
    </aside>
  );
}

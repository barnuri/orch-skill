import { useEffect, useId, useMemo, useRef, useState } from "react";
import { useFolders } from "./queries";

export function folderName(path: string): string {
  const parts = path.split("/").filter(Boolean);
  return parts[parts.length - 1] ?? path;
}

/** The chip text: the folder's name, or `project / subfolder` when the path is a project folder plus a subfolder. */
function chipName(path: string, subfolder: string | null): string {
  if (subfolder === null || subfolder === "" || !path.endsWith(`/${subfolder}`)) {
    return folderName(path);
  }
  return `${folderName(path.slice(0, -(subfolder.length + 1)))} / ${subfolder}`;
}

/** A small tag with the last part of a folder path; the full path is its tooltip. Renders nothing without a path. */
export function FolderChip({ path, inherited = false, subfolder = null, onClick }: { path: string | null | undefined; inherited?: boolean; subfolder?: string | null; onClick?: () => void }) {
  if (path === null || path === undefined || path === "") {
    return onClick === undefined ? null : <button type="button" className="folder-chip is-empty" onClick={onClick} data-testid="folder-chip">Choose folder</button>;
  }
  const body = <><span aria-hidden="true">📁</span> <span className="folder-chip-name">{chipName(path, subfolder)}</span>{inherited ? <span className="folder-chip-note"> (project)</span> : null}</>;
  return onClick === undefined
    ? <span className="folder-chip" title={path} data-testid="folder-chip">{body}</span>
    : <button type="button" className="folder-chip" title={path} onClick={onClick} data-testid="folder-chip">{body}</button>;
}

/**
 * Pick the folder the agent works in: a searchable list of the folders under the allowed roots (recent first),
 * or any path typed in. The server validates; `onPick` returns its error text, or null when it was accepted.
 */
export function FolderPicker({ title, current, onPick, onClose }: {
  title: string;
  current: string | null;
  onPick: (path: string | null) => Promise<string | null>;
  onClose: () => void;
}) {
  const [root, setRoot] = useState("");
  const [filter, setFilter] = useState("");
  const [typed, setTyped] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const folders = useFolders(root);
  const input = useRef<HTMLInputElement>(null);
  const headId = useId();
  useEffect(() => {
    input.current?.focus();
    const key = (e: KeyboardEvent): void => {
      if (e.key === "Escape") {
        onClose();
      }
    };
    document.addEventListener("keydown", key);
    return () => {
      document.removeEventListener("keydown", key);
    };
  }, [onClose]);
  const shown = useMemo(() => {
    const needle = filter.trim().toLowerCase();
    return (folders.data?.items ?? []).filter((f) => needle === "" || f.name.toLowerCase().includes(needle));
  }, [folders.data, filter]);
  const choose = async (path: string | null): Promise<void> => {
    setBusy(true);
    setError(null);
    const problem = await onPick(path);
    setBusy(false);
    if (problem === null) {
      onClose();
    } else {
      setError(problem);
    }
  };
  const data = folders.data;
  const atRoot = data === undefined || data.roots.includes(data.root);
  const parent = data === undefined ? "" : data.root.slice(0, data.root.lastIndexOf("/")) || "/";
  return (
    <div className="folder-overlay" onClick={onClose}>
      <div className="folder-dialog" role="dialog" aria-modal="true" aria-labelledby={headId} onClick={(e) => { e.stopPropagation(); }}>
        <div className="folder-head">
          <h2 id={headId} className="folder-title">{title}</h2>
          <button type="button" className="btn" onClick={onClose}>Close</button>
        </div>
        {current !== null ? <p className="folder-current mono" title={current}>Now: {current}</p> : null}
        <input
          ref={input} className="input" type="search" value={filter} placeholder="Search folders" aria-label="Search folders"
          onChange={(e) => { setFilter(e.target.value); }}
        />
        <div className="folder-where mono" title={data?.root}>
          {atRoot ? null : <button type="button" className="btn folder-up" onClick={() => { setRoot(parent); }}>↑ Up</button>}
          <span>{data?.root ?? ""}</span>
        </div>
        <ul className="folder-list" aria-label="Folders">
          {folders.isLoading ? <li className="muted">Loading…</li> : null}
          {folders.isError ? <li className="muted">Could not load folders. Type a path below.</li> : null}
          {data !== undefined && shown.length === 0 ? <li className="muted">{data.items.length === 0 ? "No folders here." : "No folder matches."}</li> : null}
          {shown.map((f) => (
            <li key={f.path} className="folder-item">
              <button type="button" className="folder-pick" disabled={busy} aria-current={f.path === current ? "true" : undefined} onClick={() => void choose(f.path)}>
                <span className="folder-item-name">{f.name}</span>
                {f.last_used_at !== null ? <span className="folder-item-note">recent</span> : null}
              </button>
              <button type="button" className="icon-btn folder-open" aria-label={`Browse inside ${f.name}`} title="Browse inside" onClick={() => { setRoot(f.path); setFilter(""); }}>›</button>
            </li>
          ))}
        </ul>
        {data?.truncated === true ? <p className="muted">Only the first 200 folders are shown. Search or type a path.</p> : null}
        <form className="folder-free" onSubmit={(e) => { e.preventDefault(); void choose(typed.trim() === "" ? null : typed.trim()); }}>
          <input className="input mono" value={typed} placeholder="/absolute/path/to/folder" aria-label="Folder path" onChange={(e) => { setTyped(e.target.value); setError(null); }} />
          <button type="submit" className="btn primary" disabled={busy || typed.trim() === ""}>Use path</button>
        </form>
        {error !== null ? <p className="folder-error" role="alert" data-testid="folder-error">{error}</p> : null}
        {current !== null ? <button type="button" className="btn" disabled={busy} onClick={() => void choose(null)}>Clear folder</button> : null}
      </div>
    </div>
  );
}

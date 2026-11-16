import { useQuery, useQueryClient } from "@tanstack/react-query";
import { useEffect, useId, useRef, useState } from "react";
import { describeFailure } from "../api/result";
import { useToast } from "../components/Toast";
import { workspaceApi, saveBlob } from "../api/workspace";
import type { Area, Scope, WorkspaceFile, WorkspaceInfo } from "../api/workspace";
import { formatBytes } from "../lib/chat-logic";
import type { Chat } from "../lib/chat-types";

type Tab = "memory" | Area;
const TABS: ReadonlyArray<{ id: Tab; label: string }> = [
  { id: "memory", label: "Memory" },
  { id: "knowledge", label: "Knowledge" },
  { id: "artifacts", label: "Artifacts" },
];
const PREVIEW_LIMIT = 100_000;

function useInfo(chatId: string, scope: Scope) {
  return useQuery<WorkspaceInfo>({
    queryKey: ["workspace", chatId, scope],
    queryFn: async () => {
      const res = await workspaceApi.info(chatId, scope);
      if (res.kind !== "ok") {
        throw new Error("workspace");
      }
      return res.body;
    },
    retry: false,
  });
}

function MemoryTab({ chatId, scope }: { chatId: string; scope: Scope }) {
  const toast = useToast();
  const client = useQueryClient();
  const [text, setText] = useState("");
  const [saved, setSaved] = useState("");
  const [loaded, setLoaded] = useState(false);
  const [busy, setBusy] = useState(false);
  useEffect(() => {
    let live = true;
    setLoaded(false);
    void workspaceApi.memory(chatId, scope).then((res) => {
      if (live && res.kind === "ok") {
        setText(res.body.content);
        setSaved(res.body.content);
        setLoaded(true);
      }
    });
    return () => {
      live = false;
    };
  }, [chatId, scope]);
  const save = async (): Promise<void> => {
    setBusy(true);
    const res = await workspaceApi.saveMemory(chatId, scope, text);
    setBusy(false);
    if (res.kind === "ok") {
      setSaved(text);
      toast("ok", "Memory saved");
      void client.invalidateQueries({ queryKey: ["workspace", chatId] });
    } else {
      toast("error", describeFailure(res, "could not save the memory"));
    }
  };
  return (
    <div className="ws-memory">
      <label className="ws-label" htmlFor={`ws-mem-${scope}`}>MEMORY.md: durable facts and decisions, kept short. The agent reads it and updates it.</label>
      <textarea id={`ws-mem-${scope}`} className="input ws-text" value={text} disabled={!loaded} spellCheck={false} onChange={(e) => { setText(e.target.value); }} data-testid="ws-memory-text" />
      <div className="ws-actions">
        <button type="button" className="btn primary" disabled={!loaded || busy || text === saved} onClick={() => void save()}>Save memory</button>
        <span className="ws-dim">{text === saved ? "Saved" : "Unsaved changes"} · {formatBytes(new Blob([text]).size)}</span>
      </div>
    </div>
  );
}

function Preview({ chatId, scope, area, file }: { chatId: string; scope: Scope; area: Area; file: WorkspaceFile }) {
  const [state, setState] = useState<{ kind: "loading" } | { kind: "text"; text: string } | { kind: "image"; url: string } | { kind: "error"; text: string }>({ kind: "loading" });
  useEffect(() => {
    let live = true;
    let url: string | null = null;
    void workspaceApi.fetchBlob(chatId, scope, area, file.name).then(async (res) => {
      if (!live) {
        return;
      }
      if ("error" in res) {
        setState({ kind: "error", text: res.error });
      } else if (file.preview === "image") {
        url = URL.createObjectURL(res.blob);
        setState({ kind: "image", url });
      } else {
        const text = await res.blob.text();
        setState({ kind: "text", text: text.length > PREVIEW_LIMIT ? `${text.slice(0, PREVIEW_LIMIT)}\n… (cut)` : text });
      }
    });
    return () => {
      live = false;
      if (url !== null) {
        URL.revokeObjectURL(url);
      }
    };
  }, [chatId, scope, area, file.name, file.preview]);
  if (state.kind === "loading") {
    return <p className="ws-dim">Loading…</p>;
  }
  if (state.kind === "error") {
    return <p className="ws-dim" role="alert">{state.text}</p>;
  }
  return state.kind === "image" ? <img className="ws-image" src={state.url} alt={file.name} /> : <pre className="ws-pre">{state.text}</pre>;
}

function FilesTab({ chatId, scope, area, files, canUpload }: { chatId: string; scope: Scope; area: Area; files: WorkspaceFile[]; canUpload: boolean }) {
  const toast = useToast();
  const client = useQueryClient();
  const input = useRef<HTMLInputElement>(null);
  const [open, setOpen] = useState<string | null>(null);
  const refresh = (): void => {
    void client.invalidateQueries({ queryKey: ["workspace", chatId] });
  };
  const upload = async (list: FileList | null): Promise<void> => {
    for (const file of Array.from(list ?? [])) {
      const problem = await workspaceApi.upload(chatId, scope, area, file);
      if (problem !== null) {
        toast("error", `${file.name}: ${problem}`);
      }
    }
    refresh();
  };
  const download = async (file: WorkspaceFile): Promise<void> => {
    const res = await workspaceApi.fetchBlob(chatId, scope, area, file.name);
    if ("error" in res) {
      toast("error", res.error);
    } else {
      saveBlob(res.blob, file.name);
    }
  };
  const trash = async (file: WorkspaceFile): Promise<void> => {
    const res = await workspaceApi.remove(chatId, scope, area, file.name);
    if (res.kind !== "ok") {
      toast("error", describeFailure(res, "could not move the file to the trash"));
    }
    setOpen(null);
    refresh();
  };
  return (
    <div className="ws-files">
      {canUpload ? (
        <div className="ws-actions">
          <input ref={input} type="file" multiple hidden data-testid="ws-upload" onChange={(e) => { void upload(e.target.files); e.target.value = ""; }} />
          <button type="button" className="btn" onClick={() => input.current?.click()}>Upload files</button>
          <span className="ws-dim">Up to 20 MB each</span>
        </div>
      ) : null}
      {files.length === 0 ? <p className="ws-dim">{area === "knowledge" ? "No reference files yet. Upload notes the agent should read." : "Nothing generated yet. Files the agent creates appear here."}</p> : null}
      <ul className="ws-list">
        {files.map((file) => (
          <li key={file.name} className="ws-file">
            <div className="ws-file-row">
              <span className="ws-file-name" title={file.name}>{file.name}</span>
              <span className="ws-dim mono">{formatBytes(file.size)} · {new Date(file.modified).toLocaleString()}</span>
              <span className="ws-file-actions">
                {file.preview === "none" ? null : (
                  <button type="button" className="btn" aria-expanded={open === file.name} onClick={() => { setOpen(open === file.name ? null : file.name); }}>{open === file.name ? "Hide" : "Preview"}</button>
                )}
                <button type="button" className="btn" onClick={() => void download(file)}>Download</button>
                <button type="button" className="btn" aria-label={`Move ${file.name} to the trash`} onClick={() => void trash(file)}>Delete</button>
              </span>
            </div>
            {open === file.name ? <Preview chatId={chatId} scope={scope} area={area} file={file} /> : null}
          </li>
        ))}
      </ul>
    </div>
  );
}

/** The chat's workspace as a side sheet (full screen on phones): memory, knowledge and artifacts, for this chat or its whole folder. */
export function WorkspacePanel({ chat, onClose }: { chat: Chat; onClose: () => void }) {
  const toast = useToast();
  const [scope, setScope] = useState<Scope>("chat");
  const [tab, setTab] = useState<Tab>("memory");
  const info = useInfo(chat.id, scope);
  const hasFolder = chat.effective_cwd != null;
  const title = useId();
  const close = useRef<HTMLButtonElement>(null);
  useEffect(() => {
    close.current?.focus();
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
  const data = info.data;
  const copyPath = (): void => {
    if (data !== undefined) {
      void navigator.clipboard.writeText(data.path).then(() => { toast("ok", "Folder path copied"); });
    }
  };
  const exportZip = async (): Promise<void> => {
    const res = await workspaceApi.fetchBlob(chat.id, scope, null, null);
    if ("error" in res) {
      toast("error", res.error);
    } else {
      saveBlob(res.blob, `${scope === "chat" ? chat.id : "folder"}-workspace.zip`);
    }
  };
  return (
    <div className="ws-overlay" onClick={onClose}>
      <aside className="ws-sheet" role="dialog" aria-modal="true" aria-labelledby={title} onClick={(e) => { e.stopPropagation(); }} data-testid="workspace-panel">
        <div className="ws-head">
          <h2 id={title} className="ws-title">Workspace</h2>
          <button ref={close} type="button" className="btn" onClick={onClose}>Close</button>
        </div>
        <div className="ws-scope" role="group" aria-label="Workspace scope">
          <button type="button" className="ws-seg" aria-pressed={scope === "chat"} onClick={() => { setScope("chat"); }}>This chat</button>
          <button type="button" className="ws-seg" aria-pressed={scope === "folder"} disabled={!hasFolder} title={hasFolder ? undefined : "This chat has no folder"} onClick={() => { setScope("folder"); }}>This folder</button>
        </div>
        {data === undefined ? null : (
          <div className="ws-where">
            <code className="ws-path mono" title={data.path}>{data.path}</code>
            <button type="button" className="btn" onClick={copyPath}>Copy folder path</button>
            <button type="button" className="btn" onClick={() => void exportZip()}>Download workspace</button>
            <p className="ws-dim">{scope === "chat" ? "Only this chat uses it." : "Shared by every chat in this folder. The agent writes here only for facts all of them should know."}{data.exists ? "" : " Created on first use."}</p>
            {data.moved_from === null ? null : <p className="ws-note" data-testid="ws-moved">This chat moved folders. Its earlier workspace stays at <code className="mono">{data.moved_from}</code> and was not copied.</p>}
          </div>
        )}
        <div className="ws-tabs" role="tablist" aria-label="Workspace area">
          {TABS.map((t) => (
            <button key={t.id} type="button" role="tab" id={`ws-tab-${t.id}`} aria-selected={tab === t.id} aria-controls="ws-body" className="ws-tab" onClick={() => { setTab(t.id); }}>{t.label}</button>
          ))}
        </div>
        <div id="ws-body" className="ws-body" role="tabpanel" aria-labelledby={`ws-tab-${tab}`}>
          {info.isError ? <p className="ws-dim" role="alert">The workspace could not be read.</p> : null}
          {tab === "memory" ? <MemoryTab key={scope} chatId={chat.id} scope={scope} /> : (
            <FilesTab key={`${scope}-${tab}`} chatId={chat.id} scope={scope} area={tab} files={data?.files[tab] ?? []} canUpload={tab === "knowledge"} />
          )}
        </div>
      </aside>
    </div>
  );
}

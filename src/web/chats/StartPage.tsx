import { useQueryClient } from "@tanstack/react-query";
import { useEffect, useMemo, useRef, useState } from "react";
import { chatsApi, uploadAttachment } from "../api/chats";
import { describeFailure } from "../api/result";
import { Select } from "../components/Select";
import { modelLabel, resolvePickers } from "../lib/chat-logic";
import type { Selection } from "../lib/chat-logic";
import { clearDraft, draftChatId, draftScope, moveDraft, setDraftText, textOnlyStorage } from "../lib/chat-draft";
import { DEFAULT_STARTERS, MAX_STARTERS, readStarters, writeStarters } from "../lib/chat-starters";
import type { Attachment, Chat } from "../lib/chat-types";
import { newChatHash } from "../router/route";
import { ChatSettings } from "./ChatSettings";
import type { SettingsBadge } from "./ChatSettings";
import { Composer } from "./Composer";
import type { Uploader } from "./Composer";
import { FolderChip, FolderPicker } from "./FolderPicker";
import { Pickers } from "./Pickers";
import { projectOptions as projectChoices } from "../lib/project-tree";
import { chatKeys, refreshChats, useChatOptions, useProjects } from "./queries";
import { takeStartSeed } from "./start-seed";
import { useDraftScopes } from "./use-draft-scopes";

const NO_PROJECT = "__none__";

export function greeting(hour: number): string {
  return hour < 5 ? "Working late" : hour < 12 ? "Good morning" : hour < 18 ? "Good afternoon" : "Good evening";
}

function chatHash(chat: Chat): string {
  return chat.project_id === null ? `#/chats/${encodeURIComponent(chat.id)}` : `#/chats/${encodeURIComponent(chat.project_id)}/${encodeURIComponent(chat.id)}`;
}

/** Editable starter chips: up to four lines; saving an empty list brings the defaults back. */
function StarterEditor({ initial, onDone }: { initial: readonly string[]; onDone: (list: string[]) => void }) {
  const [rows, setRows] = useState<string[]>(() => Array.from({ length: MAX_STARTERS }, (_, i) => initial[i] ?? ""));
  return (
    <form
      className="start-edit"
      aria-label="Edit suggestions"
      onSubmit={(e) => {
        e.preventDefault();
        writeStarters(rows);
        onDone(readStarters());
      }}
    >
      {rows.map((row, i) => (
        // eslint-disable-next-line react/no-array-index-key -- four fixed slots
        <input key={i} className="input" aria-label={`Suggestion ${i + 1}`} value={row} maxLength={200} onChange={(e) => { setRows((r) => r.map((x, j) => (j === i ? e.target.value : x))); }} />
      ))}
      <div className="start-edit-actions">
        <button type="submit" className="btn primary">Save</button>
        <button type="button" className="btn" onClick={() => { setRows(Array.from({ length: MAX_STARTERS }, (_, i) => DEFAULT_STARTERS[i] ?? "")); }}>Defaults</button>
        <button type="button" className="btn" onClick={() => { onDone(readStarters()); }}>Cancel</button>
      </div>
    </form>
  );
}

/**
 * The empty page for a new chat (and for no chat selected). Nothing exists on the server until the first message is
 * sent: then the chat, its folder and the harness session are created, the message goes out, and the page moves to the real
 * chat id. Unsent text is kept as a local draft per project.
 */
export function StartPage({ projectId, folder: urlFolder, onOpenDrawer }: { projectId: string | null; folder: string | null; onOpenDrawer: () => void }) {
  const client = useQueryClient();
  const options = useChatOptions();
  const projects = useProjects(false);
  const scope = draftScope(projectId);
  const [picked, setPicked] = useState<Selection | null>(() => takeStartSeed());
  const [effort, setEffort] = useState<string | null>(null);
  const [folder, setFolder] = useState<string | null>(urlFolder);
  const [pickingFolder, setPickingFolder] = useState(false);
  const [composerKey, setComposerKey] = useState(0);
  const [starters, setStarters] = useState<string[]>(() => readStarters());
  const [editing, setEditing] = useState(false);
  const storage = useMemo(() => textOnlyStorage(), []);
  const drafts = useDraftScopes();
  const hasDraft = drafts.includes(scope);
  const files = useRef(new Map<string, File>());
  const counter = useRef(0);
  const created = useRef<Chat | null>(null);
  const page = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (typeof window.matchMedia === "function" && window.matchMedia("(pointer: coarse)").matches) {
      return;
    }
    page.current?.querySelector<HTMLTextAreaElement>("textarea.composer-text")?.focus();
  }, [composerKey]);

  const project = (projects.data ?? []).find((p) => p.id === projectId) ?? null;
  const effectiveFolder = folder ?? project?.path ?? null;
  const resolved = options.data === undefined ? null : resolvePickers(options.data, picked);
  const sel = resolved?.selection ?? null;
  const levels = options.data === undefined || sel === null ? [] : options.data.harnesses.find((h) => h.id === sel.harness)?.efforts ?? [];
  const activeEffort = effort !== null && levels.includes(effort) ? effort : null;
  const problem = resolved?.problem ?? null;
  const summary = options.data === undefined || sel === null ? "Loading settings…" : `${sel.harness} · ${sel.profile} · ${modelLabel(options.data, sel)}${activeEffort === null ? "" : ` · ${activeEffort}`}`;
  const badge: SettingsBadge | null = problem !== null ? { tone: "error", text: problem } : null;

  const upload: Uploader = (_chatId, file, onProgress) => {
    counter.current += 1;
    const id = `local-${counter.current}`;
    files.current.set(id, file);
    onProgress(1);
    const attachment = { id, chat_id: "", message_id: null, filename: file.name, mime: "application/octet-stream", size: file.size, sha256: "", created_at: new Date().toISOString() } as Attachment;
    return { promise: Promise.resolve({ ok: true as const, attachment }), abort: () => undefined };
  };

  const send = async (text: string, ids: readonly string[]): Promise<string | null> => {
    if (options.data === undefined || sel === null) {
      return "The settings are still loading. Try again in a moment.";
    }
    if (problem !== null) {
      return problem;
    }
    let chat = created.current;
    if (chat === null) {
      const res = await chatsApi.createChat({ project_id: projectId, harness: sel.harness, profile: sel.profile, model_id: sel.model, cwd: folder, effort: activeEffort });
      if (res.kind !== "ok") {
        return describeFailure(res, "could not create the chat");
      }
      chat = res.body;
      created.current = chat;
    }
    const real: string[] = [];
    for (const id of ids) {
      const file = files.current.get(id);
      if (file === undefined) {
        return "A file you attached is no longer available. Remove it and attach it again.";
      }
      const up = await uploadAttachment(chat.id, file, () => undefined).promise;
      if (!up.ok) {
        return `${file.name}: ${up.error}`;
      }
      real.push(up.attachment.id);
    }
    const sent = await chatsApi.send(chat.id, text, real);
    if (sent.kind !== "ok") {
      return describeFailure(sent, "could not send");
    }
    clearDraft(scope);
    client.setQueryData(chatKeys.chat(chat.id), chat);
    void refreshChats(client);
    location.hash = chatHash(chat);
    return null;
  };

  const pickStarter = (text: string): void => {
    setDraftText(scope, text);
    setComposerKey((k) => k + 1);
  };

  const projectOptions = [{ value: NO_PROJECT, label: "No project" }, ...projectChoices(projects.data ?? [])];
  const hour = new Date().getHours();

  return (
    <div className="start-page" ref={page} data-testid="start-page">
      <div className="chat-head start-head">
        <button type="button" className="icon-btn drawer-btn" aria-label="Projects and chats" onClick={onOpenDrawer}>
          <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" aria-hidden="true"><path d="M4 6h16M4 12h16M4 18h16" /></svg>
        </button>
        <span className="start-head-title">New chat</span>
        {hasDraft ? <span className="draft-tag" data-testid="draft-hint">Draft</span> : null}
      </div>
      <div className="start-body">
        <h1 className="start-title">{greeting(hour)}</h1>
        <p className="start-sub">What should we work on?</p>
        <div className="start-composer">
          <Composer
            key={`${scope}:${composerKey}`}
            chatId={draftChatId(scope)}
            storage={storage as Storage}
            upload={upload}
            removeUpload={async () => undefined}
            blocked={null}
            running={false}
            toolbar={
              options.data === undefined || sel === null ? undefined : (
                <ChatSettings summary={summary} badge={badge}>
                  <Pickers options={options.data} selection={sel} locked={false} modelUsed={null} onChange={(next) => { setPicked(next); }} effort={{ value: activeEffort, onChange: setEffort }} />
                </ChatSettings>
              )
            }
            onSend={send}
            onStop={() => undefined}
            onOpenImage={() => undefined}
          />
        </div>
        <div className="start-where" data-testid="start-where">
          <span className="start-where-label">Starts in</span>
          <div className="start-project">
            <Select
              aria-label="Project"
              value={projectId ?? NO_PROJECT}
              options={projectOptions}
              onChange={(value) => {
                const next = value === NO_PROJECT ? null : value;
                moveDraft(scope, draftScope(next));
                location.hash = newChatHash({ projectId: next });
              }}
            />
          </div>
          <FolderChip path={effectiveFolder} inherited={folder === null && project?.path != null} onClick={() => { setPickingFolder(true); }} />
        </div>
        {pickingFolder ? (
          <FolderPicker
            title="Folder for this chat"
            current={folder}
            onPick={async (path) => {
              setFolder(path);
              return null;
            }}
            onClose={() => { setPickingFolder(false); }}
          />
        ) : null}
        {editing ? (
          <StarterEditor initial={starters} onDone={(list) => { setStarters(list); setEditing(false); }} />
        ) : (
          <div className="start-chips" role="group" aria-label="Suggestions">
            {starters.map((text) => (
              <button key={text} type="button" className="start-chip" onClick={() => { pickStarter(text); }}>{text}</button>
            ))}
            <button type="button" className="link-btn start-edit-btn" onClick={() => { setEditing(true); }}>Edit suggestions</button>
          </div>
        )}
      </div>
    </div>
  );
}

import { useEffect, useState } from "react";
import { chatsApi } from "../api/chats";
import { describeFailure } from "../api/result";
import { Select } from "../components/Select";
import { useToast } from "../components/Toast";
import { isLive, messageDurationMs, modelLabel } from "../lib/chat-logic";
import type { Selection } from "../lib/chat-logic";
import { formatDuration } from "../lib/duration";
import type { Attachment, Chat, ChatOptions, Message, Project } from "../lib/chat-types";
import { Lightbox } from "./Attachments";
import { Composer } from "./Composer";
import { Pickers, pickerSummary, sessionNote } from "./Pickers";
import { refreshChats, useChat, useChatOptions, useProjects } from "./queries";
import { useChatThread, useNow } from "./use-chat-thread";
import { VirtualMessages } from "./VirtualMessages";

const NO_PROJECT = "__none__";

/** Duration of the latest reply: counts up while it streams, then stays at its final value. */
function LastReplyStats({ reply }: { reply: Message | null }) {
  const now = useNow(reply !== null && isLive(reply));
  const ms = reply === null ? null : messageDurationMs(reply, now);
  return ms === null ? null : <span className="chat-stats mono" data-testid="chat-duration">{formatDuration(ms)}</span>;
}

function Header({ chat, options, modelUsed, lastReply, projects, onOpenDrawer }: {
  chat: Chat;
  options: ChatOptions | undefined;
  modelUsed: string | null;
  lastReply: Message | null;
  projects: Project[];
  onOpenDrawer: () => void;
}) {
  const toast = useToast();
  const [editing, setEditing] = useState(false);
  const [title, setTitle] = useState(chat.title);
  useEffect(() => {
    setTitle(chat.title);
  }, [chat.title]);
  const rename = async (): Promise<void> => {
    setEditing(false);
    if (title.trim() === "" || title === chat.title) {
      setTitle(chat.title);
      return;
    }
    const res = await chatsApi.rename(chat.id, title.trim());
    if (res.kind !== "ok") {
      toast("error", describeFailure(res, "could not rename"));
    }
    void refreshChats();
  };
  const move = async (value: string): Promise<void> => {
    const res = await chatsApi.moveChat(chat.id, value === NO_PROJECT ? null : value);
    if (res.kind !== "ok") {
      toast("error", describeFailure(res, "could not move the chat"));
    }
    void refreshChats();
  };
  const archive = async (): Promise<void> => {
    const res = await chatsApi.archiveChat(chat.id, chat.archived_at === null);
    if (res.kind !== "ok") {
      toast("error", describeFailure(res, "could not archive"));
    }
    void refreshChats();
  };
  const projectOptions = [{ value: NO_PROJECT, label: "No project" }, ...projects.map((p) => ({ value: p.id, label: p.name }))];
  return (
    <div className="chat-head">
      <button type="button" className="icon-btn drawer-btn" aria-label="Projects and chats" onClick={onOpenDrawer}>
        <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" aria-hidden="true"><path d="M4 6h16M4 12h16M4 18h16" /></svg>
      </button>
      <div className="chat-head-main">
        {editing ? (
          <input
            className="chat-title-input"
            aria-label="Chat title"
            value={title}
            autoFocus
            onChange={(e) => { setTitle(e.target.value); }}
            onBlur={() => void rename()}
            onKeyDown={(e) => {
              if (e.key === "Enter") {
                void rename();
              } else if (e.key === "Escape") {
                setTitle(chat.title);
                setEditing(false);
              }
            }}
          />
        ) : (
          <button type="button" className="chat-title" title="Rename" onClick={() => { setEditing(true); }}>
            {chat.title}
          </button>
        )}
        <span className="chat-summary mono" data-testid="picker-summary">
          {pickerSummary(chat, options, modelUsed)}
        </span>
        <span className="chat-session-note" data-testid="session-note">{sessionNote(chat, options)}</span>
      </div>
      <LastReplyStats reply={lastReply} />
      <div className="chat-head-actions">
        <div className="move-select">
          <Select aria-label="Move to project" value={chat.project_id ?? NO_PROJECT} options={projectOptions} onChange={(v) => void move(v)} />
        </div>
        <button type="button" className="btn" onClick={() => void archive()}>
          {chat.archived_at === null ? "Archive" : "Unarchive"}
        </button>
      </div>
    </div>
  );
}

function Config({ chat, options, running, modelUsed }: { chat: Chat; options: ChatOptions; running: boolean; modelUsed: string | null }) {
  const toast = useToast();
  const [sel, setSel] = useState<Selection>({ harness: chat.harness, profile: chat.profile, model: chat.model_id });
  useEffect(() => {
    setSel({ harness: chat.harness, profile: chat.profile, model: chat.model_id });
  }, [chat.harness, chat.profile, chat.model_id]);
  const change = async (next: Selection): Promise<void> => {
    setSel(next);
    const res = await chatsApi.configure(chat.id, { harness: next.harness, profile: next.profile, model_id: next.model });
    if (res.kind !== "ok") {
      toast("error", res.kind === "error" && res.status === 409 ? "A reply is running: change this between turns" : describeFailure(res, "could not change"));
      setSel({ harness: chat.harness, profile: chat.profile, model: chat.model_id });
    }
    void refreshChats();
  };
  return <Pickers options={options} selection={sel} locked={running} modelUsed={modelUsed} onChange={(n) => void change(n)} />;
}

export function ChatView({ chatId, onOpenDrawer }: { chatId: string; onOpenDrawer: () => void }) {
  const toast = useToast();
  const chatQuery = useChat(chatId);
  const options = useChatOptions();
  const projects = useProjects(false);
  const thread = useChatThread(chatId);
  const [lightbox, setLightbox] = useState<Attachment | null>(null);
  const chat = chatQuery.data;
  const rows = thread.messages;
  const running = thread.running || rows.some(isLive);
  const modelUsed = [...rows].reverse().find((m) => m.role === "assistant" && m.model_used !== null)?.model_used ?? null;
  const lastReply = [...rows].reverse().find((m) => m.role === "assistant") ?? null;

  if (chatQuery.isError) {
    return <div className="chat-empty"><p>This chat could not be loaded.</p></div>;
  }
  if (chat === undefined) {
    return <div className="chat-empty"><p className="muted">Loading…</p></div>;
  }
  const blocked = chat.archived_at !== null ? "Archived chat: unarchive it to continue" : null;

  const send = async (text: string, ids: readonly string[]): Promise<string | null> => {
    const failure = await thread.send(text, ids);
    if (failure === null) {
      void refreshChats();
    }
    return failure;
  };

  return (
    <div className="chat-view" data-chat={chat.id}>
      <Header
        chat={chat}
        options={options.data}
        modelUsed={modelUsed}
        lastReply={lastReply}
        projects={projects.data ?? []}
        onOpenDrawer={onOpenDrawer}
      />
      {chat.warning != null ? <p className="thread-note chat-warning" role="status" data-testid="chat-warning">{chat.warning}</p> : null}
      {thread.loadError !== null ? <p className="thread-note" role="alert">{thread.loadError}</p> : null}
      {thread.loading ? (
        <div className="thread-wrap"><p className="thread-note">Loading history…</p></div>
      ) : rows.length === 0 ? (
        <div className="thread-wrap chat-empty"><p>Send a message to start. Everything is saved.</p></div>
      ) : (
        <VirtualMessages
          messages={rows}
          hasOlder={thread.hasOlder}
          loadingOlder={thread.loadingOlder}
          onLoadOlder={thread.loadOlder}
          onOpenImage={setLightbox}
          fallbackModel={modelLabel(options.data, { harness: chat.harness, profile: chat.profile, model: chat.model_id })}
          onRetry={(text) => {
            void send(text, []).then((failure) => {
              if (failure !== null) {
                toast("error", failure);
              }
            });
          }}
        />
      )}
      {thread.conn === "reconnecting" ? <p className="conn-note" role="status">Reconnecting…</p> : null}
      <Composer key={chat.id} chatId={chat.id} blocked={blocked} running={running} toolbar={options.data === undefined ? undefined : <Config chat={chat} options={options.data} running={running} modelUsed={modelUsed} />} onSend={send} onStop={() => void thread.stop()} onOpenImage={setLightbox} />
      {lightbox !== null ? <Lightbox attachment={lightbox} onClose={() => { setLightbox(null); }} /> : null}
    </div>
  );
}

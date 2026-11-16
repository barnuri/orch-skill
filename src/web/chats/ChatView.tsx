import { useQueryClient } from "@tanstack/react-query";
import { useEffect, useState } from "react";
import { chatsApi } from "../api/chats";
import { describeFailure } from "../api/result";
import { Select } from "../components/Select";
import { useToast } from "../components/Toast";
import { isLive, messageDurationMs, modelLabel, resolvePickers } from "../lib/chat-logic";
import type { Selection } from "../lib/chat-logic";
import { formatDuration } from "../lib/duration";
import type { Attachment, Chat, ChatOptions, Message, Project } from "../lib/chat-types";
import { Lightbox } from "./Attachments";
import { latestTodos } from "../../shared/chat-parts";
import { ChatSettings } from "./ChatSettings";
import type { SettingsBadge } from "./ChatSettings";
import { ArtifactBar, ArtifactLayout } from "./artifacts/ArtifactLayout";
import { useArtifacts } from "./artifacts/use-artifacts";
import { Composer } from "./Composer";
import { ConversationView } from "./ConversationView";
import { QueueBubbles, QueueCounter, QueueTray } from "./MessageQueue";
import { EMPTY_QUEUE, waiting } from "./queue-logic";
import type { QueueSnapshot } from "./queue-logic";
import { QuestionCard } from "./QuestionCard";
import { pendingQuestion, useAnswerQuestion } from "./question-hooks";
import { WorkspacePanel } from "./WorkspacePanel";
import { TodoPanel } from "./Todos";
import { FolderChip, FolderPicker } from "./FolderPicker";
import { SubfolderField } from "./SubfolderField";
import { Pickers, pickerSummary, sessionNote } from "./Pickers";
import { refreshChats, useChat, useChatOptions, useProjects } from "./queries";
import { repairSelection } from "./repair-selection";
import { PencilIcon, TitleInput, useRenameChat } from "./rename";
import { useChatThread, useNow } from "./use-chat-thread";
import { useVoiceConversation } from "./use-voice";
import { VirtualMessages } from "./VirtualMessages";

const NO_PROJECT = "__none__";

/** Duration of the latest reply: counts up while it streams, then stays at its final value. */
function LastReplyStats({ reply }: { reply: Message | null }) {
  const now = useNow(reply !== null && isLive(reply));
  const ms = reply === null ? null : messageDurationMs(reply, now);
  return ms === null ? null : <span className="chat-stats mono" data-testid="chat-duration">{formatDuration(ms)}</span>;
}

/** The chat's title bar: rename (pencil or title click), move to project, archive. Exported for tests. */
export function Header({ chat, options, modelUsed, lastReply, projects, onOpenDrawer, queue = EMPTY_QUEUE }: {
  chat: Chat;
  options: ChatOptions | undefined;
  modelUsed: string | null;
  lastReply: Message | null;
  projects: Project[];
  onOpenDrawer: () => void;
  queue?: QueueSnapshot;
}) {
  const toast = useToast();
  const [editing, setEditing] = useState(false);
  const renameChat = useRenameChat();
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
  const client = useQueryClient();
  const [pickingFolder, setPickingFolder] = useState(false);
  const [workspace, setWorkspace] = useState(false);
  const pickFolder = async (path: string | null): Promise<string | null> => {
    const res = await chatsApi.setChatFolder(chat.id, path);
    void refreshChats(client);
    return res.kind === "ok" ? null : describeFailure(res, "could not set the folder");
  };
  const projectOptions = [{ value: NO_PROJECT, label: "No project" }, ...projects.map((p) => ({ value: p.id, label: p.name }))];
  return (
    <div className="chat-head">
      <button type="button" className="icon-btn drawer-btn" aria-label="Projects and chats" onClick={onOpenDrawer}>
        <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" aria-hidden="true"><path d="M4 6h16M4 12h16M4 18h16" /></svg>
      </button>
      <div className="chat-head-main">
        <div className="chat-title-row">
          {editing ? (
            <TitleInput
              initial={chat.title}
              className="chat-title-input"
              onSave={(value) => {
                setEditing(false);
                void renameChat(chat, value);
              }}
              onCancel={() => {
                setEditing(false);
              }}
            />
          ) : (
            <>
              <button type="button" className="chat-title" title="Rename" onClick={() => { setEditing(true); }}>
                {chat.title}
              </button>
              <button type="button" className="icon-btn chat-rename-btn" aria-label="Rename chat" title="Rename chat" onClick={() => { setEditing(true); }}>
                <PencilIcon />
              </button>
            </>
          )}
        </div>
        <span className="chat-summary mono" data-testid="picker-summary">
          {pickerSummary(chat, options, modelUsed)}
        </span>
        <span className="chat-session-note" data-testid="session-note">{sessionNote(chat, options)}</span>
        <span className="chat-folder-row">
          <FolderChip path={chat.effective_cwd} inherited={chat.cwd == null} subfolder={chat.cwd == null ? chat.subfolder : null} onClick={() => { setPickingFolder(true); }} />
          {chat.status === "running" ? <span className="chat-session-note">A change applies from the next message.</span> : null}
        </span>
        {pickingFolder ? (
          <FolderPicker title="Folder for this chat" current={chat.cwd ?? null} onPick={pickFolder} onClose={() => { setPickingFolder(false); }} />
        ) : null}
      </div>
      {workspace ? <WorkspacePanel chat={chat} onClose={() => { setWorkspace(false); }} /> : null}
      <LastReplyStats reply={lastReply} />
      <QueueCounter snapshot={queue} />
      <button type="button" className="btn chat-head-ws" aria-haspopup="dialog" onClick={() => { setWorkspace(true); }} data-testid="workspace-btn">
        Workspace
      </button>
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

function Config({ chat, options, running, modelUsed, lastFailed }: { chat: Chat; options: ChatOptions; running: boolean; modelUsed: string | null; lastFailed: boolean }) {
  const toast = useToast();
  const client = useQueryClient();
  const projectPath = useProjects(false).data?.find((p) => p.id === chat.project_id)?.path ?? null;
  const saveSubfolder = async (next: string | null): Promise<string | null> => {
    const res = await chatsApi.setChatSubfolder(chat.id, next);
    void refreshChats(client);
    return res.kind === "ok" ? null : describeFailure(res, "could not set the subfolder");
  };
  const [sel, setSel] = useState<Selection>({ harness: chat.harness, profile: chat.profile, model: chat.model_id });
  useEffect(() => {
    setSel({ harness: chat.harness, profile: chat.profile, model: chat.model_id });
  }, [chat.harness, chat.profile, chat.model_id]);
  const [effort, setEffort] = useState<string | null>(chat.effort ?? null);
  useEffect(() => {
    setEffort(chat.effort ?? null);
  }, [chat.effort]);
  const levelsOf = (harness: string): string[] => options.harnesses.find((h) => h.id === harness)?.efforts ?? [];
  const change = async (next: Selection, nextEffort: string | null = effort): Promise<void> => {
    const kept = nextEffort !== null && levelsOf(next.harness).includes(nextEffort) ? nextEffort : null;
    setSel(next);
    setEffort(kept);
    const res = await chatsApi.configure(chat.id, { harness: next.harness, profile: next.profile, model_id: next.model, effort: kept });
    if (res.kind !== "ok") {
      toast("error", res.kind === "error" && res.status === 409 ? "A reply is running: change this between turns" : describeFailure(res, "could not change"));
      setSel({ harness: chat.harness, profile: chat.profile, model: chat.model_id });
      setEffort(chat.effort ?? null);
    }
    void refreshChats();
  };
  // Store the pickers' choice when the chat's own profile or model is unusable; otherwise every send fails and the
  // locked pickers already claim the fixed value, so the user has nothing to switch.
  // A chat on a profile that is now limited to orch runs keeps working: no repair, an amber warning instead.
  const runsOnlyReason = options.not_for_chat?.[chat.profile] ?? null;
  const repair = running || runsOnlyReason !== null ? null : repairSelection(options, { harness: chat.harness, profile: chat.profile, model: chat.model_id });
  const repairKey = repair === null ? "" : `${repair.harness}/${repair.profile}/${repair.model ?? ""}`;
  useEffect(() => {
    if (repair !== null) {
      void change(repair);
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps -- keyed on the repair itself, so it runs once per bad selection
  }, [repairKey]);
  const problem = runsOnlyReason !== null ? null : resolvePickers(options, sel).problem;
  const badge: SettingsBadge | null =
    problem !== null ? { tone: "error", text: problem }
    : runsOnlyReason !== null ? { tone: "warn", text: `Not offered for new chats: ${runsOnlyReason}` }
    : lastFailed ? { tone: "error", text: "Last reply failed" }
    : chat.warning != null ? { tone: "warn", text: chat.warning }
    : chat.harness === "" || chat.profile === "" ? { tone: "warn", text: "Harness or model not set" }
    : null;
  return (
    <ChatSettings summary={pickerSummary({ ...chat, effort: effort as Chat["effort"] }, options, modelUsed)} badge={badge}>
      <Pickers options={options} selection={sel} locked={running} modelUsed={modelUsed} onChange={(n) => void change(n)} effort={{ value: effort, onChange: (e) => void change(sel, e) }} />
      {projectPath === null ? null : <SubfolderField projectPath={projectPath} value={chat.subfolder ?? null} onSave={saveSubfolder} />}
    </ChatSettings>
  );
}

export function ChatView({ chatId, onOpenDrawer }: { chatId: string; onOpenDrawer: () => void }) {
  const toast = useToast();
  const chatQuery = useChat(chatId);
  const options = useChatOptions();
  const projects = useProjects(false);
  const thread = useChatThread(chatId);
  const artifacts = useArtifacts(chatId);
  const [lightbox, setLightbox] = useState<Attachment | null>(null);
  const chat = chatQuery.data;
  const rows = thread.messages;
  const todos = latestTodos(rows);
  const asking = pendingQuestion(rows);
  const answerQuestion = useAnswerQuestion(chatId);
  const running = thread.running || rows.some(isLive);
  const voice = useVoiceConversation({
    messages: thread.messages,
    running,
    question: asking === null ? null : { part: asking.part, answer: answerQuestion },
    send: async (text) => {
      const failure = await thread.send(text, []);
      if (failure === null) {
        void refreshChats();
      }
      return failure;
    },
  });
  const stopVoice = voice.stop;
  // Another chat opened in the same view: the loop belongs to the old thread, so end it.
  useEffect(() => stopVoice, [chatId, stopVoice]);
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
    const failure = await thread.send(artifacts.compose(text), ids);
    if (failure === null) {
      void refreshChats();
    }
    return failure;
  };

  return (
    <ArtifactLayout state={artifacts}>
    <div className="chat-view" data-chat={chat.id}>
      <Header
        chat={chat}
        options={options.data}
        modelUsed={modelUsed}
        lastReply={lastReply}
        projects={projects.data ?? []}
        onOpenDrawer={onOpenDrawer}
        queue={thread.queue}
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
          tail={<QueueBubbles items={thread.queue.items} />}
          tailKey={waiting(thread.queue).length}
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
      {todos !== null && todos.length > 0 ? <TodoPanel items={todos} /> : null}
      {asking !== null && !running ? <QuestionCard key={asking.part.id} pinned part={asking.part} now={Date.now()} onSubmit={(answers) => answerQuestion(asking.part.id, answers)} /> : null}
      <ArtifactBar state={artifacts} />
      <QueueTray chatId={chat.id} snapshot={thread.queue} running={running} runningText={[...rows].reverse().find((m) => m.role === "user")?.content ?? null} onStop={() => void thread.stop()} onChange={thread.setQueue} />
      <Composer key={chat.id} chatId={chat.id} blocked={blocked} running={running} toolbar={options.data === undefined ? undefined : <Config chat={chat} options={options.data} running={running} modelUsed={modelUsed} lastFailed={lastReply?.status === "error"} />} onSend={send} onStop={() => void thread.stop()} onOpenImage={setLightbox} voice={voice} />
      {voice.phase !== "off" ? <ConversationView voice={voice} /> : null}
      {lightbox !== null ? <Lightbox attachment={lightbox} onClose={() => { setLightbox(null); }} /> : null}
    </div>
    </ArtifactLayout>
  );
}

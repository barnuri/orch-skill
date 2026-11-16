import type { ChatActivity } from "../../shared/chat-activity";
import { type AutomationPart, type ChatPart, parseParts, partsForToolCall } from "../../shared/chat-parts";
import { answerPrompt, answerProblem, type QuestionPart, questionPartFromTool } from "../../shared/chat-question";
import { existsSync, mkdirSync, statSync } from "node:fs";
import { join, resolve } from "node:path";

import type { ServerContext } from "../types/server-context";
import { MAX_CONTENT_CHARS, MAX_TITLE_CHARS } from "./limits";
import { ensureSubfolder, normaliseSubfolder, reasonOf, SubfolderError, subfolderProblem } from "./subfolder";
import { chatRoots, FolderError, folderUsable, type FolderList, listFolders, validateFolder } from "./folders";
import { alternativeHint, buildOptions, chatUsageRefusal, EFFORTS, type ChatOptions, resolveLaunch } from "./options";
import { OpencodeSession } from "./sessions/opencode-session";
import { OpencodeServerPool } from "./sessions/opencode-server";
import { ClaudeSession } from "./sessions/claude-session";
import { ChatQueue, QueueError, type QueueItem } from "./queue";
import { SessionManager } from "./sessions/manager";
import { TurnSession } from "./sessions/turn-session";
import type { AgentEvent, AgentSession, ReplayMessage, SessionFactory, SessionParams } from "./sessions/types";
import { ChatStore } from "./store";
import type { AttachmentRow, ChatRow, MessageRow, ProjectRow } from "./types";
import { runEmptyCleanupOnce } from "./empty-cleanup";
import { agentPathFor, blobPath, SWEEP_AGE_MS, sweepUnattached } from "./uploads";
import { OpencodeParser } from "./sessions/opencode-session";
import { ClaudeParser } from "./sessions/claude-session";
import { isAlive, killGroup, listTurns, type TurnMeta, type TurnParser, turnEvents, turnPaths, sweepTurnFiles } from "./sessions/turn-files";
import { PlainParser, sweepPromptDirs } from "./sessions/turn-session";
import { type LivenessOptions, TurnLiveness } from "./turn-liveness";
import { ArtifactHub, ArtifactStore, externalCandidate, readSettings } from "./artifacts";
import type { ArtifactEvent } from "../../shared/artifacts";
import { BrowserProfiles, browserEnv, ensureProfile, primaryForCwd } from "./browser-profile";
import { AUTOMATION_INSTRUCTION } from "../../shared/chat-automation";
import { indexRemove, indexUpsert, instructionBlock, memoryFingerprint, type Scope, Workspace } from "./workspace";

export class HttpError extends Error {
  constructor(readonly status: number, message: string) {
    super(message);
  }
}

function asHttp(err: unknown): unknown {
  return err instanceof FolderError ? new HttpError(400, err.message) : err;
}

export interface ChatEvent {
  /** SSE `event:` name. */
  event: "status" | "message" | "delta" | "usage" | "queue" | "done" | "activity" | "artifact";
  /** SSE `id:`, `<message id>.<content length>`; absent for events that belong to no message. */
  id?: string;
  data: Record<string, unknown>;
}

type Listener = (event: ChatEvent) => void;
interface Turn {
  assistantId: string;
  stopRequested: boolean;
  /** The server is shutting down: stop following the process, leave it and the message alone. */
  detached: boolean;
  session: AgentSession | null;
  /** Process group of a re-attached turn (no session object owns it). */
  pid: number | null;
  abort: AbortController;
  promise: Promise<void>;
  /** Set by the watchdog: the reply ends as an error with this text instead of stopped. */
  failure?: string | undefined;
  failedAt?: number | undefined;
}

const DEFAULT_TITLE = "New chat";
const WATCH_MS = 5000;
const FORCE_AFTER_MS = 4000;
const DISPATCH: string = resolve(import.meta.dir, "../../../skills/orch/scripts/dispatch.ts");

/** Both binaries can be replaced from the environment, which is how tests keep real models out. */
function defaultFactory(ctx: ServerContext, servers: OpencodeServerPool | null): SessionFactory {
  return (params: SessionParams) => {
    if (params.harness === "claude") {
      const bin = process.env.ORCH_CHAT_CLAUDE_BIN ?? Bun.which("claude");
      const resolved = resolveLaunch(ctx.paths.home, params.harness, params.profile, params.modelId);
      if (bin === null || bin === undefined) {
        throw new HttpError(400, "claude is not installed");
      }
      if (!resolved.ok) {
        throw new HttpError(400, resolved.error);
      }
      const profile = primaryForCwd(ctx.paths.home, params.cwd);
      ensureProfile(profile);
      return new ClaudeSession(params, bin, { ...resolved.launch, env: { ...resolved.launch.env, ...browserEnv(profile) } });
    }
    if (params.harness === "opencode" && process.env.ORCH_CHAT_OPENCODE_DISPATCH !== "1") {
      const bin = process.env.ORCH_CHAT_OPENCODE_BIN ?? Bun.which("opencode") ?? join(process.env.HOME ?? "", ".opencode", "bin", "opencode");
      const resolved = resolveLaunch(ctx.paths.home, params.harness, params.profile, params.modelId);
      if (!resolved.ok) {
        throw new HttpError(400, resolved.error);
      }
      return new OpencodeSession(params, bin, resolved.launch, servers);
    }
    return new TurnSession(params, process.env.ORCH_CHAT_DISPATCH ?? DISPATCH);
  };
}

export class ChatService {
  readonly store: ChatStore;
  readonly manager: SessionManager;
  private readonly listeners = new Map<string, Set<Listener>>();
  /** Every chat's events, for observers that are not a page (push notifications). */
  readonly events = new Set<(chatId: string, event: ChatEvent) => void>();
  private readonly turns = new Map<string, Turn>();
  /** Fingerprint of the memories the agent last heard about, per chat (see workspaceInstructions). */
  private readonly lastBlock = new Map<string, string>();
  private readonly browser = new BrowserProfiles(() => this.home);
  readonly recovered: number;
  readonly artifactHub = new ArtifactHub();
  private readonly artifactPaths = new Map<string, Set<string>>();
  /** The per-chat message queue: what waits while a turn runs (see queue.ts). */
  readonly queue: ChatQueue;
  readonly liveness: TurnLiveness;
  private readonly factory: SessionFactory;
  /** Chats whose agent already heard the schedule/loop/monitor line in this server run. */
  private readonly automationTold = new Set<string>();
  private readonly watchdog: ReturnType<typeof setInterval>;
  /** Long-lived `opencode serve` per profile env that opencode chat turns attach to (null: disabled, always standalone). */
  readonly opencodeServers: OpencodeServerPool | null = OpencodeServerPool.enabled() ? new OpencodeServerPool() : null;

  constructor(private readonly ctx: ServerContext, opts: { factory?: SessionFactory; idleMs?: number; liveness?: LivenessOptions & { tickMs?: number } } = {}) {
    this.liveness = new TurnLiveness(opts.liveness);
    mkdirSync(join(ctx.paths.home, "chats"), { recursive: true });
    this.store = new ChatStore(join(ctx.paths.home, "chats.db"));
    const adoptable = this.adoptableTurns();
    this.recovered = this.store.recoverStreaming(new Set(adoptable.map((a) => a.meta.message_id)));
    sweepPromptDirs();
    sweepTurnFiles(ctx.paths.home);
    const uploads = sweepUnattached(this.store, ctx.paths.home);
    const empties = this.store.archiveEmptyChatsBefore(new Date(Date.now() - SWEEP_AGE_MS).toISOString()) + runEmptyCleanupOnce(this.store, ctx.paths.home);
    if (uploads > 0 || empties > 0) {
      console.log(`chats: startup sweep removed ${uploads} unattached upload(s) and archived ${empties} empty chat(s)`);
    }
    this.factory = opts.factory ?? defaultFactory(ctx, this.opencodeServers);
    this.manager = new SessionManager(this.factory, opts.idleMs);
    this.queue = new ChatQueue(this.store, {
      isRunning: (chatId) => this.turns.has(chatId) || this.store.getChat(chatId)?.status === "running",
      start: (chatId, input) => this.sendMessage(chatId, input),
      stopRunning: (chatId) => this.stop(chatId),
      hasPendingQuestion: (chatId) => this.store.pendingQuestionRows(chatId).length > 0,
      assertOpen: (chatId) => {
        if (this.chat(chatId).archived_at !== null) {
          throw new QueueError(409, "chat is archived");
        }
      },
      emit: (chatId, snapshot) => { this.emit(chatId, { event: "queue", data: { ...snapshot } }); },
    }, ctx.paths.home);
    for (const a of adoptable) {
      this.reattach(a.meta, a.paths);
    }
    this.queue.recover((chatId) => this.turns.has(chatId));
    this.watchdog = setInterval(() => { this.watch(); }, opts.liveness?.tickMs ?? WATCH_MS);
    this.watchdog.unref();
  }

  /**
   * Every tick: a running turn that is silent or whose process is gone ends as an error, and a message that is still
   * streaming with no turn behind it (its process died, the follower threw) is closed as interrupted.
   */
  watch(): void {
    for (const [chatId, turn] of [...this.turns]) {
      if (turn.detached) {
        continue;
      }
      if (turn.failure !== undefined) {
        // The kill did not end the follower in time: finish the row here so nothing stays streaming.
        if (Date.now() - (turn.failedAt ?? 0) > FORCE_AFTER_MS) {
          this.forceFinish(chatId, turn, turn.failure);
        }
        continue;
      }
      const verdict = this.liveness.verdict(chatId, this.pidOf(turn));
      if (verdict.kind === "dead") {
        turn.failure = verdict.message;
        turn.failedAt = Date.now();
        void this.stopTurn(turn).catch(() => undefined);
      } else {
        this.emitActivity(chatId, turn);
      }
    }
    const open = new Set([...this.turns.values()].map((t) => t.assistantId));
    const orphans = (this.store.streamingRows()).filter((r) => !open.has(r.id));
    if (orphans.length > 0) {
      this.store.recoverStreaming(open);
      for (const r of orphans) {
        const row = this.store.getMessage(r.id);
        if (row !== null) {
          this.emit(r.chat_id, { event: "done", id: `${row.id}.${row.content.length}`, data: { message_id: row.id, status: row.status, error: row.error, context_truncated: row.context_truncated === 1, warning: row.warning } });
          this.emit(r.chat_id, { event: "status", data: { chat_id: r.chat_id, status: this.idleStatus(r.chat_id) } });
        }
      }
    }
  }

  /**
   * The status shown to people: `running` while a reply streams, `waiting` while an agent's question waits for an
   * answer, else `idle`. Stored `chats.status` stays idle or running; `waiting` is derived from the pending question.
   */
  statusOf(chat: Pick<ChatRow, "id" | "status" | "archived_at">, waiting: ReadonlySet<string> | null = null): "idle" | "running" | "waiting" {
    if (chat.status === "running" || this.turns.has(chat.id)) {
      return "running";
    }
    if (chat.archived_at !== null) {
      return "idle";
    }
    return (waiting === null ? this.store.pendingQuestionRows(chat.id).length > 0 : waiting.has(chat.id)) ? "waiting" : "idle";
  }

  private idleStatus(chatId: string): "idle" | "waiting" {
    const chat = this.store.getChat(chatId);
    return chat === null ? "idle" : this.statusOf({ ...chat, status: "idle" }) as "idle" | "waiting";
  }

  private pidOf(turn: Turn): boolean | null {
    const pid = turn.pid ?? turn.session?.processId ?? null;
    return pid === null ? null : isAlive(pid);
  }

  private forceFinish(chatId: string, turn: Turn, error: string): void {
    const current = this.store.getMessage(turn.assistantId);
    if (current !== null && (current.status === "streaming" || current.status === "pending")) {
      const final = this.store.finalizeMessage(turn.assistantId, { status: "error", error, model_used: null, input_tokens: 0, output_tokens: 0, cost_usd: null, context_truncated: false, warning: null }) as MessageRow;
      this.emit(chatId, { event: "done", id: `${final.id}.${final.content.length}`, data: { message_id: final.id, status: final.status, error: final.error, context_truncated: false, warning: null } });
    }
    this.store.updateChat(chatId, { status: "idle" });
    if (this.turns.get(chatId) === turn) {
      this.turns.delete(chatId);
    }
    this.liveness.end(chatId);
    void this.manager.drop(chatId);
    this.emit(chatId, { event: "status", data: { chat_id: chatId, status: this.idleStatus(chatId) } });
  }

  private emitActivity(chatId: string, turn: Turn): void {
    const activity = this.liveness.snapshot(chatId);
    if (activity !== null) {
      this.emit(chatId, { event: "activity", data: { message_id: turn.assistantId, ...activity } });
    }
  }

  /** Unfinished turns whose process is still there or whose result file is complete: the latest attempt per streaming message. */
  private adoptableTurns(): Array<{ meta: TurnMeta; paths: ReturnType<typeof turnPaths> }> {
    const latest = new Map<string, { meta: TurnMeta; paths: ReturnType<typeof turnPaths> }>();
    for (const t of listTurns(this.ctx.paths.home)) {
      const row = this.store.getMessage(t.meta.message_id);
      if (row === null || (row.status !== "streaming" && row.status !== "pending")) {
        continue;
      }
      const prev = latest.get(t.meta.message_id);
      if (prev === undefined || prev.meta.started < t.meta.started) {
        latest.set(t.meta.message_id, t);
      }
    }
    return [...latest.values()];
  }

  private parserFor(meta: TurnMeta): TurnParser {
    if (meta.parser === "claude") {
      return new ClaudeParser(meta.session_id);
    }
    if (meta.parser === "opencode") {
      return new OpencodeParser(meta.session_id, meta.model);
    }
    return new PlainParser(meta.session_id);
  }

  /** Boot: follow a turn whose harness outlived the previous server. It streams on, or is finalized from its file. */
  private reattach(meta: TurnMeta, paths: ReturnType<typeof turnPaths>): void {
    const chat = this.store.getChat(meta.chat_id);
    if (chat === null) {
      return;
    }
    this.store.updateChat(chat.id, { status: "running" }, false);
    const turn: Turn = { assistantId: meta.message_id, stopRequested: false, detached: false, session: null, pid: meta.pid, abort: new AbortController(), promise: Promise.resolve() };
    this.turns.set(chat.id, turn);
    this.liveness.begin(chat.id, meta.message_id);
    const parser = this.parserFor(meta);
    turn.promise = this.consume(chat, turn, (onReplay) => turnEvents(paths, meta, parser, { signal: turn.abort.signal, replayUntil: meta.offset, onReplay }), () => parser.sessionId() ?? meta.session_id);
  }

  get home(): string {
    return this.ctx.paths.home;
  }

  options(use: "chat" | "runs" = "chat"): ChatOptions {
    return buildOptions(this.home, this.ctx.harnesses, use);
  }

  async dispose(): Promise<void> {
    clearInterval(this.watchdog);
    this.artifactHub.closeAll();
    const running = [...this.turns.values()];
    for (const t of running) {
      t.detached = true;
      t.abort.abort();
    }
    await this.manager.disposeAll();
    await Promise.race([Promise.all(running.map((t) => t.promise)), new Promise((r) => setTimeout(r, 1000).unref())]);
    await this.opencodeServers?.stopAll();
    this.store.close();
  }

  // ---- lookups ----

  project(id: string): ProjectRow {
    const row = this.store.getProject(id);
    if (row === null) {
      throw new HttpError(404, "no such project");
    }
    return row;
  }

  chat(id: string): ChatRow {
    const row = this.store.getChat(id);
    if (row === null) {
      throw new HttpError(404, "no such chat");
    }
    return row;
  }

  private checkProject(id: string | null | undefined): void {
    if (id === null || id === undefined) {
      return;
    }
    if (this.project(id).archived_at !== null) {
      throw new HttpError(400, "project is archived");
    }
  }

  private checkChatUse(profile: string): void {
    const why = chatUsageRefusal(this.home, profile);
    if (why !== null) {
      throw new HttpError(400, why);
    }
  }

  private checkSelection(harness: string, profile: string, modelId: string | null): void {
    const result = resolveLaunch(this.home, harness, profile, modelId);
    if (!result.ok) {
      throw new HttpError(400, result.error);
    }
  }

  // ---- chats ----

  /** Never rejected for a disabled, missing or unconfigured harness: the check happens when a turn is sent. */
  createChat(input: { project_id?: string | null; title?: string; harness: string; profile: string; model_id?: string | null; cwd?: string | null; subfolder?: string | null; effort?: string | null }): ChatRow {
    this.checkProject(input.project_id);
    this.checkChatUse(input.profile);
    const cwd = input.cwd === undefined ? null : this.checkedFolder(input.cwd);
    const subfolder = this.checkedSubfolder(input.project_id ?? null, input.subfolder);
    const given = input.title?.trim().slice(0, MAX_TITLE_CHARS) ?? "";
    const row = this.store.createChat({ ...input, cwd, subfolder, effort: this.checkedEffort(input.harness, input.effort), title: given || DEFAULT_TITLE, title_manual: given !== "" && given !== DEFAULT_TITLE });
    this.indexChat(row);
    return row;
  }

  /** A person's title: trimmed, 1 to MAX_TITLE_CHARS characters, and never replaced by the auto-title afterwards. */
  renameChat(id: string, title: string): ChatRow {
    this.chat(id);
    const clean = title.trim();
    if (clean === "") {
      throw new HttpError(400, "title: must not be empty");
    }
    if (clean.length > MAX_TITLE_CHARS) {
      throw new HttpError(400, `title: longer than ${MAX_TITLE_CHARS} characters`);
    }
    const row = this.store.renameChat(id, clean) as ChatRow;
    this.indexChat(row);
    return row;
  }

  /** Harness, profile and model may change at any time between turns. A new harness cannot resume the old one's session, so its history is replayed. */
  private checkedEffort(harness: string, effort: string | null | undefined): string | null {
    if (effort === null || effort === undefined) {
      return null;
    }
    if (!(EFFORTS[harness] ?? []).includes(effort)) {
      throw new HttpError(400, `effort: harness "${harness}" has no "${effort}" level`);
    }
    return effort;
  }

  configureChat(id: string, input: { harness: string; profile: string; model_id: string | null; effort?: string | null }): ChatRow {
    const chat = this.chat(id);
    if (this.turns.has(id) || chat.status === "running") {
      throw new HttpError(409, "a reply is running; change harness, profile or model between turns");
    }
    this.checkSelection(input.harness, input.profile, input.model_id);
    if (input.profile !== chat.profile) {
      this.checkChatUse(input.profile);
    }
    const sameHarness = chat.harness === input.harness;
    const { effort: wanted, ...rest } = input;
    // A harness switch clears an effort it does not take; an omitted effort keeps the stored one while it still applies.
    const effort = this.checkedEffort(input.harness, wanted === undefined ? ((EFFORTS[input.harness] ?? []).includes(chat.effort ?? "") ? chat.effort : null) : wanted);
    const row = this.store.updateChat(id, sameHarness ? { ...rest, effort } : { ...rest, effort, session_id: null }) as ChatRow;
    void this.manager.drop(id);
    return row;
  }

  setChatProject(id: string, projectId: string | null): ChatRow {
    const before = this.chat(id);
    this.checkProject(projectId);
    const row = this.store.updateChat(id, { project_id: projectId }, false) as ChatRow;
    if (before.project_id !== projectId) {
      // A live session keeps the directory it started in; drop it so the next turn starts in the new one.
      void this.manager.drop(id);
    }
    this.afterMove(before, row);
    return row;
  }

  /** The normalised subfolder after creating it under the project's folder; null clears. Needs a project with a folder (400). */
  private checkedSubfolder(projectId: string | null, value: string | null | undefined): string | null {
    let clean: string | null;
    try {
      clean = normaliseSubfolder(value);
      if (clean === null) {
        return null;
      }
      const path = projectId === null ? null : (this.store.getProject(projectId)?.path ?? null);
      if (path === null) {
        throw new SubfolderError("subfolder needs a project with a folder");
      }
      ensureSubfolder(path, clean);
    } catch (err) {
      throw err instanceof SubfolderError ? new HttpError(400, err.message) : err;
    }
    return clean;
  }

  /** Sets or clears (null or blank) the chat's subfolder inside its project's folder. Applies from the next turn. */
  setChatSubfolder(id: string, value: string | null): ChatRow {
    const before = this.chat(id);
    const subfolder = this.checkedSubfolder(before.project_id, value);
    const row = this.store.setChatSubfolder(id, subfolder) as ChatRow;
    void this.manager.drop(id);
    this.afterMove(before, row);
    return row;
  }

  // ---- folders ----

  folders(root?: string, depth: 1 | 2 = 1): FolderList {
    try {
      return listFolders(chatRoots(this.home), root, this.store.folderUse(), depth);
    } catch (err) {
      throw asHttp(err);
    }
  }

  private checkedFolder(path: string | null): string | null {
    if (path === null || path.trim() === "") {
      return null;
    }
    try {
      const real = validateFolder(path, chatRoots(this.home));
      this.store.touchFolder(real);
      return real;
    } catch (err) {
      throw asHttp(err);
    }
  }

  /** Sets or clears (null) the chat's own folder. It overrides the project's folder from the next turn; a running turn keeps its folder. */
  setChatFolder(id: string, path: string | null): ChatRow {
    const before = this.chat(id);
    const folder = this.checkedFolder(path);
    const row = this.store.setChatCwd(id, folder) as ChatRow;
    void this.manager.drop(id);
    this.afterMove(before, row);
    return row;
  }

  /** The default folder of a project: chats without their own folder run there. */
  setProjectFolder(id: string, path: string | null): ProjectRow {
    this.project(id);
    const folder = this.checkedFolder(path);
    const row = this.store.updateProject(id, { path: folder }) as ProjectRow;
    for (const chat of this.store.listChats({ projectId: id, limit: 100 }).items) {
      void this.manager.drop(chat.id);
    }
    return row;
  }

  /**
   * The folder the chat's next turn runs in: its own, else its project's (with the subfolder when it can be used), else null (a
   * scratch folder). The subfolder is resolved with realpath on every call, so a symlink swapped in after it was set sends the
   * chat back to the project folder here, in every API read, and at the next turn alike.
   */
  effectiveCwd(chat: ChatRow): string | null {
    const project = chat.project_id === null ? null : this.store.getProject(chat.project_id);
    if (chat.cwd === null && project?.path != null && chat.subfolder !== null && subfolderProblem(project.path, chat.subfolder) === null) {
      return join(project.path, chat.subfolder);
    }
    return chat.cwd ?? project?.path ?? null;
  }

  /** Why the chat's subfolder is not used (it resolves outside the project folder, a level is a file or a broken link), or null. Creates nothing. */
  private subfolderIssue(chat: ChatRow): string | null {
    const own = this.projectOwnPath(chat);
    return chat.cwd !== null || chat.subfolder === null || own === null ? null : subfolderProblem(own, chat.subfolder);
  }

  /** Creates the chat's subfolder when missing (a deleted one comes back). Returns why it cannot be used, or null when it is ready. */
  private prepareSubfolder(chat: ChatRow): string | null {
    const path = chat.project_id === null ? null : (this.store.getProject(chat.project_id)?.path ?? null);
    if (path === null || chat.subfolder === null) {
      return "the chat has no project folder";
    }
    try {
      ensureSubfolder(path, chat.subfolder);
      return null;
    } catch (err) {
      return err instanceof SubfolderError ? reasonOf(err) : String(err);
    }
  }

  private projectOwnPath(chat: ChatRow): string | null {
    return chat.project_id === null ? null : (this.store.getProject(chat.project_id)?.path ?? null);
  }

  /** The folder a turn really runs in (exists, and inside the roots when it is the chat's own), or null for the scratch folder. */
  usableCwd(chat: ChatRow): string | null {
    let wanted = this.effectiveCwd(chat);
    if (chat.cwd === null && chat.subfolder !== null && wanted !== null && wanted !== this.projectOwnPath(chat)) {
      // the folder is created again whenever it is needed, so a deleted one never breaks a turn; on failure the project folder applies
      wanted = this.prepareSubfolder(chat) === null ? wanted : this.projectOwnPath(chat);
    }
    // A chat folder is checked again at every turn: a symlink swapped after it was picked must not lead outside the roots.
    if (wanted !== null && existsSync(wanted) && statSync(wanted).isDirectory() && (chat.cwd === null || folderUsable(wanted, chatRoots(this.home)))) {
      return wanted;
    }
    return null;
  }

  // ---- workspace ----

  /** The chat's own workspace, or the one its folder shares. The folder scope needs a folder (400 otherwise). */
  workspace(chat: ChatRow, scope: Scope): Workspace {
    const cwd = this.usableCwd(chat);
    if (scope === "folder") {
      if (cwd === null) {
        throw new HttpError(400, "scope: this chat has no folder, so there is no shared folder workspace");
      }
      return new Workspace("folder", join(cwd, ".orch", "shared"), cwd);
    }
    const meta = { id: chat.id, title: chat.title, created_at: chat.created_at, harness: chat.harness, updated_at: chat.updated_at };
    return cwd === null ? new Workspace("chat", join(this.home, "chats", "data", chat.id), null, meta) : new Workspace("chat", join(cwd, ".orch", "chats", chat.id), cwd, meta);
  }

  private indexChat(chat: ChatRow): void {
    try {
      const cwd = this.usableCwd(chat);
      if (cwd !== null) {
        indexUpsert(cwd, chat, false);
      }
    } catch {
      // the index is a convenience: never fail a chat call for it
    }
  }

  /** The workspace stays where it was when a chat moves; the new one records where the old one is. */
  private afterMove(before: ChatRow, after: ChatRow): void {
    try {
      const from = this.usableCwd(before);
      const to = this.usableCwd(after);
      if (from === to) {
        return;
      }
      const old = this.workspace(before, "chat");
      if (from !== null) {
        indexRemove(from, before.id);
      }
      if (old.exists()) {
        this.workspace(after, "chat").ensure(old.root);
      }
      if (to !== null) {
        indexUpsert(to, after, false);
      }
    } catch {
      // a broken folder must not fail the move
    }
  }

  /** The text appended to the agent's prompt, or "": sent on the first turn and whenever a MEMORY.md changed. */
  workspaceInstructions(chat: ChatRow): string {
    try {
      const own = this.workspace(chat, "chat");
      own.ensure();
      const cwd = this.usableCwd(chat);
      const shared = cwd === null ? null : this.workspace(chat, "folder");
      shared?.ensure();
      if (cwd !== null) {
        indexUpsert(cwd, chat, true);
      }
      const print = memoryFingerprint(shared?.readMemory().content ?? "", own.readMemory().content);
      // local-llm keeps no session: only the prompt carries the instructions, every turn.
      if (this.lastBlock.get(chat.id) === print && chat.harness !== "local-llm") {
        return "";
      }
      this.lastBlock.set(chat.id, print);
      const project = chat.project_id === null ? null : this.store.getProject(chat.project_id);
      return instructionBlock({ shared: shared?.root ?? null, chat: own.root, projectInstructions: project?.description ?? "" });
    } catch {
      return "";
    }
  }

  private projectPathOf(chat: ChatRow): string | null {
    const path = chat.project_id === null ? null : (this.store.getProject(chat.project_id)?.path ?? null);
    return path !== null && existsSync(path) ? path : null;
  }

  /** Why the chat will not run where the user expects, or null: its folder is gone, no longer allowed, or its subfolder is not usable. Names the reason. */
  warningFor(chat: ChatRow): string | null {
    const cwd = this.effectiveCwd(chat);
    const own = this.projectOwnPath(chat);
    if (chat.cwd === null && chat.subfolder !== null && own !== null && existsSync(own)) {
      const issue = this.subfolderIssue(chat) ?? (cwd !== own ? this.prepareSubfolder(chat) : null);
      if (issue !== null) {
        return `Subfolder ${chat.subfolder} is not used (${issue}): the agent runs in the project folder instead.`;
      }
    }
    if (cwd !== null && !existsSync(cwd) && !(cwd !== own && own !== null && existsSync(own))) {
      return `${chat.cwd === null ? "Project" : "Chat"} directory ${cwd} no longer exists: the agent runs in a scratch folder instead.`;
    }
    if (cwd !== null && chat.cwd !== null && !folderUsable(cwd, chatRoots(this.home))) {
      return `Folder ${cwd} is no longer inside an allowed root: the agent runs in a scratch folder instead.`;
    }
    return null;
  }

  // ---- messages ----

  withAttachments(rows: MessageRow[]): Array<MessageRow & { attachments: AttachmentRow[]; activity: ChatActivity | null }> {
    const map = this.store.attachmentsOf(rows.map((r) => r.id));
    return rows.map((r) => ({ ...r, attachments: map.get(r.id) ?? [], activity: r.role === "assistant" && this.turns.get(r.chat_id)?.assistantId === r.id ? this.liveness.snapshot(r.chat_id) : null }));
  }

  sendMessage(chatId: string, input: { content: string; attachment_ids?: string[] }): { user_message_id: string; assistant_message_id: string } {
    const chat = this.chat(chatId);
    if (chat.archived_at !== null) {
      throw new HttpError(409, "chat is archived");
    }
    if (this.turns.has(chatId) || chat.status === "running") {
      throw new HttpError(409, "a reply is already running; stop it first");
    }
    const content = input.content;
    if (content.trim() === "" && (input.attachment_ids ?? []).length === 0) {
      throw new HttpError(400, "content: message is empty");
    }
    if (content.length > MAX_CONTENT_CHARS) {
      throw new HttpError(400, `content: longer than ${MAX_CONTENT_CHARS} characters`);
    }
    try {
      this.checkSelection(chat.harness, chat.profile, chat.model_id);
    } catch (err) {
      if (err instanceof HttpError && err.status === 400) {
        throw new HttpError(400, `${err.message}${alternativeHint(this.options(), chat.harness, chat.profile)}`);
      }
      throw err;
    }
    const ids = [...new Set(input.attachment_ids ?? [])];
    const attachments: AttachmentRow[] = ids.map((id) => {
      const row = this.store.getAttachment(id);
      if (row === null || row.chat_id !== chatId) {
        throw new HttpError(400, `attachment_ids: unknown attachment ${id}`);
      }
      if (row.message_id !== null) {
        throw new HttpError(400, `attachment_ids: ${id} is already attached to a message`);
      }
      if (!existsSync(blobPath(this.home, row.sha256))) {
        // The stored blob is gone (trashed by hand, disk cleanup): refuse here rather than hand the agent a dangling link.
        throw new HttpError(400, `attachment_ids: the file of ${row.filename} is missing on the server; upload it again`);
      }
      return row;
    });
    const paths = attachments.map((a) => agentPathFor(this.home, a));
    this.expireQuestions(chatId);
    const userMsg = this.store.addMessage({ chat_id: chatId, role: "user", content, status: "done" });
    this.store.linkAttachments(ids, userMsg.id);
    const assistant = this.store.addMessage({ chat_id: chatId, role: "assistant", status: "streaming" });
    this.store.updateChat(chatId, { status: "running" });
    if (chat.title_manual !== 1 && chat.title === DEFAULT_TITLE) {
      // The auto-title fills in only an untouched "New chat"; the store re-checks title_manual in the same statement.
      const firstWords = content.trim().replace(/\s+/g, " ");
      this.store.autoTitle(chatId, (firstWords || attachments[0]?.filename || DEFAULT_TITLE).slice(0, 60));
    }
    this.emit(chatId, { event: "message", id: `${userMsg.id}.${content.length}`, data: { message: this.withAttachments([userMsg])[0] } });
    this.emit(chatId, { event: "message", id: `${assistant.id}.0`, data: { message: { ...assistant, attachments: [] } } });
    this.emit(chatId, { event: "status", data: { chat_id: chatId, status: "running" } });
    const turn: Turn = { assistantId: assistant.id, stopRequested: false, detached: false, session: null, pid: null, abort: new AbortController(), promise: Promise.resolve() };
    this.turns.set(chatId, turn);
    this.liveness.begin(chatId, assistant.id);
    this.emitActivity(chatId, turn);
    const fresh = this.chat(chatId);
    this.artifactTurnStart(fresh, assistant.id);
    const block = content.trim() === "" ? "" : this.workspaceInstructions(fresh);
    const browserNote = content.trim() === "" ? "" : this.browser.startTurn({ id: fresh.id, cwd: this.usableCwd(fresh), projectPath: this.projectPathOf(fresh) }, fresh.harness === "local-llm");
    const told = content.trim() === "" || (this.automationTold.has(chatId) && fresh.harness !== "local-llm");
    this.automationTold.add(chatId);
    const tail = [block, browserNote, this.artifactUserNote(fresh), told ? "" : AUTOMATION_INSTRUCTION].filter((t) => t !== "").join("\n\n");
    turn.promise = this.runTurn(fresh, turn, tail === "" ? content : `${content}\n\n${tail}`, paths).finally(() => this.browser.endTurn(chatId));
    return { user_message_id: userMsg.id, assistant_message_id: assistant.id };
  }

  /**
   * Posts a finished block into the thread (a schedule, loop or monitor result) as an assistant message, marks the
   * chat unread and moves it up the list. It never touches a running turn.
   */
  postBlock(chatId: string, input: { content: string; part: AutomationPart; failed?: boolean }): MessageRow {
    this.chat(chatId);
    const row = this.store.addMessage({ chat_id: chatId, role: "assistant", content: input.content, status: input.failed === true ? "error" : "done", error: input.failed === true ? input.content : null, parts: [{ type: "text", text: input.content }, input.part] });
    this.store.setUnread(chatId, true);
    this.store.touchChat(chatId);
    this.emitRow(chatId, row);
    return row;
  }

  markRead(chatId: string): void {
    this.chat(chatId);
    this.store.setUnread(chatId, false);
  }

  /**
   * Runs one prompt in a new, isolated session with the chat's folder, harness and effort. The chat's own session,
   * history and queue are untouched. Resolves with the final text, or the error.
   */
  async runIsolated(chatId: string, prompt: string): Promise<{ text: string; error: string | null; ms: number }> {
    const chat = this.chat(chatId);
    const started = Date.now();
    const session = this.factory({ ...this.paramsFor(chat), chatId: `${chatId}~one-off-${started}`, resumeSessionId: null, history: () => [] });
    let text = "";
    let error: string | null = null;
    try {
      await session.start();
      for await (const ev of session.send(prompt, [])) {
        if (ev.type === "text-delta") {
          text += ev.text;
        } else if (ev.type === "error" || ev.type === "interrupted") {
          error = ev.message;
        }
      }
    } catch (err) {
      error = err instanceof Error ? err.message : String(err);
    } finally {
      await session.stop().catch(() => {});
      await session.dispose().catch(() => {});
    }
    return { text: text.trim(), error, ms: Date.now() - started };
  }

  /** Resolves when the chat's running reply (if any) has been finalized. Used by tests and shutdown. */
  async settled(chatId: string): Promise<void> {
    await this.turns.get(chatId)?.promise;
  }

  /** Like `settled`, but follows the queue: resolves when no turn runs and nothing starts next. */
  async settledAll(chatId: string): Promise<void> {
    for (let guard = 0; guard < 200; guard++) {
      const turn = this.turns.get(chatId);
      if (turn === undefined) {
        return;
      }
      await turn.promise;
      await Promise.resolve();
    }
  }

  /**
   * The send used by the API: starts a turn at once when the chat is idle and nothing waits, otherwise puts the
   * message at the end of the chat's queue (it keeps the order: a new message never jumps ahead of waiting ones).
   */
  submit(chatId: string, input: { content: string; attachment_ids?: string[] }): { queued: false; user_message_id: string; assistant_message_id: string } | { queued: true; item: QueueItem } {
    const chat = this.chat(chatId);
    const busy = this.turns.has(chatId) || chat.status === "running";
    if (!busy && !this.queue.hasQueued(chatId)) {
      return { queued: false, ...this.sendMessage(chatId, input) };
    }
    const item = this.queue.enqueue(chatId, input);
    if (!busy) {
      this.queue.advance(chatId);
    }
    return { queued: true, item };
  }

  async stop(chatId: string): Promise<boolean> {
    this.chat(chatId);
    const turn = this.turns.get(chatId);
    if (turn === undefined) {
      this.queue.pause(chatId, "The reply was stopped.");
      return false;
    }
    await this.stopTurn(turn);
    await turn.promise;
    return true;
  }

  private async stopTurn(turn: Turn): Promise<void> {
    turn.stopRequested = true;
    if (turn.session !== null) {
      await turn.session.stop();
    } else if (turn.pid !== null) {
      turn.abort.abort();
      await killGroup(turn.pid);
    }
  }

  /** Ends the turn's process without marking the reply stopped (the agent asked a question and waits for the answer). */
  private async endProcess(turn: Turn): Promise<void> {
    if (turn.session !== null) {
      await turn.session.stop();
    } else if (turn.pid !== null) {
      turn.abort.abort();
      await killGroup(turn.pid);
    }
  }

  /**
   * Answers (or, with `answers` null, dismisses) the agent's question `qid`. The state changes before the message is
   * sent, so a second call finds it settled (409) and nothing is delivered twice; a send that fails puts it back.
   */
  answerQuestion(chatId: string, qid: string, answers: string[][] | null): { user_message_id: string; assistant_message_id: string; message: MessageRow } {
    this.chat(chatId);
    const row = this.store.findQuestionRow(chatId, qid);
    const part = parseParts(row?.parts ?? null)?.find((p): p is QuestionPart => p.type === "question" && p.id === qid);
    if (row === null || part === undefined) {
      throw new HttpError(404, "no such question");
    }
    if (part.state !== "pending") {
      throw new HttpError(409, `question already ${part.state}`);
    }
    if (answers !== null) {
      const problem = answerProblem(part, answers);
      if (problem !== null) {
        throw new HttpError(400, problem);
      }
    }
    if (this.turns.has(chatId) || this.chat(chatId).status === "running") {
      throw new HttpError(409, "a reply is running; wait for it to end");
    }
    const settle = (next: QuestionPart): MessageRow => {
      const updated = this.store.setParts(row.id, parseParts(row.parts)?.map((p) => (p.type === "question" && p.id === qid ? next : p)) ?? [next]) as MessageRow;
      this.emitRow(chatId, updated);
      return updated;
    };
    const settled = settle({ ...part, state: answers === null ? "dismissed" : "answered", ...(answers === null ? {} : { answers }), settled_at: new Date().toISOString() });
    try {
      return { ...this.sendMessage(chatId, { content: answerPrompt(part, answers) }), message: settled };
    } catch (err) {
      settle(part);
      throw err;
    }
  }

  /** A new message ends the wait: a question still pending is closed as dismissed, so it does not stay pinned. */
  private expireQuestions(chatId: string): void {
    for (const row of this.store.pendingQuestionRows(chatId)) {
      const parts = (parseParts(row.parts) ?? []).map((p) => (p.type === "question" && p.state === "pending" ? { ...p, state: "dismissed" as const, settled_at: new Date().toISOString() } : p));
      const next = this.store.setParts(row.id, parts);
      if (next !== null) {
        this.emitRow(chatId, next);
      }
    }
  }

  /** Chats that wait for an answer to a question. */
  chatsWaitingForAnswer(): string[] {
    return this.store.chatsWithPendingQuestion();
  }

  private paramsFor(chat: ChatRow): SessionParams {
    const cwd = this.usableCwd(chat) ?? join(this.home, "chats", "workspace");
    mkdirSync(cwd, { recursive: true });
    return { chatId: chat.id, home: this.home, harness: chat.harness, profile: chat.profile, modelId: chat.model_id, cwd, resumeSessionId: chat.session_id, effort: (EFFORTS[chat.harness] ?? []).includes(chat.effort ?? "") ? chat.effort : null, history: () => this.historyFor(chat.id) };
  }

  /** Finished user and assistant messages before the reply now streaming, oldest first. */
  private historyFor(chatId: string): ReplayMessage[] {
    const rows: ReplayMessage[] = [];
    let cursor: string | null = null;
    do {
      const page = this.store.listMessages(chatId, { limit: 100, cursor });
      for (const m of page.items) {
        if ((m.role === "user" || m.role === "assistant") && m.status !== "streaming" && m.status !== "pending" && m.content !== "") {
          rows.push({ role: m.role, content: m.content });
        }
      }
      cursor = page.next_cursor;
    } while (cursor !== null && rows.length < 200);
    rows.reverse();
    // The newest user message is the prompt being sent; the session adds it itself.
    if (rows.length > 0 && rows[rows.length - 1]?.role === "user") {
      rows.pop();
    }
    return rows;
  }

  private async runTurn(chat: ChatRow, turn: Turn, prompt: string, paths: string[]): Promise<void> {
    const id = turn.assistantId;
    let session: AgentSession | null = null;
    return this.consume(chat, turn, () => {
      session = this.manager.acquire(this.paramsFor(chat));
      turn.session = session;
      return session.send(prompt, paths, { messageId: id }) as AsyncIterable<AgentEvent>;
    }, () => (session as AgentSession | null)?.sessionId ?? null);
  }

  /**
   * Applies a turn's events to the database and the live listeners, then finalizes the message once. `source`
   * gets a callback for events that were already delivered before a restart (their text is rebuilt silently).
   */
  private async consume(chat: ChatRow, turn: Turn, source: (onReplay: (ev: AgentEvent) => void) => AsyncIterable<AgentEvent>, sessionIdOf: () => string | null): Promise<void> {
    const id = turn.assistantId;
    let content = "";
    let usage = { input: 0, output: 0, cost: null as number | null, model: null as string | null };
    let truncated = false;
    let warning: string | null = null;
    let outcome: { status: "done" | "error" | "stopped"; error: string | null } | null = null;
    let interrupted = false;
    let asked = false;
    let askedStopped = false;
    let replayedText = false;
    const toolRows = new Map<string, string>();
    let reasoning = "";
    let reasoningRow: string | null = null;
    const flush = (): void => {
      if (replayedText) {
        replayedText = false;
        this.store.setContent(id, content);
      }
    };
    const handle = (ev: AgentEvent, replay: boolean): void => {
      if (!replay && this.liveness.note(chat.id, ev)) {
        this.emitActivity(chat.id, turn);
      }
      if (ev.type === "text-delta") {
        content += ev.text;
        if (replay) {
          replayedText = true;
        } else {
          this.store.appendContent(id, ev.text);
          this.emit(chat.id, { event: "delta", id: `${id}.${content.length}`, data: { message_id: id, text: ev.text, offset: content.length } });
        }
      } else if (ev.type === "tool") {
        const question = questionPartFromTool(ev.name, ev.id ?? "", ev.input ?? null, new Date().toISOString());
        if (question !== null) {
          asked = true;
          if (!replay) {
            const row = this.store.addMessage({ chat_id: chat.id, role: "tool", content: `question: ${question.questions[0]?.question ?? ""}`.slice(0, 200), status: "done", parts: [question] });
            this.emitRow(chat.id, row);
          }
        } else if (!replay) {
          const parts = partsForToolCall({ id: ev.id ?? "", name: ev.name, input: ev.input ?? null, at: new Date().toISOString() });
          const tool = this.store.addMessage({ chat_id: chat.id, role: "tool", content: ev.summary === "" ? ev.name : `${ev.name}: ${ev.summary}`, status: "done", parts });
          if (ev.id !== undefined && ev.id !== "") {
            toolRows.set(ev.id, tool.id);
          }
          this.emitRow(chat.id, tool);
          this.artifactTool(chat, ev.name, ev.input ?? null);
        }
      } else if (ev.type === "tool-result") {
        const rowId = toolRows.get(ev.id);
        const row = rowId === undefined || replay ? null : this.store.getMessage(rowId);
        const parts = parseParts(row?.parts ?? null);
        if (row !== null && parts !== null) {
          const done = parts.map((p) => (p.type === "tool-call" ? { ...p, state: ev.error ? "error" as const : "done" as const, output: ev.output.slice(0, 20_000), ended_at: new Date().toISOString() } : p));
          const next = this.store.setParts(row.id, done);
          if (next !== null) {
            this.emitRow(chat.id, next);
          }
        }
      } else if (ev.type === "reasoning-delta") {
        if (!replay) {
          reasoning += ev.text;
          const parts: ChatPart[] = [{ type: "reasoning", text: reasoning }];
          const row = reasoningRow === null ? this.store.addMessage({ chat_id: chat.id, role: "tool", content: "", status: "done", parts }) : this.store.setParts(reasoningRow, parts);
          if (row !== null) {
            reasoningRow = row.id;
            this.emitRow(chat.id, row);
          }
        }
      } else if (ev.type === "usage") {
        usage = { input: ev.input_tokens, output: ev.output_tokens, cost: ev.cost_usd, model: ev.model };
        if (!replay) {
          this.emit(chat.id, { event: "usage", id: `${id}.${content.length}`, data: { message_id: id, input_tokens: ev.input_tokens, output_tokens: ev.output_tokens, cost_usd: ev.cost_usd, model: ev.model } });
        }
      } else if (ev.type === "context-truncated") {
        truncated = true;
      } else if (ev.type === "warning") {
        warning = warning === null ? ev.message : `${warning} ${ev.message}`;
      } else if (ev.type === "done") {
        outcome = { status: "done", error: null };
        if (ev.session_id !== null && ev.session_id !== chat.session_id) {
          this.store.updateChat(chat.id, { session_id: ev.session_id }, false);
        }
      } else if (ev.type === "interrupted") {
        interrupted = true;
        outcome = { status: "error", error: ev.message };
      } else {
        outcome = { status: "error", error: ev.message };
      }
    };
    try {
      for await (const ev of source((r) => handle(r, true))) {
        flush();
        handle(ev, false);
        if (asked && !askedStopped && !turn.stopRequested) {
          // No harness has a live channel for an answer (see chat-harnesses.md): end the run here, the answer starts the next turn.
          askedStopped = true;
          await this.endProcess(turn);
        }
      }
    } catch (err) {
      outcome = { status: "error", error: err instanceof Error ? err.message : String(err) };
    }
    if (turn.detached) {
      return;
    }
    flush();
    if (turn.failure !== undefined) {
      outcome = { status: "error", error: turn.failure };
    } else if (turn.stopRequested) {
      outcome = { status: "stopped", error: null };
    } else if (outcome === null && asked) {
      outcome = { status: "done", error: null };
    } else if (outcome === null) {
      outcome = { status: "error", error: "agent ended without a result" };
    }
    if (interrupted || asked) {
      const sid = sessionIdOf();
      if (sid !== null && sid !== chat.session_id) {
        this.store.updateChat(chat.id, { session_id: sid }, false);
      }
    }
    const current = this.store.getMessage(id);
    const final = (current !== null && (current.status === "streaming" || current.status === "pending")
      ? this.store.finalizeMessage(id, {
        status: outcome.status, error: outcome.error, model_used: usage.model, input_tokens: usage.input, output_tokens: usage.output, cost_usd: usage.cost,
        context_truncated: truncated, warning,
      })
      : current) as MessageRow;
    const now = this.turns.get(chat.id);
    if (now !== undefined && now !== turn) {
      // A watchdog already closed this reply and a newer one runs: leave the chat alone.
      return;
    }
    this.store.updateChat(chat.id, { status: "idle" });
    if (now === turn) {
      this.turns.delete(chat.id);
      this.liveness.end(chat.id);
    }
    this.manager.release(chat.id);
    this.artifactTurnEnd(chat);
    this.emit(chat.id, { event: "done", id: `${id}.${final.content.length}`, data: { message_id: id, status: final.status, error: final.error, context_truncated: final.context_truncated === 1, warning: final.warning } });
    this.emit(chat.id, { event: "status", data: { chat_id: chat.id, status: this.idleStatus(chat.id) } });
    try {
      this.queue.turnEnded(chat.id, final.status === "done" ? "done" : final.status === "stopped" ? "stopped" : "error");
    } catch (err) {
      console.error(`chats: queue advance failed for ${chat.id}: ${err instanceof Error ? err.message : String(err)}`);
    }
  }

  // ---- live events ----

  private emitRow(chatId: string, row: MessageRow): void {
    this.emit(chatId, { event: "message", id: `${row.id}.${row.content.length}`, data: { message: { ...row, parts: parseParts(row.parts), attachments: [] } } });
  }

  private emit(chatId: string, event: ChatEvent): void {
    for (const listener of this.listeners.get(chatId) ?? []) {
      listener(event);
    }
    for (const observer of this.events) {
      try {
        observer(chatId, event);
      } catch (err) {
        console.error(`chats: event observer failed: ${err instanceof Error ? err.message : String(err)}`);
      }
    }
  }

  /** Registers a listener and returns the replay (from the database) for the events it missed, plus the unsubscribe. */
  subscribe(chatId: string, lastEventId: string | null, listener: Listener): { replay: ChatEvent[]; unsubscribe: () => void } {
    const chat = this.chat(chatId);
    const set = this.listeners.get(chatId) ?? new Set<Listener>();
    set.add(listener);
    this.listeners.set(chatId, set);
    this.artifactAttach(chat);
    this.artifactHub.retain(chatId);
    let open = true;
    return {
      replay: this.replayFor(chat, lastEventId),
      unsubscribe: () => {
        set.delete(listener);
        if (open) {
          open = false;
          this.artifactHub.release(chatId);
        }
      },
    };
  }

  // ---- artifacts (see artifacts.ts) ----

  artifactStore(chat: ChatRow): ArtifactStore {
    return new ArtifactStore(this.workspace(chat, "chat"));
  }

  emitArtifact(ev: ArtifactEvent): void {
    this.emit(ev.chat_id, { event: "artifact", data: { ...ev } });
  }

  private artifactAttach(chat: ChatRow): void {
    try {
      this.artifactHub.attach(chat.id, this.artifactStore(chat), (ev) => this.emitArtifact(ev));
    } catch {
      // a broken folder must not break the event stream
    }
  }

  private artifactTurnStart(chat: ChatRow, turnId: string): void {
    this.artifactAttach(chat);
    this.artifactHub.setTurn(chat.id, turnId);
    this.artifactPaths.set(chat.id, new Set());
  }

  /** A Write or Edit of an opted-in file type under the chat folder: copy it into artifacts/ once the tool has run. */
  private artifactTool(chat: ChatRow, name: string, input: unknown): void {
    try {
      const folder = this.usableCwd(chat);
      const file = folder === null ? null : externalCandidate(name, input, folder, readSettings(this.home));
      if (folder === null || file === null) {
        return;
      }
      this.artifactPaths.get(chat.id)?.add(file);
      for (const delay of [400, 2000]) {
        setTimeout(() => {
          this.artifactMirror(chat, folder, file);
        }, delay).unref();
      }
    } catch {
      // never fail a turn over an artifact
    }
  }

  private artifactMirror(chat: ChatRow, folder: string, file: string): void {
    try {
      this.artifactAttach(chat);
      if (this.artifactStore(chat).mirror(file, folder) !== null) {
        this.artifactHub.scan(chat.id);
      }
    } catch {
      // ignored: the file may be gone or the folder unusable
    }
  }

  private artifactTurnEnd(chat: ChatRow): void {
    try {
      const folder = this.usableCwd(chat);
      for (const file of this.artifactPaths.get(chat.id) ?? []) {
        if (folder !== null) {
          this.artifactMirror(chat, folder, file);
        }
      }
      this.artifactPaths.delete(chat.id);
      this.artifactHub.scan(chat.id);
      this.artifactHub.setTurn(chat.id, null);
    } catch {
      // ignored
    }
  }

  /** One line for the next prompt when the user edited artifacts since the last turn, else "". */
  artifactUserNote(chat: ChatRow): string {
    try {
      const names = this.artifactStore(chat).takeUserEdits();
      return names.length === 0 ? "" : `[The user edited ${names.map((n) => `artifacts/${n}`).join(", ")} since your last turn: read the file again before you change it.]`;
    } catch {
      return "";
    }
  }

  private replayFor(chat: ChatRow, lastEventId: string | null): ChatEvent[] {
    const out: ChatEvent[] = [];
    const match = lastEventId === null ? null : /^(msg-[0-9a-z]+)\.(\d+)$/.exec(lastEventId);
    if (match !== null) {
      const seen = this.store.getMessage(match[1] as string);
      if (seen !== null && seen.chat_id === chat.id) {
        const offset = Number(match[2]);
        if (seen.content.length > offset) {
          out.push({ event: "delta", id: `${seen.id}.${seen.content.length}`, data: { message_id: seen.id, text: seen.content.slice(offset), offset: seen.content.length } });
        }
        if (seen.status !== "streaming" && seen.status !== "pending") {
          out.push({ event: "done", id: `${seen.id}.${seen.content.length}`, data: { message_id: seen.id, status: seen.status, error: seen.error, context_truncated: seen.context_truncated === 1, warning: seen.warning } });
        }
        // Ids sort by creation, but a reply's tool rows are created after its assistant row, so "after the
        // cursor" cannot rely on ids alone: send a full snapshot of every row that is newer by id, still
        // streaming, or finished at or after the cursor row's creation.
        const snapshot = this.store.messagesSince(chat.id, seen.id, seen.created_at).filter((row) => row.id !== seen.id);
        for (const row of this.withAttachments(snapshot)) {
          out.push({ event: "message", id: `${row.id}.${row.content.length}`, data: { message: { ...row, parts: parseParts(row.parts) } } });
        }
      }
    }
    out.push({ event: "status", data: { chat_id: chat.id, status: this.store.getChat(chat.id) === null ? "idle" : this.statusOf(this.store.getChat(chat.id) as ChatRow) } });
    const turn = this.turns.get(chat.id);
    const activity = turn === undefined ? null : this.liveness.snapshot(chat.id);
    if (turn !== undefined && activity !== null) {
      out.push({ event: "activity", data: { message_id: turn.assistantId, ...activity } });
    }
    const queued = this.queue.snapshot(chat.id);
    if (queued.items.length > 0 || queued.paused) {
      out.push({ event: "queue", data: { ...queued } });
    }
    return out;
  }
}

const services = new WeakMap<ServerContext, ChatService>();

/** One service per server: the controllers share its store and its sessions. */
export function chatServiceFor(ctx: ServerContext): ChatService {
  let service = services.get(ctx);
  if (service === undefined) {
    service = new ChatService(ctx);
    services.set(ctx, service);
  }
  return service;
}

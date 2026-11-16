import { existsSync, mkdirSync, statSync } from "node:fs";
import { join, resolve } from "node:path";

import type { ServerContext } from "../types/server-context";
import { MAX_CONTENT_CHARS, MAX_TITLE_CHARS } from "./limits";
import { alternativeHint, buildOptions, type ChatOptions, resolveLaunch } from "./options";
import { OpencodeSession } from "./sessions/opencode-session";
import { OpencodeServerPool } from "./sessions/opencode-server";
import { ClaudeSession } from "./sessions/claude-session";
import { SessionManager } from "./sessions/manager";
import { TurnSession } from "./sessions/turn-session";
import type { AgentEvent, AgentSession, ReplayMessage, SessionFactory, SessionParams } from "./sessions/types";
import { ChatStore } from "./store";
import type { AttachmentRow, ChatRow, MessageRow, ProjectRow } from "./types";
import { agentPathFor, blobPath, SWEEP_AGE_MS, sweepUnattached } from "./uploads";
import { OpencodeParser } from "./sessions/opencode-session";
import { ClaudeParser } from "./sessions/claude-session";
import { killGroup, listTurns, type TurnMeta, type TurnParser, turnEvents, turnPaths, sweepTurnFiles } from "./sessions/turn-files";
import { PlainParser, sweepPromptDirs } from "./sessions/turn-session";

export class HttpError extends Error {
  constructor(readonly status: number, message: string) {
    super(message);
  }
}

export interface ChatEvent {
  /** SSE `event:` name. */
  event: "status" | "message" | "delta" | "usage" | "done";
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
}

const DEFAULT_TITLE = "New chat";
const DISPATCH: string = resolve(import.meta.dir, "../../../skills/orch/scripts/dispatch.sh");

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
      return new ClaudeSession(params, bin, resolved.launch);
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
  private readonly turns = new Map<string, Turn>();
  readonly recovered: number;
  /** Long-lived `opencode serve` per profile env that opencode chat turns attach to (null: disabled, always standalone). */
  readonly opencodeServers: OpencodeServerPool | null = OpencodeServerPool.enabled() ? new OpencodeServerPool() : null;

  constructor(private readonly ctx: ServerContext, opts: { factory?: SessionFactory; idleMs?: number } = {}) {
    mkdirSync(join(ctx.paths.home, "chats"), { recursive: true });
    this.store = new ChatStore(join(ctx.paths.home, "chats.db"));
    const adoptable = this.adoptableTurns();
    this.recovered = this.store.recoverStreaming(new Set(adoptable.map((a) => a.meta.message_id)));
    sweepPromptDirs();
    sweepTurnFiles(ctx.paths.home);
    const uploads = sweepUnattached(this.store, ctx.paths.home);
    const empties = this.store.archiveEmptyChatsBefore(new Date(Date.now() - SWEEP_AGE_MS).toISOString());
    if (uploads > 0 || empties > 0) {
      console.log(`chats: startup sweep removed ${uploads} unattached upload(s) and archived ${empties} empty chat(s)`);
    }
    this.manager = new SessionManager(opts.factory ?? defaultFactory(ctx, this.opencodeServers), opts.idleMs);
    for (const a of adoptable) {
      this.reattach(a.meta, a.paths);
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
    const parser = this.parserFor(meta);
    turn.promise = this.consume(chat, turn, (onReplay) => turnEvents(paths, meta, parser, { signal: turn.abort.signal, replayUntil: meta.offset, onReplay }), () => parser.sessionId() ?? meta.session_id);
  }

  get home(): string {
    return this.ctx.paths.home;
  }

  options(): ChatOptions {
    return buildOptions(this.home, this.ctx.harnesses);
  }

  async dispose(): Promise<void> {
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

  private checkSelection(harness: string, profile: string, modelId: string | null): void {
    const result = resolveLaunch(this.home, harness, profile, modelId);
    if (!result.ok) {
      throw new HttpError(400, result.error);
    }
  }

  // ---- chats ----

  /** Never rejected for a disabled, missing or unconfigured harness: the check happens when a turn is sent. */
  createChat(input: { project_id?: string | null; title?: string; harness: string; profile: string; model_id?: string | null }): ChatRow {
    this.checkProject(input.project_id);
    const given = input.title?.trim().slice(0, MAX_TITLE_CHARS) ?? "";
    return this.store.createChat({ ...input, title: given || DEFAULT_TITLE, title_manual: given !== "" && given !== DEFAULT_TITLE });
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
    return this.store.renameChat(id, clean) as ChatRow;
  }

  /** Harness, profile and model may change at any time between turns. A new harness cannot resume the old one's session, so its history is replayed. */
  configureChat(id: string, input: { harness: string; profile: string; model_id: string | null }): ChatRow {
    const chat = this.chat(id);
    if (this.turns.has(id) || chat.status === "running") {
      throw new HttpError(409, "a reply is running; change harness, profile or model between turns");
    }
    this.checkSelection(input.harness, input.profile, input.model_id);
    const sameHarness = chat.harness === input.harness;
    const row = this.store.updateChat(id, sameHarness ? input : { ...input, session_id: null }) as ChatRow;
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
    return row;
  }

  /** Why the chat will not run where the user expects, or null: its project's directory is gone. */
  warningFor(chat: ChatRow): string | null {
    const project = chat.project_id === null ? null : this.store.getProject(chat.project_id);
    if (project?.path && !(existsSync(project.path) && statSync(project.path).isDirectory())) {
      return `Project directory ${project.path} no longer exists: the agent runs in a scratch folder instead.`;
    }
    return null;
  }

  // ---- messages ----

  withAttachments(rows: MessageRow[]): Array<MessageRow & { attachments: AttachmentRow[] }> {
    const map = this.store.attachmentsOf(rows.map((r) => r.id));
    return rows.map((r) => ({ ...r, attachments: map.get(r.id) ?? [] }));
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
    turn.promise = this.runTurn(this.chat(chatId), turn, content, paths);
    return { user_message_id: userMsg.id, assistant_message_id: assistant.id };
  }

  /** Resolves when the chat's running reply (if any) has been finalized. Used by tests and shutdown. */
  async settled(chatId: string): Promise<void> {
    await this.turns.get(chatId)?.promise;
  }

  async stop(chatId: string): Promise<boolean> {
    this.chat(chatId);
    const turn = this.turns.get(chatId);
    if (turn === undefined) {
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

  private paramsFor(chat: ChatRow): SessionParams {
    const project = chat.project_id === null ? null : this.store.getProject(chat.project_id);
    let cwd = join(this.home, "chats", "workspace");
    if (project?.path && existsSync(project.path) && statSync(project.path).isDirectory()) {
      cwd = project.path;
    }
    mkdirSync(cwd, { recursive: true });
    return { chatId: chat.id, home: this.home, harness: chat.harness, profile: chat.profile, modelId: chat.model_id, cwd, resumeSessionId: chat.session_id, history: () => this.historyFor(chat.id) };
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
    let replayedText = false;
    const flush = (): void => {
      if (replayedText) {
        replayedText = false;
        this.store.setContent(id, content);
      }
    };
    const handle = (ev: AgentEvent, replay: boolean): void => {
      if (ev.type === "text-delta") {
        content += ev.text;
        if (replay) {
          replayedText = true;
        } else {
          this.store.appendContent(id, ev.text);
          this.emit(chat.id, { event: "delta", id: `${id}.${content.length}`, data: { message_id: id, text: ev.text, offset: content.length } });
        }
      } else if (ev.type === "tool") {
        if (!replay) {
          const tool = this.store.addMessage({ chat_id: chat.id, role: "tool", content: ev.summary === "" ? ev.name : `${ev.name}: ${ev.summary}`, status: "done" });
          this.emit(chat.id, { event: "message", id: `${tool.id}.${tool.content.length}`, data: { message: { ...tool, attachments: [] } } });
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
      }
    } catch (err) {
      outcome = { status: "error", error: err instanceof Error ? err.message : String(err) };
    }
    if (turn.detached) {
      return;
    }
    flush();
    if (turn.stopRequested) {
      outcome = { status: "stopped", error: null };
    } else if (outcome === null) {
      outcome = { status: "error", error: "agent ended without a result" };
    }
    if (interrupted) {
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
    this.store.updateChat(chat.id, { status: "idle" });
    this.turns.delete(chat.id);
    this.manager.release(chat.id);
    this.emit(chat.id, { event: "done", id: `${id}.${final.content.length}`, data: { message_id: id, status: final.status, error: final.error, context_truncated: final.context_truncated === 1, warning: final.warning } });
    this.emit(chat.id, { event: "status", data: { chat_id: chat.id, status: "idle" } });
  }

  // ---- live events ----

  private emit(chatId: string, event: ChatEvent): void {
    for (const listener of this.listeners.get(chatId) ?? []) {
      listener(event);
    }
  }

  /** Registers a listener and returns the replay (from the database) for the events it missed, plus the unsubscribe. */
  subscribe(chatId: string, lastEventId: string | null, listener: Listener): { replay: ChatEvent[]; unsubscribe: () => void } {
    const chat = this.chat(chatId);
    const set = this.listeners.get(chatId) ?? new Set<Listener>();
    set.add(listener);
    this.listeners.set(chatId, set);
    return { replay: this.replayFor(chat, lastEventId), unsubscribe: () => set.delete(listener) };
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
          out.push({ event: "message", id: `${row.id}.${row.content.length}`, data: { message: row } });
        }
      }
    }
    out.push({ event: "status", data: { chat_id: chat.id, status: this.store.getChat(chat.id)?.status ?? "idle" } });
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

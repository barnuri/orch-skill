import type { ChatPart } from "../../shared/chat-parts";
import { Database } from "bun:sqlite";
import { mkdirSync } from "node:fs";
import { dirname } from "node:path";

import { newId } from "./ids";
import { MIGRATIONS } from "./migrations";
import type {
  AttachmentRow, ChatRow, MessageRow, MessageStatus, Page, ProjectRow, Role, SearchHit,
} from "./types";

const now = (): string => new Date().toISOString();

function clamp(limit: number | undefined, fallback: number, max: number): number {
  return Math.min(Math.max(Math.trunc(limit ?? fallback), 1), max);
}

/**
 * Chat history in `<home>/chats.db`. Rows are archived, never deleted, except an upload no message owns (dropUnattached). Messages are
 * indexed for search when they are final, not on every streamed delta.
 */
export const INTERRUPTED_NO_PROCESS = "interrupted: the dashboard restarted before this answer was finished and no agent process was left to continue it. The partial answer is kept; send another message to continue.";

export class ChatStore {
  private readonly db: Database;

  constructor(path: string) {
    if (path !== ":memory:") {
      mkdirSync(dirname(path), { recursive: true });
    }
    this.db = new Database(path, { create: true });
    this.db.exec("PRAGMA journal_mode = WAL; PRAGMA foreign_keys = ON; PRAGMA synchronous = NORMAL; PRAGMA busy_timeout = 5000;");
    this.migrate();
  }

  close(): void {
    this.db.close();
  }

  private migrate(): void {
    this.db.exec("CREATE TABLE IF NOT EXISTS schema_migrations (version INTEGER PRIMARY KEY, applied_at TEXT NOT NULL)");
    const done = new Set(this.db.query("SELECT version FROM schema_migrations").all().map((r) => (r as { version: number }).version));
    MIGRATIONS.forEach((sql, index) => {
      const version = index + 1;
      if (done.has(version)) {
        return;
      }
      this.db.transaction(() => {
        this.db.exec(sql);
        this.db.query("INSERT INTO schema_migrations (version, applied_at) VALUES (?, ?)").run(version, now());
      })();
    });
  }

  schemaVersion(): number {
    return (this.db.query("SELECT MAX(version) AS v FROM schema_migrations").get() as { v: number }).v;
  }

  // ---- projects ----

  createProject(input: { name: string; path?: string | null; description?: string }): ProjectRow {
    const row: ProjectRow = {
      id: newId("prj"), name: input.name, path: input.path ?? null, description: input.description ?? "",
      created_at: now(), archived_at: null,
    };
    this.db.query("INSERT INTO projects (id, name, path, description, created_at) VALUES (?, ?, ?, ?, ?)")
      .run(row.id, row.name, row.path, row.description, row.created_at);
    return row;
  }

  getProject(id: string): ProjectRow | null {
    return (this.db.query("SELECT * FROM projects WHERE id = ?").get(id) as ProjectRow | null) ?? null;
  }

  listProjects(opts: { includeArchived?: boolean; limit?: number; cursor?: string | null }): Page<ProjectRow> {
    const limit = clamp(opts.limit, 30, 100);
    const rows = this.db.query(
      `SELECT * FROM projects WHERE (?1 = 1 OR archived_at IS NULL) AND (?2 IS NULL OR id < ?2)
       ORDER BY id DESC LIMIT ?3`,
    ).all(opts.includeArchived ? 1 : 0, opts.cursor ?? null, limit + 1) as ProjectRow[];
    return page(rows, limit, (r) => r.id);
  }

  updateProject(id: string, patch: { name?: string; path?: string | null; description?: string }): ProjectRow | null {
    const cur = this.getProject(id);
    if (cur === null) {
      return null;
    }
    const next = { name: patch.name ?? cur.name, path: patch.path === undefined ? cur.path : patch.path, description: patch.description ?? cur.description };
    this.db.query("UPDATE projects SET name = ?, path = ?, description = ? WHERE id = ?").run(next.name, next.path, next.description, id);
    return this.getProject(id);
  }

  setProjectArchived(id: string, archived: boolean): ProjectRow | null {
    this.db.query("UPDATE projects SET archived_at = ? WHERE id = ?").run(archived ? now() : null, id);
    return this.getProject(id);
  }

  // ---- chats ----

  createChat(input: { project_id?: string | null; title: string; harness: string; profile: string; model_id?: string | null; title_manual?: boolean; cwd?: string | null }): ChatRow {
    const stamp = now();
    const row: ChatRow = {
      id: newId("chat"), project_id: input.project_id ?? null, title: input.title, harness: input.harness,
      profile: input.profile, model_id: input.model_id ?? null, session_id: null, status: "idle",
      created_at: stamp, updated_at: stamp, archived_at: null, title_manual: input.title_manual === true ? 1 : 0, cwd: input.cwd ?? null,
    };
    this.db.query(
      `INSERT INTO chats (id, project_id, title, harness, profile, model_id, session_id, status, created_at, updated_at, title_manual, cwd)
       VALUES (?, ?, ?, ?, ?, ?, NULL, 'idle', ?, ?, ?, ?)`,
    ).run(row.id, row.project_id, row.title, row.harness, row.profile, row.model_id, stamp, stamp, row.title_manual, row.cwd);
    return row;
  }

  getChat(id: string): ChatRow | null {
    return (this.db.query("SELECT * FROM chats WHERE id = ?").get(id) as ChatRow | null) ?? null;
  }

  /** `projectId` "none" lists chats without a project; null lists all. Newest activity first. */
  listChats(opts: { projectId?: string | null; archived?: boolean; limit?: number; cursor?: string | null }): Page<ChatRow> {
    const limit = clamp(opts.limit, 30, 100);
    const [cursorAt, cursorId] = (opts.cursor ?? "").split("~");
    const hasCursor = cursorAt !== undefined && cursorId !== undefined && cursorId !== "";
    const rows = this.db.query(
      `SELECT * FROM chats
       WHERE ((?1 = 1 AND archived_at IS NOT NULL) OR (?1 = 0 AND archived_at IS NULL))
         AND (?2 IS NULL OR (?2 = 'none' AND project_id IS NULL) OR project_id = ?2)
         AND (?3 = 0 OR updated_at < ?4 OR (updated_at = ?4 AND id < ?5))
       ORDER BY updated_at DESC, id DESC LIMIT ?6`,
    ).all(opts.archived ? 1 : 0, opts.projectId ?? null, hasCursor ? 1 : 0, cursorAt ?? "", cursorId ?? "", limit + 1) as ChatRow[];
    return page(rows, limit, (r) => `${r.updated_at}~${r.id}`);
  }

  updateChat(id: string, patch: Partial<Pick<ChatRow, "title" | "project_id" | "harness" | "profile" | "model_id" | "session_id" | "status">>, touch: boolean = true): ChatRow | null {
    const cur = this.getChat(id);
    if (cur === null) {
      return null;
    }
    const next = { ...cur, ...patch, updated_at: touch ? now() : cur.updated_at };
    this.db.query(
      "UPDATE chats SET title = ?, project_id = ?, harness = ?, profile = ?, model_id = ?, session_id = ?, status = ?, updated_at = ? WHERE id = ?",
    ).run(next.title, next.project_id, next.harness, next.profile, next.model_id, next.session_id, next.status, next.updated_at, id);
    return this.getChat(id);
  }

  /** Sets or clears the chat's own folder. It does not touch `updated_at`: moving a folder is not activity. */
  setChatCwd(id: string, cwd: string | null): ChatRow | null {
    this.db.query("UPDATE chats SET cwd = ? WHERE id = ?").run(cwd, id);
    return this.getChat(id);
  }

  /** Remembers that a folder was picked, so the folder list shows recent ones first. */
  touchFolder(path: string): void {
    this.db.query("INSERT INTO folder_use (path, last_used_at) VALUES (?1, ?2) ON CONFLICT(path) DO UPDATE SET last_used_at = ?2").run(path, now());
  }

  folderUse(): Map<string, string> {
    return new Map((this.db.query("SELECT path, last_used_at FROM folder_use").all() as Array<{ path: string; last_used_at: string }>).map((r) => [r.path, r.last_used_at]));
  }

  /** A title a person chose. It is marked manual, so the first-message auto-title never replaces it. */
  renameChat(id: string, title: string): ChatRow | null {
    this.db.query("UPDATE chats SET title = ?, title_manual = 1 WHERE id = ?").run(title, id);
    return this.getChat(id);
  }

  /** The auto-title from the first message, in one statement: it applies only while no person has set a title. */
  autoTitle(id: string, title: string): void {
    this.db.query("UPDATE chats SET title = ? WHERE id = ? AND title_manual = 0").run(title, id);
  }

  setChatArchived(id: string, archived: boolean): ChatRow | null {
    this.db.query("UPDATE chats SET archived_at = ? WHERE id = ?").run(archived ? now() : null, id);
    return this.getChat(id);
  }

  /** No message and no attachment: a "New chat" that was never used. */
  chatIsEmpty(id: string): boolean {
    const row = this.db.query(
      "SELECT (SELECT COUNT(*) FROM messages WHERE chat_id = ?1) + (SELECT COUNT(*) FROM attachments WHERE chat_id = ?1) AS n",
    ).get(id) as { n: number };
    return row.n === 0;
  }

  /** Archives every active empty chat created before `cutoffIso`. Returns how many. */
  archiveEmptyChatsBefore(cutoffIso: string): number {
    const res = this.db.query(
      `UPDATE chats SET archived_at = ?1
       WHERE archived_at IS NULL AND status = 'idle' AND created_at < ?2
         AND NOT EXISTS (SELECT 1 FROM messages WHERE messages.chat_id = chats.id)
         AND NOT EXISTS (SELECT 1 FROM attachments WHERE attachments.chat_id = chats.id)`,
    ).run(now(), cutoffIso);
    return res.changes;
  }

  chatMessageCount(id: string): number {
    return (this.db.query("SELECT COUNT(*) AS n FROM messages WHERE chat_id = ?").get(id) as { n: number }).n;
  }

  // ---- messages ----

  addMessage(input: { chat_id: string; role: Role; content?: string; status: MessageStatus; error?: string | null; model_used?: string | null; parts?: ChatPart[] }): MessageRow {
    const stamp = now();
    const row: MessageRow = {
      id: newId("msg"), chat_id: input.chat_id, role: input.role, content: input.content ?? "", status: input.status,
      error: input.error ?? null, model_used: input.model_used ?? null, input_tokens: 0, output_tokens: 0, cost_usd: null,
      started_at: input.status === "streaming" ? stamp : null, finished_at: input.status === "done" ? stamp : null, created_at: stamp,
      context_truncated: 0, warning: null, parts: input.parts === undefined ? null : JSON.stringify(input.parts),
    };
    this.db.query(
      `INSERT INTO messages (id, chat_id, role, content, status, error, model_used, input_tokens, output_tokens, cost_usd, started_at, finished_at, created_at, parts)
       VALUES (?, ?, ?, ?, ?, ?, ?, 0, 0, NULL, ?, ?, ?, ?)`,
    ).run(row.id, row.chat_id, row.role, row.content, row.status, row.error, row.model_used, row.started_at, row.finished_at, row.created_at, row.parts);
    if (row.status === "done" && row.content !== "") {
      this.index(row);
    }
    return row;
  }

  getMessage(id: string): MessageRow | null {
    return (this.db.query("SELECT * FROM messages WHERE id = ?").get(id) as MessageRow | null) ?? null;
  }

  setParts(id: string, parts: ChatPart[]): MessageRow | null {
    this.db.query("UPDATE messages SET parts = ? WHERE id = ?").run(JSON.stringify(parts), id);
    return this.getMessage(id);
  }

  appendContent(id: string, text: string): void {
    this.db.query("UPDATE messages SET content = content || ? WHERE id = ?").run(text, id);
  }

  finalizeMessage(id: string, fin: { status: "done" | "error" | "stopped"; error?: string | null; model_used?: string | null; input_tokens?: number; output_tokens?: number; cost_usd?: number | null; context_truncated?: boolean; warning?: string | null }): MessageRow | null {
    this.db.query(
      `UPDATE messages SET status = ?, error = ?, model_used = COALESCE(?, model_used), input_tokens = ?, output_tokens = ?,
       cost_usd = ?, finished_at = ?, context_truncated = ?, warning = ? WHERE id = ?`,
    ).run(fin.status, fin.error ?? null, fin.model_used ?? null, fin.input_tokens ?? 0, fin.output_tokens ?? 0, fin.cost_usd ?? null, now(), fin.context_truncated === true ? 1 : 0, fin.warning ?? null, id);
    const row = this.getMessage(id);
    if (row !== null) {
      this.index(row);
    }
    return row;
  }

  private index(row: MessageRow): void {
    this.db.query("DELETE FROM messages_fts WHERE message_id = ?").run(row.id);
    if (row.content !== "") {
      this.db.query("INSERT INTO messages_fts (content, chat_id, message_id) VALUES (?, ?, ?)").run(row.content, row.chat_id, row.id);
    }
  }

  /** Newest first. `cursor` is the id of the oldest message the caller already has. */
  listMessages(chatId: string, opts: { limit?: number; cursor?: string | null }): Page<MessageRow> {
    const limit = clamp(opts.limit, 30, 100);
    const rows = this.db.query("SELECT * FROM messages WHERE chat_id = ?1 AND (?2 IS NULL OR id < ?2) ORDER BY id DESC LIMIT ?3")
      .all(chatId, opts.cursor ?? null, limit + 1) as MessageRow[];
    return page(rows, limit, (r) => r.id);
  }

  /** Oldest first, strictly after `afterId` (or from the start when null). */
  messagesAfter(chatId: string, afterId: string | null): MessageRow[] {
    return this.db.query("SELECT * FROM messages WHERE chat_id = ?1 AND (?2 IS NULL OR id > ?2) ORDER BY id ASC")
      .all(chatId, afterId) as MessageRow[];
  }

  /** Rows a reconnecting client may have missed: newer by id, still running, or a reply that finished at or after `sinceIso`. Oldest first. */
  messagesSince(chatId: string, afterId: string, sinceIso: string): MessageRow[] {
    return this.db.query(
      `SELECT * FROM messages WHERE chat_id = ?1 AND (id > ?2 OR status IN ('streaming','pending') OR (role = 'assistant' AND finished_at >= ?3)) ORDER BY id ASC`,
    ).all(chatId, afterId, sinceIso) as MessageRow[];
  }

  /** Replaces a message's content (boot recovery rebuilds it from the turn file). */
  setContent(id: string, content: string): void {
    this.db.query("UPDATE messages SET content = ? WHERE id = ?").run(content, id);
  }

  /**
   * At startup a streaming message is either still served by a surviving process (`keep`: its turn is re-attached,
   * the row and its chat stay running) or has lost its process: it ends as `error` marked `interrupted:` with the
   * partial text kept. Returns how many rows were marked interrupted.
   */
  recoverStreaming(keep: ReadonlySet<string> = new Set()): number {
    const stamp = now();
    const hit = (this.db.query("SELECT id, chat_id, content FROM messages WHERE status IN ('streaming','pending')").all() as MessageRow[]).filter((r) => !keep.has(r.id));
    for (const row of hit) {
      this.db.query("UPDATE messages SET status = 'error', error = ?, finished_at = ? WHERE id = ?").run(INTERRUPTED_NO_PROCESS, stamp, row.id);
      this.index({ ...row, status: "error" });
    }
    const running = new Set<string>();
    for (const id of keep) {
      const row = this.getMessage(id);
      if (row !== null) {
        running.add(row.chat_id);
      }
    }
    for (const chat of this.db.query("SELECT id FROM chats WHERE status != 'idle'").all() as Array<{ id: string }>) {
      if (!running.has(chat.id)) {
        this.db.query("UPDATE chats SET status = 'idle' WHERE id = ?").run(chat.id);
      }
    }
    return hit.length;
  /** Ids and chats of every reply still marked streaming or pending. */
  streamingRows(): Array<{ id: string; chat_id: string }> {
    return this.db.query("SELECT id, chat_id FROM messages WHERE status IN ('streaming','pending')").all() as Array<{ id: string; chat_id: string }>;
  }

  }

  search(q: string, opts: { projectId?: string | null; limit?: number }): SearchHit[] {
    const match = ftsQuery(q);
    if (match === null) {
      return [];
    }
    const limit = clamp(opts.limit, 30, 100);
    try {
      return this.searchRows(match, opts.projectId ?? null, limit);
    } catch (err) {
      // An FTS5 syntax error from an odd query is "no hits", not a server error.
      if (err instanceof Error && /fts5|syntax|unterminated|malformed|no such column/i.test(err.message)) {
        return [];
      }
      throw err;
    }
  }

  private searchRows(match: string, projectId: string | null, limit: number): SearchHit[] {
    return this.db.query(
      `SELECT m.id AS message_id, m.chat_id, m.role, m.created_at, c.title AS chat_title, c.project_id,
              snippet(messages_fts, 0, '[[', ']]', '…', 14) AS snippet
       FROM messages_fts JOIN messages m ON m.id = messages_fts.message_id JOIN chats c ON c.id = m.chat_id
       WHERE messages_fts MATCH ?1 AND (?2 IS NULL OR c.project_id = ?2)
       ORDER BY rank LIMIT ?3`,
    ).all(match, projectId, limit) as SearchHit[];
  }

  // ---- attachments ----

  addAttachment(input: Omit<AttachmentRow, "id" | "created_at" | "message_id">): AttachmentRow {
    const row: AttachmentRow = { ...input, id: newId("att"), message_id: null, created_at: now() };
    this.db.query("INSERT INTO attachments (id, chat_id, message_id, filename, mime, size, sha256, rel_path, created_at) VALUES (?, ?, NULL, ?, ?, ?, ?, ?, ?)")
      .run(row.id, row.chat_id, row.filename, row.mime, row.size, row.sha256, row.rel_path, row.created_at);
    return row;
  }

  getAttachment(id: string): AttachmentRow | null {
    return (this.db.query("SELECT * FROM attachments WHERE id = ?").get(id) as AttachmentRow | null) ?? null;
  }

  /** Attachments of this chat that no message owns yet. */
  pendingAttachments(chatId: string): AttachmentRow[] {
    return this.db.query("SELECT * FROM attachments WHERE chat_id = ? AND message_id IS NULL ORDER BY id").all(chatId) as AttachmentRow[];
  }

  pendingSize(chatId: string): number {
    return (this.db.query("SELECT COALESCE(SUM(size), 0) AS n FROM attachments WHERE chat_id = ? AND message_id IS NULL").get(chatId) as { n: number }).n;
  }

  /** Removes the row of an attachment no message owns. Returns the row, or null when it is unknown or already attached. */
  dropUnattached(id: string): AttachmentRow | null {
    const row = this.getAttachment(id);
    if (row === null || row.message_id !== null) {
      return null;
    }
    this.db.query("DELETE FROM attachments WHERE id = ? AND message_id IS NULL").run(id);
    return row;
  }

  unattachedBefore(cutoffIso: string): AttachmentRow[] {
    return this.db.query("SELECT * FROM attachments WHERE message_id IS NULL AND created_at < ? ORDER BY id").all(cutoffIso) as AttachmentRow[];
  }

  sha256InUse(sha: string): boolean {
    return (this.db.query("SELECT COUNT(*) AS n FROM attachments WHERE sha256 = ?").get(sha) as { n: number }).n > 0;
  }

  linkAttachments(ids: readonly string[], messageId: string): void {
    for (const id of ids) {
      this.db.query("UPDATE attachments SET message_id = ? WHERE id = ?").run(messageId, id);
    }
  }

  attachmentsOf(messageIds: readonly string[]): Map<string, AttachmentRow[]> {
    const out = new Map<string, AttachmentRow[]>();
    if (messageIds.length === 0) {
      return out;
    }
    const marks = messageIds.map(() => "?").join(",");
    for (const row of this.db.query(`SELECT * FROM attachments WHERE message_id IN (${marks}) ORDER BY id`).all(...messageIds) as AttachmentRow[]) {
      out.set(row.message_id as string, [...(out.get(row.message_id as string) ?? []), row]);
    }
    return out;
  }
}

function page<T>(rows: T[], limit: number, cursorOf: (row: T) => string): Page<T> {
  const more = rows.length > limit;
  const items = more ? rows.slice(0, limit) : rows;
  return { items, next_cursor: more ? cursorOf(items[items.length - 1] as T) : null };
}

/** Every word becomes a quoted FTS term (so user punctuation cannot break the query); the last one is a prefix. */
export function ftsQuery(q: string): string | null {
  // eslint-disable-next-line no-control-regex
  const words = q.replace(/[\u0000-\u001f\u007f]/g, " ").slice(0, 200).split(/\s+/).map((w) => w.replace(/"/g, "")).filter((w) => /[\p{L}\p{N}]/u.test(w));
  if (words.length === 0) {
    return null;
  }
  return words.map((w, i) => (i === words.length - 1 ? `"${w}"*` : `"${w}"`)).join(" ");
}

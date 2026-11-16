import type { Database } from "bun:sqlite";

import { QUEUE_MAX_ITEMS, QUEUE_MAX_TEXT_BYTES } from "../../shared/dto/chat-queue";
import { newId } from "./ids";
import type { ChatStore } from "./store";
import { blobPath, deleteHeldBy } from "./uploads";
import { existsSync } from "node:fs";

export { QUEUE_MAX_ITEMS, QUEUE_MAX_TEXT_BYTES };

export type QueueState = "queued" | "running" | "sent" | "cancelled";

export interface QueueItem {
  id: string;
  chat_id: string;
  text: string;
  attachment_ids: string[];
  /** 1-based among the waiting messages; 0 for the running one. */
  position: number;
  state: QueueState;
  created_at: string;
  edited_at: string | null;
  message_id: string | null;
}

export interface QueueSnapshot {
  chat_id: string;
  items: QueueItem[];
  paused: boolean;
  reason: string | null;
  /** True while the agent's question waits for the person: the queue does not start the next message until it is answered or skipped. */
  waiting_for_answer: boolean;
}

/** An error the API shows as `status` plus the message. */
export class QueueError extends Error {
  constructor(readonly status: number, message: string) {
    super(message);
  }
}

export const ALREADY_STARTED = "Already started: this message was already sent to the agent, so it can no longer be changed.";

interface Raw {
  id: string; chat_id: string; text: string; attachments: string; position: number; state: QueueState;
  created_at: string; edited_at: string | null; message_id: string | null;
}

const now = (): string => new Date().toISOString();

function item(row: Raw): QueueItem {
  let ids: string[] = [];
  try {
    const parsed: unknown = JSON.parse(row.attachments);
    ids = Array.isArray(parsed) ? parsed.filter((x): x is string => typeof x === "string") : [];
  } catch {
    ids = [];
  }
  return { id: row.id, chat_id: row.chat_id, text: row.text, attachment_ids: ids, position: row.state === "queued" ? row.position : 0, state: row.state, created_at: row.created_at, edited_at: row.edited_at, message_id: row.message_id };
}

export interface QueueInput {
  content: string;
  attachment_ids?: string[];
}

/** What the queue needs from the chat service. The service owns the turns; the queue owns the order and the pause. */
export interface QueueHost {
  isRunning(chatId: string): boolean;
  /** Starts a turn now (the service's strict send). Throws when it cannot. */
  start(chatId: string, input: { content: string; attachment_ids: string[] }): { user_message_id: string };
  /** Stops the running turn and waits until it is finalized. False when none was running. */
  stopRunning(chatId: string): Promise<boolean>;
  /** True while a question the agent asked still waits for the person. */
  hasPendingQuestion(chatId: string): boolean;
  /** Throws a QueueError when the chat does not take messages (missing, archived). */
  assertOpen(chatId: string): void;
  emit(chatId: string, snapshot: QueueSnapshot): void;
}

/**
 * The persisted per-chat queue (`chat_queue`, `chat_queue_state`) and the loop that runs it: one running turn per chat,
 * the next queued message starts when a reply ends well, and a failed or stopped reply pauses the queue.
 */
export class ChatQueue {
  private readonly db: Database;
  /** Chats where send-now is cutting the running turn: the item to start next. */
  private readonly sendNowTarget = new Map<string, string>();

  constructor(private readonly store: ChatStore, private readonly host: QueueHost, private readonly home: string) {
    this.db = store.handle;
  }

  // ---- reads ----

  private rows(chatId: string, where: string): Raw[] {
    return this.db.query(`SELECT * FROM chat_queue WHERE chat_id = ? AND ${where} ORDER BY position, id`).all(chatId) as Raw[];
  }

  private row(chatId: string, qid: string): Raw | null {
    return (this.db.query("SELECT * FROM chat_queue WHERE id = ? AND chat_id = ?").get(qid, chatId) as Raw | null) ?? null;
  }

  /** One queue row in any state (the snapshot lists only waiting and running ones). */
  find(chatId: string, qid: string): QueueItem | null {
    const r = this.row(chatId, qid);
    return r === null ? null : item(r);
  }

  queued(chatId: string): QueueItem[] {
    return this.rows(chatId, "state = 'queued'").map(item);
  }

  hasQueued(chatId: string): boolean {
    return (this.db.query("SELECT COUNT(*) AS n FROM chat_queue WHERE chat_id = ? AND state = 'queued'").get(chatId) as { n: number }).n > 0;
  }

  private pauseRow(chatId: string): { paused: boolean; reason: string | null } {
    const r = this.db.query("SELECT paused, reason FROM chat_queue_state WHERE chat_id = ?").get(chatId) as { paused: number; reason: string | null } | null;
    return { paused: r !== null && r.paused === 1, reason: r?.reason ?? null };
  }

  isPaused(chatId: string): boolean {
    return this.pauseRow(chatId).paused;
  }

  snapshot(chatId: string): QueueSnapshot {
    const running = this.rows(chatId, "state = 'running'").map(item);
    const { paused, reason } = this.pauseRow(chatId);
    const items = [...running, ...this.queued(chatId)];
    return { chat_id: chatId, items, paused, reason, waiting_for_answer: items.length > 0 && this.host.hasPendingQuestion(chatId) };
  }

  private publish(chatId: string): void {
    this.host.emit(chatId, this.snapshot(chatId));
  }

  // ---- changes by the person ----

  private checkInput(chatId: string, text: string, ids: readonly string[], allowIn?: string): string[] {
    if (new TextEncoder().encode(text).length > QUEUE_MAX_TEXT_BYTES) {
      throw new QueueError(413, `content: longer than ${QUEUE_MAX_TEXT_BYTES / 1024} KB`);
    }
    const unique = [...new Set(ids)];
    if (text.trim() === "" && unique.length === 0) {
      throw new QueueError(400, "content: message is empty");
    }
    const taken = new Set<string>();
    for (const r of this.rows(chatId, "state = 'queued'")) {
      if (r.id !== allowIn) {
        for (const id of item(r).attachment_ids) {
          taken.add(id);
        }
      }
    }
    for (const id of unique) {
      const att = this.store.getAttachment(id);
      if (att === null || att.chat_id !== chatId) {
        throw new QueueError(400, `attachment_ids: unknown attachment ${id}`);
      }
      if (att.message_id !== null || taken.has(id)) {
        throw new QueueError(400, `attachment_ids: ${id} is already attached to a message`);
      }
      if (!existsSync(blobPath(this.home, att.sha256))) {
        throw new QueueError(400, `attachment_ids: the file of ${att.filename} is missing on the server; upload it again`);
      }
    }
    return unique;
  }

  enqueue(chatId: string, input: QueueInput): QueueItem {
    this.host.assertOpen(chatId);
    const ids = this.checkInput(chatId, input.content, input.attachment_ids ?? []);
    const count = (this.db.query("SELECT COUNT(*) AS n FROM chat_queue WHERE chat_id = ? AND state = 'queued'").get(chatId) as { n: number }).n;
    if (count >= QUEUE_MAX_ITEMS) {
      throw new QueueError(409, `The queue is full: at most ${QUEUE_MAX_ITEMS} messages can wait in one chat.`);
    }
    const id = newId("que");
    this.db.query("INSERT INTO chat_queue (id, chat_id, text, attachments, position, state, created_at) VALUES (?, ?, ?, ?, ?, 'queued', ?)")
      .run(id, chatId, input.content, JSON.stringify(ids), count + 1, now());
    this.store.holdForQueue(id, ids);
    this.publish(chatId);
    return item(this.row(chatId, id) as Raw);
  }

  private stateError(row: Raw | null): QueueError {
    if (row === null) {
      return new QueueError(404, "no such queued message");
    }
    return row.state === "cancelled" ? new QueueError(409, "This message was cancelled.") : new QueueError(409, ALREADY_STARTED);
  }

  /** Changes a message that is still queued. The row is updated only while its state is `queued`, so a start in between wins (409). */
  edit(chatId: string, qid: string, patch: { content?: string; attachment_ids?: string[] }): QueueItem {
    const cur = this.row(chatId, qid);
    if (cur === null || cur.state !== "queued") {
      throw this.stateError(cur);
    }
    const before = item(cur);
    const text = patch.content ?? before.text;
    const ids = this.checkInput(chatId, text, patch.attachment_ids ?? before.attachment_ids, qid);
    const res = this.db.query("UPDATE chat_queue SET text = ?, attachments = ?, edited_at = ? WHERE id = ? AND chat_id = ? AND state = 'queued'")
      .run(text, JSON.stringify(ids), now(), qid, chatId);
    if (res.changes === 0) {
      throw this.stateError(this.row(chatId, qid));
    }
    this.store.holdForQueue(qid, ids);
    this.publish(chatId);
    return item(this.row(chatId, qid) as Raw);
  }

  cancel(chatId: string, qid: string): QueueItem {
    const res = this.db.query("UPDATE chat_queue SET state = 'cancelled' WHERE id = ? AND chat_id = ? AND state = 'queued'").run(qid, chatId);
    if (res.changes === 0) {
      throw this.stateError(this.row(chatId, qid));
    }
    deleteHeldBy(this.store, this.home, qid);
    this.renumber(chatId);
    if (!this.hasQueued(chatId)) {
      this.setPause(chatId, false, null);
    }
    this.publish(chatId);
    return item(this.row(chatId, qid) as Raw);
  }

  /** `ids` first, in that order; queued messages left out keep their order after them. Every id must still be queued. */
  reorder(chatId: string, ids: readonly string[]): QueueSnapshot {
    const current = this.rows(chatId, "state = 'queued'");
    const known = new Set(current.map((r) => r.id));
    for (const id of ids) {
      if (!known.has(id)) {
        const row = this.row(chatId, id);
        throw row === null ? new QueueError(404, `no such queued message ${id}`) : this.stateError(row);
      }
    }
    const first = [...new Set(ids)];
    const order = [...first, ...current.map((r) => r.id).filter((id) => !first.includes(id))];
    this.db.transaction(() => {
      order.forEach((id, index) => {
        this.db.query("UPDATE chat_queue SET position = ? WHERE id = ? AND state = 'queued'").run(index + 1, id);
      });
    })();
    this.publish(chatId);
    return this.snapshot(chatId);
  }

  private renumber(chatId: string): void {
    this.rows(chatId, "state = 'queued'").forEach((r, index) => {
      this.db.query("UPDATE chat_queue SET position = ? WHERE id = ?").run(index + 1, r.id);
    });
  }

  private setPause(chatId: string, paused: boolean, reason: string | null): void {
    this.db.query("INSERT INTO chat_queue_state (chat_id, paused, reason) VALUES (?, ?, ?) ON CONFLICT(chat_id) DO UPDATE SET paused = excluded.paused, reason = excluded.reason")
      .run(chatId, paused ? 1 : 0, paused ? reason : null);
  }

  pause(chatId: string, reason: string): void {
    if (this.hasQueued(chatId)) {
      this.setPause(chatId, true, reason);
      this.publish(chatId);
    }
  }

  /** Lets the queue run on by itself again and starts the next message when no turn is running. */
  resume(chatId: string): QueueSnapshot {
    this.setPause(chatId, false, null);
    this.advance(chatId);
    this.publish(chatId);
    return this.snapshot(chatId);
  }

  /**
   * Starts this queued message next. A running turn is stopped first (its partial reply is kept); the queue then
   * goes on from this message even when it was paused.
   */
  async sendNow(chatId: string, qid: string): Promise<{ interrupted: boolean }> {
    const cur = this.row(chatId, qid);
    if (cur === null || cur.state !== "queued") {
      throw this.stateError(cur);
    }
    this.reorder(chatId, [qid]);
    this.setPause(chatId, false, null);
    if (!this.host.isRunning(chatId)) {
      this.advance(chatId, true);
      this.publish(chatId);
      return { interrupted: false };
    }
    this.sendNowTarget.set(chatId, qid);
    const stopped = await this.host.stopRunning(chatId);
    // The turn ended on its own before the stop reached it, or its end hook ran without seeing the marker: start it here.
    if (this.sendNowTarget.get(chatId) === qid) {
      this.sendNowTarget.delete(chatId);
      this.setPause(chatId, false, null);
      this.advance(chatId, true);
      this.publish(chatId);
    }
    return { interrupted: stopped };
  }

  // ---- the loop ----

  /**
   * Starts the first queued message when nothing runs and the queue is not paused. While a question of the agent
   * waits for the person it starts nothing (starting a message would dismiss the question); `force` is the person's
   * own "send now".
   */
  advance(chatId: string, force: boolean = false): void {
    if (this.host.isRunning(chatId) || this.isPaused(chatId)) {
      return;
    }
    const next = this.rows(chatId, "state = 'queued'")[0];
    if (next === undefined) {
      return;
    }
    if (!force && this.host.hasPendingQuestion(chatId)) {
      this.publish(chatId);
      return;
    }
    const claimed = this.db.query("UPDATE chat_queue SET state = 'running', position = 0 WHERE id = ? AND state = 'queued'").run(next.id);
    if (claimed.changes === 0) {
      return;
    }
    this.renumber(chatId);
    try {
      const started = this.host.start(chatId, { content: next.text, attachment_ids: item(next).attachment_ids });
      this.db.query("UPDATE chat_queue SET message_id = ? WHERE id = ?").run(started.user_message_id, next.id);
    } catch (err) {
      // It never started: give the message its place back and wait for a person.
      this.db.query("UPDATE chat_queue SET state = 'queued', position = 0 WHERE id = ?").run(next.id);
      this.reorder(chatId, [next.id]);
      this.setPause(chatId, true, `The next message could not start: ${err instanceof Error ? err.message : String(err)}`);
    }
    this.publish(chatId);
  }

  /** Called by the service after a turn is finalized and no longer counted as running. */
  turnEnded(chatId: string, status: "done" | "error" | "stopped"): void {
    const finished = this.db.query("UPDATE chat_queue SET state = 'sent' WHERE chat_id = ? AND state = 'running'").run(chatId).changes > 0;
    const target = this.sendNowTarget.get(chatId);
    if (target !== undefined) {
      this.sendNowTarget.delete(chatId);
      this.setPause(chatId, false, null);
      this.advance(chatId, true);
      this.publish(chatId);
      return;
    }
    if (!this.hasQueued(chatId)) {
      const wasPaused = this.isPaused(chatId);
      this.setPause(chatId, false, null);
      if (finished || wasPaused) {
        this.publish(chatId);
      }
      return;
    }
    if (status === "done" && !this.isPaused(chatId)) {
      this.advance(chatId);
      return;
    }
    this.pause(chatId, status === "stopped" ? "The reply was stopped." : status === "error" ? "The reply failed." : this.pauseRow(chatId).reason ?? "Paused.");
    this.publish(chatId);
  }

  /** Server start: a message that was running is over (its turn was adopted or marked interrupted); waiting ones show paused. */
  recover(hasTurn: (chatId: string) => boolean): void {
    const chats = this.db.query("SELECT DISTINCT chat_id FROM chat_queue WHERE state IN ('queued','running')").all() as Array<{ chat_id: string }>;
    for (const { chat_id } of chats) {
      if (hasTurn(chat_id)) {
        continue;
      }
      this.db.query("UPDATE chat_queue SET state = 'sent' WHERE chat_id = ? AND state = 'running'").run(chat_id);
      if (this.hasQueued(chat_id)) {
        this.setPause(chat_id, true, "The dashboard restarted. Resume to send the waiting messages.");
      } else {
        this.setPause(chat_id, false, null);
      }
    }
  }
}

import { IDLE_SESSION_MS } from "../limits";
import type { AgentSession, SessionFactory, SessionParams } from "./types";

interface Entry { cwd: string; session: AgentSession; timer: ReturnType<typeof setTimeout> | null; busy: boolean }

/** One live session per active chat. A session idle for `idleMs` is disposed; the stored session id resumes it later. */
export class SessionManager {
  private readonly entries = new Map<string, Entry>();

  constructor(private readonly factory: SessionFactory, private readonly idleMs: number = IDLE_SESSION_MS) {}

  acquire(params: SessionParams): AgentSession {
    let entry = this.entries.get(params.chatId);
    if (entry !== undefined && !entry.busy && entry.cwd !== params.cwd) {
      // The chat moved to another folder: a session keeps the folder it started in, so the next turn gets a new one.
      this.entries.delete(params.chatId);
      this.clearTimer(entry);
      void entry.session.dispose();
      entry = undefined;
    }
    if (entry === undefined) {
      entry = { cwd: params.cwd, session: this.factory(params), timer: null, busy: false };
      this.entries.set(params.chatId, entry);
    }
    entry.busy = true;
    this.clearTimer(entry);
    return entry.session;
  }

  release(chatId: string): void {
    const entry = this.entries.get(chatId);
    if (entry === undefined) {
      return;
    }
    entry.busy = false;
    this.clearTimer(entry);
    entry.timer = setTimeout(() => void this.drop(chatId), this.idleMs);
    entry.timer.unref();
  }

  has(chatId: string): boolean {
    return this.entries.has(chatId);
  }

  size(): number {
    return this.entries.size;
  }

  /** Forget a session whose chat changed harness, profile or model. */
  async drop(chatId: string): Promise<void> {
    const entry = this.entries.get(chatId);
    if (entry === undefined || entry.busy) {
      return;
    }
    this.entries.delete(chatId);
    this.clearTimer(entry);
    await entry.session.dispose();
  }

  async disposeAll(): Promise<void> {
    const all = [...this.entries.values()];
    this.entries.clear();
    await Promise.all(all.map((entry) => {
      this.clearTimer(entry);
      return entry.session.dispose();
    }));
  }

  private clearTimer(entry: Entry): void {
    if (entry.timer !== null) {
      clearTimeout(entry.timer);
      entry.timer = null;
    }
  }
}

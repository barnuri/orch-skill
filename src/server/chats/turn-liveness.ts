import { type ActivityState, type ChatActivity, DEAD_MS, EXITED_MESSAGE, silentMessage, STALL_MS } from "../../shared/chat-activity";
import type { AgentEvent } from "./sessions/types";

const EXIT_GRACE_MS = 5_000;

export interface LivenessOptions { now?: () => number; stallMs?: number; deadMs?: number }

interface Beat {
  messageId: string;
  state: ActivityState;
  since: number;
  lastEvent: number;
  lastOutput: number | null;
  tool: { id: string; name: string; started: number } | null;
  /** Set while a question waits for the person: nothing is wrong with a silent agent then. */
  waiting: boolean;
}

export type Verdict =
  | { kind: "ok" }
  | { kind: "stalled"; idle_ms: number }
  | { kind: "dead"; idle_ms: number; message: string };

/** One heartbeat per running turn: when the agent last spoke, what it is doing, and whether it should be called stalled or dead. */
export class TurnLiveness {
  private readonly beats = new Map<string, Beat>();
  private readonly now: () => number;
  readonly stallMs: number;
  readonly deadMs: number;

  constructor(opts: LivenessOptions = {}) {
    this.now = opts.now ?? Date.now;
    this.stallMs = opts.stallMs ?? STALL_MS;
    this.deadMs = opts.deadMs ?? DEAD_MS;
  }

  begin(chatId: string, messageId: string): void {
    const t = this.now();
    this.beats.set(chatId, { messageId, state: "starting", since: t, lastEvent: t, lastOutput: null, tool: null, waiting: false });
  }

  end(chatId: string): void {
    this.beats.delete(chatId);
  }

  has(chatId: string): boolean {
    return this.beats.has(chatId);
  }

  private move(beat: Beat, state: ActivityState, t: number): void {
    if (beat.state !== state) {
      beat.state = state;
      beat.since = t;
    }
  }

  /** Records one event. Returns true when what the page shows (state or tool) changed. */
  note(chatId: string, ev: AgentEvent): boolean {
    const beat = this.beats.get(chatId);
    if (beat === undefined) {
      return false;
    }
    const t = this.now();
    const before = `${beat.state}|${beat.tool?.id ?? ""}`;
    beat.lastEvent = t;
    if (ev.type === "text-delta") {
      beat.lastOutput = t;
      this.move(beat, "writing", t);
    } else if (ev.type === "reasoning-delta") {
      beat.lastOutput = t;
      this.move(beat, "thinking", t);
    } else if (ev.type === "tool") {
      beat.lastOutput = t;
      beat.tool = { id: ev.id ?? "", name: ev.name, started: t };
      beat.state = "tool";
      beat.since = t;
    } else if (ev.type === "tool-result" && beat.tool !== null && (beat.tool.id === ev.id || ev.id === "")) {
      beat.tool = null;
      this.move(beat, "thinking", t);
    }
    return before !== `${beat.state}|${beat.tool?.id ?? ""}`;
  }

  /** A question is open (true) or answered (false). */
  setWaiting(chatId: string, waiting: boolean): void {
    const beat = this.beats.get(chatId);
    if (beat !== undefined) {
      const t = this.now();
      beat.waiting = waiting;
      beat.lastEvent = t;
      if (waiting) {
        this.move(beat, "waiting", t);
      } else if (beat.state === "waiting") {
        this.move(beat, "thinking", t);
      }
    }
  }

  snapshot(chatId: string): ChatActivity | null {
    const beat = this.beats.get(chatId);
    if (beat === undefined) {
      return null;
    }
    const t = this.now();
    return {
      state: beat.state, since: new Date(beat.since).toISOString(), last_event_at: new Date(beat.lastEvent).toISOString(),
      state_ms: t - beat.since, idle_ms: t - beat.lastEvent,
      tool: beat.tool === null ? null : { id: beat.tool.id, name: beat.tool.name, started_at: new Date(beat.tool.started).toISOString() },
    };
  }

  /** `alive` is the child process check: true or false when the pid is known, null when no process is watched. */
  verdict(chatId: string, alive: boolean | null): Verdict {
    const beat = this.beats.get(chatId);
    if (beat === undefined || beat.waiting) {
      return { kind: "ok" };
    }
    const idle = this.now() - beat.lastEvent;
    // A short grace: a process that just exited may still have its last lines and exit file to deliver.
    if (alive === false && idle >= EXIT_GRACE_MS) {
      return { kind: "dead", idle_ms: idle, message: EXITED_MESSAGE };
    }
    if (idle >= this.deadMs) {
      return { kind: "dead", idle_ms: idle, message: silentMessage(idle) };
    }
    return idle >= this.stallMs ? { kind: "stalled", idle_ms: idle } : { kind: "ok" };
  }
}

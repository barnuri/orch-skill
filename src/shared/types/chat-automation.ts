import type { AutomationMode, MonitorSpec } from "../chat-automation";

export type ItemStatus = "running" | "done" | "failed" | "stopped" | "lost";

export interface ChatLoop {
  id: string;
  label: string;
  prompt: string;
  mode: AutomationMode;
  status: ItemStatus;
  reason: string | null;
  iteration: number;
  max: number;
  interval: number;
  /** Epoch seconds of the next iteration, 0 when none. */
  next_tick: number;
  until: { command: string; regex: string; text: string };
  last_exit: number | null;
  started: string;
  ended: string | null;
}

export interface MonitorThen { mode: "tell" | "act"; prompt?: string }

export interface ChatMonitor {
  id: string;
  name: string;
  spec: MonitorSpec;
  /** Seconds between checks; 0 streams the command's output. */
  interval: number;
  status: ItemStatus;
  reason: string | null;
  events: number;
  last_event: string | null;
  once: boolean;
  debounce: number;
  then: MonitorThen;
  /** Epoch seconds. */
  expires_at: number;
  started: string;
}

export interface LogEntry { at: string; status: string; text: string; message_id?: string | null }

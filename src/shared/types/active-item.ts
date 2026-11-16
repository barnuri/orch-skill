export type ActiveKind = "loop" | "watch";
export type ActiveStatus = "running" | "failed" | "lost";

/** One running (or needs-attention) loop or watch, as `dispatch.ts active --json` reports it. */
export interface ActiveItem {
  kind: ActiveKind;
  id: string;
  name: string;
  status: ActiveStatus;
  reason: string | null;
  started: string;
  /** Seconds between ticks for a loop, or between reruns for a scheduled watch (0 = streaming). */
  interval: number;
  /** Epoch seconds when the loop or watch stops by itself. */
  deadline: number;
  // Loop-only.
  iteration?: number;
  max?: number;
  /** Epoch seconds of the next tick. */
  next?: number;
  last_exit?: number | null;
  session?: string;
  /** Ticks skipped because the target session was busy (only with --when-idle). */
  skipped?: number;
  when_idle?: boolean;
  // Watch-only.
  events?: number;
  last_event?: string | null;
  cmd?: string;
}

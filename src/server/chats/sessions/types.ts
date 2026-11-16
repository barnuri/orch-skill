export type AgentEvent =
  | { type: "text-delta"; text: string }
  | { type: "tool"; name: string; summary: string; id?: string; input?: unknown }
  | { type: "tool-result"; id: string; output: string; error: boolean }
  | { type: "reasoning-delta"; text: string }
  | { type: "usage"; input_tokens: number; output_tokens: number; cost_usd: number | null; model: string | null }
  | { type: "warning"; message: string }
  | { type: "context-truncated" }
  | { type: "done"; session_id: string | null }
  | { type: "error"; message: string }
  /** The agent process ended without a result and without being stopped (restart, kill): keep the partial text. */
  | { type: "interrupted"; message: string };

/** What a session needs to make its turn adoptable after a restart. */
export interface TurnInfo { messageId: string }

/**
 * One conversation with an agent. `send` runs one turn and yields its events; it always ends with
 * `done` or `error`, except after `stop()`, when it just ends.
 */
export interface AgentSession {
  /** True when one live process serves every turn; false when each turn starts a process and resumes. */
  readonly persistent: boolean;
  /** The harness-side session id once known; null before the first turn. */
  readonly sessionId: string | null;
  /** Process group of the running turn, when the session has one the watchdog can probe. */
  readonly processId?: number | null;
  start(): Promise<void>;
  send(prompt: string, attachments: readonly string[], turn?: TurnInfo): AsyncIterable<AgentEvent>;
  /** Kills the running turn. A later `send` starts again from the stored session. */
  stop(): Promise<void>;
  /** Stops following a running turn but leaves its process alone: the server restarts without cutting an answer. */
  dispose(): Promise<void>;
}

export interface SessionParams {
  chatId: string;
  home: string;
  harness: string;
  profile: string;
  modelId: string | null;
  cwd: string;
  /** The chat's stored session id, when it has had a turn before. */
  resumeSessionId: string | null;
  /** Earlier finished turns (oldest first, current message excluded), for harnesses that have to replay them. */
  history?: () => ReplayMessage[];
  /** Character budget for a replayed history. Defaults to REPLAY_CHAR_BUDGET. */
  replayBudget?: number;
}

export interface ReplayMessage { role: "user" | "assistant"; content: string }

export type SessionFactory = (params: SessionParams) => AgentSession;

export function withAttachments(prompt: string, attachments: readonly string[]): string {
  if (attachments.length === 0) {
    return prompt;
  }
  return `${prompt}\n\nAttached files (read them from these absolute paths):\n${attachments.map((p) => `- ${p}`).join("\n")}`;
}

/** Extensions a file-attaching harness (opencode `-f`) turns into parts every model takes: image input or plain text. */
const NATIVE_EXT: ReadonlySet<string> = new Set([
  "png", "jpg", "jpeg", "gif", "webp",
  "txt", "md", "json", "csv", "log", "yaml", "yml", "xml", "html", "htm", "js", "ts", "tsx", "jsx", "py", "sh", "toml", "ini", "sql", "css",
]);

/**
 * True for files a file-attaching harness (opencode `-f`) turns into parts every model takes: image input or text.
 * Other files (a PDF, an archive) go as a path the agent opens with its tools: as a part, a model without PDF input
 * gets a "not supported" notice instead and gives up.
 */
export function attachesNatively(path: string): boolean {
  const name = path.split("/").pop() ?? "";
  return NATIVE_EXT.has(name.includes(".") ? (name.split(".").pop() as string).toLowerCase() : "");
}

/** Async queue: one producer pushes, one consumer awaits. */
export class Channel<T> {
  private readonly items: T[] = [];
  private waiter: ((v: void) => void) | null = null;
  private closed = false;

  push(item: T): void {
    this.items.push(item);
    this.wake();
  }

  close(): void {
    this.closed = true;
    this.wake();
  }

  private wake(): void {
    const w = this.waiter;
    this.waiter = null;
    w?.();
  }

  /** The next item, or null once the channel is closed and drained. */
  async next(): Promise<T | null> {
    while (this.items.length === 0) {
      if (this.closed) {
        return null;
      }
      await new Promise<void>((resolve) => {
        this.waiter = resolve;
      });
    }
    return this.items.shift() as T;
  }
}

export async function drainText(stream: ReadableStream<Uint8Array> | null, onChunk: (text: string) => void): Promise<void> {
  if (stream === null) {
    return;
  }
  const decoder = new TextDecoder();
  const reader = stream.getReader();
  for (;;) {
    const { done, value } = await reader.read();
    if (done) {
      break;
    }
    onChunk(decoder.decode(value, { stream: true }));
  }
}

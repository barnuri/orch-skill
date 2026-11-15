export interface SseEvent {
  event: string;
  data: string;
  id: string | null;
}

/** Incremental text/event-stream parser: feed it decoded chunks, it returns the complete events. */
export class SseParser {
  private buffer = "";
  private event = "";
  private data: string[] = [];
  private id: string | null = null;
  /** Last `id:` seen, which a reconnect sends as Last-Event-ID. */
  lastId: string | null = null;

  feed(chunk: string): SseEvent[] {
    this.buffer += chunk;
    const out: SseEvent[] = [];
    let cut: number;
    while ((cut = this.nextLineEnd()) >= 0) {
      const raw = this.buffer.slice(0, cut);
      const crlf = this.buffer.startsWith("\r\n", cut);
      this.buffer = this.buffer.slice(cut + (crlf ? 2 : 1));
      this.line(raw, out);
    }
    return out;
  }

  private nextLineEnd(): number {
    const lf = this.buffer.indexOf("\n");
    const cr = this.buffer.indexOf("\r");
    if (cr >= 0 && cr === this.buffer.length - 1) {
      return -1;
    }
    return cr >= 0 && (lf < 0 || cr < lf) ? cr : lf;
  }

  private line(raw: string, out: SseEvent[]): void {
    if (raw === "") {
      if (this.data.length > 0 || this.event !== "") {
        out.push({ event: this.event === "" ? "message" : this.event, data: this.data.join("\n"), id: this.id });
      }
      this.event = "";
      this.data = [];
      this.id = null;
      return;
    }
    if (raw.startsWith(":")) {
      return;
    }
    const colon = raw.indexOf(":");
    const field = colon < 0 ? raw : raw.slice(0, colon);
    let value = colon < 0 ? "" : raw.slice(colon + 1);
    if (value.startsWith(" ")) {
      value = value.slice(1);
    }
    if (field === "event") {
      this.event = value;
    } else if (field === "data") {
      this.data.push(value);
    } else if (field === "id") {
      this.id = value;
      this.lastId = value;
    }
  }
}

export type ConnState = "connecting" | "open" | "reconnecting";

export interface SseOptions {
  url: string;
  headers: () => Record<string, string>;
  /** Value for Last-Event-ID on the next (re)connect, or null for none. */
  resumeId: () => string | null;
  onEvents: (events: SseEvent[]) => void;
  onState?: (state: ConnState) => void;
  signal: AbortSignal;
  fetchImpl?: typeof fetch;
  sleep?: (ms: number) => Promise<void>;
  minDelayMs?: number;
  maxDelayMs?: number;
}

const DEFAULT_MIN = 1000;
const DEFAULT_MAX = 10_000;

function abortableSleep(ms: number, signal: AbortSignal): Promise<void> {
  return new Promise((resolve) => {
    const timer = setTimeout(resolve, ms);
    signal.addEventListener("abort", () => {
      clearTimeout(timer);
      resolve();
    }, { once: true });
  });
}

/**
 * Follows an event stream with fetch, so the Authorization header can be sent (EventSource cannot).
 * Reconnects with backoff after an error or a clean close, each time asking for Last-Event-ID.
 * Resolves when the signal aborts.
 */
export async function followSse(opts: SseOptions): Promise<void> {
  const doFetch = opts.fetchImpl ?? fetch;
  const sleep = opts.sleep ?? ((ms: number) => abortableSleep(ms, opts.signal));
  const min = opts.minDelayMs ?? DEFAULT_MIN;
  const max = opts.maxDelayMs ?? DEFAULT_MAX;
  let delay = min;
  let first = true;
  while (!opts.signal.aborted) {
    opts.onState?.(first ? "connecting" : "reconnecting");
    first = false;
    try {
      const headers: Record<string, string> = { ...opts.headers(), Accept: "text/event-stream" };
      const resume = opts.resumeId();
      if (resume !== null) {
        headers["Last-Event-ID"] = resume;
      }
      const res = await doFetch(opts.url, { headers, signal: opts.signal, cache: "no-store" });
      if (!res.ok || res.body === null) {
        throw new Error(`HTTP ${res.status}`);
      }
      opts.onState?.("open");
      delay = min;
      const parser = new SseParser();
      const reader = res.body.getReader();
      const decoder = new TextDecoder();
      for (;;) {
        const { done, value } = await reader.read();
        if (done) {
          break;
        }
        const events = parser.feed(decoder.decode(value, { stream: true }));
        if (events.length > 0) {
          opts.onEvents(events);
        }
      }
    } catch (err) {
      if (opts.signal.aborted) {
        return;
      }
      if (!(err instanceof Error)) {
        throw err;
      }
    }
    if (opts.signal.aborted) {
      return;
    }
    await sleep(delay);
    delay = Math.min(max, delay * 2);
  }
}

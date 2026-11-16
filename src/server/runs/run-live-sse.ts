import { COMMON_HEADERS } from "../http/responses";
import { subscribeNodeChanges, type NodeChange } from "./auto-dispatch";

const HEARTBEAT_MS = 15_000;

/**
 * Server-Sent Events for one run: an `node` event each time a node of the run turns done or error
 * (from the run engine in auto-dispatch.ts). The page refetches the run on each event. No replay:
 * a reconnecting client refetches the run anyway.
 */
export function runLiveStream(runId: string, signal: AbortSignal): Response {
  const encoder = new TextEncoder();
  let cleanup = (): void => {};
  const stream = new ReadableStream<Uint8Array>({
    start(controller) {
      const write = (text: string): void => {
        try {
          controller.enqueue(encoder.encode(text));
        } catch {
          cleanup();
        }
      };
      const unsubscribe = subscribeNodeChanges((c: NodeChange) => {
        if (c.run === runId) {
          write(`event: node\ndata: ${JSON.stringify(c)}\n\n`);
        }
      });
      const timer = setInterval(() => write(": ping\n\n"), HEARTBEAT_MS);
      cleanup = (): void => {
        clearInterval(timer);
        unsubscribe();
        try {
          controller.close();
        } catch {
          // already closed
        }
      };
      signal.addEventListener("abort", cleanup, { once: true });
      write("retry: 3000\n\n");
    },
    cancel() {
      cleanup();
    },
  });
  return new Response(stream, {
    headers: { ...COMMON_HEADERS, "Content-Type": "text/event-stream; charset=utf-8", "Cache-Control": "no-store, no-transform", "X-Accel-Buffering": "no" },
  });
}

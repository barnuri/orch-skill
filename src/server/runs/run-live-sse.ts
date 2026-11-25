import { COMMON_HEADERS } from "../http/responses";
import { diffRun } from "../../shared/run-patch";
import { subscribeNodeChanges, type NodeChange } from "./auto-dispatch";

const HEARTBEAT_MS = 15_000;
/** How often a connection compares the run with what it last sent. */
export const PATCH_CHECK_MS = 2000;

/**
 * Server-Sent Events for one run: an `node` event each time a node of the run turns done or error
 * (from the run engine in auto-dispatch.ts). The page refetches the run on each event. No replay:
 * a reconnecting client refetches the run anyway.
 */
export function runLiveStream(runId: string, signal: AbortSignal, document?: () => Record<string, unknown> | null, checkMs = PATCH_CHECK_MS): Response {
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
      // The first read is the baseline the client's own fetch is compared against: no event is sent for it.
      let last = document?.() ?? null;
      const differ = document === undefined ? null : setInterval(() => {
        const next = document();
        if (next === null) {
          return;
        }
        const patch = last === null ? null : diffRun(runId, last, next);
        last = next;
        if (patch !== null) {
          write(`event: patch\ndata: ${JSON.stringify(patch)}\n\n`);
        }
      }, checkMs);
      cleanup = (): void => {
        clearInterval(timer);
        if (differ !== null) {
          clearInterval(differ);
        }
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

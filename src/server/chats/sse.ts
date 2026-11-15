import { COMMON_HEADERS } from "../http/responses";
import type { ChatEvent, ChatService } from "./service";

const HEARTBEAT_MS = 15_000;

function frame(ev: ChatEvent): string {
  return `${ev.id === undefined ? "" : `id: ${ev.id}\n`}event: ${ev.event}\ndata: ${JSON.stringify(ev.data)}\n\n`;
}

/**
 * Server-Sent Events for one chat. A reconnect's `Last-Event-ID` is answered from the database
 * before live events continue, so nothing the client missed is lost. A comment line every 15 s keeps
 * proxies and the server's idle timeout from closing a quiet stream.
 */
export function eventStream(service: ChatService, chatId: string, lastEventId: string | null, signal: AbortSignal): Response {
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
      const { replay, unsubscribe } = service.subscribe(chatId, lastEventId, (ev) => write(frame(ev)));
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
      for (const ev of replay) {
        write(frame(ev));
      }
    },
    cancel() {
      cleanup();
    },
  });
  return new Response(stream, {
    headers: { ...COMMON_HEADERS, "Content-Type": "text/event-stream; charset=utf-8", "Cache-Control": "no-store, no-transform", "X-Accel-Buffering": "no" },
  });
}

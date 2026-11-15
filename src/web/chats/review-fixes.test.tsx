import { afterAll, afterEach, describe, expect, test } from "bun:test";
import { installDom } from "../test/dom";
import type { Message } from "../lib/chat-types";

const uninstall = installDom();
const { render, screen, fireEvent, cleanup, act, renderHook, waitFor } = await import("@testing-library/react");
const { QueryClient, QueryClientProvider } = await import("@tanstack/react-query");
const { ToastProvider } = await import("../components/Toast");
const { chatsApi, attachmentBlobUrl } = await import("../api/chats");
const { useChatThread } = await import("./use-chat-thread");
const { Sidebar } = await import("./Sidebar");
const { useSingleFlight } = await import("../lib/use-single-flight");

const realFetch = globalThis.fetch;
const realApi = { ...chatsApi };
afterEach(() => {
  cleanup();
  globalThis.fetch = realFetch;
  Object.assign(chatsApi, realApi);
});
afterAll(uninstall);

const msg = (id: string, created: string, over: Partial<Message> = {}): Message =>
  ({ id, chat_id: "c1", role: "user", content: id, status: "done", error: null, model_used: null, input_tokens: 0, output_tokens: 0, cost_usd: null, started_at: null, finished_at: created, created_at: created, attachments: [], ...over }) as Message;

const ok = <T,>(body: T) => ({ kind: "ok" as const, body, etag: null });
const flush = async (): Promise<void> => {
  for (let i = 0; i < 20; i += 1) {
    await Promise.resolve();
  }
};

describe("double submits", () => {
  test("useSingleFlight ignores a second call while the first is in flight", async () => {
    let calls = 0;
    let release = (): void => undefined;
    const { result } = renderHook(() =>
      useSingleFlight(async () => {
        calls += 1;
        await new Promise<void>((done) => {
          release = done;
        });
      }),
    );
    let first: Promise<void> = Promise.resolve();
    act(() => {
      first = result.current[0]();
      void result.current[0]();
    });
    expect(calls).toBe(1);
    expect(result.current[1]).toBe(true);
    await act(async () => {
      release();
      await first;
    });
    expect(result.current[1]).toBe(false);
  });

  test("a double click on New chat creates one chat", async () => {
    let created = 0;
    Object.assign(chatsApi, {
      projects: async () => ok({ items: [], next_cursor: null }),
      chats: async () => ok({ items: [], next_cursor: null }),
      createChat: () => {
        created += 1;
        return new Promise(() => undefined);
      },
    });
    render(
      <QueryClientProvider client={new QueryClient()}>
        <ToastProvider>
          <Sidebar activeChatId={null} activeProjectId={null} options={undefined} onNavigate={() => undefined} />
        </ToastProvider>
      </QueryClientProvider>,
    );
    const button = screen.getByRole("button", { name: "New chat" });
    fireEvent.click(button);
    fireEvent.click(button);
    expect(created).toBe(1);
    await waitFor(() => {
      expect((screen.getByRole("button", { name: "New chat" }) as HTMLButtonElement).disabled).toBe(true);
    });
  });
});

describe("chat thread", () => {
  test("an SSE chunk that lands before the re-render keeps the older page just loaded", async () => {
    const newest = msg("msg-3", "2026-01-03T00:00:00Z", { role: "assistant", status: "streaming", content: "", finished_at: null });
    let olderPage = (_: unknown): void => undefined;
    Object.assign(chatsApi, {
      messages: (_id: string, cursor: string | null) =>
        cursor === null
          ? Promise.resolve(ok({ items: [newest], next_cursor: "c" }))
          : new Promise((done) => {
              olderPage = done;
            }),
    });
    let stream: ReadableStreamDefaultController<Uint8Array> | null = null;
    globalThis.fetch = (async () =>
      new Response(
        new ReadableStream<Uint8Array>({
          start(controller) {
            stream = controller;
          },
        }),
        { status: 200 },
      )) as unknown as typeof fetch;
    const { result } = renderHook(() => useChatThread("c1"));
    await waitFor(() => {
      expect(result.current.conn).toBe("open");
    });
    let loading: Promise<void> = Promise.resolve();
    act(() => {
      loading = result.current.loadOlder();
    });
    // No act from here: the older page's state update is queued, React has not rendered yet.
    const realError = console.error;
    console.error = () => undefined;
    try {
      olderPage(ok({ items: [msg("msg-1", "2026-01-01T00:00:00Z"), msg("msg-2", "2026-01-02T00:00:00Z")], next_cursor: null }));
      await loading;
      const line = `event: delta\ndata: ${JSON.stringify({ message_id: "msg-3", text: "hi", offset: 2 })}\n\n`;
      (stream as unknown as ReadableStreamDefaultController<Uint8Array>).enqueue(new TextEncoder().encode(line));
      await flush();
      await act(async () => {
        await flush();
      });
    } finally {
      console.error = realError;
    }
    expect(result.current.messages.map((m) => m.id).sort()).toEqual(["msg-1", "msg-2", "msg-3"]);
    expect(result.current.messages.find((m) => m.id === "msg-3")?.content).toBe("hi");
  });
});

describe("attachment images", () => {
  test("a failed fetch is not cached, so the next request retries", async () => {
    let calls = 0;
    globalThis.fetch = (async () => {
      calls += 1;
      if (calls === 1) {
        throw new TypeError("offline");
      }
      return new Response(new Blob(["x"]), { status: 200 });
    }) as unknown as typeof fetch;
    expect(await attachmentBlobUrl("att-retry")).toBeNull();
    const url = await attachmentBlobUrl("att-retry");
    expect(url).not.toBeNull();
    expect(calls).toBe(2);
  });
});

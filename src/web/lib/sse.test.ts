import { describe, expect, test } from "bun:test";
import { SseParser, followSse } from "./sse";
import type { SseEvent } from "./sse";

describe("SseParser", () => {
  test("parses events split across chunks, with ids, comments and CRLF", () => {
    const p = new SseParser();
    expect(p.feed("retry: 3000\n\n: ping\n\nid: msg-1.0\nevent: mess")).toEqual([]);
    const out = p.feed('age\ndata: {"a":1}\n\nid: msg-1.2\r\nevent: delta\r\ndata: x\r\ndata: y\r\n\r\n');
    expect(out).toEqual([
      { event: "message", data: '{"a":1}', id: "msg-1.0" },
      { event: "delta", data: "x\ny", id: "msg-1.2" },
    ]);
    expect(p.lastId).toBe("msg-1.2");
  });
  test("an event without data or event name is dropped", () => {
    expect(new SseParser().feed("id: 1\n\n")).toEqual([]);
  });
});

function streamOf(text: string, hold = false): Response {
  const body = new ReadableStream<Uint8Array>({
    start(c) {
      c.enqueue(new TextEncoder().encode(text));
      if (!hold) {
        c.close();
      }
    },
  });
  return new Response(body, { status: 200 });
}

describe("followSse", () => {
  test("reconnects after a close, sending the latest resume id, and stops on abort", async () => {
    const seen: (string | null)[] = [];
    const got: SseEvent[] = [];
    const abort = new AbortController();
    let call = 0;
    let resume: string | null = null;
    const fetchImpl = (async (_url: string, init: RequestInit) => {
      seen.push((init.headers as Record<string, string>)["Last-Event-ID"] ?? null);
      call += 1;
      if (call === 1) {
        return streamOf("id: msg-1.3\nevent: delta\ndata: {}\n\n");
      }
      if (call === 2) {
        throw new Error("network down");
      }
      return streamOf("id: msg-1.5\nevent: done\ndata: {}\n\n", true);
    }) as unknown as typeof fetch;
    await new Promise<void>((resolve) => {
      void followSse({
        url: "/x",
        headers: () => ({ Authorization: "Bearer t" }),
        resumeId: () => resume,
        fetchImpl,
        sleep: async () => {},
        signal: abort.signal,
        onEvents: (events) => {
          got.push(...events);
          resume = events[events.length - 1]?.id ?? resume;
          if (events.some((e) => e.event === "done")) {
            abort.abort();
            resolve();
          }
        },
      });
    });
    expect(seen).toEqual([null, "msg-1.3", "msg-1.3"]);
    expect(got.map((e) => e.event)).toEqual(["delta", "done"]);
  });
  test("an HTTP error retries instead of throwing", async () => {
    const abort = new AbortController();
    let call = 0;
    const states: string[] = [];
    const fetchImpl = (async () => {
      call += 1;
      if (call === 1) {
        return new Response("no", { status: 502 });
      }
      abort.abort();
      return streamOf("");
    }) as unknown as typeof fetch;
    await followSse({ url: "/x", headers: () => ({}), resumeId: () => null, fetchImpl, sleep: async () => {}, signal: abort.signal, onEvents: () => {}, onState: (s) => states.push(s) });
    expect(call).toBe(2);
    expect(states[0]).toBe("connecting");
    expect(states).toContain("reconnecting");
  });
});

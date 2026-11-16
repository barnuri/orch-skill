import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { ChatStore } from "./store";
import { hubAdmin, hubSelection, hubWorkerHeaders, hubWorkerId, selectionFrom } from "./hub-selection";

let seen: { url: string; auth: string | null }[] = [];
let mode: "ok" | "array" | "error" = "ok";
const hub = Bun.serve({
  port: 0,
  hostname: "127.0.0.1",
  fetch(req) {
    const url = new URL(req.url);
    seen.push({ url: url.pathname + url.search, auth: req.headers.get("authorization") });
    if (mode === "error") {
      return new Response("nope", { status: 500 });
    }
    const entry = { selected_effort: "high", selected_model: "claude-sonnet-x" };
    return Response.json(mode === "array" ? [{ selected_effort: "low", selected_model: null }, entry] : entry);
  },
});
const base = `http://127.0.0.1:${hub.port}`;

afterAll(() => hub.stop(true));

describe("worker id and header", () => {
  test("the worker id is chat/<chat id>/<message id>", () => {
    expect(hubWorkerId("chat-1", "msg-2")).toBe("chat/chat-1/msg-2");
  });

  test("the header keeps a profile header that is already set", () => {
    expect(hubWorkerHeaders("c", "m", undefined)).toBe("x-llm-hub-smart-auto-worker: chat/c/m");
    expect(hubWorkerHeaders("c", "m", "x-other: 1")).toBe("x-other: 1\nx-llm-hub-smart-auto-worker: chat/c/m");
  });
});

describe("selectionFrom", () => {
  test("reads one object, an array (newest last) and a wrapped list", () => {
    expect(selectionFrom({ selected_effort: "high", selected_model: "m" })).toEqual({ effort: "high", model: "m" });
    expect(selectionFrom([{ selected_effort: "low", selected_model: null }, { selected_effort: null, selected_model: "m2" }])).toEqual({ effort: null, model: "m2" });
    expect(selectionFrom({ entries: [{ selected_effort: "max", selected_model: null }] })).toEqual({ effort: "max", model: null });
  });

  test("answers null when nothing usable is there", () => {
    expect(selectionFrom({})).toBeNull();
    expect(selectionFrom([])).toBeNull();
    expect(selectionFrom("text")).toBeNull();
    expect(selectionFrom(null)).toBeNull();
  });
});

describe("hubSelection against a fake hub", () => {
  beforeAll(() => {
    seen = [];
    mode = "ok";
  });

  test("queries the history for the worker with the key and returns the selection", async () => {
    const got = await hubSelection({ base, apiKey: "k1" }, "chat/c/m");
    expect(got).toEqual({ effort: "high", model: "claude-sonnet-x" });
    expect(seen.at(-1)).toEqual({ url: "/api/smart-auto/history?worker=chat%2Fc%2Fm", auth: "Bearer k1" });
  });

  test("an array answer uses the newest entry", async () => {
    mode = "array";
    expect(await hubSelection({ base, apiKey: "k" }, "w")).toEqual({ effort: "high", model: "claude-sonnet-x" });
    mode = "ok";
  });

  test("a failing hub answers null and does not throw", async () => {
    mode = "error";
    expect(await hubSelection({ base, apiKey: "k" }, "w")).toBeNull();
    mode = "ok";
  });

  test("an unreachable hub answers null", async () => {
    const closed = Bun.serve({ port: 0, hostname: "127.0.0.1", fetch: () => new Response("") });
    const port = closed.port;
    closed.stop(true);
    expect(await hubSelection({ base: `http://127.0.0.1:${port}`, apiKey: "k" }, "w")).toBeNull();
  });

  test("a hub that never answers is cut off by the timeout", async () => {
    const slow = Bun.serve({ port: 0, hostname: "127.0.0.1", fetch: () => new Promise<Response>(() => {}) });
    try {
      expect(await hubSelection({ base: `http://127.0.0.1:${slow.port}`, apiKey: "k" }, "w", fetch, 100)).toBeNull();
    } finally {
      slow.stop(true);
    }
  });
});

describe("hubAdmin", () => {
  test("strips /v1 and needs a key; null without one", () => {
    const keys = ["LLM_HUB_V1_URL", "LLM_HUB_BASE_URL", "LLM_HUB_API_KEY", "LLM_HUB_KEY"];
    const saved = Object.fromEntries(keys.map((k) => [k, process.env[k]]));
    try {
      for (const k of keys) {
        delete process.env[k];
      }
      const home = mkdtempSync(join(tmpdir(), "hub-admin-"));
      expect(hubAdmin(home)).toBeNull();
      process.env.LLM_HUB_V1_URL = "http://hub.test:4000/v1/";
      expect(hubAdmin(home)).toBeNull();
      process.env.LLM_HUB_API_KEY = "key";
      expect(hubAdmin(home)).toEqual({ base: "http://hub.test:4000", apiKey: "key" });
    } finally {
      for (const k of keys) {
        if (saved[k] === undefined) {
          delete process.env[k];
        } else {
          process.env[k] = saved[k];
        }
      }
    }
  });
});

describe("message effort and model storage", () => {
  test("a new reply has no selection; setSelection stores it and a null keeps the field null", () => {
    const store = new ChatStore(":memory:");
    try {
      const chat = store.createChat({ title: "t", harness: "claude", profile: "p" });
      const msg = store.addMessage({ chat_id: chat.id, role: "assistant", status: "done" });
      expect(store.getMessage(msg.id)?.selected_effort).toBeNull();
      store.setSelection(msg.id, { effort: "high", model: null });
      expect(store.getMessage(msg.id)).toMatchObject({ selected_effort: "high", selected_model: null });
    } finally {
      store.close();
    }
  });
});

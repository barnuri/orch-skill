import { describe, expect, test } from "bun:test";

import { startTestServer } from "../test-support/test-server";
import { publishNodeChange } from "./auto-dispatch";
import { runLiveStream } from "./run-live-sse";

describe("GET /api/runs/{id}/live", () => {
  test("streams a node event for its run only", async () => {
    const t = startTestServer();
    const abort = new AbortController();
    try {
      const res = await t.api("/api/runs/r1/live", { signal: abort.signal });
      expect(res.status).toBe(200);
      expect(res.headers.get("content-type")).toContain("text/event-stream");
      const reader = (res.body as ReadableStream<Uint8Array>).getReader();
      const decoder = new TextDecoder();
      let text = decoder.decode((await reader.read()).value);
      publishNodeChange({ run: "other", node: "x", from: "running", to: "done", at: "t" });
      publishNodeChange({ run: "r1", node: "b", from: "running", to: "error", at: "t" });
      while (!text.includes("event: node")) {
        text += decoder.decode((await reader.read()).value);
      }
      expect(text).toContain('"node":"b"');
      expect(text).not.toContain('"node":"x"');
    } finally {
      abort.abort();
      t.stop();
    }
  });

  test("needs the token and rejects a malformed id", async () => {
    const t = startTestServer();
    try {
      expect((await t.api("/api/runs/r1/live", {}, false)).status).toBe(401);
      expect((await t.api("/api/runs/..bad/live")).status).toBe(404);
    } finally {
      t.stop();
    }
  });

  test("sends a patch event with only the changed node fields, nothing for an unchanged run", async () => {
    const t = startTestServer();
    const abort = new AbortController();
    try {
      let doc: Record<string, unknown> = { run_id: "r1", status: "running", edges: [], nodes: [{ id: "a", status: "running" }, { id: "b", status: "waiting" }] };
      const res = runLiveStream("r1", abort.signal, () => doc, 20);
      const reader = (res.body as ReadableStream<Uint8Array>).getReader();
      const decoder = new TextDecoder();
      let text = decoder.decode((await reader.read()).value);
      await new Promise((r) => setTimeout(r, 80));
      expect(text).not.toContain("event: patch");
      doc = { ...doc, nodes: [{ id: "a", status: "done" }, { id: "b", status: "waiting" }] };
      while (!text.includes("event: patch")) {
        text += decoder.decode((await reader.read()).value);
      }
      const data = JSON.parse(text.split("event: patch\ndata: ")[1]!.split("\n")[0]!);
      expect(data.nodes).toEqual([{ id: "a", changed: { status: "done" } }]);
    } finally {
      abort.abort();
      t.stop();
    }
  });
});

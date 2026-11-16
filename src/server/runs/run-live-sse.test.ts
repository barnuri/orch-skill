import { describe, expect, test } from "bun:test";

import { startTestServer } from "../test-support/test-server";
import { publishNodeChange } from "./auto-dispatch";

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
});

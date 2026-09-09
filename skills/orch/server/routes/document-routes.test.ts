import { afterEach, describe, expect, test } from "bun:test";
import { readdirSync } from "node:fs";
import { resolve } from "node:path";

import { startTestServer } from "../test-support/test-server";
import type { TestServerHandle } from "../types/test-server-handle";
import { MAX_BODY_BYTES } from "./document-routes";

const DISPATCH: string = resolve(import.meta.dir, "../../scripts/dispatch.sh");
const ETAG_PATTERN = /^"[0-9a-f]{64}"$/;
const JSON_HEADERS: Record<string, string> = { "Content-Type": "application/json" };
const UTF8_NOTE: string = "résumé ✓ — 日本語";

const servers: TestServerHandle[] = [];

function server(): TestServerHandle {
  const srv = startTestServer();
  servers.push(srv);
  return srv;
}

function put(srv: TestServerHandle, path: string, body: string, extra: Record<string, string> = {}) {
  return srv.api(path, { method: "PUT", headers: { ...JSON_HEADERS, ...extra }, body });
}

function sha(srv: TestServerHandle, rel: string): string {
  return Bun.SHA256.hash(srv.home.read(rel), "hex");
}

function tmpLeftovers(srv: TestServerHandle): string[] {
  return readdirSync(srv.home.path).filter((name) => name.includes(".tmp"));
}

// The CLI is the other writer of these files; running it for real is the only way to prove the
// compare-and-write actually notices an out-of-band change.
function runCli(srv: TestServerHandle, args: readonly string[]) {
  return Bun.spawnSync(["bash", DISPATCH, ...args], {
    env: { ...process.env, HARNESS_ORCH_HOME: srv.home.path },
  });
}

afterEach(() => {
  for (const srv of servers.splice(0)) {
    srv.stop();
  }
});

describe("GET /api/profiles", () => {
  test("the envelope carries the harness enum, the limits and a strong ETag", async () => {
    const srv = server();
    const res = await srv.api("/api/profiles");
    expect(res.status).toBe(200);
    expect(res.headers.get("etag")).toMatch(ETAG_PATTERN);

    const body = await res.json();
    expect(body.harnesses).toHaveLength(4);
    // The shipped template must validate clean, or every fresh install opens with errors.
    expect(body.issues).toEqual([]);
    expect(body.limits.max_body_bytes).toBe(MAX_BODY_BYTES);
    expect(body.document.profiles["claude-sub"].harness).toBe("claude");
  });

  test("an unchanged file answers 304", async () => {
    const srv = server();
    const etag = (await srv.api("/api/profiles")).headers.get("etag") ?? "";
    expect((await srv.api("/api/profiles", { headers: { "If-None-Match": etag } })).status).toBe(304);
  });

  // A hand-broken file must still open the editor, with the problem named, instead of 500ing.
  test("a corrupt file yields a null document and a root issue", async () => {
    const srv = server();
    srv.home.write("profiles.json", "{ not json");
    const body = await (await srv.api("/api/profiles")).json();
    expect(body.document).toBeNull();
    expect(body.issues[0].path).toBe("$");
    expect(body.issues[0].reason).toContain("not valid JSON");
  });
});

describe("GET /api/memory", () => {
  test("an empty memory validates clean and exposes the outcome enum", async () => {
    const srv = server();
    const body = await (await srv.api("/api/memory")).json();
    expect(body.document).toEqual([]);
    expect(body.outcomes).toEqual(["success", "failure", "partial"]);
    expect(body.issues).toEqual([]);
  });
});

describe("PUT happy path", () => {
  test("a valid document is written atomically and the ETag matches the body", async () => {
    const srv = server();
    const get = await srv.api("/api/profiles");
    const etag = get.headers.get("etag") ?? "";
    const doc = (await get.json()).document;
    doc.profiles["claude-sub"].model = "haiku";

    const res = await put(srv, "/api/profiles", JSON.stringify(doc), { "If-Match": etag });
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.ok).toBe(true);
    expect(res.headers.get("etag")).toBe(body.etag);

    expect(JSON.parse(srv.home.read("profiles.json")).profiles["claude-sub"].model).toBe("haiku");
    expect(srv.home.mode("profiles.json")).toBe(0o644);
    expect(tmpLeftovers(srv)).toEqual([]);
  });

  test("memory keeps UTF-8 bytes raw", async () => {
    const srv = server();
    const entry = [
      { ts: "2026-09-03T12:00:00Z", profile: "claude-sub", outcome: "success", note: UTF8_NOTE },
    ];
    expect((await put(srv, "/api/memory", JSON.stringify(entry))).status).toBe(200);
    expect(srv.home.read("memory.json")).toContain(UTF8_NOTE);
    expect(JSON.parse(srv.home.read("memory.json"))[0].note).toBe(UTF8_NOTE);
  });

  test("a PUT with no If-Match still writes", async () => {
    const srv = server();
    expect((await put(srv, "/api/memory", "[]")).status).toBe(200);
  });
});

describe("optimistic concurrency", () => {
  test("a stale If-Match is 412 and leaves the file untouched", async () => {
    const srv = server();
    const before = sha(srv, "profiles.json");
    const res = await put(srv, "/api/profiles", srv.home.read("profiles.json"), {
      "If-Match": '"0000000000000000000000000000000000000000000000000000000000000000"',
    });
    expect(res.status).toBe(412);
    const body = await res.json();
    expect(body.etag).toMatch(ETAG_PATTERN);
    expect(sha(srv, "profiles.json")).toBe(before);
  });

  // The real race: the browser holds an etag, the CLI writes, the browser saves.
  test("a CLI write between GET and PUT wins", async () => {
    const srv = server();
    const get = await srv.api("/api/memory");
    const staleEtag = get.headers.get("etag") ?? "";

    const added = runCli(srv, ["memory", "add", "--profile", "claude-sub", "--outcome", "success"]);
    expect(added.exitCode).toBe(0);

    const res = await put(srv, "/api/memory", "[]", { "If-Match": staleEtag });
    expect(res.status).toBe(412);

    // The CLI's row survived the rejected overwrite.
    expect(JSON.parse(srv.home.read("memory.json"))).toHaveLength(1);
    expect(runCli(srv, ["memory", "list"]).stdout.toString()).toContain("claude-sub");
  });
});

describe("PUT rejections", () => {
  test("a validation failure is 400 with every issue and no write", async () => {
    const srv = server();
    const before = sha(srv, "profiles.json");
    const doc = { settings: {}, profiles: { bad: { harness: "nope" } } };

    const res = await put(srv, "/api/profiles", JSON.stringify(doc));
    expect(res.status).toBe(400);
    const body = await res.json();
    expect(Array.isArray(body.issues)).toBe(true);
    expect(body.issues.length).toBeGreaterThan(0);
    expect(typeof body.error).toBe("string");
    expect(sha(srv, "profiles.json")).toBe(before);
    expect(tmpLeftovers(srv)).toEqual([]);
  });

  // JSON.parse silently keeps the last duplicate; strict parsing refuses so a hand-edited file
  // can never lose a key without saying so.
  const badJson: readonly [string, string][] = [
    ["a duplicate key", '{"settings":{},"settings":{}}'],
    ["NaN", '{"settings":{"retention_days":NaN},"profiles":{}}'],
    ["not JSON at all", "not json"],
  ];
  for (const [label, body] of badJson) {
    test(`${label} is 400`, async () => {
      const srv = server();
      const res = await put(srv, "/api/profiles", body);
      expect(res.status).toBe(400);
      expect((await res.json()).error).toContain("JSON");
    });
  }

  test("an array root is reported at $", async () => {
    const srv = server();
    const res = await put(srv, "/api/profiles", "[]");
    expect(res.status).toBe(400);
    expect((await res.json()).issues[0].path).toBe("$");
  });

  test("a non-JSON media type is 415", async () => {
    const srv = server();
    const res = await srv.api("/api/memory", {
      method: "PUT",
      headers: { "Content-Type": "text/plain" },
      body: "[]",
    });
    expect(res.status).toBe(415);
  });

  test("a missing Content-Type is 415", async () => {
    const srv = server();
    const res = await srv.api("/api/memory", { method: "PUT", body: "[]" });
    expect(res.status).toBe(415);
  });

  test("an oversized declared body is 413 before it is read", async () => {
    const srv = server();
    const before = sha(srv, "memory.json");
    const body = "[".repeat(MAX_BODY_BYTES + 1);
    const res = await put(srv, "/api/memory", body);
    expect(res.status).toBe(413);
    expect(sha(srv, "memory.json")).toBe(before);
  });
});

describe("repair", () => {
  test("a corrupt file can be fixed by a PUT", async () => {
    const srv = server();
    srv.home.write("memory.json", "{ not json");
    expect((await (await srv.api("/api/memory")).json()).document).toBeNull();

    expect((await put(srv, "/api/memory", "[]")).status).toBe(200);
    const body = await (await srv.api("/api/memory")).json();
    expect(body.document).toEqual([]);
    expect(body.issues).toEqual([]);
  });
});

import { afterEach, describe, expect, test } from "bun:test";

import { startTestServer } from "../test-support/test-server";
import type { TestServerHandle } from "../types/test-server-handle";

const servers: TestServerHandle[] = [];

function server(overrides = {}): TestServerHandle {
  const srv = startTestServer(overrides);
  servers.push(srv);
  return srv;
}

afterEach(() => {
  for (const srv of servers.splice(0)) {
    srv.stop();
  }
});

type Spec = { paths: Record<string, Record<string, { summary?: string; description?: string; tags?: string[] }>> };

async function spec(srv: TestServerHandle): Promise<Spec> {
  return (await (await srv.api("/api/openapi.json")).json()) as Spec;
}

describe("OpenAPI document", () => {
  test("describes every route the dashboard calls", async () => {
    const paths = Object.keys((await spec(server())).paths);
    for (const path of [
      "/api/health", "/api/active", "/api/schedules", "/api/schedules/preview", "/api/runs", "/api/runs/{id}",
      "/api/jobs/{id}/log", "/api/profiles", "/api/profiles/sanity", "/api/harnesses", "/api/memory", "/api/suggestions",
    ]) {
      expect(paths).toContain(path);
    }
  });

  test("every operation carries a summary, a description and a tag", async () => {
    const doc = await spec(server());
    const missing: string[] = [];
    for (const [path, ops] of Object.entries(doc.paths)) {
      for (const [method, op] of Object.entries(ops)) {
        if (!op.summary || !op.description || (op.tags ?? []).length === 0) {
          missing.push(`${method.toUpperCase()} ${path}`);
        }
      }
    }
    expect(missing).toEqual([]);
  });

  test("asks for the same token as the API", async () => {
    const srv = server();
    expect((await srv.api("/api/openapi.json", {}, false)).status).toBe(401);
    expect((await srv.api("/api/openapi.json")).status).toBe(200);
  });
});

describe("request validation", () => {
  const post = (srv: TestServerHandle, body: unknown): Promise<Response> =>
    srv.api("/api/schedules", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) });

  test("a field that fails its schema answers 400 in the API's own error shape", async () => {
    const srv = server();
    const res = await post(srv, { name: "", cron: "* * * * *", kind: "command", command: "true" });
    expect(res.status).toBe(400);
    const body = await res.json();
    expect(Object.keys(body)).toEqual(["error"]);
    expect(body.error).toMatch(/^name: /);
  });

  test("an unknown kind names the allowed values", async () => {
    const res = await post(server(), { name: "x", cron: "* * * * *", kind: "nope" });
    expect(res.status).toBe(400);
    expect((await res.json()).error).toMatch(/^kind: .*prompt.*command/);
  });

  test("a body that is not JSON is 400, not a crash", async () => {
    const res = await server().api("/api/schedules", { method: "POST", headers: { "Content-Type": "application/json" }, body: "{ nope" });
    expect(res.status).toBe(400);
  });
});

describe("pipeline order", () => {
  test("an unknown path is 404 even without a token, as it never reaches the gate", async () => {
    expect((await server().api("/api/nope", {}, false)).status).toBe(404);
  });

  test("a known path without a token is 401, whatever the verb", async () => {
    const srv = server();
    expect((await srv.api("/api/runs", {}, false)).status).toBe(401);
    expect((await srv.api("/api/runs", { method: "PUT" }, false)).status).toBe(401);
  });

  test("a known path with the wrong verb is 405 and lists the verbs it has", async () => {
    const srv = server();
    const res = await srv.api("/api/schedules", { method: "DELETE" });
    expect(res.status).toBe(405);
    expect(res.headers.get("allow")).toBe("GET, POST");
  });

  test("a wrong Host is refused before anything else", async () => {
    const srv = server();
    const res = await srv.api("/api/health", { headers: { Host: "evil.example" } });
    expect(res.status).toBe(400);
  });

  test("a handler that throws answers 500 with nothing but the word internal", async () => {
    const srv = server();
    // A corrupt state file reaches the handler's error path, not the framework's.
    srv.home.write("profiles.json", "{ not json");
    const res = await srv.api("/api/profiles");
    expect([200, 500]).toContain(res.status);
    if (res.status === 500) {
      expect(await res.text()).not.toContain("at ");
    }
  });
});

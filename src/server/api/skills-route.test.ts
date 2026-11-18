import { afterEach, describe, expect, test } from "bun:test";

import { startTestServer } from "../test-support/test-server";
import type { TestServerHandle } from "../types/test-server-handle";

const servers: TestServerHandle[] = [];

afterEach(() => {
  for (const srv of servers.splice(0)) {
    srv.stop();
  }
});

describe("GET /api/skills", () => {
  test("lists skills with name and description, from the repo skills folder", async () => {
    const srv = startTestServer();
    servers.push(srv);
    const res = await srv.api("/api/skills");
    expect(res.status).toBe(200);
    const body = (await res.json()) as { skills: Array<{ name: string; description: string }> };
    const orch = body.skills.find((s) => s.name === "orch");
    expect(orch).toBeDefined();
    expect(orch!.description.length).toBeGreaterThan(0);
  });

  test("requires the same token as the rest of the API", async () => {
    const srv = startTestServer();
    servers.push(srv);
    const res = await srv.api("/api/skills", { headers: { Authorization: "Bearer nope" } }, false);
    expect(res.status).toBe(401);
  });
});

import { afterEach, describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";

import { startTestServer } from "../test-support/test-server";
import type { TestServerHandle } from "../types/test-server-handle";

const PROFILES = {
  settings: { default_profile: "p" },
  models: { m: { slug: "alpha", harnesses: ["claude"] } },
  profiles: { p: { harness: "claude", model: "m" } },
};
const servers: TestServerHandle[] = [];
afterEach(() => {
  for (const s of servers.splice(0)) s.stop();
});
function server(): TestServerHandle {
  const srv = startTestServer();
  srv.home.write("profiles.json", JSON.stringify(PROFILES));
  servers.push(srv);
  return srv;
}
const patch = (srv: TestServerHandle, path: string, body: unknown) =>
  srv.api(path, { method: "PATCH", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) });
const saved = (srv: TestServerHandle) => JSON.parse(readFileSync(join(srv.home.path, "profiles.json"), "utf8"));

describe("PATCH usage", () => {
  test("a profile is limited to chat, then back to both", async () => {
    const srv = server();
    const r = await patch(srv, "/api/profiles/p/usage", { usage: "chat" });
    expect(r.status).toBe(200);
    expect(await r.json()).toMatchObject({ id: "p", usage: ["chat"] });
    expect(saved(srv).profiles.p.usage).toEqual(["chat"]);
    expect(((await (await patch(srv, "/api/profiles/p/usage", { usage: "both" })).json()) as any).usage).toEqual(["chat", "runs"]);
    expect(saved(srv).profiles.p.usage).toBeUndefined();
  });
  test("a harness is limited to runs and recorded in settings.harness_usage", async () => {
    const srv = server();
    expect((await patch(srv, "/api/harnesses/claude/usage", { usage: "runs" })).status).toBe(200);
    expect(saved(srv).settings.harness_usage).toEqual({ claude: ["runs"] });
  });
  test("bad bodies are 400, unknown names 404, and the token is required", async () => {
    const srv = server();
    expect((await patch(srv, "/api/profiles/p/usage", { usage: "never" })).status).toBe(400);
    expect((await patch(srv, "/api/profiles/p/usage", {})).status).toBe(400);
    expect((await patch(srv, "/api/profiles/ghost/usage", { usage: "chat" })).status).toBe(404);
    expect((await patch(srv, "/api/harnesses/ghost/usage", { usage: "chat" })).status).toBe(404);
    const noAuth = await srv.api("/api/profiles/p/usage", { method: "PATCH", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ usage: "chat" }) }, false);
    expect(noAuth.status).toBe(401);
  });
  test("the document read shows the saved usage", async () => {
    const srv = server();
    await patch(srv, "/api/profiles/p/usage", { usage: "runs" });
    const doc = (await (await srv.api("/api/profiles")).json()) as any;
    expect(doc.document.profiles.p.usage).toEqual(["runs"]);
    expect(doc.issues ?? []).toEqual([]);
  });
});

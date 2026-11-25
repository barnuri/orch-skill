// The user's message to the orchestrator: a session-only coordinator gets it over the shared opencode service,
// a down service leaves it pending, and the mailbox keeps a record either way.
import { test, expect } from "bun:test";
import { join } from "node:path";
import { existsSync, readFileSync, readdirSync, writeFileSync } from "node:fs";
import { orch, seedHome, tempDir, autoCleanup } from "../helpers";
autoCleanup();

const PW = "pw";
const BASIC = "Basic " + Buffer.from(`opencode:${PW}`).toString("base64");

async function fakeService() {
  const dir = tempDir("orch-tell-svc-");
  const log = join(dir, "requests");
  const script = join(dir, "svc.ts");
  writeFileSync(script, `
    import { appendFileSync } from "node:fs";
    const s = Bun.serve({ port: 0, hostname: "127.0.0.1", fetch(req) {
      const u = new URL(req.url);
      if (req.headers.get("authorization") !== ${JSON.stringify(BASIC)}) return new Response("no", { status: 401 });
      if (req.method === "GET" && u.pathname === "/api/info") return Response.json({ version: "2.4.1" });
      return req.text().then((b) => { appendFileSync(${JSON.stringify(log)}, req.method + " " + u.pathname + " " + b + "\\n"); return Response.json({ ok: true }); });
    } });
    process.stdout.write(String(s.port));
  `);
  const p = Bun.spawn([process.execPath, script], { stdout: "pipe" });
  const port = Number(new TextDecoder().decode((await p.stdout.getReader().read()).value).trim());
  const file = join(dir, "service.json");
  writeFileSync(file, JSON.stringify({ url: `http://127.0.0.1:${port}`, version: "2.4.1", pid: p.pid, password: PW }));
  return { file, requests: () => (existsSync(log) ? readFileSync(log, "utf8") : ""), stop: () => p.kill() };
}

function inboxOrch(home: string, run: string): any[] {
  const dir = join(home, "runs", run, "inbox", "orch");
  return readdirSync(dir).filter((f) => f.endsWith(".json")).map((f) => JSON.parse(readFileSync(join(dir, f), "utf8")));
}

test("tell coordinator posts to the orchestrator session, records the mailbox, and stays pending when the service is down", async () => {
  const svc = await fakeService();
  try {
    const home = seedHome();
    const env = { ORCH_OPENCODE_SERVICE_JSON: svc.file, OPENCODE_SESSION_ID: "ses_orchmain1" };
    const o = orch(home, env);
    const R = o("run", "start", "tell-orch").out.trim();
    o("use", R);
    const sent = o("node", "tell", R, "coordinator", "ship it", "--from", "user");
    expect(sent.out).toMatch(/coordinator delivered/);
    expect(svc.requests()).toMatch(/^POST \/api\/session\/ses_orchmain1\/prompt .*ship it/);
    const msgs = inboxOrch(home, R);
    expect(msgs.length).toBe(1);
    expect(msgs[0]).toMatchObject({ from: "user", to: "orch", status: "delivered", via: "opencode-service" });
    expect(readFileSync(join(home, "runs", R, "messages.jsonl"), "utf8")).toMatch(/"from":"user","to":"orch","text":"ship it"/);

    svc.stop();
    await Bun.sleep(300);
    const late = o("node", "tell", R, "coordinator", "again", "--from", "user");
    expect(late.out).toMatch(/coordinator pending/);
    expect(inboxOrch(home, R).find((m) => m.text === "again")?.status).toBe("pending");
  } finally { svc.stop(); }
});

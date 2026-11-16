#!/usr/bin/env bun
// check-cli-socket.ts - POST /api/cli on <home>/serve/orch.sock of a throwaway server (temp home, temp port): answers
// `suggest list`, `serve status` and `serve config show`, refuses a command it does not serve, the CLI really uses the
// socket (a marker server proves it), and falls back in process when the socket is dead or absent, and after 150 ms
// when connect hangs (the hang is a Bun.connect stub: macOS refuses a full listener backlog at once, so a real hang
// cannot be made). PASS or FAIL per check; exit 1 on any FAIL.
import { existsSync, mkdirSync, mkdtempSync, realpathSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { DISPATCH, run, sleep, tmpDir, trashPath } from "../lib/util.ts";

let fail = false;
const check = (ok: boolean, msg: string) => (console.log(`${ok ? "PASS" : "FAIL"} ${msg}`), ok || (fail = true));
const root = realpathSync(mkdtempSync(join(tmpDir(), "clisock-")));
const home = join(root, "h");
const probe = Bun.listen({ hostname: "127.0.0.1", port: 0, socket: { data() {} } });
const port = probe.port;
probe.stop(true);
const call = (h: string, directly: boolean, a: string[]) => {
  const t = performance.now();
  const r = run([process.execPath, DISPATCH, ...a], { env: { HARNESS_ORCH_HOME: h, ORCH_HERDR: "0", ORCH_DIRECT: directly ? "1" : "" } });
  return { ...r, ms: performance.now() - t };
};
const callAsync = async (h: string, a: string[]) => {
  const p = Bun.spawn([process.execPath, DISPATCH, ...a], { env: { ...process.env, HARNESS_ORCH_HOME: h, ORCH_HERDR: "0", ORCH_DIRECT: "" }, stdout: "pipe", stderr: "pipe", stdin: "ignore" });
  const out = await new Response(p.stdout).text();
  return { out, code: await p.exited };
};
const post = async (sock: string, argv: string[]) => {
  const res = await fetch("http://orch/api/cli", { unix: sock, method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ argv, env: {} }) } as RequestInit);
  return { status: res.status, body: (await res.json()) as any };
};

call(home, true, ["init"]);
call(home, true, ["serve", "config", "set", "--host", "127.0.0.1", "--port", String(port)]);
const server = Bun.spawn([process.execPath, DISPATCH, "serve"], { env: { ...process.env, HARNESS_ORCH_HOME: home, ORCH_HERDR: "0" }, stdout: "ignore", stderr: "ignore", stdin: "ignore" });
const sock = join(home, "serve", "orch.sock");
let up = false;
for (let i = 0; i < 80 && !up; i++) {
  up = existsSync(sock) && (await fetch(`http://127.0.0.1:${port}/api/health`).then((r) => r.ok).catch(() => false));
  if (!up) await sleep(500);
}
check(up, `server up on port ${port}, socket ${sock}`);
for (const argv of [["suggest", "list"], ["serve", "status"], ["serve", "config", "show"]]) {
  const r = await post(sock, argv);
  const d = call(home, true, argv);
  const same = r.body.stdout === d.out;
  check(r.status === 200 && r.body.code === 0 && (same || r.body.stdout.length > 0), `POST /api/cli ${argv.join(" ")} -> ${r.status}, code ${r.body.code}, stdout ${JSON.stringify(String(r.body.stdout).slice(0, 70))}${same ? " (same as direct)" : ""}`);
}
const nope = await post(sock, ["run", "list"]);
check(nope.status === 400 && /not served/.test(nope.body.error), `a command the server does not serve: ${nope.status} ${nope.body.error}`);
const live = call(home, false, ["serve", "status"]);
check(live.code === 0 && live.out.trim().length > 0, `CLI \`serve status\` with the server up (${live.ms.toFixed(0)} ms): ${live.out.trim().split("\n")[0]}`);
server.kill();
await server.exited;

const fake = join(root, "fake");
mkdirSync(join(fake, "serve"), { recursive: true, mode: 0o700 });
const fakeSock = join(fake, "serve", "orch.sock");
const marker = Bun.serve({ unix: fakeSock, fetch: () => Response.json({ code: 0, stdout: "VIA-SOCKET-MARKER\n", stderr: "" }) });
const via = await callAsync(fake, ["serve", "status"]);
check(via.out.includes("VIA-SOCKET-MARKER"), `the CLI answers through the socket when one is listening: ${via.out.trim()}`);
marker.stop(true);
writeFileSync(fakeSock, "");
const dead = call(fake, false, ["serve", "status"]);
check(!dead.out.includes("VIA-SOCKET-MARKER") && /^state=down/.test(dead.out), `socket path without a listener: falls back in process (${dead.ms.toFixed(0)} ms): ${dead.out.trim()}`);
const none = call(join(root, "none"), false, ["serve", "status"]);
check(/^state=down/.test(none.out), `no socket at all: in process: ${none.out.trim()}`);

const { viaServer, CONNECT_MS } = await import("../../skills/orch/core/client.ts");
const hang = join(root, "hang");
mkdirSync(join(hang, "serve"), { recursive: true });
writeFileSync(join(hang, "serve", "orch.sock"), "");
const realConnect = Bun.connect;
(Bun as any).connect = () => new Promise(() => {});
const t0 = performance.now();
const r = await viaServer(hang, ["serve", "status"]);
const ms = performance.now() - t0;
(Bun as any).connect = realConnect;
check(r === null && ms >= CONNECT_MS - 10 && ms < CONNECT_MS + 150, `connect that never completes: viaServer returns null after ${ms.toFixed(0)} ms (CONNECT_MS ${CONNECT_MS})`);
trashPath(root, tmpDir());
process.exit(fail ? 1 : 0);

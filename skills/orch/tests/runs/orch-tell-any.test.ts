// A message to the orchestrator reaches it in every case: service, recorded terminal, the session's TUI terminal, else pending with the reason.
import { test, expect } from "bun:test";
import { join } from "node:path";
import { readFileSync, readdirSync, writeFileSync, existsSync } from "node:fs";
import { orch, seedHome, tempDir, fakeBin, autoCleanup } from "../helpers";
import { parsePs, tuiBySessionArg, envFromPsE, terminalFromEnv } from "../../core/adapters/session-terminal.ts";
autoCleanup();

const SID = "ses_tellany1";
function inboxOrch(home: string, run: string): any[] {
  const dir = join(home, "runs", run, "inbox", "orch");
  return readdirSync(dir).filter((f) => f.endsWith(".json")).map((f) => JSON.parse(readFileSync(join(dir, f), "utf8")));
}
const bin = (log: string, psOut: string, envOut: string) => fakeBin({
  hc: `echo "hc $@" >> ${log}; case "$1" in get) echo '{"state":"live","status":"idle"}';; esac`,
  ps: `case "$*" in *-E*) echo '${envOut}';; *) printf '%s\\n' '${psOut}';; esac`,
  lsof: "exit 0",
});

test("ps parsing finds the TUI by -s or --session and ignores servers", () => {
  const rows = parsePs([
    "  10 /bin/opencode serve --stdio --port 0",
    "  11 opencode --standalone -s ses_a",
    "  12 opencode --session ses_b --standalone",
    "  13 /x/opencode serve -s ses_a",
  ].join("\n"));
  expect(tuiBySessionArg(rows, "ses_a").map((r) => r.pid)).toEqual([11]);
  expect(tuiBySessionArg(rows, "ses_b").map((r) => r.pid)).toEqual([12]);
  expect(terminalFromEnv(envFromPsE("opencode FOO=1 HC_TERMINAL_ID=t9 HC_TERMINAL_SOCKET=/s HERDR_PANE_ID=w:p1"))).toEqual({ hc_terminal: "t9", hc_socket: "/s" });
});

test("no service: the message is typed into the session's TUI terminal (found by ps), no mailbox-only loss", () => {
  const home = seedHome();
  const log = join(tempDir("orch-ta-"), "calls");
  const b = bin(log, `501 opencode --standalone -s ${SID}`, "opencode HC_TERMINAL_ID=t77");
  const o = orch(home, { OPENCODE_SESSION_ID: SID, PATH: `${b}:${process.env.PATH}` });
  const R = o("run", "start", "tell-any").out.trim();
  o("use", R);
  const sent = o("node", "tell", R, "coordinator", "hello main", "--from", "user");
  expect(sent.out).toMatch(/coordinator delivered/);
  expect(readFileSync(log, "utf8")).toMatch(/hc send t77 \[orch tell #m1 from user\] hello main/);
  expect(inboxOrch(home, R)[0]).toMatchObject({ status: "delivered", via: "hc-terminal" });
  const st = JSON.parse(readFileSync(join(home, "runs", R, "state.json"), "utf8"));
  expect(st.coordinator.terminal).toEqual({ hc_terminal: "t77" });
});

test("msg send --to orch uses the same delivery", () => {
  const home = seedHome();
  const log = join(tempDir("orch-ta-"), "calls");
  const b = bin(log, `501 opencode --standalone -s ${SID}`, "opencode HC_TERMINAL_ID=t78");
  const o = orch(home, { OPENCODE_SESSION_ID: SID, PATH: `${b}:${process.env.PATH}` });
  const R = o("run", "start", "tell-any2").out.trim();
  o("use", R);
  const r = o("msg", "send", R, "--to", "orch", "from a node");
  expect(r.out).toMatch(/coordinator delivered/);
  expect(readFileSync(log, "utf8")).toMatch(/hc send t78 .*from a node/);
});

test("a recorded terminal is used before any process search", () => {
  const home = seedHome();
  const log = join(tempDir("orch-ta-"), "calls");
  const b = bin(log, "", "");
  const o = orch(home, { OPENCODE_SESSION_ID: SID, PATH: `${b}:${process.env.PATH}` });
  const R = o("run", "start", "tell-any3").out.trim();
  o("use", R);
  const o2 = orch(home, { OPENCODE_SESSION_ID: SID, HC_TERMINAL_ID: "t5", PATH: `${b}:${process.env.PATH}` });
  o2("orchestrator", "register", R);
  const sent = o("node", "tell", R, "coordinator", "x", "--from", "user");
  expect(sent.out).toMatch(/coordinator delivered/);
  expect(readFileSync(log, "utf8")).toMatch(/hc send t5 /);
});

test("no service, no terminal: pending with the exact reason", () => {
  const home = seedHome();
  const b = bin(join(tempDir("orch-ta-"), "calls"), "", "");
  const o = orch(home, { OPENCODE_SESSION_ID: SID, PATH: `${b}:${process.env.PATH}` });
  const R = o("run", "start", "tell-any4").out.trim();
  o("use", R);
  const sent = o("node", "tell", R, "coordinator", "x", "--from", "user");
  expect(sent.out).toMatch(/coordinator pending/);
  expect(inboxOrch(home, R)[0].last_error).toMatch(/private server and no terminal is known/);
  const st = JSON.parse(readFileSync(join(home, "runs", R, "state.json"), "utf8"));
  expect(st.coordinator.unreachable.reason).toMatch(/private server and no terminal is known/);
});

// G22 live finding: a TUI resumed in its terminal (`opencode --standalone`, no -s) is not found by session id, and the
// shared service only queues for it. The recorded terminal must win over a healthy service.
test("recorded terminal of a standalone TUI is typed into before a healthy service", async () => {
  const home = seedHome();
  const dir = tempDir("orch-ta-");
  const log = join(dir, "calls");
  const reqLog = join(dir, "requests");
  const script = join(dir, "svc.ts");
  writeFileSync(script, `
    import { appendFileSync } from "node:fs";
    const s = Bun.serve({ port: 0, hostname: "127.0.0.1", fetch(req) {
      const u = new URL(req.url);
      if (u.pathname === "/api/info") return Response.json({ version: "2.4.1" });
      return req.text().then((b) => { appendFileSync(${JSON.stringify(reqLog)}, u.pathname + "\\n"); return Response.json({ ok: true }); });
    } });
    process.stdout.write(String(s.port));
  `);
  const p = Bun.spawn([process.execPath, script], { stdout: "pipe" });
  try {
    const port = Number(new TextDecoder().decode((await p.stdout.getReader().read()).value).trim());
    const svc = join(dir, "service.json");
    writeFileSync(svc, JSON.stringify({ id: "x", version: "2.4.1", url: `http://127.0.0.1:${port}`, pid: p.pid, password: "pw" }));
    const b = fakeBin({
      hc: `echo "hc $@" >> ${log}; case "$1" in get) echo '{"state":"live","foreground":{"argv":["opencode","--standalone"]}}';; esac`,
      ps: "exit 0",
      lsof: "exit 0",
    });
    const env = { OPENCODE_SESSION_ID: SID, ORCH_OPENCODE_SERVICE_JSON: svc, PATH: `${b}:${process.env.PATH}` };
    const o = orch(home, env);
    const R = o("run", "start", "tell-any5").out.trim();
    o("use", R);
    orch(home, { ...env, HC_TERMINAL_ID: "t18x" })("orchestrator", "register", R);
    const sent = o("node", "tell", R, "coordinator", "probe", "--from", "user");
    expect(sent.out).toMatch(/coordinator delivered/);
    expect(readFileSync(log, "utf8")).toMatch(/hc send t18x \[orch tell #m1 from user\] probe/);
    expect(existsSync(reqLog) ? readFileSync(reqLog, "utf8") : "").not.toMatch(/prompt/);
    expect(inboxOrch(home, R)[0]).toMatchObject({ status: "delivered", via: "hc-terminal" });
  } finally { p.kill(); }
});

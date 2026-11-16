import { test, expect } from "bun:test";
import { join } from "node:path";
import { existsSync, writeFileSync, renameSync } from "node:fs";
import { orch, seedHome, tempDir, fakeBin, readJson, readText, editJson, runState, waitUntil, pidAlive, autoCleanup } from "../helpers";
autoCleanup();

const setup = (shims: Record<string, string>, env: Record<string, string> = {}) => {
  const home = seedHome();
  const bin = fakeBin(shims);
  const o = orch(home, { PATH: `${bin}:${process.env.PATH}`, ORCH_EVERY_MIN_SECS: "1", ...env });
  const loopState = (id: string) => readJson(join(home, "loops", id, "state.json"));
  const watchState = (id: string) => readJson(join(home, "watches", id, "state.json"));
  const ws = (id: string) => `${watchState(id).status} ${watchState(id).reason ?? ""}`;
  return { home, bin, o, loopState, watchState, ws };
};
const until = (f: () => boolean, s = 60) => waitUntil(() => { try { return f(); } catch { return false; } }, s);
const TICK = `echo "tick"\n[ -n "\${STOP_LOOP:-}" ] && echo STOP > "$ORCH_LOOP_CONTROL"\nexit 0`;

test("loop start/stop, watch wait and cursors", async () => {
  const { home, o, loopState } = setup({ claude: TICK });
  expect(o("loop", "start", "--profile", "claude-default", "hi").rc).toBe(2);
  expect(o("loop", "start", "--every", "0s", "--profile", "claude-default", "hi").rc).toBe(2);
  let id = o("loop", "start", "--every", "1s", "--max", "1", "--profile", "claude-default", "hi").out.trim();
  expect(id).toMatch(/^loop-/);
  await until(() => loopState(id).status === "done");
  expect(`${loopState(id).status} ${loopState(id).reason}`).toMatch(/done/);
  expect(o("loop", "tail", id).all).toMatch(/tick/);
  id = o.env({ STOP_LOOP: "1" }, "loop", "start", "--every", "1s", "--profile", "claude-default", "hi").out.trim();
  await until(() => loopState(id).status === "stopped");
  expect(`${loopState(id).status} ${loopState(id).reason}`).toBe("stopped agent");
  expect(o("active").all).toMatch(/no active loops or watches/);
  expect(o("active", "--json").out.trim()).toBe("[]");
  const w = o("watch", "start", "--name", "stream", "printf 'ok\\nFAIL one\\nfine\\nFAIL two\\n'", "--match", "FAIL").out.trim();
  expect(w).toMatch(/^watch-/);
  let r = o("watch", "wait", w, "--timeout", "60", "--max-lines", "1");
  expect(r.rc).toBe(0); expect(r.all).toMatch(/FAIL one/); expect(r.all).not.toMatch(/FAIL two/);
  expect(o("watch", "wait", w, "--timeout", "60").all).toMatch(/FAIL two/);
  expect(o("watch", "wait", w, "--timeout", "60").rc).toBe(3);
  expect(o("watch", "start", "--name", "bad", "--every", "0s", "true").rc).toBe(2);
  expect(o("watch", "start", "--name", "bad", "--on-match", "x", "true").rc).toBe(2);
}, 240000);

test("loop sessions, runtime, lost loops", async () => {
  const { home, o, loopState } = setup({ claude: `echo "sess=\${ORCH_SESSION_ID:-} resume=\${ORCH_RESUME_SESSION:-}"\nexit "\${SHIM_EXIT:-0}"` });
  expect(o("loop", "start", "--every", "1s", "--session", "resume", "opencode", "x").rc).toBe(2);
  expect(o("loop", "start", "--every", "1s", "--max-runtime", "nope", "--profile", "claude-default", "x").rc).toBe(2);
  let id = o("loop", "start", "--every", "1s", "--max", "2", "--session", "resume", "--profile", "claude-default", "x").out.trim();
  await until(() => loopState(id).status === "done");
  const l1 = readText(join(home, "loops", id, "iter-1.log")), l2 = readText(join(home, "loops", id, "iter-2.log"));
  expect(l1).toMatch(/^sess=[0-9a-f-]{36} resume=$/m);
  expect(l2).toMatch(/^sess= resume=[0-9a-f-]{36}$/m);
  expect(l2).toContain(l1.match(/^sess=(.*) resume=$/m)![1]);
  id = o("loop", "start", "--every", "1s", "--max-runtime", "2s", "--profile", "claude-default", "x").out.trim();
  await until(() => loopState(id).status === "done");
  expect(`${loopState(id).status} ${loopState(id).reason}`).toMatch(/done max-runtime/);
  expect(o("loop", "resume", id).rc).toBe(2);
  id = o("loop", "start", "--every", "1s", "--profile", "claude-default", "x").out.trim();
  await until(() => loopState(id).iteration === 1);
  try { process.kill(loopState(id).pid, "SIGKILL"); } catch {}
  await until(() => /lost/.test(o("loop", "list").out.split("\n").find((l) => l.includes(id)) ?? ""));
  expect(o("loop", "list").out).toMatch(/lost/);
  expect(o("active", "--json").out).toMatch(/"status":"lost"/);
  o("sync", "--no-serve");
  await until(() => /running/.test(o("loop", "list").out.split("\n").find((l) => l.includes(id)) ?? ""));
  expect(o("loop", "list").out.split("\n").find((l) => l.includes(id))).toMatch(/running/);
  o("loop", "stop", id);
  expect(o("loop", "resume", id).rc).toBe(0);
  o("loop", "stop", id);
}, 240000);

test("streaming watch, loop runs, when-idle, truncation", async () => {
  const { home, o, bin, loopState, watchState, ws } = setup({
    claude: `echo "sess=\${ORCH_SESSION_ID:-} resume=\${ORCH_RESUME_SESSION:-}"\nexit "\${SHIM_EXIT:-0}"`,
    beat: "while :; do echo beat; sleep 1; done",
  });
  let w = o("watch", "start", "--name", "beat", "beat", "--match", "beat", "--until", "beat").out.trim();
  await until(() => watchState(w).status === "done");
  expect(ws(w)).toMatch(/done until/);
  await until(() => Bun.spawnSync(["pgrep", "-f", join(bin, "beat")]).exitCode !== 0, 10);
  expect(Bun.spawnSync(["pgrep", "-f", join(bin, "beat")]).exitCode).not.toBe(0);
  let id = o("loop", "start", "--every", "1s", "--max", "2", "--profile", "claude-default", "Check the PR").out.trim();
  await until(() => runState(home, id).status === "done");
  expect(o("run", "list").out).toContain(id);
  expect(runState(home, id).nodes.map((n: any) => `${n.id} ${n.status}`).join(" ")).toBe("i1 done i2 done");
  expect(existsSync(join(home, "runs", id, "out/i1/output.txt"))).toBe(true);
  id = o("loop", "start", "--every", "1s", "--profile", "claude-default", "x").out.trim();
  await until(() => runState(home, id).nodes.length >= 1);
  o("loop", "stop", id);
  expect(runState(home, id).status).toBe("cancelled");
  expect(o("run", "sync", id).rc).toBe(0);

  const flag = tempDir();
  const oc = fakeBin({ opencode: `if [ "$1" = api ]; then
  if [ -f "${flag}/busy" ]; then echo '{"data":[{"type":"assistant","time":{"created":1,"streamed":2}}],"cursor":null}'
  else echo '{"data":[{"type":"assistant","time":{"created":1,"completed":2},"finish":"stop"}],"cursor":null}'; fi
  exit 0
fi
echo "ran: $*" >> "${flag}/ran.log"` });
  const oi = orch(home, { PATH: `${oc}:${bin}:${process.env.PATH}`, ORCH_EVERY_MIN_SECS: "1" });
  expect(oi("loop", "start", "--every", "1s", "--when-idle", "--profile", "claude-default", "x").rc).toBe(2);
  writeFileSync(join(flag, "busy"), "");
  const lid = oi("loop", "start", "--every", "1s", "--session", "ses_test", "opencode", "check").out.trim();
  await until(() => loopState(lid).skipped >= 1);
  expect(`${loopState(lid).iteration} ${loopState(lid).skipped}`).toBe("0 1");
  expect(existsSync(join(flag, "ran.log"))).toBe(false);
  renameSync(join(flag, "busy"), join(flag, "busy.off"));
  await until(() => existsSync(join(flag, "ran.log")));
  expect(readText(join(flag, "ran.log"))).toMatch(/ran: run check/);
  oi("loop", "stop", lid);
  w = o("watch", "start", "--name", "quiet", "beat", "--match", "nomatch", "--max-runtime", "2s").out.trim();
  await until(() => watchState(w).status === "done");
  expect(ws(w)).toMatch(/done max-runtime/);
  const long = "x".repeat(2500);
  w = o("watch", "start", "--name", "long", `printf '${long}\\n'`).out.trim();
  await until(() => readText(join(home, "watches", w, "events.jsonl")).length > 0);
  expect(JSON.parse(readText(join(home, "watches", w, "events.jsonl")).split("\n")[0]).text).toMatch(/…$/);
}, 300000);

test("watch lifecycle: TERM, dead, reused pid, restarts", async () => {
  const { home, o, watchState, ws } = setup({ claude: 'echo "ok"' });
  let w = o("watch", "start", "--name", "sig", "--every", "10s", "echo hi").out.trim();
  await until(() => readText(join(home, "watches", w, "events.jsonl")).length > 0, 20);
  process.kill(watchState(w).pid, "SIGTERM");
  await until(() => watchState(w).status === "stopped", 20);
  expect(ws(w)).toBe("stopped signal TERM");
  w = o("watch", "start", "--name", "killed", "--every", "10s", "echo hi").out.trim();
  let wpid = watchState(w).pid;
  try { process.kill(-wpid, "SIGKILL"); } catch {}
  await until(() => !pidAlive(wpid), 10);
  expect(ws(w)).toMatch(/^running/);
  expect(o("watch", "list").out).toContain(`${w}\tdead`);
  expect(ws(w)).toMatch(/^dead process \d+ gone/);
  expect(readText(join(home, "watches", w, "events.jsonl")).trim().split("\n").pop()).toMatch(/"kind":"lifecycle"/);
  expect(o("active", "--json").out).not.toContain(w);
  const other = Bun.spawn(["sleep", "300"]);
  w = o("watch", "start", "--name", "reused", "--every", "10s", "echo hi").out.trim();
  try { process.kill(-watchState(w).pid, "SIGKILL"); } catch {}
  editJson(join(home, "watches", w, "state.json"), (s) => { s.pid = other.pid; });
  expect(o("active", "--json").out).not.toContain(w);
  expect(ws(w)).toMatch(/^dead pid \d+ now belongs to another process$/);
  const w2 = o("watch", "start", "--name", "reused2", "--every", "10s", "echo hi").out.trim();
  try { process.kill(-watchState(w2).pid, "SIGKILL"); } catch {}
  editJson(join(home, "watches", w2, "state.json"), (s) => { s.pid = other.pid; });
  o("watch", "stop", w2);
  expect(pidAlive(other.pid)).toBe(true);
  other.kill();
  const liveRun = o("run", "start", "live").out.trim(), overRun = o("run", "start", "over").out.trim();
  const wLive = o("watch", "start", "--name", "live", "--every", "10s", `echo ${liveRun}`).out.trim();
  const wOver = o("watch", "start", "--name", "over", "--every", "10s", `echo ${overRun}`).out.trim();
  const wUser = o("watch", "start", "--name", "user", "--every", "10s", "echo hi").out.trim();
  o("watch", "stop", wUser); o("run", "finish", overRun);
  const oldPid = watchState(wLive).pid;
  const killed = [wLive, wOver].map((x) => watchState(x).pid);
  for (const p of killed) try { process.kill(-p, "SIGKILL"); } catch {}
  for (const p of killed) await until(() => !pidAlive(p), 10);
  o("sync", "--no-serve");
  const np = watchState(wLive).pid;
  expect(ws(wLive)).toMatch(/^running/);
  expect(np).not.toBe(oldPid); expect(pidAlive(np)).toBe(true);
  expect(readText(join(home, "watches", wLive, "events.jsonl"))).toMatch(/restarted \(was dead: process \d+ gone/);
  expect(o("watch", "list").out).toContain(`${wLive}\trunning`);
  expect(ws(wOver)).toMatch(/^dead /);
  expect(ws(wUser)).toBe("stopped stopped");
  o("watch", "stop", wLive);
}, 240000);

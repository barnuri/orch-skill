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

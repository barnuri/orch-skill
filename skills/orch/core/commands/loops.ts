// `loop`, `watch` and `active`. Port of lib/automation/loops.sh. Each loop and watch is a detached
// `orch loop __run <id>` / `orch watch __run <id>` process with its own state dir under <home>/loops
// and <home>/watches. State writes are atomic (tmp + rename), so a reader never sees half a file.
import { appendFileSync, closeSync, copyFileSync, existsSync, mkdirSync, openSync, readFileSync, readdirSync, writeFileSync, statSync } from "node:fs";
import { join } from "node:path";
import { orchHome, paths } from "../state/home.ts";
import { confirmMiss, effectiveDeadline, judgeAll, killGhosts, rejudgeOne, scanRunners, selfCheckReason, stillSameCommand, UNAMBIGUOUS, type Judgement, type RunnerProc } from "../ghosts.ts";
import { settingFrom } from "../state/settings.ts";
import { loadProfilesDoc } from "../state/settings.ts";
import { tmpdir } from "node:os";
import { nowIso, epochOf } from "../state/clock.ts";
import { acquireLock } from "../state/lock.ts";
import { loadRun, saveRun } from "../state/store.ts";
import { trashPath } from "../state/trash.ts";
import { readCatalog } from "../adapters/routing.ts";
import { usageRefusal } from "../../../../src/shared/profile-usage.ts";
import { LIMITS, urlProblem, type MonitorSpec } from "../../../../src/shared/chat-automation.ts";
import {
  dispatchSh, hex4, isUint, parseDuration, patchJsonSync, pidAlive, psCommand, readJsonOr, readJsonSync, runLimited, sleep, spawnOrch,
  stampUtc, writeJsonSync,
} from "../state/proc.ts";

const LOOP_MAX_FAILURES = 5;
const LOOP_BACKOFF_CAP_SECS = 3600;
const LOOP_RUN_NODES_KEEP = 50;
const IDLE_POLL_SECS = 5;
const LOOP_UNTIL_TIMEOUT_SECS = 30;
const WATCH_MAX_LINES_DEFAULT = 20;
const WATCH_ON_MATCH_GAP_SECS = 60;
const WATCH_CMD_TIMEOUT_SECS = 300;
const WATCH_WAIT_POLL_SECS = 2;
const MAX_RUNTIME_DEFAULT_SECS = 86400;
const WATCH_MAX_BYTES = 10485760;
const WATCH_EVENT_MAX_CHARS = 2000;
const WATCH_EVENTS_KEEP = 500;
const WATCH_READ_TICK_MS = 5000;
const WATCH_START_GRACE_SECS = 30;
const VALID_HARNESSES = "claude cursor-agent opencode local-llm copilot pi".split(" ");
const ADAPTER_NAMES = ["claude-native", ...VALID_HARNESSES];

export const LOOP_USAGE =
  "dispatch.ts loop start --every <dur> [--max N] [--until CMD] [--max-runtime <dur>] [--session fresh|resume|<id>] [--when-idle|--no-when-idle] (--profile P | <adapter>) <prompt|@file> [args...] | list [--chat ID] | stop <id> | resume <id> | tail <id> [-n N]\n  chat target (flags before --profile): --chat ID [--mode message|fresh] [--until-re RE] [--until-text TEXT] [--cwd DIR] [--max-failures N]";
export const WATCH_USAGE =
  'dispatch.ts watch start --name N "<cmd>" [--match RE] [--ignore RE] [--until RE] [--every DUR] [--max-runtime DUR] [--on-match PROMPT --profile P] [--chat ID --meta JSON [--baseline]] | wait <id> [--timeout S] [--max-lines N] | events <id> [--since N] | list | stop <id>';

const out = (s: string) => process.stdout.write(s);
const err = (s: string) => process.stderr.write(s);
const home = () => orchHome();
const loopsHome = () => join(home(), "loops");
const watchesHome = () => join(home(), "watches");
const nowEpoch = () => Math.floor(Date.now() / 1000);
const lines = (s: string) => s.split("\n").filter((l) => l !== "");

function dirsOf(root: string): string[] {
  if (!existsSync(root)) return [];
  return readdirSync(root).sort().filter((n) => existsSync(join(root, n, "state.json")));
}

const loopPatch = (id: string, fn: (o: any) => void) => patchJsonSync(join(loopsHome(), id, "state.json"), fn);
const watchPatch = (id: string, fn: (o: any) => void) => patchJsonSync(join(watchesHome(), id, "state.json"), fn);

function stopGroup(pid: unknown): boolean {
  if (!pidAlive(pid)) return false;
  const n = Number(pid);
  try {
    process.kill(-n, "SIGTERM");
    return true;
  } catch {
    try {
      process.kill(n, "SIGTERM");
      return true;
    } catch {
      return false;
    }
  }
}

// ---- run bookkeeping (every loop is also an orch run) ------------------------------------------

async function loopRunOpen(id: string, label: string): Promise<void> {
  // A loop run is bookkeeping, not agent work: no done-gate node.
  await dispatchSh(["run", "start", `↻ loop · ${label}`, "--id", id], { env: { ...process.env, ORCH_NO_DONE_GATE: "1" } });
}

async function loopRunTickStart(id: string, iter: number): Promise<void> {
  const a = await dispatchSh(["node", "add", id, `i${iter}`, `Tick ${iter}`, "--origin", "loop"]);
  if (a.code !== 0) return;
  await dispatchSh(["node", "update", id, `i${iter}`, "running"]);
  const lock = await acquireLock(home(), `run-${id}`, 600, 50);
  if (!lock) return;
  try {
    const run = await loadRun(home(), id);
    if (run && run.nodes.length > LOOP_RUN_NODES_KEEP) {
      run.nodes = run.nodes.slice(run.nodes.length - LOOP_RUN_NODES_KEEP);
      await saveRun(home(), id, run);
    }
  } finally {
    await lock.release();
  }
}

async function loopRunTickEnd(id: string, iter: number, rc: number, log: string): Promise<void> {
  try {
    const o = paths.runOutDir(home(), id, `i${iter}`);
    mkdirSync(o, { recursive: true });
    copyFileSync(log, join(o, "output.txt"));
  } catch {}
  if (rc === 0) await dispatchSh(["node", "update", id, `i${iter}`, "done"]);
  else await dispatchSh(["node", "update", id, `i${iter}`, "error", "--error", `exit=${rc}`]);
}

async function loopRunClose(id: string, status: string): Promise<void> {
  if (!existsSync(paths.runState(home(), id))) return;
  if (status === "cancelled") await dispatchSh(["__run-cancel", id]);
  // Loop ticks write no handoff.md, so the verify gate does not apply to a loop run.
  else await dispatchSh(["run", "finish", id, "--status", status, "--force", "--reason", "loop ended"]);
}

async function reopenRun(id: string): Promise<void> {
  const lock = await acquireLock(home(), `run-${id}`, 600, 50);
  if (!lock) return;
  try {
    const run = await loadRun(home(), id);
    if (run && run.finished != null) {
      run.status = "running";
      run.finished = null;
      await saveRun(home(), id, run);
    }
  } finally {
    await lock.release();
  }
}

// ---- loops ----------------------------------------------------------------------------------------

async function opencodeSessionState(session: string): Promise<string> {
  const bin = Bun.which("opencode", { PATH: process.env.PATH ?? "" }) ?? [`${process.env.HOME}/.bun/bin`, `${process.env.HOME}/.opencode/bin`, "/opt/homebrew/bin", "/usr/local/bin"].map((d) => join(d, "opencode")).find((p) => existsSync(p));
  if (!bin) return "unknown";
  const r = await runLimited(30, [bin, "api", "GET", `/api/session/${session}/message`, "--param", "limit=1", "--param", "order=desc"]);
  if (r.code !== 0) return "unknown";
  try {
    const j = JSON.parse(r.out);
    if (!Array.isArray(j.data)) return "unknown";
    if (j.data.length === 0) return "idle";
    const m = j.data[0];
    return m.type === "assistant" && m.time?.completed != null ? "idle" : "busy";
  } catch {
    return "unknown";
  }
}

function adapterSupportsResume(harness: string, mode: string): boolean {
  if (["claude", "copilot", "opencode"].includes(harness)) return true;
  if (harness === "cursor-agent") return mode.startsWith("cursor:");
  return false;
}

async function loopStart(args: string[]): Promise<number> {
  let every = "", max = "0", untilCmd = "", maxRuntime = "", sessionMode = "fresh", whenIdle = "";
  let label = "", chat = "", chatMode = "message", untilRe = "", untilText = "", cwd = "", maxFailures = "";
  let i = 0;
  scan: for (; i < args.length; i++) {
    const a = args[i]!;
    switch (a) {
      case "--every": every = args[++i] ?? ""; break;
      case "--max": max = args[++i] ?? ""; break;
      case "--until": untilCmd = args[++i] ?? ""; break;
      case "--max-runtime": maxRuntime = args[++i] ?? ""; break;
      case "--session": sessionMode = args[++i] ?? ""; break;
      case "--chat": chat = args[++i] ?? ""; break;
      case "--mode": chatMode = args[++i] ?? ""; break;
      case "--until-re": untilRe = args[++i] ?? ""; break;
      case "--until-text": untilText = args[++i] ?? ""; break;
      case "--cwd": cwd = args[++i] ?? ""; break;
      case "--label": label = args[++i] ?? ""; break;
      case "--max-failures": maxFailures = args[++i] ?? ""; break;
      case "--when-idle": whenIdle = "true"; break;
      case "--no-when-idle": whenIdle = "false"; break;
      case "--profile": break scan;
      default:
        if (ADAPTER_NAMES.includes(a)) break scan;
        err(`loop start: unknown argument ${a}\n  usage: ${LOOP_USAGE}\n`);
        return 2;
    }
  }
  if (!every) { err(`loop start: --every is required\n  usage: ${LOOP_USAGE}\n`); return 2; }
  const interval = parseDuration(every);
  if (interval === null || interval < (Number(process.env.ORCH_EVERY_MIN_SECS) >= 1 ? Number(process.env.ORCH_EVERY_MIN_SECS) : 10)) { err("loop start: --every must be a duration of at least 10s (e.g. 10m)\n"); return 2; }
  if (!isUint(max)) { err("loop start: --max must be a whole number\n"); return 2; }
  if (chat && chatMode !== "message" && chatMode !== "fresh") { err("loop start: --mode must be message or fresh\n"); return 2; }
  if (chat && args[i] !== "--profile") { err("loop start: --chat needs --profile (the chat's profile)\n"); return 2; }
  if (untilRe) { try { new RegExp(untilRe); } catch { err("loop start: --until-re is not a valid regular expression\n"); return 2; } }
  if (maxFailures && !isUint(maxFailures)) { err("loop start: --max-failures must be a whole number\n"); return 2; }
  const rest = args.slice(i);
  let kind: string, name: string, rawPrompt: string, argc: number;
  if (rest[0] === "--profile") { kind = "profile"; name = rest[1] ?? ""; rawPrompt = rest[2] ?? ""; argc = 3; }
  else { kind = "adapter"; name = rest[0] ?? ""; rawPrompt = rest[1] ?? ""; argc = 2; }
  if (!name || !rawPrompt) { err("usage: dispatch.ts loop start (--profile <name> | <adapter>) <prompt|@file> [args...]\n"); return 2; }
  let prompt = rawPrompt;
  if (rawPrompt.startsWith("@")) {
    const f = rawPrompt.slice(1);
    if (!existsSync(f) || !statSync(f).isFile()) { err(`resolve_prompt: prompt file not found: ${f}\n`); return 1; }
    prompt = readFileSync(f, "utf8");
  }
  const targetArgs = rest.slice(argc);
  const runtime = parseDuration(maxRuntime || "24h");
  if (runtime === null) { err("loop start: --max-runtime must be a duration (e.g. 6h)\n"); return 2; }

  let harness = name;
  if (kind === "profile") harness = (await readCatalog(paths.profiles(home()))).profiles?.[name]?.harness ?? "";
  if (kind === "profile") {
    const why = usageRefusal(await readCatalog(paths.profiles(home())), name, "runs");
    if (why !== null) { err(`${why}\n`); return 2; }
  }
  let sessionId = "";
  if (sessionMode === "fresh") {
  } else if (sessionMode === "resume") {
    if (harness === "claude" || harness === "copilot") sessionId = crypto.randomUUID();
    else { err(`loop start: --session resume needs a claude or copilot target (got ${harness || "unknown"}); pass --session <id> to resume an existing session\n`); return 2; }
  } else {
    if (!adapterSupportsResume(harness, sessionMode)) { err(`loop start: ${harness || "this target"} cannot resume a session by id\n`); return 2; }
    sessionId = sessionMode;
    sessionMode = "id";
  }
  if (sessionMode === "id" && harness === "opencode") {
    if (!whenIdle) whenIdle = "true";
    err(`loop start: warning: ticks send prompts into the existing opencode session ${sessionId}${whenIdle === "true" ? " (each waits for it to be idle, up to one interval)" : ""}\n`);
  }
  if (!whenIdle) whenIdle = "false";
  if (whenIdle === "true" && (sessionMode !== "id" || harness !== "opencode")) { err("loop start: --when-idle needs --session <id> on an opencode target\n"); return 2; }

  mkdirSync(home(), { recursive: true });
  const id = `loop-${stampUtc()}-${hex4()}`;
  const dir = join(loopsHome(), id);
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, "prompt.txt"), prompt);
  const now = nowEpoch();
  writeJsonSync(join(dir, "spec.json"), {
    ...(chat ? { target: { kind: "chat", chat_id: chat, mode: chatMode } } : {}),
    label, until_re: untilRe, until_text: untilText, cwd, max_failures: maxFailures ? Number(maxFailures) : chat ? LIMITS.maxFailures : LOOP_MAX_FAILURES,
    id, kind, name, interval, max: Number(max), until: untilCmd, args: targetArgs, t0: now, started: nowIso(), deadline: now + runtime,
    session_mode: sessionMode, session: sessionId, when_idle: whenIdle === "true",
  });
  writeJsonSync(join(dir, "state.json"), {
    id, status: "running", iteration: 0, failures: 0, next_tick: now, last_exit: null, last_ts: null, pid: null, ended: null, reason: null,
    in_flight: null, interrupted: null, skipped: 0,
  });
  await loopRunOpen(id, prompt.replace(/\n/g, " ").slice(0, 50));
  const pid = spawnOrch(["loop", "__run", id], join(dir, "log"));
  loopPatch(id, (o) => { o.pid = pid; });
  out(`${id}\n`);
  return 0;
}

// The loop's own process. Runs detached; never called by a user.
async function loopRun(args: string[]): Promise<number> {
  const id = args[0] ?? "";
  const dir = join(loopsHome(), id);
  const spec = readJsonSync(join(dir, "spec.json"));
  const stateFile = join(dir, "state.json");
  const { kind, name, interval, max, until: untilCmd, t0, deadline: specDeadline } = spec;
  const deadline = effectiveDeadline(specDeadline, t0, home(), tmpdir());
  const sessionMode = spec.session_mode as string;
  const sessionId = spec.session as string;
  const whenIdle = spec.when_idle === true;
  const targetArgs: string[] = (spec.args ?? []).filter((x: string) => x !== "");
  const control = join(dir, "control");
  writeFileSync(control, "");
  process.env.ORCH_LOOP_CONTROL = control;
  process.env.ORCH_LOOP_ID = id;
  let st = readJsonSync(stateFile);
  let iter = Number(st.iteration);
  let fails = Number(st.failures);
  let nextTick = Number(st.next_tick);
  for (;;) {
    let now = nowEpoch();
    if (nextTick >= deadline || now >= deadline) {
      loopPatch(id, (o) => { o.status = "done"; o.reason = "max-runtime"; o.ended = nowIso(); o.pid = null; });
      await loopRunClose(id, "done");
      return 0;
    }
    if (nextTick > now) await sleep((Math.min(nextTick, deadline) - now) * 1000);
    const miss = await confirmMiss(() => selfCheckReason("loop", home(), stateFile, process.pid), (s) => sleep(s * 1000));
    if (miss !== null) {
      err(`ghost: ${miss}\n`);
      return 0;
    }
    if (readJsonOr(stateFile, { status: "" }).status !== "running") return 0;

    if (whenIdle) {
      let waited = 0;
      while ((await opencodeSessionState(sessionId)) === "busy") {
        if (waited >= interval - 1) break;
        await sleep(IDLE_POLL_SECS * 1000);
        waited += IDLE_POLL_SECS;
      }
      if ((await opencodeSessionState(sessionId)) === "busy") {
        now = nowEpoch();
        nextTick = t0 + (Math.floor((now - t0) / interval) + 1) * interval;
        loopPatch(id, (o) => { o.skipped = (o.skipped ?? 0) + 1; o.next_tick = nextTick; });
        continue;
      }
    }

    const env: Record<string, string | undefined> = { ...process.env };
    delete env.ORCH_SESSION_ID;
    delete env.ORCH_RESUME_SESSION;
    if (sessionMode === "id") env.ORCH_RESUME_SESSION = sessionId;
    else if (sessionMode === "resume") {
      if (iter >= 1) env.ORCH_RESUME_SESSION = sessionId;
      else env.ORCH_SESSION_ID = sessionId;
    }
    iter += 1;
    loopPatch(id, (o) => { o.in_flight = iter; });
    await loopRunTickStart(id, iter);
    const cond = spec.until_text ? `\n\nStop condition: ${spec.until_text}. When it is true, write STOP to that file.` : "";
    const prompt = `${readFileSync(join(dir, "prompt.txt"), "utf8")}${cond}\n\nTo end this loop, write STOP to the file at ${control}.`;
    const log = join(dir, `iter-${iter}.log`);
    const fd = openSync(log, "w");
    const p = Bun.spawn([process.execPath, process.env.ORCH_DISPATCH || join(import.meta.dir, "..", "..", "scripts", "dispatch.ts"), "run", ...(kind === "profile" ? ["--profile", name] : [name]), prompt, ...targetArgs], {
      stdin: "ignore", stdout: fd, stderr: fd, env: env as any, ...(spec.cwd && existsSync(spec.cwd) ? { cwd: spec.cwd } : {}),
    });
    const rc = (await p.exited) ?? 1;
    closeSync(fd);
    const end = nowEpoch();
    await loopRunTickEnd(id, iter, rc, log);
    fails = rc === 0 ? 0 : fails + 1;

    if (fails >= Number(spec.max_failures ?? LOOP_MAX_FAILURES)) {
      const ts = nowIso();
      loopPatch(id, (o) => { o.status = "failed"; o.reason = "failures"; o.in_flight = null; o.iteration = iter; o.last_exit = rc; o.last_ts = ts; o.ended = ts; o.pid = null; });
      await loopRunClose(id, "error");
      return 1;
    }
    if (fails > 0) {
      nextTick = end + interval * 2 ** Math.min(fails, 10);
      if (nextTick - end > LOOP_BACKOFF_CAP_SECS) nextTick = end + LOOP_BACKOFF_CAP_SECS;
    } else nextTick = t0 + (Math.floor((end - t0) / interval) + 1) * interval;

    let status = "running";
    let reason = "";
    if (untilCmd && (await runLimited(LOOP_UNTIL_TIMEOUT_SECS, ["sh", "-c", untilCmd])).code === 0) { status = "done"; reason = "until"; }
    if (status === "running" && spec.until_re && reTest(spec.until_re, readFileSync(log, "utf8"))) { status = "done"; reason = "until"; }
    if (status === "running" && readFileSync(control, "utf8").split("\n")[0] === "STOP") { status = "stopped"; reason = "agent"; }
    if (status === "running" && max > 0 && iter >= max) { status = "done"; reason = "max"; }
    const ts = nowIso();
    const nt = nextTick;
    loopPatch(id, (o) => {
      o.iteration = iter; o.failures = fails; o.next_tick = nt; o.last_exit = rc; o.last_ts = ts; o.in_flight = null;
      if (status !== "running") o.status = status;
      if (reason !== "") o.reason = reason;
      o.ended = status === "running" ? null : ts;
    });
    if (status !== "running") {
      await loopRunClose(id, reason === "agent" ? "cancelled" : "done");
      return 0;
    }
  }
}

function loopAliveStatus(id: string): string {
  const s = readJsonSync(join(loopsHome(), id, "state.json"));
  if (s.status === "running" && !pidAlive(s.pid) && s.demo !== true) return "lost";
  return s.status;
}

function loopList(args: string[] = []): number {
  const ci = args.indexOf("--chat");
  const chat = ci >= 0 ? args[ci + 1] ?? "" : "";
  const root = loopsHome();
  if (!existsSync(root)) { out("no loops\n"); return 0; }
  const rows: string[] = [];
  for (const id of dirsOf(root)) {
    const s = readJsonSync(join(root, id, "state.json"));
    const p = readJsonSync(join(root, id, "spec.json"));
    if (chat && p.target?.chat_id !== chat) continue;
    rows.push([s.id, loopAliveStatus(id), `iter ${s.iteration}`, `every ${p.interval}s`, p.max > 0 ? `max ${p.max}` : "no max", p.name].join("\t"));
  }
  rows.sort().reverse();
  if (rows.length) out(rows.join("\n") + "\n");
  return 0;
}

async function loopStop(args: string[]): Promise<number> {
  const id = args[0] ?? "";
  if (!id) { err("usage: dispatch.ts loop stop <loop-id>\n"); return 2; }
  const f = join(loopsHome(), id, "state.json");
  if (!existsSync(f)) { err(`unknown loop: ${id}\n`); return 2; }
  stopGroup(readJsonSync(f).pid);
  loopPatch(id, (o) => { o.status = "stopped"; o.reason = "stopped"; o.ended = nowIso(); o.pid = null; });
  await loopRunClose(id, "cancelled");
  out(`stopped: ${id}\n`);
  return 0;
}

async function loopRespawn(id: string): Promise<boolean> {
  const dir = join(loopsHome(), id);
  const cut = readJsonSync(join(dir, "state.json")).in_flight;
  if (cut != null) await dispatchSh(["node", "update", id, `i${cut}`, "error", "--error", "interrupted"]);
  await reopenRun(id).catch(() => {});
  loopPatch(id, (o) => {
    o.status = "running"; o.reason = null; o.ended = null; o.failures = 0; o.next_tick = nowEpoch();
    o.interrupted = o.in_flight;
    o.iteration = o.in_flight != null ? o.in_flight : o.iteration;
    o.in_flight = null;
  });
  const pid = spawnOrch(["loop", "__run", id], join(dir, "log"));
  loopPatch(id, (o) => { o.pid = pid; });
  return true;
}

async function loopResume(args: string[]): Promise<number> {
  const id = args[0] ?? "";
  if (!id) { err("usage: dispatch.ts loop resume <loop-id>\n"); return 2; }
  const dir = join(loopsHome(), id);
  if (!existsSync(join(dir, "state.json"))) { err(`unknown loop: ${id}\n`); return 2; }
  const status = loopAliveStatus(id);
  if (status === "running") { err(`loop ${id} is already running\n`); return 2; }
  if (status === "done") { err(`loop ${id} is done (${readJsonSync(join(dir, "state.json")).reason}); start a new loop\n`); return 2; }
  patchJsonSync(join(dir, "spec.json"), (o) => { o.deadline = nowEpoch() + MAX_RUNTIME_DEFAULT_SECS; });
  await loopRespawn(id);
  out(`resumed: ${id}\n`);
  return 0;
}

function loopTail(args: string[]): number {
  const id = args[0] ?? "";
  if (!id) { err("usage: dispatch.ts loop tail <loop-id> [-n N]\n"); return 2; }
  let n = 20;
  for (let i = 1; i < args.length; i++) if (args[i] === "-n") n = Number(args[++i] ?? 20);
  const dir = join(loopsHome(), id);
  if (!existsSync(join(dir, "state.json"))) { err(`unknown loop: ${id}\n`); return 2; }
  const iter = readJsonSync(join(dir, "state.json")).iteration;
  if (!(iter > 0)) { out(`loop ${id} has no iterations yet\n`); return 0; }
  out(`── iter ${iter} ──\n`);
  const text = readFileSync(join(dir, `iter-${iter}.log`), "utf8");
  const ls = text.split("\n");
  if (ls[ls.length - 1] === "") ls.pop();
  out(ls.slice(Math.max(0, ls.length - n)).join("\n") + (ls.length ? "\n" : ""));
  return 0;
}

// Called by `sync`: loops whose process vanished restart; a scheduled watch that died unintentionally restarts.
export async function loopsRecover(): Promise<number> {
  let recovered = 0;
  for (const id of dirsOf(loopsHome())) {
    if (loopAliveStatus(id) !== "lost") continue;
    if (await loopRespawn(id)) recovered++;
  }
  for (const id of dirsOf(watchesHome())) {
    watchAliveStatus(id);
    if (!watchRestartWanted(id)) continue;
    if (await watchRespawn(id)) recovered++;
  }
  if (recovered) err(`recovered ${recovered} loop(s)/watch(es)\n`);
  await ghostsSync();
  return 0;
}

// ---- ghosts -----------------------------------------------------------------------------------------

// `sync` and the watchdog: report the ghost count, kill the unambiguous ones when settings.auto_kill_ghosts is on.
export async function ghostsSync(): Promise<{ ghosts: number; killed: number }> {
  const procs = scanRunners();
  const judged = judgeAll(procs);
  const ghosts = judged.filter((j) => j.ghost);
  if (!ghosts.length) return { ghosts: 0, killed: 0 };
  const auto = settingFrom(await loadProfilesDoc(home()), "auto_kill_ghosts", "false") === "true";
  let killed = 0;
  if (auto) {
    const sure = ghosts.filter((j) => UNAMBIGUOUS.includes(j.reason!));
    killed = await killGhostsNow(sure, procs);
  }
  err(`${ghosts.length} ghost runner(s)${auto ? `, killed ${killed}` : ""}\n`);
  return { ghosts: ghosts.length, killed };
}

function killGhostsNow(judged: Judgement[], procs: RunnerProc[]): Promise<number> {
  return killGhosts(judged, procs, {
    kill: (pid, sig) => { try { process.kill(pid, sig); } catch {} },
    alive: (pid) => pidAlive(pid),
    sleep,
    still: (pid) => stillSameCommand(pid),
    rejudge: rejudgeOne,
  }, (s) => err(s));
}

// `orch ghosts [--json] [--kill]`: lists runner processes with a GHOST verdict and reason. --kill sends
// SIGTERM, waits 5 s, then SIGKILL, for ghosts only.
async function ghostsCommand(args: string[]): Promise<number> {
  const asJson = args.includes("--json");
  const kill = args.includes("--kill");
  const procs = scanRunners();
  const judged = judgeAll(procs);
  if (kill) {
    const ghosts = judged.filter((j) => j.ghost);
    const n = await killGhostsNow(ghosts, procs);
    if (!asJson) out(`killed ${n} ghost runner(s)\n`);
  }
  const rows = judged.filter((j) => j.kind !== "serve" || j.ghost);
  if (asJson) { out(JSON.stringify(rows) + "\n"); return 0; }
  if (!rows.length) { out("no runner processes\n"); return 0; }
  for (const j of rows) {
    out(`${j.ghost ? "GHOST" : "ok   "}\t${j.pid}\t${j.kind}\t${j.id}\t${j.reason ?? "-"}\t${j.home ?? "no HARNESS_ORCH_HOME"}\n`);
  }
  return 0;
}


// `loop prune <cutoff-epoch> <dry 0|1>`: recoverably removes ended loops and watches older than the cutoff.
async function loopsPrune(args: string[]): Promise<number> {
  const cutoff = Number(args[0]);
  const dry = args[1] === "1";
  for (const root of [loopsHome(), watchesHome()]) {
    for (const id of dirsOf(root)) {
      const ended = readJsonOr(join(root, id, "state.json"), {} as any).ended;
      if (!ended) continue;
      const epoch = epochOf(ended);
      if (epoch === null || !(epoch < cutoff)) continue;
      const path = join(root, id);
      if (dry) out(`would prune: ${path}\n`);
      else { await trashPath(home(), path); out(`pruned: ${path}\n`); }
    }
  }
  return 0;
}

// ---- watches ----------------------------------------------------------------------------------------

function watchPidIs(pid: unknown, id: string): boolean {
  if (!pidAlive(pid)) return false;
  const cmd = psCommand(Number(pid));
  if (cmd === null) return false;
  return cmd.includes(`watch __run ${id}`) || cmd.includes(`watch_run ${id}`);
}

function watchDeadReason(id: string): string {
  const dir = join(watchesHome(), id);
  const st = readJsonOr(join(dir, "state.json"), {} as any);
  const pid = st.pid;
  if (!pid) {
    let started = epochOf(readJsonOr(join(dir, "spec.json"), {} as any).started ?? "") ?? 0;
    const restarted = Number(st.restart_epoch ?? 0) || 0;
    if (restarted > started) started = restarted;
    if (nowEpoch() - started < WATCH_START_GRACE_SECS) return "";
    return "no process recorded";
  }
  if (watchPidIs(pid, id)) return "";
  if (pidAlive(pid)) return `pid ${pid} now belongs to another process`;
  return `process ${pid} gone (killed or host restarted)`;
}

function watchLifecycleEvent(id: string, text: string): void {
  const dir = join(watchesHome(), id);
  const n = Number(readJsonSync(join(dir, "state.json")).events ?? 0) + 1;
  appendFileSync(join(dir, "events.jsonl"), JSON.stringify({ n, ts: nowIso(), text, kind: "lifecycle" }) + "\n");
  watchPatch(id, (o) => { o.events = n; });
}

function watchEnd(id: string, status: string, reason: string): void {
  watchPatch(id, (o) => { o.status = status; o.reason = reason; o.ended = nowIso(); o.pid = null; });
}

function watchMarkDead(id: string, why: string): void {
  watchEnd(id, "dead", why);
  watchLifecycleEvent(id, `dead: ${why}`);
  const name = readJsonOr(join(watchesHome(), id, "spec.json"), {} as any).name ?? "";
  if (/^health:./.test(name)) {
    // A dead health monitor is also a health event on that run (run_event: at/kind/node/from/to/note/by).
    try {
      appendFileSync(paths.runEvents(home(), name.slice(7)), JSON.stringify({ at: nowIso(), kind: "health", node: null, from: null, to: null, note: `monitor ${id} dead: ${why}`, by: process.env.ORCH_EVENT_BY || "cli" }) + "\n");
    } catch {}
  }
}

export function watchAliveStatus(id: string): string {
  const f = join(watchesHome(), id, "state.json");
  let status = readJsonSync(f).status as string;
  if (status === "running") {
    const why = watchDeadReason(id);
    if (why) {
      watchMarkDead(id, why);
      status = "dead";
    }
  }
  return status;
}

function watchTiedRuns(id: string): string[] {
  const spec = readJsonOr(join(watchesHome(), id, "spec.json"), {} as any);
  const runs: string[] = [];
  if (/^health:./.test(spec.name ?? "")) runs.push(spec.name.slice(7));
  const found = new Set<string>();
  for (const m of String(spec.cmd ?? "").matchAll(/[0-9]{8}-[0-9]{6}-[0-9a-f]{4}/g)) found.add(m[0]);
  for (const r of [...found].sort()) if (existsSync(paths.runState(home(), r))) runs.push(r);
  return runs;
}

function watchRestartWanted(id: string): boolean {
  const dir = join(watchesHome(), id);
  const st = readJsonOr(join(dir, "state.json"), {} as any);
  const reason = st.reason ?? "";
  if (!(st.status === "dead" || (st.status === "stopped" && String(reason).startsWith("signal ")))) return false;
  const spec = readJsonOr(join(dir, "spec.json"), {} as any);
  if (!(Number(spec.interval ?? 0) > 0)) return false;
  if (!(Number(spec.deadline ?? 0) > nowEpoch())) return false;
  if (String(spec.name ?? "").startsWith("health:")) return false;
  for (const r of watchTiedRuns(id)) {
    if (readJsonOr(paths.runState(home(), r), {} as any).status !== "running") return false;
  }
  return true;
}

async function watchRespawn(id: string): Promise<boolean> {
  const dir = join(watchesHome(), id);
  const lock = await acquireLock(home(), `watch-respawn-${id}`, 600, 50);
  if (!lock) return false;
  let ok = false;
  try {
    if (watchRestartWanted(id)) {
      const st = readJsonSync(join(dir, "state.json"));
      const why = `${st.status}: ${st.reason ?? "unknown"}`;
      watchPatch(id, (o) => { o.status = "running"; o.reason = null; o.ended = null; o.pid = null; o.restart_epoch = nowEpoch(); });
      watchLifecycleEvent(id, `restarted (was ${why})`);
      const pid = spawnOrch(["watch", "__run", id], join(dir, "log"));
      watchPatch(id, (o) => { o.pid = pid; o.restarts = (o.restarts ?? 0) + 1; });
      ok = true;
    }
  } finally {
    await lock.release();
  }
  return ok;
}

function watchActiveCount(chat = ""): number {
  return dirsOf(watchesHome()).filter((id) => {
    if (watchAliveStatus(id) !== "running") return false;
    const t = readJsonOr<any>(join(watchesHome(), id, "spec.json"), {}).target;
    return chat ? t?.chat_id === chat : t?.kind !== "chat";
  }).length;
}

async function watchStart(args: string[]): Promise<number> {
  let name = "", cmd = "", match = "", ignore = "", untilRe = "", every = "", onMatch = "", profile = "", maxRuntime = "", chat = "", metaRaw = "";
  let baseline = false, replaces = "";
  for (let i = 0; i < args.length; i++) {
    const a = args[i]!;
    switch (a) {
      case "--chat": chat = args[++i] ?? ""; break;
      case "--meta": metaRaw = args[++i] ?? ""; break;
      case "--baseline": baseline = true; break;
      case "--replaces": replaces = args[++i] ?? ""; break;
      case "--name": name = args[++i] ?? ""; break;
      case "--match": match = args[++i] ?? ""; break;
      case "--ignore": ignore = args[++i] ?? ""; break;
      case "--until": untilRe = args[++i] ?? ""; break;
      case "--every": every = args[++i] ?? ""; break;
      case "--on-match": onMatch = args[++i] ?? ""; break;
      case "--profile": profile = args[++i] ?? ""; break;
      case "--max-runtime": maxRuntime = args[++i] ?? ""; break;
      default:
        if (!cmd) cmd = a;
        else { err(`watch start: unexpected argument ${a}\n  usage: ${WATCH_USAGE}\n`); return 2; }
    }
  }
  if (!cmd) { err(`usage: ${WATCH_USAGE}\n`); return 2; }
  if (!name) name = "watch";
  let interval = 0;
  if (every) {
    const d = parseDuration(every);
    if (d === null || d < (Number(process.env.ORCH_EVERY_MIN_SECS) >= 1 ? Number(process.env.ORCH_EVERY_MIN_SECS) : 10)) { err("watch start: --every must be a duration of at least 10s\n"); return 2; }
    interval = d;
  }
  const runtime = parseDuration(maxRuntime || "24h");
  if (runtime === null) { err("watch start: --max-runtime must be a duration (e.g. 6h)\n"); return 2; }
  if (onMatch && !profile) { err("watch start: --on-match needs --profile\n"); return 2; }
  if (onMatch) {
    const why = usageRefusal(await readCatalog(paths.profiles(home())), profile, "runs");
    if (why !== null) { err(`${why}\n`); return 2; }
  }
  let meta: any = null;
  if (chat) {
    try { meta = metaRaw ? JSON.parse(metaRaw) : {}; } catch { err("watch start: --meta is not valid JSON\n"); return 2; }
    const sp = meta.spec as MonitorSpec | undefined;
    if (sp?.type === "url") {
      const why = urlProblem(sp.target, meta.allow_link_local === true);
      if (why !== null) { err(`watch start: ${why}\n`); return 2; }
      const urlMin = Number(process.env.ORCH_EVERY_MIN_SECS) >= 1 ? Number(process.env.ORCH_EVERY_MIN_SECS) : LIMITS.minUrlSecs;
      if (interval < urlMin) { err(`watch start: a URL monitor needs --every of at least ${urlMin}s\n`); return 2; }
    }
    const n = watchActiveCount(chat);
    if (n >= LIMITS.maxChatMonitors) { err(`watch start: ${n} monitors are already active in this chat (limit ${LIMITS.maxChatMonitors})\n`); return 1; }
  } else {
    const limit = Number(process.env.WATCH_MAX_ACTIVE ?? 10);
    const active = watchActiveCount();
    if (active >= limit) { err(`watch start: ${active} watches already active (limit ${limit})\n`); return 1; }
  }
  mkdirSync(home(), { recursive: true });
  const id = `watch-${stampUtc()}-${hex4()}`;
  const dir = join(watchesHome(), id);
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, "events.jsonl"), "");
  writeJsonSync(join(dir, "spec.json"), { id, name, cmd, match, ignore, until: untilRe, interval, on_match: onMatch, profile, started: nowIso(), deadline: nowEpoch() + runtime, baseline, ...(replaces ? { replaces } : {}), ...(chat ? { target: { kind: "chat", chat_id: chat }, meta } : {}) });
  writeJsonSync(join(dir, "state.json"), { id, status: "running", events: 0, cursor: 0, last_event: null, last_dispatch_epoch: 0, pid: null, ended: null, reason: null });
  const pid = spawnOrch(["watch", "__run", id], join(dir, "log"));
  watchPatch(id, (o) => { o.pid = pid; });
  out(`${id}\n`);
  return 0;
}

function reTest(re: string, line: string): boolean {
  try {
    return new RegExp(re).test(line);
  } catch {
    return false;
  }
}

async function watchEmit(id: string, textIn: string): Promise<void> {
  const dir = join(watchesHome(), id);
  const now = nowEpoch();
  const text = textIn.length > WATCH_EVENT_MAX_CHARS ? textIn.slice(0, WATCH_EVENT_MAX_CHARS) + "…" : textIn;
  const n = Number(readJsonSync(join(dir, "state.json")).events) + 1;
  const ts = nowIso();
  appendFileSync(join(dir, "events.jsonl"), JSON.stringify({ n, ts, text }) + "\n");
  watchPatch(id, (o) => { o.events = n; o.last_event = ts; });
  if (n % 50 === 0) {
    const ls = lines(readFileSync(join(dir, "events.jsonl"), "utf8"));
    if (ls.length > WATCH_EVENTS_KEEP) writeFileSync(join(dir, "events.jsonl"), ls.slice(ls.length - WATCH_EVENTS_KEEP).join("\n") + "\n");
  }
  const spec = readJsonSync(join(dir, "spec.json"));
  if (!spec.on_match) return;
  const last = Number(readJsonSync(join(dir, "state.json")).last_dispatch_epoch ?? 0);
  if (now - last < WATCH_ON_MATCH_GAP_SECS) return;
  const pf = join(dir, `on-match-${n}.md`);
  writeFileSync(pf, `${spec.on_match}\n\nMatched output:\n${text}\n`);
  const r = await dispatchSh(["start", "--profile", spec.profile, `@${pf}`]);
  if (r.code !== 0) return;
  const job = r.out.replace(/\n+$/, "");
  watchPatch(id, (o) => { o.last_dispatch_epoch = now; o.last_job = job; });
}

let streamPid = 0;
function killStream(): void {
  if (!streamPid) return;
  try { process.kill(-streamPid, "SIGTERM"); } catch { try { process.kill(streamPid, "SIGTERM"); } catch {} }
}

async function watchStream(id: string, cmd: string, match: string, ignore: string, untilRe: string, deadline: number): Promise<string> {
  const proc = Bun.spawn(["sh", "-c", `exec 2>&1; ${cmd}`], { stdin: "ignore", stdout: "pipe", stderr: "ignore", detached: true });
  streamPid = proc.pid;
  const reader = proc.stdout.getReader();
  const dec = new TextDecoder();
  let buf = "";
  let ended = "";
  let pending: Promise<Awaited<ReturnType<typeof reader.read>>> | null = null;
  outer: for (;;) {
    if (nowEpoch() >= deadline) { ended = "max-runtime"; break; }
    if (await watchMissed(id)) { ended = "ghost"; break; }
    pending ??= reader.read();
    const r = await Promise.race([pending, sleep(WATCH_READ_TICK_MS).then(() => null)]);
    if (r === null) continue;
    pending = null;
    if (r.done) {
      if (buf !== "") await handleLine(buf);
      break;
    }
    buf += dec.decode(r.value, { stream: true });
    let nl: number;
    while ((nl = buf.indexOf("\n")) >= 0) {
      const line = buf.slice(0, nl);
      buf = buf.slice(nl + 1);
      if (await handleLine(line)) break outer;
    }
  }
  async function handleLine(line: string): Promise<boolean> {
    if (match && !reTest(match, line)) return false;
    if (ignore && reTest(ignore, line)) return false;
    await watchEmit(id, line);
    if (untilRe && reTest(untilRe, line)) { ended = "until"; return true; }
    return false;
  }
  killStream();
  return ended;
}

async function watchScheduled(id: string, cmd: string, match: string, ignore: string, untilRe: string, interval: number, deadline: number): Promise<string> {
  let last = "";
  let skipFirst = readJsonSync(join(watchesHome(), id, "spec.json")).baseline === true;
  for (;;) {
    if (readJsonOr(join(watchesHome(), id, "state.json"), { status: "" }).status !== "running") return "";
    if (nowEpoch() >= deadline) return "max-runtime";
    if (await watchMissed(id)) return "ghost";
    const r = await runLimited(WATCH_CMD_TIMEOUT_SECS, ["sh", "-c", cmd]);
    const outText = r.out.slice(0, WATCH_MAX_BYTES);
    let text = "";
    const ls = outText.split("\n");
    if (ls[ls.length - 1] === "") ls.pop();
    for (const line of ls) {
      if (match && !reTest(match, line)) continue;
      if (ignore && reTest(ignore, line)) continue;
      text += line + "\n";
    }
    if (skipFirst) { last = text; skipFirst = false; }
    else if (text !== "" && text !== last) {
      await watchEmit(id, text.replace(/\n$/, ""));
      last = text;
      if (untilRe && reTest(untilRe, text)) return "until";
    }
    await sleep(Math.max(0, Math.min(interval, deadline - nowEpoch())) * 1000);
  }
}

// Self-check of a watch runner: its own state.json only. Returns true when the runner must exit as a ghost.
async function watchMissed(id: string): Promise<boolean> {
  const miss = await confirmMiss(() => selfCheckReason("watch", watchesHome(), join(watchesHome(), id, "state.json"), process.pid), (s) => sleep(s * 1000));
  if (miss === null) return false;
  err(`ghost: ${miss}\n`);
  return true;
}

function watchOnExit(id: string, why: string): void {
  if (readJsonOr(join(watchesHome(), id, "state.json"), { status: "" }).status !== "running") return;
  watchEnd(id, "stopped", why);
  watchLifecycleEvent(id, `stopped: ${why}`);
}

async function watchRun(args: string[]): Promise<number> {
  const id = args[0] ?? "";
  const spec = readJsonSync(join(watchesHome(), id, "spec.json"));
  spec.deadline = effectiveDeadline(spec.deadline, spec.started ? epochOf(spec.started) ?? nowEpoch() : nowEpoch(), home(), tmpdir());
  let busy = false;
  const onSignal = (sig: string, code: number) => () => {
    if (busy) return;
    busy = true;
    watchOnExit(id, `signal ${sig}`);
    killStream();
    try { process.kill(-process.pid, "SIGTERM"); } catch {}
    process.exit(code);
  };
  process.on("SIGTERM", onSignal("TERM", 143));
  process.on("SIGINT", onSignal("INT", 130));
  process.on("SIGHUP", onSignal("HUP", 129));
  process.on("exit", () => {
    try { watchOnExit(id, "exited without recording an end"); } catch {}
  });
  const ended = spec.interval > 0
    ? await watchScheduled(id, spec.cmd, spec.match, spec.ignore, spec.until, spec.interval, spec.deadline)
    : await watchStream(id, spec.cmd, spec.match, spec.ignore, spec.until, spec.deadline);
  if (ended === "ghost") return 0;
  watchEnd(id, "done", ended || "source ended");
  return 0;
}

function watchStop(args: string[]): number {
  const id = args[0] ?? "";
  if (!id) { err("usage: dispatch.ts watch stop <watch-id>\n"); return 2; }
  const f = join(watchesHome(), id, "state.json");
  if (!existsSync(f)) { err(`unknown watch: ${id}\n`); return 2; }
  const pid = readJsonSync(f).pid;
  const own = watchPidIs(pid, id);
  watchEnd(id, "stopped", "stopped");
  if (own) stopGroup(pid);
  out(`stopped: ${id}\n`);
  return 0;
}

function eventRows(id: string, since: number): string[] {
  const rows: string[] = [];
  for (const l of lines(readFileSync(join(watchesHome(), id, "events.jsonl"), "utf8"))) {
    try {
      const e = JSON.parse(l);
      if (e.n > since) rows.push(`${e.n}\t${e.ts}\t${String(e.text).replace(/\n/g, " | ")}`);
    } catch {}
  }
  return rows;
}

async function watchWait(args: string[]): Promise<number> {
  const id = args[0] ?? "";
  if (!id) { err("usage: dispatch.ts watch wait <watch-id> [--timeout S] [--max-lines N] [--since N]\n"); return 2; }
  let timeout = 300, maxLines = WATCH_MAX_LINES_DEFAULT, since = "";
  for (let i = 1; i < args.length; i++) {
    if (args[i] === "--timeout") timeout = Number(args[++i] ?? 300);
    else if (args[i] === "--max-lines") maxLines = Number(args[++i] ?? WATCH_MAX_LINES_DEFAULT);
    else if (args[i] === "--since") since = args[++i] ?? "";
  }
  const dir = join(watchesHome(), id);
  if (!existsSync(join(dir, "state.json"))) { err(`unknown watch: ${id}\n`); return 2; }
  const sinceN = since === "" ? Number(readJsonSync(join(dir, "state.json")).cursor) : Number(since);
  let elapsed = 0;
  for (;;) {
    const count = Number(readJsonSync(join(dir, "state.json")).events);
    if (count > sinceN) {
      const total = count;
      out(`watch ${id}: ${total - sinceN} new event(s), ${total} total\n`);
      const rows = eventRows(id, sinceN).slice(0, maxLines);
      if (rows.length) out(rows.join("\n") + "\n");
      const t2 = Number(readJsonSync(join(dir, "state.json")).events);
      watchPatch(id, (o) => { o.cursor = sinceN + maxLines < t2 ? sinceN + maxLines : t2; });
      return 0;
    }
    const status = watchAliveStatus(id);
    if (status !== "running") { out(`watch ${id} ended (${status}) with no new events\n`); return 3; }
    if (elapsed >= timeout) { err(`wait: timed out after ${timeout}s (no new events)\n`); return 124; }
    await sleep(WATCH_WAIT_POLL_SECS * 1000);
    elapsed += WATCH_WAIT_POLL_SECS;
  }
}

function watchEvents(args: string[]): number {
  const id = args[0] ?? "";
  if (!id) { err("usage: dispatch.ts watch events <watch-id> [--since N] [--limit N]\n"); return 2; }
  let since = 0, limit = 50;
  for (let i = 1; i < args.length; i++) {
    if (args[i] === "--since") since = Number(args[++i] ?? 0);
    else if (args[i] === "--limit") limit = Number(args[++i] ?? 50);
  }
  if (!existsSync(join(watchesHome(), id, "events.jsonl"))) { err(`unknown watch: ${id}\n`); return 2; }
  const rows = eventRows(id, since);
  const tail = rows.slice(Math.max(0, rows.length - limit));
  if (tail.length) out(tail.join("\n") + "\n");
  return 0;
}

function watchList(args: string[] = []): number {
  const ci = args.indexOf("--chat");
  const chat = ci >= 0 ? args[ci + 1] ?? "" : "";
  const root = watchesHome();
  if (!existsSync(root)) { out("no watches\n"); return 0; }
  const rows: string[] = [];
  for (const id of dirsOf(root)) {
    const status = watchAliveStatus(id);
    const s = readJsonSync(join(root, id, "state.json"));
    const p = readJsonSync(join(root, id, "spec.json"));
    if (chat && p.target?.chat_id !== chat) continue;
    rows.push([s.id, status, `${s.events} events`, p.name].join("\t"));
  }
  rows.sort().reverse();
  if (rows.length) out(rows.join("\n") + "\n");
  return 0;
}

// `watch status-of <id>`: the reconciled status, for the bash callers that still need it (run health).
function watchStatusOf(args: string[]): number {
  const id = args[0] ?? "";
  if (!existsSync(join(watchesHome(), id, "state.json"))) return 1;
  out(watchAliveStatus(id) + "\n");
  return 0;
}

// ---- active ---------------------------------------------------------------------------------------

function active(args: string[]): number {
  const asJson = args[0] === "--json";
  const rows: any[] = [];
  for (const id of dirsOf(loopsHome())) {
    const st = loopAliveStatus(id);
    if (!["running", "failed", "lost"].includes(st)) continue;
    let s: any;
    let p: any;
    try {
      s = readJsonSync(join(loopsHome(), id, "state.json"));
      p = readJsonSync(join(loopsHome(), id, "spec.json"));
    } catch { continue; }
    rows.push({
      kind: "loop", id: s.id, name: p.name, status: st, reason: s.reason ?? null, started: p.started ?? null, interval: p.interval ?? null,
      iteration: s.iteration ?? null, max: p.max ?? null, next: s.next_tick ?? null, last_exit: s.last_exit ?? null, session: p.session_mode ?? null,
      deadline: p.deadline ?? null, skipped: s.skipped ?? 0, when_idle: p.when_idle ?? false,
    });
  }
  for (const id of dirsOf(watchesHome())) {
    const st = watchAliveStatus(id);
    if (!["running", "lost"].includes(st)) continue;
    let s: any;
    let p: any;
    try {
      s = readJsonSync(join(watchesHome(), id, "state.json"));
      p = readJsonSync(join(watchesHome(), id, "spec.json"));
    } catch { continue; }
    rows.push({
      kind: "watch", id: s.id, name: p.name, status: st, reason: s.reason ?? null, started: p.started ?? null, interval: p.interval ?? null,
      events: s.events ?? null, last_event: s.last_event ?? null, cmd: p.cmd ?? null, deadline: p.deadline ?? null,
    });
  }
  const ghostIds = new Set(judgeAll(scanRunners()).filter((j) => j.ghost).map((j) => j.id));
  for (const r of rows) r.ghost = ghostIds.has(r.id);
  if (asJson) { out(JSON.stringify(rows) + "\n"); return 0; }
  if (!rows.length) { out("no active loops or watches\n"); return 0; }
  for (const r of rows) {
    const flag = r.ghost ? " [ghost]" : r.status === "running" ? "" : ` [${r.status}]`;
    if (r.kind === "loop") {
      const t = new Date(r.next * 1000).toISOString().slice(11, 19);
      out(`loop ${r.name} · ${r.id} · iter ${r.iteration}${r.max > 0 ? `/${r.max}` : ""} · next ${t} UTC · last exit ${r.last_exit ?? "-"}${flag}\n`);
    } else {
      out(`watch ${r.name} · ${r.id} · ${r.events} event(s)${r.last_event ? " · last " + r.last_event : ""}${flag}\n`);
    }
  }
  return 0;
}

const usage = (u: string) => () => {
  err(`usage: ${u}\n`);
  return 2;
};

export const loopCommands = {
  "loop start": loopStart,
  "loop list": (a: string[]) => loopList(a),
  "loop stop": loopStop,
  "loop resume": loopResume,
  "loop tail": loopTail,
  "loop recover": () => loopsRecover(),
  "loop prune": loopsPrune,
  "loop __run": loopRun,
  loop: usage(LOOP_USAGE),
  "watch start": watchStart,
  "watch wait": watchWait,
  "watch events": watchEvents,
  "watch list": (a: string[]) => watchList(a),
  "watch stop": watchStop,
  "watch status-of": watchStatusOf,
  "watch __run": watchRun,
  watch: usage(WATCH_USAGE),
  active,
  ghosts: ghostsCommand,
};

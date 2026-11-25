// `schedule add|edit|list|show|enable|disable|remove|run|log|tick|next`. Port of lib/automation/schedules.sh.
// A schedule fires a prompt (through a profile) or a shell command on a 5-field cron expression. Each
// lives in <home>/schedules/<id>/schedule.json, written atomically. `schedule tick` is the only thing
// that fires them (the dashboard server calls it every 30 s).
import { existsSync, mkdirSync, readFileSync, readdirSync, statSync, writeFileSync, renameSync, openSync, closeSync, readSync } from "node:fs";
import { join } from "node:path";
import { orchHome, paths } from "../state/home.ts";
import { nowIso } from "../state/clock.ts";
import { trashPath } from "../state/trash.ts";
import { cronNextIn, machineZone, validZone } from "../../../../src/shared/cron-next.ts";
import { LIMITS } from "../../../../src/shared/chat-automation.ts";
import { usageRefusal } from "../../../../src/shared/profile-usage.ts";
import { readCatalog, modelIdAllowed, hasHarnessDisabled } from "../adapters/routing.ts";
import {
  dispatchSh, ensureDir, hex4, isUint, jobStatus, mtimeSecs, parseDuration, patchJsonSync, pidAlive, readJsonSync, spawnOrch, stampUtc,
} from "../state/proc.ts";

const RUNS_KEEP = 30;
const CMD_TIMEOUT_DEFAULT = 3600;
const NEXT_DAYS = 366;
const VALID_HARNESSES = "claude cursor-agent opencode local-llm copilot pi".split(" ");
export const SCHEDULE_USAGE =
  'dispatch.ts schedule add --name N [--description D] --cron "<m h dom mon dow>" (--prompt TEXT|@file --profile P [--model M] | --command CMD [--workdir DIR] [--timeout DUR]) | edit <id> [--name N] [--description D] [--cron C] [--prompt TEXT|@file] [--profile P] [--model M] [--command CMD] [--workdir DIR] [--timeout DUR] | list [--json] | show <id> | enable|disable|mute|unmute <id> | remove <id> | run <id> | log <id> [index] | tick | next "<cron>" | record <id> --status ok|failed|skipped [--message-id M] [--duration-ms N] [--error E] [--advance] [--note T] [--at EPOCH]\n  chat target: add --chat <id> [--mode message|fresh] [--tz ZONE] [--once] --name N --cron C --prompt P; list --chat <id>';

const out = (s: string) => process.stdout.write(s);
const err = (s: string) => process.stderr.write(s);
const home = () => orchHome();
const schedDir = (id: string) => join(home(), "schedules", id);
const schedFile = (id: string) => join(schedDir(id), "schedule.json");

// First matching minute after `from` (epoch seconds, local time), or null for a bad or never-matching expression.
export function cronNext(exprIn: string, from: number, days = NEXT_DAYS): number | null {
  return cronNextIn(exprIn, from, undefined, days);
}

function fmtLocal(epoch: number): string {
  const d = new Date(epoch * 1000);
  const p = (n: number) => String(n).padStart(2, "0");
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())} ${p(d.getHours())}:${p(d.getMinutes())}`;
}

const nowEpoch = () => Math.floor(Date.now() / 1000);
const exists = (id: string) => !!id && existsSync(schedFile(id));
const read = (id: string) => readJsonSync(schedFile(id));
const patch = (id: string, fn: (o: any) => void) => patchJsonSync(schedFile(id), fn);

function setNext(id: string, at = nowEpoch()): void {
  const s = read(id);
  const n = cronNextIn(s.cron, at, s.timezone || undefined);
  patch(id, (o) => {
    o.next_at = n;
  });
}

function readFirst(path: string, n: number): string {
  return readFileSync(path, "utf8").slice(0, n);
}

function runState(run: any): string {
  if (run.kind === "prompt") {
    const out_ = jobStatus(paths.jobs(home()), run.ref);
    if (out_ === null) return "lost";
    if (out_ === "running") return "running";
    if (out_ === "done exit=0") return "ok";
    if (out_.startsWith("done")) return "failed";
    return "lost";
  }
  const exitFile = join(run.ref, "exit");
  if (existsSync(exitFile)) return readFileSync(exitFile, "utf8").trim() === "0" ? "ok" : "failed";
  let pid = "";
  try {
    pid = readFileSync(join(run.ref, "pid"), "utf8").trim();
  } catch {}
  return pidAlive(pid) ? "running" : "lost";
}

function runEnd(run: any): string {
  const marker = run.kind === "prompt" ? join(paths.jobs(home()), run.ref, "exit_code") : join(run.ref, "exit");
  const m = mtimeSecs(marker);
  return m !== null ? nowIso(new Date(m * 1000)) : nowIso();
}

function reap(id: string): void {
  const s = read(id);
  (s.runs as any[]).forEach((run, idx) => {
    if (run.status !== "running") return;
    const state = runState(run);
    if (state === "running") return;
    let code: number | null = null;
    if (run.kind === "command" && existsSync(join(run.ref, "exit"))) {
      const c = Number(readFileSync(join(run.ref, "exit"), "utf8").trim());
      code = Number.isFinite(c) ? c : null;
    }
    const ended = runEnd(run);
    patch(id, (o) => {
      o.runs[idx].status = state;
      o.runs[idx].ended_at = ended;
      o.runs[idx].exit = code;
    });
  });
}

const running = (id: string) => (read(id).runs as any[]).some((r) => r.status === "running");

async function fire(id: string): Promise<string | null> {
  const s = read(id);
  const dir = schedDir(id);
  const kind = s.kind as string;
  let ref = "";
  let model = "";
  if (kind === "prompt") {
    model = s.model ?? "";
    writeFileSync(join(dir, "prompt.md"), String(s.prompt ?? "") + "\n");
    const env: Record<string, string | undefined> = { ...process.env };
    if (s.muted === true) env.ORCH_MUTED = "1";
    else delete env.ORCH_MUTED;
    if (model) env.ORCH_MODEL_ID = model;
    else delete env.ORCH_MODEL_ID;
    const r = await dispatchSh(["start", "--profile", s.profile, `@${join(dir, "prompt.md")}`], { env, inheritErr: true });
    if (r.code !== 0) {
      const t = nowIso();
      patch(id, (o) => {
        o.runs = [{ started_at: t, ended_at: t, kind: "prompt", ref: "", status: "failed", exit: null, model: model || null }, ...o.runs].slice(0, RUNS_KEEP);
      });
      return null;
    }
    ref = r.out.replace(/\n+$/, "");
  } else {
    const rundir = join(dir, "runs", `${stampUtc()}-${Math.floor(Math.random() * 32768)}`);
    ensureDir(rundir);
    writeFileSync(join(rundir, "command"), String(s.command ?? "") + "\n");
    ref = rundir;
    const timeout = Number(s.timeout ?? 0) > 0 ? Number(s.timeout) : CMD_TIMEOUT_DEFAULT;
    const pid = spawnOrch(["schedule", "__runcmd", rundir, String(timeout), s.workdir ?? ""], null);
    writeFileSync(join(rundir, "pid"), `${pid}\n`);
  }
  const t = nowIso();
  patch(id, (o) => {
    o.last_run_at = t;
    o.runs = [{ started_at: t, ended_at: null, kind, ref, status: "running", exit: null, model: model || null }, ...o.runs].slice(0, RUNS_KEEP);
  });
  return ref;
}

// Detached runner of one command run: `bash <rundir>/command` with a time limit, output to <rundir>/out,
// exit code to <rundir>/exit (written through exit.tmp). SIGALRM on timeout, as perl's alarm did (142).
export async function scheduleRunCmd(args: string[]): Promise<number> {
  const [rundir, secsRaw, workdir] = args;
  const secs = Number(secsRaw) || CMD_TIMEOUT_DEFAULT;
  const finish = (rc: number) => {
    writeFileSync(join(rundir!, "exit.tmp"), String(rc));
    renameSync(join(rundir!, "exit.tmp"), join(rundir!, "exit"));
  };
  if (workdir && !(existsSync(workdir) && statSync(workdir).isDirectory())) {
    writeFileSync(join(rundir!, "out"), `cannot cd to ${workdir}\n`);
    finish(1);
    return 1;
  }
  const fd = openSync(join(rundir!, "out"), "w");
  const p = Bun.spawn(["bash", join(rundir!, "command")], {
    cwd: workdir || undefined,
    stdin: "ignore",
    stdout: fd,
    stderr: fd,
    timeout: secs * 1000,
    killSignal: "SIGALRM",
  });
  const code = await p.exited;
  closeSync(fd);
  const rc = p.signalCode ? 128 + ({ SIGALRM: 14, SIGTERM: 15, SIGKILL: 9, SIGINT: 2, SIGHUP: 1 } as Record<string, number>)[p.signalCode]! || 1 : code ?? 1;
  finish(rc);
  return 0;
}

async function resolvePrompt(prompt: string, who: string): Promise<string | null> {
  if (!prompt.startsWith("@")) return prompt;
  const f = prompt.slice(1);
  if (!existsSync(f) || !statSync(f).isFile()) {
    err(`${who}: no such prompt file: ${f}\n`);
    return null;
  }
  return readFileSync(f, "utf8").replace(/\n+$/, "");
}

// profile_load's checks that can fail a schedule: unknown profile, bad or disabled harness, model not allowed.
async function profileOk(name: string): Promise<number> {
  const cat = await readCatalog(paths.profiles(home()));
  const p = cat.profiles?.[name];
  if (!p) {
    err(`profile ${name}: unknown profile. Available: ${Object.keys(cat.profiles ?? {}).sort().join(" ")}\n`);
    return 2;
  }
  if (!VALID_HARNESSES.includes(p.harness ?? "")) {
    err(`profile ${name}: harness "${p.harness ?? ""}" must be one of: ${VALID_HARNESSES.join(" ")}\n`);
    return 2;
  }
  if (hasHarnessDisabled(cat, p.harness)) {
    err(`profile ${name}: harness "${p.harness}" is disabled (settings.disabled_harnesses); enable it on the Harnesses page first\n`);
    return 2;
  }
  const refusal = usageRefusal(cat, name, "runs");
  if (refusal) {
    err(`${refusal}\n`);
    return 2;
  }
  return 0;
}

async function modelOk(profile: string, model: string): Promise<boolean> {
  const cat = await readCatalog(paths.profiles(home()));
  return modelIdAllowed(cat, profile, model);
}

async function add(args: string[]): Promise<number> {
  let name = "", cron = "", prompt = "", profile = "", model = "", command = "", workdir = "", timeout = "", chat = "", mode = "message", tz = "", description = "";
  let once = false;
  for (let i = 0; i < args.length; ) {
    const k = args[i]!;
    const v = args[i + 1] ?? "";
    if (k === "--once") { once = true; i += 1; continue; }
    switch (k) {
      case "--chat": chat = v; break;
      case "--mode": mode = v; break;
      case "--tz": tz = v; break;
      case "--name": name = v; break;
      case "--description": description = v; break;
      case "--cron": cron = v; break;
      case "--prompt": prompt = v; break;
      case "--profile": profile = v; break;
      case "--model": model = v; break;
      case "--command": command = v; break;
      case "--workdir": workdir = v; break;
      case "--timeout": timeout = v; break;
      default: err(`schedule add: unknown argument: ${k}\n`); return 2;
    }
    i += 2;
  }
  if (!name || !cron) { err(`usage: ${SCHEDULE_USAGE}\n`); return 2; }
  if (prompt && command) { err("schedule add: give --prompt or --command, not both\n"); return 2; }
  let kind: string;
  if (chat) {
    if (command || profile || model || workdir || timeout) { err("schedule add: --chat takes only --prompt (the chat's own harness runs it)\n"); return 2; }
    if (!prompt) { err("schedule add: --chat needs --prompt\n"); return 2; }
    if (mode !== "message" && mode !== "fresh") { err("schedule add: --mode must be message or fresh\n"); return 2; }
    if (tz && !validZone(tz)) { err(`schedule add: unknown time zone: ${tz}\n`); return 2; }
    const p = await resolvePrompt(prompt, "schedule add");
    if (p === null) return 2;
    prompt = p;
    kind = "prompt";
  } else if (prompt) {
    kind = "prompt";
    if (!profile) { err("schedule add: --prompt needs --profile\n"); return 2; }
    const rc = await profileOk(profile);
    if (rc) return rc;
    if (model && !(await modelOk(profile, model))) {
      err(`schedule add: model ${model} is not allowed for profile ${profile} (see: dispatch.ts model list --profile ${profile})\n`);
      return 2;
    }
    const p = await resolvePrompt(prompt, "schedule add");
    if (p === null) return 2;
    prompt = p;
  } else if (command) {
    kind = "command";
    if (model) { err("schedule add: --model belongs to a prompt schedule\n"); return 2; }
    if (workdir && !(existsSync(workdir) && statSync(workdir).isDirectory())) { err(`schedule add: no such directory: ${workdir}\n`); return 2; }
  } else {
    err("schedule add: give --prompt or --command\n");
    return 2;
  }
  let secs = 0;
  if (timeout) {
    const d = parseDuration(timeout);
    if (d === null) { err(`schedule add: bad --timeout: ${timeout}\n`); return 2; }
    secs = d;
  }
  const zone = chat ? tz || machineZone() : "";
  const first = cronNextIn(cron, nowEpoch(), zone || undefined);
  if (first === null) { err(`schedule add: bad or never-matching cron: ${cron}\n`); return 2; }
  if (chat) {
    const second = cronNextIn(cron, first, zone);
    if (second !== null && second - first < LIMITS.minScheduleSecs) { err(`schedule add: a chat schedule must be at least ${LIMITS.minScheduleSecs / 60} minutes apart\n`); return 2; }
    const active = loadIds().filter((x) => { const o = read(x); return o.target?.kind === "chat" && o.enabled === true; }).length;
    if (active >= LIMITS.maxChatSchedules) { err(`schedule add: ${active} chat schedules are already active (limit ${LIMITS.maxChatSchedules})\n`); return 1; }
  }
  const id = `sch-${stampUtc()}-${hex4()}`;
  ensureDir(schedDir(id));
  const o = {
    id, name, description: description.trim() === "" ? null : description.trim(), cron, kind, enabled: true, muted: false, created_at: nowIso(),
    prompt: kind === "prompt" ? prompt : null,
    profile: kind === "prompt" ? profile : null,
    model: kind === "prompt" && model ? model : null,
    command: kind === "command" ? command : null,
    workdir: workdir === "" ? null : workdir,
    timeout: secs, next_at: null, last_run_at: null, runs: [],
    ...(chat ? { target: { kind: "chat", chat_id: chat, mode }, timezone: zone, once, consecutive_failures: 0, retry_at: null, pause_reason: null } : {}),
  };
  writeFileSync(schedFile(id), JSON.stringify(o, null, 2) + "\n");
  setNext(id);
  out(`${id}\n`);
  return 0;
}

async function edit(args: string[]): Promise<number> {
  const id = args[0] ?? "";
  if (!exists(id)) { err(`unknown schedule: ${id}\n`); return 2; }
  const v: Record<string, string> = {};
  const has = new Set<string>();
  for (let i = 1; i < args.length; i += 2) {
    const k = args[i]!;
    if (i + 1 >= args.length) { err(`schedule edit: ${k} needs a value\n`); return 2; }
    if (!["--name", "--description", "--cron", "--prompt", "--profile", "--model", "--command", "--workdir", "--timeout", "--tz", "--mode"].includes(k)) {
      err(`schedule edit: unknown argument: ${k}\n`);
      return 2;
    }
    v[k.slice(2)] = args[i + 1]!;
    has.add(k.slice(2));
  }
  if (has.size === 0) { err("schedule edit: nothing to change\n"); return 2; }
  const s = read(id);
  if (has.size === 1 && has.has("description")) {
    patch(id, (o) => { o.description = v.description!.trim() === "" ? null : v.description!.trim(); o.updated_at = nowIso(); });
    out(`edited: ${id}\n`);
    return 0;
  }
  if (s.target?.kind === "chat") return editChat(id, s, v);
  if (has.has("tz") || has.has("mode")) { err("schedule edit: --tz and --mode belong to a chat schedule\n"); return 2; }
  const kind = s.kind as string;
  const oldCron = s.cron ?? "";
  const oldNext = s.next_at;
  if (has.has("prompt") && has.has("command")) { err("schedule edit: give --prompt or --command, not both\n"); return 2; }
  let newKind = kind;
  if (has.has("prompt")) newKind = "prompt";
  if (has.has("command")) newKind = "command";
  if (has.has("name") && !v.name) { err("schedule edit: --name cannot be empty\n"); return 2; }
  if (has.has("cron") && cronNext(v.cron!, nowEpoch()) === null) { err(`schedule edit: bad or never-matching cron: ${v.cron}\n`); return 2; }
  let hasModel = has.has("model");
  let model = v.model ?? "";
  if (newKind === "prompt") {
    if (has.has("workdir") || has.has("timeout")) { err("schedule edit: --workdir and --timeout belong to a command schedule\n"); return 2; }
    if (has.has("prompt")) {
      const p = await resolvePrompt(v.prompt!, "schedule edit");
      if (p === null) return 2;
      v.prompt = p;
      if (!p) { err("schedule edit: --prompt cannot be empty\n"); return 2; }
    }
    if (!has.has("profile")) {
      if (!(kind === "prompt" && s.profile)) { err("schedule edit: --prompt needs --profile\n"); return 2; }
    } else {
      if (!v.profile) { err("schedule edit: --profile cannot be empty\n"); return 2; }
      const rc = await profileOk(v.profile);
      if (rc) return rc;
    }
    const eff = has.has("profile") ? v.profile! : (s.profile ?? "");
    if (hasModel) {
      if (model && !(await modelOk(eff, model))) {
        err(`schedule edit: model ${model} is not allowed for profile ${eff} (see: dispatch.ts model list --profile ${eff})\n`);
        return 2;
      }
    } else if (has.has("profile")) {
      const cur = s.model ?? "";
      if (cur && !(await modelOk(eff, cur))) { model = ""; hasModel = true; }
    }
  } else {
    if (has.has("profile") || has.has("model")) { err("schedule edit: --profile and --model belong to a prompt schedule\n"); return 2; }
    if (has.has("command") && !v.command) { err("schedule edit: --command cannot be empty\n"); return 2; }
    if (has.has("workdir") && v.workdir && !(existsSync(v.workdir) && statSync(v.workdir).isDirectory())) {
      err(`schedule edit: no such directory: ${v.workdir}\n`);
      return 2;
    }
  }
  let secs = 0;
  if (has.has("timeout")) {
    const d = parseDuration(v.timeout!);
    if (d === null) { err(`schedule edit: bad --timeout: ${v.timeout}\n`); return 2; }
    secs = d;
  }
  patch(id, (o) => {
    if (has.has("name")) o.name = v.name;
    if (has.has("description")) o.description = v.description!.trim() === "" ? null : v.description!.trim();
    if (has.has("cron")) o.cron = v.cron;
    if (newKind === "prompt") {
      if (o.kind !== "prompt") { o.kind = "prompt"; o.command = null; o.workdir = null; o.timeout = 0; }
      if (has.has("prompt")) o.prompt = v.prompt;
      if (has.has("profile")) o.profile = v.profile;
      if (hasModel) o.model = model === "" ? null : model;
    } else {
      o.kind = "command"; o.prompt = null; o.profile = null; o.model = null;
      if (has.has("command")) o.command = v.command;
      if (has.has("workdir")) o.workdir = v.workdir === "" ? null : v.workdir;
      if (has.has("timeout")) o.timeout = secs;
    }
    o.updated_at = nowIso();
  });
  if (read(id).enabled === true && ((has.has("cron") && v.cron !== oldCron) || oldNext === null || oldNext === undefined || oldNext === "")) setNext(id);
  out(`edited: ${id}\n`);
  return 0;
}

function editChat(id: string, s: any, v: Record<string, string>): number {
  for (const k of ["profile", "model", "command", "workdir", "timeout"]) if (k in v) { err(`schedule edit: --${k} does not apply to a chat schedule\n`); return 2; }
  if ("name" in v && !v.name) { err("schedule edit: --name cannot be empty\n"); return 2; }
  if ("prompt" in v && !v.prompt) { err("schedule edit: --prompt cannot be empty\n"); return 2; }
  if ("mode" in v && v.mode !== "message" && v.mode !== "fresh") { err("schedule edit: --mode must be message or fresh\n"); return 2; }
  if ("tz" in v && !validZone(v.tz!)) { err(`schedule edit: unknown time zone: ${v.tz}\n`); return 2; }
  const cron = v.cron ?? s.cron;
  const zone = v.tz ?? s.timezone ?? machineZone();
  const first = cronNextIn(cron, nowEpoch(), zone);
  if (first === null) { err(`schedule edit: bad or never-matching cron: ${cron}\n`); return 2; }
  const second = cronNextIn(cron, first, zone);
  if (second !== null && second - first < LIMITS.minScheduleSecs) { err(`schedule edit: a chat schedule must be at least ${LIMITS.minScheduleSecs / 60} minutes apart\n`); return 2; }
  patch(id, (o) => {
    if ("name" in v) o.name = v.name;
    if ("description" in v) o.description = v.description!.trim() === "" ? null : v.description!.trim();
    if ("cron" in v) o.cron = v.cron;
    if ("prompt" in v) o.prompt = v.prompt;
    if ("mode" in v) o.target.mode = v.mode;
    if ("tz" in v) o.timezone = v.tz;
    o.updated_at = nowIso();
  });
  if (read(id).enabled === true) setNext(id);
  out(`edited: ${id}\n`);
  return 0;
}

function loadIds(): string[] {
  const d = join(home(), "schedules");
  if (!existsSync(d)) return [];
  return readdirSync(d).sort().filter((n) => existsSync(join(d, n, "schedule.json")));
}

function list(args: string[]): number {
  const asJson = args.includes("--json");
  const ci = args.indexOf("--chat");
  const chat = ci >= 0 ? args[ci + 1] ?? "" : "";
  if (ci >= 0 && !chat) { err("schedule list: --chat needs a chat id\n"); return 2; }
  const rows: any[] = [];
  for (const id of loadIds()) {
    reap(id);
    const s = read(id);
    if (chat && s.target?.chat_id !== chat) continue;
    rows.push({ ...s, last_status: s.runs?.[0]?.status ?? null });
  }
  if (asJson) {
    const sorted = rows.map((r, i) => [r, i] as const).sort((a, b) => (a[0].created_at < b[0].created_at ? -1 : a[0].created_at > b[0].created_at ? 1 : a[1] - b[1])).map((x) => x[0]).reverse();
    out(JSON.stringify(sorted) + "\n");
    return 0;
  }
  if (rows.length === 0) { out("no schedules\n"); return 0; }
  for (const r of rows) {
    out([r.id, r.enabled ? "on" : "off", r.muted === true ? "muted" : "-", r.cron, r.kind, r.last_status ?? "never run", r.next_at ? "next " + fmtLocal(r.next_at) : "no next run", r.name].join("\t") + "\n");
  }
  return 0;
}

function show(args: string[]): number {
  const id = args[0] ?? "";
  if (!exists(id)) { err(`unknown schedule: ${id}\n`); return 2; }
  reap(id);
  out(JSON.stringify(read(id), null, 2) + "\n");
  return 0;
}

function setEnabled(value: boolean, args: string[]): number {
  const id = args[0] ?? "";
  if (!exists(id)) { err(`unknown schedule: ${id}\n`); return 2; }
  patch(id, (o) => { o.enabled = value; if (value) { o.consecutive_failures = 0; o.retry_at = null; o.pause_reason = null; } });
  if (!value) patch(id, (o) => { o.next_at = null; });
  else setNext(id);
  out(`${id}: ${value ? "enabled" : "disabled"}\n`);
  return 0;
}

function setMuted(value: boolean, args: string[]): number {
  const id = args[0] ?? "";
  if (!exists(id)) { err(`unknown schedule: ${id}\n`); return 2; }
  patch(id, (o) => { o.muted = value; });
  out(`${id}: ${value ? "muted" : "unmuted"}\n`);
  return 0;
}

async function remove(args: string[]): Promise<number> {
  const id = args[0] ?? "";
  if (!exists(id)) { err(`unknown schedule: ${id}\n`); return 2; }
  await trashPath(home(), schedDir(id));
  out(`removed: ${id}\n`);
  return 0;
}

async function runNow(args: string[]): Promise<number> {
  const id = args[0] ?? "";
  if (!exists(id)) { err(`unknown schedule: ${id}\n`); return 2; }
  if (read(id).target?.kind === "chat") { err("schedule run: a chat schedule runs inside the dashboard server (POST /api/chats/{id}/schedules/{sid}/run-now)\n"); return 2; }
  if ((await fire(id)) === null) return 1;
  out(`started: ${id}\n`);
  return 0;
}

async function tick(): Promise<number> {
  const now = nowEpoch();
  for (const id of loadIds()) {
    reap(id);
    const s = read(id);
    if (s.enabled !== true || s.target?.kind === "chat") continue;
    const next = Number(s.next_at ?? 0);
    if (!(next > 0 && next <= now)) continue;
    setNext(id);
    if (running(id)) { out(`skipped (still running): ${id}\n`); continue; }
    if ((await fire(id)) !== null) out(`fired: ${id}\n`);
  }
  return 0;
}

// The single writer for what a chat schedule's run did. The dashboard server runs the prompt in the chat and then calls
// this: it records the run, counts failures (retry once after 5 minutes, pause at 3 in a row) and moves next_at.
function record(args: string[]): number {
  const id = args[0] ?? "";
  if (!exists(id)) { err(`unknown schedule: ${id}\n`); return 2; }
  const f: Record<string, string> = {};
  let advance = false;
  for (let i = 1; i < args.length; i++) {
    const k = args[i]!;
    if (k === "--advance") { advance = true; continue; }
    if (!["--status", "--message-id", "--duration-ms", "--error", "--note", "--at"].includes(k) || i + 1 >= args.length) { err(`schedule record: bad argument: ${k}\n`); return 2; }
    f[k.slice(2)] = args[++i]!;
  }
  const status = f.status ?? "";
  if (!["ok", "failed", "skipped"].includes(status)) { err("schedule record: --status must be ok, failed or skipped\n"); return 2; }
  const s = read(id);
  if (s.target?.kind !== "chat") { err("schedule record: not a chat schedule\n"); return 2; }
  const t = nowIso();
  const at = f.at && isUint(f.at) ? Number(f.at) : nowEpoch();
  const wasRetry = typeof s.retry_at === "number" && s.retry_at <= at;
  patch(id, (o) => {
    const run = {
      started_at: t, ended_at: t, kind: "chat", ref: f["message-id"] ?? "", status, exit: null, model: null,
      message_id: f["message-id"] ?? null, duration_ms: f["duration-ms"] ? Number(f["duration-ms"]) : null, error: f.error ?? null, note: f.note ?? null,
    };
    o.runs = [run, ...o.runs].slice(0, RUNS_KEEP);
    if (status !== "skipped") o.last_run_at = t;
    if (status === "ok") { o.consecutive_failures = 0; o.retry_at = null; }
    else if (status === "failed") {
      o.consecutive_failures = Number(o.consecutive_failures ?? 0) + 1;
      if (o.consecutive_failures >= LIMITS.maxFailures) {
        o.enabled = false; o.next_at = null; o.retry_at = null; o.pause_reason = `paused after ${LIMITS.maxFailures} failed runs in a row: ${f.error ?? "failed"}`;
      } else o.retry_at = wasRetry ? null : at + LIMITS.retryDelaySecs;
    }
  });
  const o = read(id);
  if (o.enabled === true && advance) {
    if (o.once === true && status !== "failed") patch(id, (x) => { x.enabled = false; x.next_at = null; x.pause_reason = "ran once"; });
    else setNext(id, at);
  }
  out(`recorded: ${id} ${status}\n`);
  return 0;
}

// Pauses a schedule for a stated reason (an archived chat); `enable` clears it.
function pauseWith(args: string[]): number {
  const id = args[0] ?? "";
  if (!exists(id)) { err(`unknown schedule: ${id}\n`); return 2; }
  const reason = args[1] ?? "paused";
  patch(id, (o) => { o.enabled = false; o.next_at = null; o.retry_at = null; o.pause_reason = reason; });
  out(`${id}: paused\n`);
  return 0;
}

function log(args: string[]): number {
  const id = args[0] ?? "";
  const idxS = args[1] ?? "0";
  if (!exists(id)) { err(`unknown schedule: ${id}\n`); return 2; }
  if (!isUint(idxS)) { err("schedule log: index must be a number\n"); return 2; }
  const run = read(id).runs?.[Number(idxS)];
  if (!run) { err("no such run\n"); return 2; }
  const file = run.kind === "prompt" ? join(paths.jobs(home()), run.ref, "log") : join(run.ref, "out");
  if (!run.ref || !existsSync(file)) { out("(no output yet)\n"); return 0; }
  const size = statSync(file).size;
  const len = Math.min(size, 65536);
  const buf = Buffer.alloc(len);
  const fd = openSync(file, "r");
  readSync(fd, buf, 0, len, size - len);
  closeSync(fd);
  out(buf.toString("utf8"));
  return 0;
}

function next(args: string[]): number {
  const cron = args[0] ?? "";
  if (!cron) { err(`usage: ${SCHEDULE_USAGE}\n`); return 2; }
  const n = cronNext(cron, nowEpoch());
  if (n === null) { err(`bad or never-matching cron: ${cron}\n`); return 2; }
  out(fmtLocal(n) + "\n");
  return 0;
}

export const scheduleUsage = () => { err(`usage: ${SCHEDULE_USAGE}\n`); return 2; };
export const scheduleCommands = {
  "schedule add": add,
  "schedule edit": edit,
  "schedule list": list,
  "schedule show": show,
  "schedule enable": (a: string[]) => setEnabled(true, a),
  "schedule disable": (a: string[]) => setEnabled(false, a),
  "schedule mute": (a: string[]) => setMuted(true, a),
  "schedule unmute": (a: string[]) => setMuted(false, a),
  "schedule remove": remove,
  "schedule run": runNow,
  "schedule log": log,
  "schedule tick": () => tick(),
  "schedule next": next,
  "schedule record": record,
  "schedule pause": pauseWith,
  "schedule __runcmd": scheduleRunCmd,
  schedule: () => scheduleUsage(),
};

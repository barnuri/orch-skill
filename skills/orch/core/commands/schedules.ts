// `schedule add|edit|list|show|enable|disable|remove|run|log|tick|next`. Port of lib/automation/schedules.sh.
// A schedule fires a prompt (through a profile) or a shell command on a 5-field cron expression. Each
// lives in <home>/schedules/<id>/schedule.json, written atomically. `schedule tick` is the only thing
// that fires them (the dashboard server calls it every 30 s).
import { existsSync, mkdirSync, readFileSync, readdirSync, statSync, writeFileSync, renameSync, openSync, closeSync, readSync } from "node:fs";
import { join } from "node:path";
import { orchHome, paths } from "../state/home.ts";
import { nowIso } from "../state/clock.ts";
import { trashPath } from "../state/trash.ts";
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
  'dispatch.ts schedule add --name N --cron "<m h dom mon dow>" (--prompt TEXT|@file --profile P [--model M] | --command CMD [--workdir DIR] [--timeout DUR]) | edit <id> [--name N] [--cron C] [--prompt TEXT|@file] [--profile P] [--model M] [--command CMD] [--workdir DIR] [--timeout DUR] | list [--json] | show <id> | enable|disable <id> | remove <id> | run <id> | log <id> [index] | tick | next "<cron>"';

const out = (s: string) => process.stdout.write(s);
const err = (s: string) => process.stderr.write(s);
const home = () => orchHome();
const schedDir = (id: string) => join(home(), "schedules", id);
const schedFile = (id: string) => join(schedDir(id), "schedule.json");

const ALIAS: Record<string, string> = { "@hourly": "0 * * * *", "@daily": "0 0 * * *", "@weekly": "0 0 * * 0", "@monthly": "0 0 1 * *" };
const RANGE: Array<[number, number]> = [[0, 59], [0, 23], [1, 31], [1, 12], [0, 7]];

// First matching minute after `from` (epoch seconds, local time), or null for a bad or never-matching expression.
export function cronNext(exprIn: string, from: number, days = NEXT_DAYS): number | null {
  const expr = ALIAS[exprIn] ?? exprIn;
  const f = expr.split(/\s+/).filter((x) => x !== "");
  if (f.length !== 5) return null;
  const set: Array<Set<number>> = [];
  const star: boolean[] = [];
  for (let i = 0; i < 5; i++) {
    const [min, max] = RANGE[i]!;
    const ok = new Set<number>();
    star[i] = /^\*(\/1)?$/.test(f[i]!);
    for (const part of f[i]!.split(",")) {
      const slash = part.indexOf("/");
      const r = slash < 0 ? part : part.slice(0, slash);
      const sraw = slash < 0 ? undefined : part.slice(slash + 1);
      const s = sraw === undefined ? 1 : /^\d+$/.test(sraw) ? Number(sraw) : NaN;
      if (!Number.isFinite(s) || s < 1) return null;
      let lo: number, hi: number;
      let m: RegExpExecArray | null;
      if (r === "*") [lo, hi] = [min, max];
      else if ((m = /^(\d+)-(\d+)$/.exec(r))) [lo, hi] = [Number(m[1]), Number(m[2])];
      else if (/^\d+$/.test(r)) [lo, hi] = [Number(r), sraw !== undefined ? max : Number(r)];
      else return null;
      if (lo < min || hi > max || lo > hi) return null;
      for (let v = lo; v <= hi; v += s) ok.add(i === 4 && v === 7 ? 0 : v);
    }
    set[i] = ok;
  }
  const d = new Date((from - (from % 60) + 60) * 1000);
  for (let n = 0; n < days * 1440; n++) {
    const dayOk = star[2] || star[4]
      ? set[2]!.has(d.getDate()) && set[4]!.has(d.getDay())
      : set[2]!.has(d.getDate()) || set[4]!.has(d.getDay());
    if (set[0]!.has(d.getMinutes()) && set[1]!.has(d.getHours()) && set[3]!.has(d.getMonth() + 1) && dayOk) return Math.floor(d.getTime() / 1000);
    d.setTime(d.getTime() + 60000);
  }
  return null;
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

function setNext(id: string): void {
  const s = read(id);
  const n = cronNext(s.cron, nowEpoch());
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
  let name = "", cron = "", prompt = "", profile = "", model = "", command = "", workdir = "", timeout = "";
  for (let i = 0; i < args.length; ) {
    const k = args[i]!;
    const v = args[i + 1] ?? "";
    switch (k) {
      case "--name": name = v; break;
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
  if (prompt) {
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
  if (cronNext(cron, nowEpoch()) === null) { err(`schedule add: bad or never-matching cron: ${cron}\n`); return 2; }
  const id = `sch-${stampUtc()}-${hex4()}`;
  ensureDir(schedDir(id));
  const o = {
    id, name, cron, kind, enabled: true, created_at: nowIso(),
    prompt: kind === "prompt" ? prompt : null,
    profile: kind === "prompt" ? profile : null,
    model: kind === "prompt" && model ? model : null,
    command: kind === "command" ? command : null,
    workdir: workdir === "" ? null : workdir,
    timeout: secs, next_at: null, last_run_at: null, runs: [],
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
    if (!["--name", "--cron", "--prompt", "--profile", "--model", "--command", "--workdir", "--timeout"].includes(k)) {
      err(`schedule edit: unknown argument: ${k}\n`);
      return 2;
    }
    v[k.slice(2)] = args[i + 1]!;
    has.add(k.slice(2));
  }
  if (has.size === 0) { err("schedule edit: nothing to change\n"); return 2; }
  const s = read(id);
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

function loadIds(): string[] {
  const d = join(home(), "schedules");
  if (!existsSync(d)) return [];
  return readdirSync(d).sort().filter((n) => existsSync(join(d, n, "schedule.json")));
}

function list(args: string[]): number {
  const asJson = args[0] === "--json";
  const rows: any[] = [];
  for (const id of loadIds()) {
    reap(id);
    const s = read(id);
    rows.push({ ...s, last_status: s.runs?.[0]?.status ?? null });
  }
  if (asJson) {
    const sorted = rows.map((r, i) => [r, i] as const).sort((a, b) => (a[0].created_at < b[0].created_at ? -1 : a[0].created_at > b[0].created_at ? 1 : a[1] - b[1])).map((x) => x[0]).reverse();
    out(JSON.stringify(sorted) + "\n");
    return 0;
  }
  if (rows.length === 0) { out("no schedules\n"); return 0; }
  for (const r of rows) {
    out([r.id, r.enabled ? "on" : "off", r.cron, r.kind, r.last_status ?? "never run", r.next_at ? "next " + fmtLocal(r.next_at) : "no next run", r.name].join("\t") + "\n");
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
  patch(id, (o) => { o.enabled = value; });
  if (!value) patch(id, (o) => { o.next_at = null; });
  else setNext(id);
  out(`${id}: ${value ? "enabled" : "disabled"}\n`);
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
  if ((await fire(id)) === null) return 1;
  out(`started: ${id}\n`);
  return 0;
}

async function tick(): Promise<number> {
  const now = nowEpoch();
  for (const id of loadIds()) {
    reap(id);
    const s = read(id);
    if (s.enabled !== true) continue;
    const next = Number(s.next_at ?? 0);
    if (!(next > 0 && next <= now)) continue;
    setNext(id);
    if (running(id)) { out(`skipped (still running): ${id}\n`); continue; }
    if ((await fire(id)) !== null) out(`fired: ${id}\n`);
  }
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
  "schedule remove": remove,
  "schedule run": runNow,
  "schedule log": log,
  "schedule tick": () => tick(),
  "schedule next": next,
  "schedule __runcmd": scheduleRunCmd,
  schedule: () => scheduleUsage(),
};

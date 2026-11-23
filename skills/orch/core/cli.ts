// orch CLI entry: argv parse, command table, exit codes. Bun built-ins only, no npm imports.
// Importing this module has no side effects; main() runs only when executed directly.

import { USAGE } from "./usage.ts";
import { orchHome } from "./state/home.ts";
import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { join } from "node:path";

export const VERSION = "0.1.0";

export type Handler = (args: string[]) => Promise<number> | number;

// Every command is loaded on first use: a call imports its own module and nothing else (a process start is the cost).
const L = <M>(load: () => Promise<M>, pick: (m: M) => (a: string[]) => number | Promise<number>): Handler => async (a) => pick(await load())(a);
const inbox = () => import("./commands/inbox.ts");
const pause = () => import("./commands/pause.ts");
const health = () => import("./commands/health.ts");
const node = () => import("./commands/node.ts");
const timing = () => import("./commands/timing.ts");
const owners = () => import("./commands/owners.ts");
const profile = () => import("./commands/profile.ts");
const config = () => import("./commands/config.ts");
const hubModels = () => import("./commands/hub-models.ts");
const dispatchCmds = () => import("./commands/dispatch.ts");
const runs = () => import("./commands/runs.ts");
const nodeOps = () => import("./commands/node-ops.ts");
const serve = () => import("./commands/serve.ts");
const delegate = () => import("./commands/delegate.ts");
const herdr = () => import("./adapters/herdr.ts");
const hub = () => import("./adapters/hub.ts");
const harness = () => import("./adapters/harness.ts");
const spawn = () => import("./adapters/spawn.ts");
const jobs = () => import("./commands/jobs.ts");
const loops = () => import("./commands/loops.ts");
const schedules = () => import("./commands/schedules.ts");

// run_create_with_monitor: after a run is created (start or carry), record the coordinator and start its health monitor.
function withMonitor(h: Handler): Handler {
  return async (args) => {
    const w = process.stdout.write;
    let first = "";
    process.stdout.write = ((chunk: any, ...rest: any[]) => {
      if (!first) first = String(chunk).split("\n")[0] ?? "";
      return (w as any).call(process.stdout, chunk, ...rest);
    }) as any;
    let rc: number;
    try { rc = await h(args); } finally { process.stdout.write = w; }
    if (rc === 0 && first) {
      const home = orchHome();
      const [{ coordinatorAutoRecord }, { healthMonitorAutostart }] = await Promise.all([inbox(), health()]);
      await coordinatorAutoRecord(home, first).catch(() => undefined);
      await healthMonitorAutostart(home, first).catch(() => undefined);
    }
    return rc;
  };
}

// Verbs of `herdr <verb>`: kept here so building the table does not load the herdr adapter (a test checks it matches).
export const HERDR_VERB_KEYS = ["on", "off", "auto", "status", "attach", "ensure", "stop", "health", "sweep", "enabled", "start-job", "close-tab", "close-ended", "job-gone-note", "serve-boot", "cli", "cleanup"];
// `loop` and `schedule` handler keys, as exported by their modules (a test checks they match).
export const LOOP_KEYS = ["loop start", "loop list", "loop stop", "loop resume", "loop tail", "loop recover", "loop prune", "loop __run", "loop", "watch start", "watch wait", "watch events", "watch list", "watch stop", "watch status-of", "watch __run", "watch", "active", "ghosts"];
export const SCHEDULE_KEYS = ["schedule add", "schedule edit", "schedule list", "schedule show", "schedule enable", "schedule disable", "schedule remove", "schedule run", "schedule log", "schedule tick", "schedule next", "schedule record", "schedule pause", "schedule __runcmd", "schedule"];

export const COMMANDS: Record<string, Handler> = {
  "run start": withMonitor(L(runs, (m) => m.runStart)), "run describe": L(() => import("./commands/overview.ts"), (m) => m.runDescribe), "run overview": L(() => import("./commands/overview.ts"), (m) => m.runOverview), "run list": L(runs, (m) => m.runList), "run retry": L(runs, (m) => m.runRetry), "run sync": L(runs, (m) => m.runSync),
  "__run-cancel": L(runs, (m) => m.runCancel), prune: L(runs, (m) => (a) => m.prune(a)),
  "node usage": L(nodeOps, (m) => m.nodeUsage), "node cost": L(nodeOps, (m) => m.nodeCost), "node out": L(nodeOps, (m) => m.nodeOut), "node digest": L(nodeOps, (m) => m.nodeDigest),
  "node remove": L(nodeOps, (m) => m.nodeRemove), "node ping": L(nodeOps, (m) => m.nodePing),
  "node dispatch": L(dispatchCmds, (m) => m.nodeDispatch),
  "node retry": L(dispatchCmds, (m) => m.nodeRetry),
  "run finish": L(dispatchCmds, (m) => m.runFinish),
  "run verify": L(() => import("./commands/verify.ts"), (m) => m.runVerify),
  "req add": L(() => import("./commands/req.ts"), (m) => m.reqAdd),
  "req link": L(() => import("./commands/req.ts"), (m) => m.reqLink),
  "req evidence": L(() => import("./commands/req.ts"), (m) => m.reqEvidence),
  "req status": L(() => import("./commands/req.ts"), (m) => m.reqStatus),
  "req list": L(() => import("./commands/req.ts"), (m) => m.reqList),
  "req check": L(() => import("./commands/req.ts"), (m) => m.reqCheck),
  "plan apply": L(() => import("./commands/plan.ts"), (m) => m.planApply),
  "msg send": L(() => import("./commands/msg.ts"), (m) => m.msgSend),
  "msg read": L(() => import("./commands/msg.ts"), (m) => m.msgRead),
  "node tell": L(inbox, (m) => m.cmdNodeTell),
  "node ask": L(inbox, (m) => m.cmdNodeAsk),
  "node inbox": L(inbox, (m) => m.cmdNodeInbox),
  "node answer": L(inbox, (m) => m.cmdNodeAnswer),
  "node cancel": L(pause, (m) => m.nodeCancel),
  "run messages": L(inbox, (m) => m.cmdRunMessages),
  "run broadcast": L(inbox, (m) => m.cmdRunBroadcast),
  "run rule": L(inbox, (m) => m.cmdRunRule),
  "run repoint": L(inbox, (m) => m.cmdRunRepoint),
  "orchestrator start": L(() => import("./commands/coordinator.ts"), (m) => m.coordinatorStart),
  "orchestrator register": L(() => import("./commands/pause.ts"), (m) => m.coordinatorRegister),
  "orchestrator rotate": L(() => import("./commands/coordinator.ts"), (m) => m.coordinatorRotate),
  "coordinator start": L(() => import("./commands/coordinator.ts"), (m) => m.coordinatorStart),
  "coordinator register": L(() => import("./commands/pause.ts"), (m) => m.coordinatorRegister),
  "coordinator rotate": L(() => import("./commands/coordinator.ts"), (m) => m.coordinatorRotate),
  "run pause": L(pause, (m) => m.runPause),
  "run resume": L(pause, (m) => m.runResume),
  "run stop": L(pause, (m) => m.runStop),
  "run set": L(pause, (m) => m.runSet),
  "run guard": L(pause, (m) => m.runGuard),
  "run health": L(health, (m) => m.runHealth),
  "node add": L(node, (m) => m.nodeAdd),
  "node update": L(node, (m) => m.nodeUpdate),
  "node report": L(node, (m) => m.nodeReport),
  "node result": L(node, (m) => m.nodeResult),
  "delivery run": L(() => import("./commands/delivery.ts"), (m) => m.deliveryRun),
  "delivery status": L(() => import("./commands/delivery.ts"), (m) => m.deliveryStatus),
  "node quality": L(() => import("./commands/quality.ts"), (m) => m.nodeQuality),
  "node show": L(node, (m) => m.nodeShow),
  "node batch": L(() => import("./commands/node-batch.ts"), (m) => m.nodeBatch),
  "node started": L(timing, (m) => m.nodeStarted),
  "stats context": L(() => import("./commands/stats.ts"), (m) => m.statsContext),
  "run backfill-timing": L(timing, (m) => m.runBackfillTiming),
  "run wait": L(() => import("./commands/wait.ts"), (m) => m.runWait),
  "run watch": L(() => import("./commands/run-watch.ts"), (m) => m.runWatch),
  "run cover": L(() => import("./commands/cover.ts"), (m) => m.runCover),
  "run heal": L(() => import("./commands/heal.ts"), (m) => m.runHeal),
  "suggest learn": L(() => import("./commands/learn.ts"), (m) => m.suggestLearn),
  "run uncover": L(() => import("./commands/cover.ts"), (m) => m.runUncover),
  "run carry": withMonitor(L(() => import("./commands/carry.ts"), (m) => m.runCarry)),
  "run merge": L(() => import("./commands/merge.ts"), (m) => m.runMerge),
  "node replace": L(() => import("./commands/cover.ts"), (m) => m.nodeReplace),
  use: L(() => import("./commands/use.ts"), (m) => m.useCommand),
  "run status": L(() => import("./commands/run.ts"), (m) => m.runStatusCommand),
  "node selections": L(() => import("./commands/selections.ts"), (m) => m.nodeSelections),
  "node verify-owners": L(owners, (m) => m.nodeVerifyOwners),
  "node bind-owners": L(owners, (m) => m.nodeBindOwners),
  "node brief": L(owners, (m) => m.nodeBrief),
  "node activity": L(owners, (m) => m.nodeActivity),
  "owner event": L(owners, (m) => m.ownerEvent),
  "profile list": L(profile, (m) => m.profileList),
  "profile show": L(profile, (m) => m.profileShow),
  "profile pick": L(profile, (m) => m.profilePickCommand),
  "model list": L(profile, (m) => m.modelList),
  "model sync-hub": L(hubModels, (m) => m.modelSyncHub),
  "profile sanity": L(config, (m) => m.profileSanity),
  "profile unset-env": L(config, (m) => m.profileUnsetEnv),
  "profile set-usage": L(config, (m) => m.profileSetUsage),
  "profile sync-overlay": L(config, (m) => m.profileSyncOverlay),
  "settings get": L(config, (m) => (a) => m.settings(["get", ...a])),
  "settings set": L(config, (m) => (a) => m.settings(["set", ...a])),
  "memory add": L(config, (m) => (a) => m.memory(["add", ...a])),
  "memory list": L(config, (m) => (a) => m.memory(["list", ...a])),
  "run advance": L(() => import("./commands/advance.ts"), (m) => m.runAdvance),
  init: L(config, (m) => m.init),
  ...Object.fromEntries(HERDR_VERB_KEYS.map((v): [string, Handler] => [`herdr ${v}`, L(herdr, (m) => (a) => m.herdrCommand(v, a))])),
  "harness list": L(harness, (m) => (a) => m.cmdHarness(["list", ...a])),
  "harness set-usage": L(harness, (m) => (a) => m.cmdHarness(["set-usage", ...a])),
  "hub setup": L(hub, (m) => (a) => m.cmdHub(["setup", ...a])),
  "hub off": L(hub, (m) => (a) => m.cmdHub(["off", ...a])),
  "hub status": L(hub, (m) => (a) => m.cmdHub(["status", ...a])),
  "hub resolve": L(hub, (m) => (a) => m.cmdHub(["resolve", ...a])),
  // `delegate <run> <verb>`: the run id is the second word, so the key is built in main().
  "delegate plan": L(delegate, (m) => (a) => m.delegatePlan(a)),
  "delegate task": L(delegate, (m) => (a) => m.delegateTask(a)),
  "delegate finding": L(delegate, (m) => (a) => m.delegateFinding(a)),
  "delegate show": L(delegate, (m) => (a) => m.delegateShow(a)),
  // One-word commands: the verb is the first handler argument (or a flag).
  serve: L(serve, (m) => m.serveCommand),
  "serve status": L(serve, (m) => m.serveStatus),
  "serve config": L(serve, (m) => m.serveConfig),
  "serve recover": L(serve, (m) => m.serveRecover),
  "serve tls": L(serve, (m) => m.serveTls),
  ui: L(serve, (m) => m.uiCommand),
  artifact: L(serve, (m) => m.artifactCommand),
  suggest: L(() => import("./commands/suggest.ts"), (m) => m.suggestCommand),
  demo: L(() => import("./commands/demo.ts"), (m) => m.demoCommand),
  sync: L(() => import("./commands/suggest.ts"), (m) => m.syncCommand),
  ...Object.fromEntries(LOOP_KEYS.map((k): [string, Handler] => [k, L(loops, (m) => (m.loopCommands as Record<string, Handler>)[k]!)])),
  ...Object.fromEntries(SCHEDULE_KEYS.map((k): [string, Handler] => [k, L(schedules, (m) => (m.scheduleCommands as Record<string, Handler>)[k]!)])),
  announce: L(() => import("./commands/announce.ts"), (m) => m.announce),
  // `feedback <verb>`: the module takes the verb as its first argument.
  ...Object.fromEntries(["add", "list", "show", "update", "work"].map((v): [string, Handler] => [`feedback ${v}`, L(() => import("./commands/feedback.ts"), (m) => (a) => m.feedbackCommand([v, ...a]))])),
};

const ONE_WORD = new Set(["__run-cancel", "prune", "init", "serve", "ui", "artifact", "suggest", "demo", "sync", "use", "ghosts"]);
// Commands the dashboard server answers on its socket (same core function, in its process).
const SOCKET_KEYS = new Set(["suggest", "serve status", "serve config"]);

function resolveCommand(words: string[]): { key: string; skip: number } | null {
  const two = `${words[0]} ${words[1] ?? ""}`.trim();
  if (COMMANDS[two]) return { key: two, skip: 2 };
  if (ONE_WORD.has(words[0] ?? "") && COMMANDS[words[0] ?? ""]) return { key: words[0] ?? "", skip: 1 };
  return null;
}

export function isSocketable(argv: string[]): boolean {
  const { words } = parseArgv(argv);
  const r = words.length ? resolveCommand(words) : null;
  return !!r && SOCKET_KEYS.has(r.key);
}

export function parseArgv(argv: string[]): { flags: Set<string>; words: string[] } {
  const flags = new Set<string>();
  const words: string[] = [];
  for (const a of argv) {
    if (a.startsWith("--")) flags.add(a);
    else words.push(a);
  }
  return { flags, words };
}

const usage = (): string => USAGE;

// After a state mutation, refresh the Herdr label and status line in the background. Debounced (5 s),
// skipped for the dashboard server (ORCH_NO_ANNOUNCE=1) and outside Herdr and agent sessions.
async function announceHook(argv: string[]): Promise<void> {
  const [a, b] = argv;
  const hit = (a === "run" && ["start", "finish", "sync"].includes(b ?? "")) || (a === "node" && ["update", "report", "ping", "dispatch", "batch"].includes(b ?? ""));
  if (!hit || process.env.ORCH_NO_ANNOUNCE === "1") return;
  if (process.env.HERDR_ENV !== "1" && !process.env.CLAUDE_CODE_SESSION_ID && !process.env.OPENCODE_SESSION_ID) return;
  try {
    const home = orchHome();
    const stamp = join(home, ".announce-ts");
    const now = Math.floor(Date.now() / 1000);
    const last = existsSync(stamp) ? Number(readFileSync(stamp, "utf8").trim()) || 0 : 0;
    if (now - last < 5) return;
    mkdirSync(home, { recursive: true });
    const tmp = `${stamp}.${process.pid}`;
    writeFileSync(tmp, `${now}\n`);
    renameSync(tmp, stamp);
    const { BIN_ORCH, spawnDetached } = await import("./state/proc.ts");
    spawnDetached([process.execPath, BIN_ORCH, "announce", "--quiet"], null);
  } catch {}
}

export async function main(argv: string[], opts: { direct?: boolean } = {}): Promise<number> {
  const rc = await mainInner(argv, opts);
  await announceHook(argv);
  return rc;
}

async function mainInner(argv: string[], opts: { direct?: boolean }): Promise<number> {
  const { flags, words } = parseArgv(argv);
  if (flags.has("--version")) {
    process.stdout.write(`orch ${VERSION}\n`);
    return 0;
  }
  if (words.length === 0 || flags.has("--help") || words[0] === "-h") {
    process.stdout.write(usage() + "\n");
    return 0;
  }
  if (words[0] === "doctor" && words.length === 1) return (await import("./commands/doctor.ts")).doctor();
  if (words[0] === "version") {
    process.stdout.write(`orch ${VERSION}\n`);
    return 0;
  }
  if (words[0] === "classify") return (await jobs()).classifyCommand(argv.slice(1));
  if (words[0] === "budget-check") return (await jobs()).budgetCheckCommand();
  if (words[0] === "status") return (await jobs()).statusCommand(argv.slice(1));
  if (words[0] === "tail") return (await jobs()).tailCommand(argv.slice(1));
  if (words[0] === "wait") return (await jobs()).waitCommand(argv.slice(1));
  if (words[0] === "list") return (await jobs()).listCommand();
  // `run (--profile P | <adapter>) <prompt>` and `start ...` spawn an adapter. They take the raw argv
  // (flags included). `run <verb>` stays with the run-state commands.
  const RUN_ADAPTERS = ["--profile", "claude", "claude-native", "cursor-agent", "local-llm", "opencode", "copilot", "pi"];
  if (words[0] === "start" || (words[0] === "run" && (words.length === 1 || RUN_ADAPTERS.includes(argv[1] ?? "")))) {
    const rest = argv.slice(1);
    const sp = await spawn();
    return words[0] === "start" ? sp.cmdStart(rest) : sp.cmdRun(rest);
  }
  if (words[0] === "run-util") return (await pause()).runUtil(argv.slice(1));
  if (words[0] === "adapter-util") return (await import("./commands/adapter-util.ts")).adapterUtil(argv.slice(1));
  if (words[0] === "job-run") return (await spawn()).cmdJobRun(argv.slice(1));
  // Single-word commands take every later argument, so `announce --run <id>` is not read as a verb.
  if (words[0] === "announce" || words[0] === "active") {
    const first = argv.indexOf(words[0]);
    return await COMMANDS[words[0]]!(argv.slice(first + 1));
  }
  // `delegate <run> <verb> ...`: the verb is the third word. The handler gets the run id first, then
  // the rest, so the verb is dropped from argv.
  if (words[0] === "delegate") {
    const dkey = `delegate ${words[2] ?? ""}`.trim();
    const dh = COMMANDS[dkey];
    if (!dh || words.length < 3) {
      process.stderr.write(`usage: ${(await delegate()).DELEGATE_USAGE}\n`);
      return 2;
    }
    const drest: string[] = [];
    let nonflag = 0;
    for (const a of argv) {
      if (a.startsWith("--")) {
        drest.push(a);
        continue;
      }
      nonflag++;
      if (nonflag === 1 || nonflag === 3) continue;
      drest.push(a);
    }
    return await dh(drest);
  }
  // `goal "<objective>"` runs planning and execution from one command.
  if (words[0] === "goal") return await (await import("./commands/goal.ts")).goalCommand(argv.slice(1));
  // `plan <run> "<goal>"`: the run id is the second word; `plan apply <run>` is a normal pair.
  if (words[0] === "plan" && words[1] !== "apply") return await (await import("./commands/plan.ts")).planCommand(argv.slice(1));
  const resolved = resolveCommand(words);
  if (!resolved) {
    const key = `${words[0]} ${words[1] ?? ""}`.trim();
    process.stderr.write(`unknown subcommand: ${words[0]}\n${usage()}\n`);
    return 2;
  }
  const handler = COMMANDS[resolved.key]!;
  if (!opts.direct && process.env.ORCH_DIRECT !== "1" && SOCKET_KEYS.has(resolved.key)) {
    const r = await (await import("./client.ts")).viaServer(orchHome(), argv);
    if (r) {
      process.stdout.write(r.stdout);
      process.stderr.write(r.stderr);
      return r.code;
    }
  }
  // Handlers get every argument after the command words, flags included.
  const rest: string[] = [];
  let skipped = 0;
  for (const a of argv) {
    if (!a.startsWith("--") && skipped < resolved.skip) skipped++;
    else rest.push(a);
  }
  return await handler(rest);
}

if (import.meta.main) {
  process.exitCode = await main(process.argv.slice(2));
}

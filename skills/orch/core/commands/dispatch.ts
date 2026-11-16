// `node dispatch`, `node retry`, `run finish`. Ported from lib/runs/runs.sh (cmd_node_dispatch, node_retry_dispatch,
// cmd_node_retry, cmd_run_finish). The job itself starts through spawnNode (core/adapters).
// Not ported: hub_node_expect (hub-mode expectation record).
import { mkdir, readdir } from "node:fs/promises";
import { join } from "node:path";
import { spawnNode } from "../adapters/spawn.ts";
import { orchHome, paths } from "../state/home.ts";
import { loadRun, type RunState } from "../state/store.ts";
import { nowIso } from "../state/clock.ts";
import { loadProfilesDoc } from "../state/settings.ts";
import { archiveAttempt, ev, findNode, OpError, setStatus, SMART_AUTO_TIERS } from "../runs/node.ts";
import { errLine, mutateRun, resolveRun } from "./node.ts";
import { inboxFiles, markDelivered, readMsg } from "./inbox.ts";
import { pauseGuard } from "./pause.ts";

export const NODE_DISPATCH_USAGE = "dispatch.ts node dispatch <run-id> <node-id> (--profile <name> | <adapter>) <prompt|@file> [args...]";
export const NODE_RETRY_USAGE = "dispatch.ts node retry <run-id> <node-id> [--profile P | <adapter>] [--no-dispatch] [<prompt|@file>]";
export const RUN_FINISH_USAGE = "dispatch.ts run finish <run-id> [--status done|error|cancelled]";
export const RUN_RETRY_USAGE = "dispatch.ts run retry <run-id> [--profile P] [--no-dispatch]";
const RUN_STATUSES = ["done", "error", "cancelled"];
export const VALID_HARNESSES = ["claude", "cursor-agent", "opencode", "local-llm", "copilot", "pi"];
export const ADAPTER_NAMES = ["claude-native", ...VALID_HARNESSES];

const dispatchPath = () => process.env.ORCH_DISPATCH || join(import.meta.dir, "../../scripts/dispatch.ts");

export async function nodeOutDir(home: string, runId: string, nodeId: string, run?: RunState | null): Promise<string> {
  const r = run ?? (await loadRun(home, runId));
  const rec = r ? findNode(r, nodeId)?.out_dir : "";
  return rec ? String(rec) : join(home, "runs", runId, "out", nodeId);
}

async function readTrim(file: string): Promise<string> {
  return (await Bun.file(file).text().catch(() => "")).trim();
}

// node_live_job: the job id of a live job bound to this node, or null.
export async function nodeLiveJob(home: string, runId: string, nodeId: string): Promise<string | null> {
  const names = await readdir(paths.jobs(home)).catch(() => [] as string[]);
  for (const job of names.sort()) {
    if ((await readTrim(join(paths.jobs(home), job, "node"))) !== `${runId}/${nodeId}`) continue;
    const pid = Number(await readTrim(join(paths.jobs(home), job, "pid")));
    if (!pid) continue;
    try {
      process.kill(pid, 0);
      return job;
    } catch {
      /* not alive */
    }
  }
  return null;
}

async function inboxRulesBlock(run: RunState, runId: string, node: string): Promise<string> {
  const rules = ((run.rules ?? []) as any[]).map((r) => `- ${r.text}`).join("\n");
  let s = rules ? `## Run rules\n\n${rules}\n\n` : "";
  s += `Messages: the coordinator can send you messages. Read them with \`dispatch.ts node inbox ${runId} ${node}\` between steps. Ask the coordinator with \`dispatch.ts node ask ${runId} ${node} "<question>"\`.\n`;
  return s;
}

async function inboxRetryPrefix(home: string, runId: string, node: string): Promise<string> {
  let body = "";
  for (const f of await inboxFiles(home, runId, node)) {
    const m = await readMsg(f);
    if (m.status !== "pending" || m.kind === "answer") continue;
    body += `- [${m.id} from ${m.from}] ${m.text}\n`;
    await markDelivered(f, "retry");
  }
  return body ? `# Messages sent while you were not running\n\n${body}\n` : "";
}

async function inboxAnswersPrefix(home: string, runId: string, node: string): Promise<string> {
  let body = "";
  for (const f of await inboxFiles(home, runId, node)) {
    const m = await readMsg(f);
    if (m.kind !== "answer" || m.status !== "pending") continue;
    body += `- ${m.text}\n`;
    await markDelivered(f, "retry");
  }
  return body ? `Unread answers from the coordinator:\n${body}\n` : "";
}

export function smartAutoTierOf(model: string): string {
  const m = /smart-auto-([a-z]+)$/.exec(model);
  return m && SMART_AUTO_TIERS.includes(m[1]) ? m[1] : "";
}

export interface DispatchOpts {
  force?: boolean;
  resume?: string;
}

// Starts a waiting node. rest = (--profile P | adapter) <prompt> [args...], or <prompt> alone (the node's profile).
export async function dispatchNodeJob(home: string, runId: string, nodeId: string, restIn: string[], o: DispatchOpts = {}): Promise<{ rc: number; jobId: string }> {
  const fail = (m: string, rc = 2) => (errLine(m), { rc, jobId: "" });
  let rest = [...restIn];
  const run = await loadRun(home, runId);
  if (!run) return fail(`run ${runId}: unknown run`);
  const node = findNode(run, nodeId);
  if (!node) return fail(`node ${nodeId}: not in this run`);
  if (node.status !== "waiting") return fail(`node dispatch: ${nodeId} is ${node.status}, not waiting`);
  if (!o.force && process.env.ORCH_NODE_DISPATCH_FORCE !== "1") {
    const live = await nodeLiveJob(home, runId, nodeId);
    if (live) return fail(`node dispatch: ${nodeId} already has live job ${live}; pass --force to start another`);
  }
  if (rest[0] !== "--profile" && !ADAPTER_NAMES.includes(rest[0])) {
    const p = String(node.profile ?? "");
    if (!p) return fail(`node dispatch: ${nodeId} has no profile; pass --profile or an adapter`);
    rest = ["--profile", p, ...rest];
  }
  const isProfile = rest[0] === "--profile";
  const targetName = isProfile ? rest[1] ?? "" : rest[0];
  const promptIdx = isProfile ? 2 : 1;
  const rawPrompt = rest[promptIdx] ?? "";
  let prompt = rawPrompt;
  if (!rawPrompt.startsWith("@")) {
    let inject = "";
    if (((run.rules ?? []) as any[]).length > 0) inject = await inboxRulesBlock(run, runId, nodeId);
    inject += await inboxRetryPrefix(home, runId, nodeId);
    const answers = await inboxAnswersPrefix(home, runId, nodeId);
    if (inject || answers) prompt = `${answers}${rawPrompt}\n\n${inject}`;
  }
  const passArgs = rest.slice(promptIdx + 1);

  const outDir = await nodeOutDir(home, runId, nodeId, run);
  try {
    await mkdir(outDir, { recursive: true });
  } catch {
    return fail(`node dispatch: cannot create ${outDir}`, 1);
  }
  const attempt = ((node.attempts ?? []) as any[]).length + 1;
  let tier = String(node.tier ?? "");
  let newTier = "";
  if (!tier && isProfile) {
    const doc = await loadProfilesDoc(home);
    tier = smartAutoTierOf(String(doc.profiles?.[targetName]?.model ?? ""));
    newTier = tier;
  }
  const env: Record<string, string> = {
    ORCH_NODE_OUT: outDir,
    ORCH_RUN_ID: runId,
    ORCH_NODE_ID: nodeId,
    ORCH_DISPATCH: dispatchPath(),
    HARNESS_ORCH_HOME: home,
    ORCH_NODE_ATTEMPT: String(attempt),
    ORCH_NODE_ROLE: String(node.role ?? ""),
    ORCH_NODE_TIER: tier,
    ORCH_NODE_ACCEPTANCE: String(node.acceptance ?? ""),
  };
  let jobId: string;
  try {
    ({ jobId } = await spawnNode({ home, runId, nodeId, target: { kind: isProfile ? "profile" : "adapter", name: targetName }, prompt, args: passArgs, env, resumeSession: o.resume || process.env.ORCH_RESUME_SESSION || undefined }));
  } catch (e) {
    return { rc: Number((e as any).code) || 1, jobId: "" };
  }
  const jobDir = join(paths.jobs(home), jobId);
  await Bun.write(join(jobDir, "node"), `${runId}/${nodeId}\n`);
  const adapter = await readTrim(join(jobDir, "adapter"));
  const [profile, session, model, modelId] = await Promise.all(["profile", "session", "model", "model_id"].map((f) => readTrim(join(jobDir, f))));
  const transport = adapter === "claude" || adapter === "opencode" ? "headers" : adapter === "claude-native" ? "" : "preset-model";
  const rc = await mutateRun(home, runId, (r, ctx) => {
    const n = findNode(r, nodeId);
    if (!n) throw new OpError(`node ${nodeId}: not in this run`);
    if (newTier) n.tier = newTier;
    n.metadata_transport = transport || null;
    n.worker_identity = transport === "headers" ? `${runId}/${nodeId}/${attempt}` : null;
    setStatus(r, nodeId, "running", jobId, "", "", "", ctx, true);
    if (adapter) n.adapter = adapter;
    if (profile) n.profile = profile;
    if (session) n.session = session;
    if (model) n.model = model;
    if (modelId) n.model_id = modelId;
    n.prompt = rawPrompt;
    n.dispatch_args = passArgs;
  });
  if (rc !== 0) return { rc: 1, jobId };
  const pane = await readTrim(join(jobDir, "herdr_pane"));
  if (pane) {
    const hh = await readTrim(join(jobDir, "herdr_home"));
    errLine(`node dispatch: ${nodeId} runs in herdr pane ${pane}; reach it with HOME=${hh} herdr pane read|send-text ${pane}`);
  }
  return { rc: 0, jobId };
}

export async function nodeDispatch(args: string[]): Promise<number> {
  const [runArg = "", nodeId = "", third = ""] = args;
  if (!runArg || !nodeId || !third) {
    errLine(`usage: ${NODE_DISPATCH_USAGE}`);
    return 2;
  }
  const home = orchHome();
  const runId = await resolveRun(home, runArg);
  if (runId === null) return 1;
  const guard = await pauseGuard(home, runId, true);
  if (guard !== 0) return guard;
  const force = args.slice(2).includes("--force");
  const rest = args.slice(2).filter((a) => a !== "--force");
  if (rest.length === 0) {
    errLine(`usage: ${NODE_DISPATCH_USAGE}`);
    return 2;
  }
  const { rc, jobId } = await dispatchNodeJob(home, runId, nodeId, rest, { force });
  if (rc === 0) process.stdout.write(jobId + "\n");
  return rc;
}

// Target args for a stored node: its profile, else its adapter.
function targetArgs(override: string, profile: string, adapter: string): string[] | null {
  if (override) return ADAPTER_NAMES.includes(override) ? [override] : ["--profile", override];
  if (profile) return ["--profile", profile];
  if (adapter) return [adapter];
  return null;
}

export async function nodeDispatchStored(home: string, runId: string, nodeId: string, prompt: string): Promise<{ rc: number; jobId: string }> {
  const run = await loadRun(home, runId);
  const n = run ? findNode(run, nodeId) : undefined;
  const target = targetArgs("", String(n?.profile ?? ""), String(n?.adapter ?? ""));
  const extra = ((n?.dispatch_args ?? []) as string[]).filter((a) => a !== "");
  return dispatchNodeJob(home, runId, nodeId, [...(target ?? []), prompt, ...extra]);
}

const resumeOk = (adapter: string, session: string) => ["claude", "copilot", "opencode"].includes(adapter) || (adapter === "cursor-agent" && session.startsWith("cursor:"));

function errorSummary(n: Record<string, any>): string {
  const t = n.error ? String(n.error) : ((n.log_tail ?? []) as string[]).join(" | ");
  return t.slice(0, 500);
}

// profile_require: false (after printing the problem) when the profile does not exist.
export async function profileRequire(home: string, name: string): Promise<boolean> {
  const doc = await loadProfilesDoc(home);
  if (doc.profiles?.[name]) return true;
  const avail = Object.keys((doc as any).profiles ?? {}).sort().join(", ");
  errLine(`profile ${name}: unknown profile. Available: ${avail}`);
  return false;
}

export async function retryDispatch(home: string, runId: string, nodeId: string, override: string, noDispatch: boolean, reason: string, supplied: string, force: boolean): Promise<{ rc: number; jobId: string; out?: string }> {
  const fail = (m: string) => (errLine(m), { rc: 2, jobId: "" });
  const run = (await loadRun(home, runId))!;
  const n = findNode(run, nodeId)!;
  if (!["error", "skipped", "stopped"].includes(n.status)) return fail(`node retry: ${nodeId} is ${n.status}, not error or skipped`);
  const prompt = String(n.prompt ?? "") || supplied;
  const doc = await loadProfilesDoc(home);
  const harnessOf = (p: string) => String(doc.profiles?.[p]?.harness ?? "");
  let profile = String(n.profile ?? "");
  let adapter = String(n.adapter ?? "");
  const oldProfile = profile;
  let oldAdapter = adapter;
  const prevSession = String(n.session ?? "");
  if (!oldAdapter && oldProfile) oldAdapter = harnessOf(oldProfile);
  if (override) {
    if (ADAPTER_NAMES.includes(override)) {
      profile = "";
      adapter = override;
    } else {
      profile = override;
      adapter = "";
      if (!(await profileRequire(home, profile))) return { rc: 2, jobId: "" };
    }
  }
  let target = adapter;
  if (!target && profile) target = harnessOf(profile);
  const summary = errorSummary(n);
  let mode = "";
  let resume = "";
  let dispatchPrompt = prompt;
  if (!noDispatch && prompt && prevSession && target === oldAdapter && resumeOk(target, prevSession)) {
    mode = "resumed";
    resume = prevSession;
    dispatchPrompt = supplied || `The previous attempt stopped with: ${summary || "unknown error"}.\nContinue the same task from where you left off; check $ORCH_NODE_OUT for any partial handoff or notes from the previous attempt.\n`;
  } else if (!noDispatch && prompt) {
    mode = "restarted";
    let original = prompt;
    if (prompt.startsWith("@")) {
      const f = Bun.file(prompt.slice(1));
      if (!(await f.exists())) {
        errLine(`resolve_prompt: prompt file not found: ${prompt.slice(1)}`);
        return { rc: 1, jobId: "" };
      }
      original = await f.text();
    }
    dispatchPrompt = `Previous attempt on ${oldProfile || "unknown profile"} failed with: ${summary || "unknown error"}.\nPartial work may already exist in the repo and in $ORCH_NODE_OUT. Inspect before changing files and continue carefully.\n\n${original}\n`;
  }
  const now = nowIso();
  await mutateRun(home, runId, (r, ctx) => {
    const x = findNode(r, nodeId)!;
    archiveAttempt(x, reason, mode, resume);
    Object.assign(x, { status: "waiting", job_id: null, adapter: adapter || null, profile: profile || null, session: null, started: null, finished: null, error: null, log_tail: [], cost: null, actual_model: null, updated: now, next_retry_at: null });
    ev(ctx, "retry", nodeId, "", "waiting", "");
    if (r.finished != null) {
      r.status = "running";
      r.finished = null;
    }
    if ((noDispatch || !prompt) && prompt) x.prompt = prompt;
  });
  if (noDispatch || !prompt) return { rc: 0, jobId: "", out: `waiting: ${nodeId}\n` };
  const target2 = targetArgs(override, profile, adapter);
  if (!target2) return fail(`node retry: ${nodeId} has no profile or adapter; pass --profile or an adapter`);
  const extra = ((n.dispatch_args ?? []) as string[]).filter((a) => a !== "");
  const res = await dispatchNodeJob(home, runId, nodeId, [...target2, dispatchPrompt, ...extra], { force, resume });
  if (res.rc !== 0) return res;
  await mutateRun(home, runId, (r) => {
    findNode(r, nodeId)!.prompt = prompt;
  });
  return res;
}

export async function nodeRetry(args: string[]): Promise<number> {
  const [runArg = "", nodeId = ""] = args;
  if (!runArg || !nodeId) {
    errLine(`usage: ${NODE_RETRY_USAGE}`);
    return 2;
  }
  const home = orchHome();
  const runId = await resolveRun(home, runArg);
  if (runId === null) return 1;
  let override = "";
  let noDispatch = false;
  let force = false;
  let prompt = "";
  const rest = args.slice(2);
  for (let i = 0; i < rest.length; i++) {
    const a = rest[i];
    if (a === "--profile") override = rest[++i] ?? "";
    else if (a === "--no-dispatch") noDispatch = true;
    else if (a === "--force") force = true;
    else if (a.startsWith("--")) {
      errLine(`node retry: unknown argument ${a}\n  usage: ${NODE_RETRY_USAGE}`);
      return 2;
    } else if (!override && ADAPTER_NAMES.includes(a)) override = a;
    else if (!prompt) prompt = a;
    else {
      errLine(`node retry: pass at most one prompt\n  usage: ${NODE_RETRY_USAGE}`);
      return 2;
    }
  }
  const run = await loadRun(home, runId);
  if (!run) return (errLine(`run ${runId}: unknown run`), 2);
  if (!findNode(run, nodeId)) return (errLine(`node ${nodeId}: not in this run`), 2);
  if (!force) {
    const live = await nodeLiveJob(home, runId, nodeId);
    if (live) return (errLine(`node retry: ${nodeId} already has live job ${live}; pass --force to start another`), 2);
  }
  const res = await retryDispatch(home, runId, nodeId, override, noDispatch, "manual retry", prompt, force);
  if (res.out) process.stdout.write(res.out);
  if (res.rc === 0 && res.jobId) process.stdout.write(res.jobId + "\n");
  return res.rc;
}

async function learningAfterFinish(home: string): Promise<void> {
  const doc = await loadProfilesDoc(home);
  if (String(doc.settings?.["learning.auto_scan_on_finish"] ?? "true") !== "true") return;
  const p = Bun.spawn([process.execPath, dispatchPath(), "suggest", "scan"], { env: { ...process.env, HARNESS_ORCH_HOME: home }, stdout: "ignore", stderr: "ignore" });
  await p.exited;
}

export async function runFinish(args: string[]): Promise<number> {
  const [runArg = ""] = args;
  if (!runArg) return (errLine(`usage: ${RUN_FINISH_USAGE}`), 2);
  let status = "";
  const rest = args.slice(1);
  for (let i = 0; i < rest.length; i++) {
    if (rest[i] === "--status") status = rest[++i] ?? "";
    else return (errLine(`run finish: unknown argument ${rest[i]}`), 2);
  }
  const home = orchHome();
  const runId = await resolveRun(home, runArg);
  if (runId === null) return 1;
  let final = "";
  const rc = await mutateRun(home, runId, (run, ctx) => {
    final = status || (run.nodes.some((n) => n.status === "error") ? "error" : "done");
    if (!RUN_STATUSES.includes(final)) throw new OpError(`run finish: status must be one of: ${RUN_STATUSES.join(" ")}`);
    run.status = final;
    run.finished = ctx.now;
    ev(ctx, "run", "", "", final, "");
  });
  if (rc !== 0) return rc;
  await learningAfterFinish(home);
  process.stdout.write(final + "\n");
  return 0;
}

// `node dispatch`, `node retry`, `run finish`. Ported from lib/runs/runs.sh (cmd_node_dispatch, node_retry_dispatch,
// cmd_node_retry, cmd_run_finish). The job itself starts through spawnNode (core/adapters).
import { profileAllowedFor, usageRefusal } from "../../../../src/shared/profile-usage.ts";
import { mkdir, readdir } from "node:fs/promises";
import { join } from "node:path";
import { spawnNode } from "../adapters/spawn.ts";
import { hubNodeExpect } from "../adapters/hub.ts";
import { nodeModelOverride } from "../adapters/routing.ts";
import { orchHome, paths } from "../state/home.ts";
import { loadRun, type RunState } from "../state/store.ts";
import { nowIso } from "../state/clock.ts";
import { loadProfilesDoc } from "../state/settings.ts";
import { acquireLock } from "../state/lock.ts";
import { archiveAttempt, ev, findNode, OpError, setStatus, SMART_AUTO_TIERS } from "../runs/node.ts";
import { errLine, mutateRun, resolveRun } from "./node.ts";
import { inboxFiles, markDelivered, readMsg } from "./inbox.ts";
import { pauseGuard } from "./pause.ts";
import { closureProblems } from "../runs/closure.ts";
import { learningAfterFinish } from "./suggest.ts";

export const NODE_DISPATCH_USAGE = "dispatch.ts node dispatch <run-id> <node-id> (--profile <name> | <adapter>) <prompt|@file> [args...]";
export const NODE_RETRY_USAGE = "dispatch.ts node retry <run-id> <node-id> [--profile P | <adapter>] [--no-dispatch] [--force] [--early-end] [<prompt|@file>]";
export const RUN_FINISH_USAGE = "dispatch.ts run finish <run-id> [--status done|error|cancelled] [--force --reason T]";
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

const NODE_LOCK_TRIES = 600;
const NODE_LOCK_SLEEP_MS = 50;
const nodeChains = new Map<string, Promise<unknown>>();

// One dispatch or retry per node at a time: an in-process chain (the lock file is per pid, so two callers in one
// process would both pass it) and a lock file (two processes). A caller that waits finds the node already running
// and the live job, and refuses; so a node never gets two jobs.
export async function withNodeLock<T>(home: string, runId: string, nodeId: string, fn: () => Promise<T>): Promise<T> {
  const key = `${home}\0${runId}/${nodeId}`;
  const prev = nodeChains.get(key) ?? Promise.resolve();
  const run = prev.catch(() => undefined).then(async () => {
    const lock = await acquireLock(home, `node-${runId}-${nodeId}`, NODE_LOCK_TRIES, NODE_LOCK_SLEEP_MS);
    if (!lock) throw new OpError(`node ${nodeId}: another dispatch or retry holds its lock`);
    try {
      return await fn();
    } finally {
      await lock.release();
    }
  });
  nodeChains.set(key, run);
  try {
    return await run;
  } finally {
    if (nodeChains.get(key) === run) nodeChains.delete(key);
  }
}

// node_live_job: the job id of a live job bound to this node, or null.
export async function nodeLiveJob(home: string, runId: string, nodeId: string): Promise<string | null> {
  const names = await readdir(paths.jobs(home)).catch(() => [] as string[]);
  for (const job of names.sort()) {
    if ((await readTrim(join(paths.jobs(home), job, "node"))) !== `${runId}/${nodeId}`) continue;
    const pid = Number(await readTrim(join(paths.jobs(home), job, "pid")));
    if (!pid) continue;
    const exitCode = await readTrim(join(paths.jobs(home), job, "exit_code"));
    if (exitCode !== "") continue;
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
  s += `Messages: the orchestrator can send you messages. Read them with \`dispatch.ts node inbox ${runId} ${node}\` between steps. Ask the orchestrator with \`dispatch.ts node ask ${runId} ${node} "<question>"\`.\n`;
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
  return m && SMART_AUTO_TIERS.includes(m[1]!) ? m[1]! : "";
}

export interface DispatchOpts {
  force?: boolean;
  resume?: string;
  /** The caller already holds the node lock (retry). */
  locked?: boolean;
}

// Starts a waiting node. rest = (--profile P | adapter) <prompt> [args...], or <prompt> alone (the node's profile).
export async function dispatchNodeJob(home: string, runId: string, nodeId: string, restIn: string[], o: DispatchOpts = {}): Promise<{ rc: number; jobId: string }> {
  if (o.locked) return dispatchNodeJobLocked(home, runId, nodeId, restIn, o);
  try {
    return await withNodeLock(home, runId, nodeId, () => dispatchNodeJobLocked(home, runId, nodeId, restIn, { ...o, locked: true }));
  } catch (e) {
    if (!(e instanceof OpError)) throw e;
    errLine(e.message);
    return { rc: 2, jobId: "" };
  }
}

async function dispatchNodeJobLocked(home: string, runId: string, nodeId: string, restIn: string[], o: DispatchOpts): Promise<{ rc: number; jobId: string }> {
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
  if (rest[0] !== "--profile" && !ADAPTER_NAMES.includes(rest[0] ?? "")) {
    const p = String(node.profile ?? "");
    if (!p) return fail(`node dispatch: ${nodeId} has no profile; pass --profile or an adapter`);
    rest = ["--profile", p, ...rest];
  }
  const isProfile = rest[0] === "--profile";
  const targetName = isProfile ? rest[1] ?? "" : rest[0]!;
  const promptIdx = isProfile ? 2 : 1;
  const rawPrompt = rest[promptIdx] ?? "";
  const nodeGoal = String(node.label ?? "");
  let prompt = appendNodeGoal(rawPrompt, nodeGoal);
  if (!rawPrompt.startsWith("@")) {
    let inject = "";
    if (((run.rules ?? []) as any[]).length > 0) inject = await inboxRulesBlock(run, runId, nodeId);
    inject += await inboxRetryPrefix(home, runId, nodeId);
    const answers = await inboxAnswersPrefix(home, runId, nodeId);
    if (inject || answers) prompt = `${answers}${rawPrompt}\n\n${inject}`;
  }
  const passArgs = rest.slice(promptIdx + 1);

  const outDir = await nodeOutDir(home, runId, nodeId, run);
  if (prompt.startsWith("@")) {
    const text = await Bun.file(prompt.slice(1)).text().catch(() => null);
    if (text !== null) prompt = withHandoffFooter(text, outDir, runId, nodeId);
  } else {
    prompt = withHandoffFooter(prompt, outDir, runId, nodeId);
  }
  try {
    await mkdir(outDir, { recursive: true });
    await Bun.write(join(outDir, "goal.md"), `${nodeGoal}\n`);
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
    ORCH_NODE_GOAL: nodeGoal,
    ORCH_NODE_GOAL_FILE: join(outDir, "goal.md"),
    ORCH_RUN_ID: runId,
    ORCH_NODE_ID: nodeId,
    ORCH_NODE_LABEL: String(node.label ?? nodeId),
    ORCH_DISPATCH: dispatchPath(),
    HARNESS_ORCH_HOME: home,
    ORCH_NODE_ATTEMPT: String(attempt),
    ORCH_NODE_ROLE: String(node.role ?? ""),
    ORCH_NODE_TIER: tier,
    ORCH_NODE_ACCEPTANCE: String(node.acceptance ?? ""),
  };
  if (isProfile) {
    // An explicit node model overrides the profile model. ORCH_MODEL_ID is the per-job seam loadProfile reads.
    const ov = nodeModelOverride((await loadProfilesDoc(home)) as any, targetName, String(node.model ?? ""));
    if (ov.error) throw new OpError(`node dispatch: ${nodeId}: ${ov.error}`);
    if (ov.modelId) env.ORCH_MODEL_ID = ov.modelId;
  }
  await hubNodeExpect(runId, nodeId, tier, String(node.role ?? ""), `${runId}/${nodeId}/${attempt}`).catch(() => 0);
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

// opencode resumes only a real `ses_` session id (adapterOpencode ignores any other value and starts a new session).
const resumeOk = (adapter: string, session: string) =>
  ["claude", "copilot"].includes(adapter) || (adapter === "opencode" && session.startsWith("ses")) || (adapter === "cursor-agent" && session.startsWith("cursor:"));

// The session id a retry resumes: the job's own `session` (claude, copilot, cursor), and for opencode the `ses_` id the owner bind found.
export function resumeSessionOf(n: Record<string, any>, adapter: string): string {
  const own = String(n.session ?? "");
  if (adapter !== "opencode") return own;
  const owner = String(n.owner_id ?? "");
  if (owner.startsWith("ses_") && (n.owner_kind ?? "session") === "session") return owner;
  return own;
}

// Every node prompt ends with where its handoff goes. A prompt that already names ORCH_NODE_OUT (the footer does too) is left as is, so a retry or resume never adds a second footer.
export function withHandoffFooter(prompt: string, outDir: string, runId: string, nodeId: string): string {
  if (prompt.includes("ORCH_NODE_OUT")) return prompt;
  return `${prompt.trimEnd()}\n\n---\nHandoff: write ${outDir}/handoff.md ($ORCH_NODE_OUT/handoff.md). agent-spec/ is not the handoff.\nThen record: dispatch.ts node result ${runId} ${nodeId} --verdict full|partial|blocked --summary "<one sentence>" --follow-up "<findings or none>"\n`;
}

// A prompt that only points at the node goal gets the goal text appended, so the agent does not need a lookup.
const SEE_GOAL_ONLY = /^\s*see (?:the )?node goal\.?\s*$/i;
export function appendNodeGoal(prompt: string, goal: string): string {
  if (!goal || !SEE_GOAL_ONLY.test(prompt)) return prompt;
  return `${prompt.trim()}\n\n## Your task\n${goal}\n`;
}

export const EARLY_END_MESSAGE = "You ended early. Read your task and handoff notes, continue, and write handoff.md in $ORCH_NODE_OUT before you finish. Do not ask a question: decide and continue. Do not end your turn while a background command you started is still running: wait for it and read its result. Finish the task, then write the handoff and record the result.";
export const MAX_EARLY_END_RESUMES = 2;

function errorSummary(n: Record<string, any>): string {
  const t = n.error ? String(n.error) : ((n.log_tail ?? []) as string[]).join(" | ");
  return t.slice(0, 500);
}

// profile_require: false (after printing the problem) when the profile does not exist.
export async function profileRequire(home: string, name: string): Promise<boolean> {
  const doc = await loadProfilesDoc(home);
  if (doc.profiles?.[name]) {
    const why = usageRefusal(doc, name, "runs");
    if (why === null) return true;
    errLine(why);
    return false;
  }
  const avail = Object.keys((doc as any).profiles ?? {}).sort().join(", ");
  errLine(`profile ${name}: unknown profile. Available: ${avail}`);
  return false;
}

export async function retryDispatch(home: string, runId: string, nodeId: string, override: string, noDispatch: boolean, reason: string, supplied: string, force: boolean, earlyEnd = false): Promise<{ rc: number; jobId: string; out?: string }> {
  try {
    return await withNodeLock(home, runId, nodeId, () => retryDispatchLocked(home, runId, nodeId, override, noDispatch, reason, supplied, force, earlyEnd));
  } catch (e) {
    if (!(e instanceof OpError)) throw e;
    errLine(e.message);
    return { rc: 2, jobId: "" };
  }
}

async function retryDispatchLocked(home: string, runId: string, nodeId: string, override: string, noDispatch: boolean, reason: string, supplied: string, force: boolean, earlyEnd: boolean): Promise<{ rc: number; jobId: string; out?: string }> {
  const fail = (m: string) => (errLine(m), { rc: 2, jobId: "" });
  const run = await loadRun(home, runId);
  const n = run ? findNode(run, nodeId) : undefined;
  if (!run || !n) return fail(`node ${nodeId}: not in this run`);
  const retryable = earlyEnd ? ["done", "error", "skipped", "stopped"] : ["error", "skipped", "stopped"];
  if (!retryable.includes(n.status)) return fail(`node retry: ${nodeId} is ${n.status}, not error or skipped`);
  if (!force) {
    const live = await nodeLiveJob(home, runId, nodeId);
    if (live) return fail(`node retry: ${nodeId} already has live job ${live}; pass --force to start another`);
  }
  const resumesSoFar = Number(n.resumes ?? 0);
  if (earlyEnd && resumesSoFar >= MAX_EARLY_END_RESUMES && !force) {
    return fail(`node retry: ${nodeId} was already resumed ${resumesSoFar} times after an early end (max ${MAX_EARLY_END_RESUMES}); pass --force`);
  }
  const prompt = String(n.prompt ?? "");
  const doc = await loadProfilesDoc(home);
  const harnessOf = (p: string) => String(doc.profiles?.[p]?.harness ?? "");
  let profile = String(n.profile ?? "");
  let adapter = String(n.adapter ?? "");
  const oldProfile = profile;
  let oldAdapter = adapter;
  if (!oldAdapter && oldProfile) oldAdapter = harnessOf(oldProfile);
  const prevSession = resumeSessionOf(n, oldAdapter);
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
  if (!noDispatch && (prompt || supplied) && prevSession && target === oldAdapter && resumeOk(target, prevSession)) {
    mode = "resumed";
    resume = prevSession;
    const continuation = supplied || (earlyEnd ? EARLY_END_MESSAGE : "") || `The previous attempt stopped with: ${summary || "unknown error"}.\nContinue the same task from where you left off; check $ORCH_NODE_OUT for any partial handoff or notes from the previous attempt.\n`;
    dispatchPrompt = continuation;
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
    dispatchPrompt = earlyEnd
      ? `${supplied || EARLY_END_MESSAGE}\nThe previous attempt on ${oldProfile || "unknown profile"} ended without a handoff. Partial work may already exist in the repo and in $ORCH_NODE_OUT.\n\n${withHandoffFooter(original, await nodeOutDir(home, runId, nodeId, run), runId, nodeId)}\n`
      : `Previous attempt on ${oldProfile || "unknown profile"} failed with: ${summary || "unknown error"}.\nPartial work may already exist in the repo and in $ORCH_NODE_OUT. Inspect before changing files and continue carefully.\n\n${withHandoffFooter(original, await nodeOutDir(home, runId, nodeId, run), runId, nodeId)}\n`;
  }
  const now = nowIso();
  await mutateRun(home, runId, (r, ctx) => {
    const x = findNode(r, nodeId)!;
    archiveAttempt(x, reason, mode, resume);
    if (earlyEnd) {
      x.resumes = Number(x.resumes ?? 0) + 1;
      x.unverified = null;
      ev(ctx, "resumed", nodeId, String(x.status ?? ""), "waiting", `early end, ${mode === "resumed" ? `resumed session ${resume}` : "restarted (no resumable session)"}, ${x.resumes} of ${MAX_EARLY_END_RESUMES}`);
    }
    Object.assign(x, { status: "waiting", job_id: null, adapter: adapter || null, profile: profile || null, session: null, started: null, finished: null, error: null, log_tail: [], cost: null, actual_model: null, updated: now, next_retry_at: null });
    ev(ctx, "retry", nodeId, "", "waiting", "");
    if (r.finished != null && r.status !== "covered") {
      r.status = "running";
      r.finished = null;
    }
    if ((noDispatch || !prompt) && prompt) x.prompt = prompt;
  });
  if (noDispatch || (!prompt && !supplied)) return { rc: 0, jobId: "", out: `waiting: ${nodeId}\n` };
  const target2 = targetArgs(override, profile, adapter);
  if (!target2) return fail(`node retry: ${nodeId} has no profile or adapter; pass --profile or an adapter`);
  const extra = ((n.dispatch_args ?? []) as string[]).filter((a) => a !== "");
  const res = await dispatchNodeJob(home, runId, nodeId, [...target2, dispatchPrompt, ...extra], { force, resume, locked: true });
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
  let earlyEnd = false;
  let prompt = "";
  const rest = args.slice(2);
  for (let i = 0; i < rest.length; i++) {
    const a = rest[i]!;
    if (a === "--profile") override = rest[++i] ?? "";
    else if (a === "--no-dispatch") noDispatch = true;
    else if (a === "--force") force = true;
    else if (a === "--early-end") earlyEnd = true;
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
  const res = await retryDispatch(home, runId, nodeId, override, noDispatch, earlyEnd ? "early end, resumed" : "manual retry", prompt, force, earlyEnd);
  if (res.out) process.stdout.write(res.out);
  if (res.rc === 0 && res.jobId) process.stdout.write(res.jobId + "\n");
  return res.rc;
}

export async function runFinish(args: string[]): Promise<number> {
  const [runArg = ""] = args;
  if (!runArg) return (errLine(`usage: ${RUN_FINISH_USAGE}`), 2);
  let status = "";
  let force = false;
  let reason = "";
  const rest = args.slice(1);
  for (let i = 0; i < rest.length; i++) {
    if (rest[i] === "--status") status = rest[++i] ?? "";
    else if (rest[i] === "--force") force = true;
    else if (rest[i] === "--reason") {
      reason = rest[i + 1] ?? "";
      if (reason === "" || reason.startsWith("--")) return (errLine(`run finish: --reason expects a text, not a flag\n  usage: ${RUN_FINISH_USAGE}`), 2);
      i++;
    }
    else return (errLine(`run finish: unknown argument ${rest[i]}`), 2);
  }
  if (force && !reason) return (errLine(`run finish: --force needs --reason "<why>"\n  usage: ${RUN_FINISH_USAGE}`), 2);
  const home = orchHome();
  const runId = await resolveRun(home, runArg);
  if (runId === null) return 1;
  const pre = await loadRun(home, runId);
  if (!pre) return (errLine(`run ${runId}: unknown run`), 2);
  // The closure gate holds even with --force: a run never becomes done while work is open or the done-gate has not run.
  const closing = status === "" ? !pre.nodes.some((n) => n.status === "error") : status === "done";
  if (closing && pre.status !== "covered") {
    const open = closureProblems(pre);
    if (open.length > 0) return (errLine(`run finish refused: ${open.join("; ")}\n  fix: dispatch.ts run advance ${runId}, or skip each node with a reason: dispatch.ts node update ${runId} <node> skipped --force --reason "<why>"`), 1);
  }
  if (!force && status !== "cancelled") {
    const { verifyRun, formatFailures } = await import("./verify.ts");
    const fails = await verifyRun(home, runId, pre);
    if (fails.length > 0) {
      errLine(`run finish refused: ${fails.length} verify failure(s)\n${formatFailures(fails)}fix them, or: dispatch.ts run finish ${runId} --force --reason "<why>"`);
      return 1;
    }
  }
  let final = "";
  const rc = await mutateRun(home, runId, (run, ctx) => {
    final = status || (run.nodes.some((n) => n.status === "error") ? "error" : "done");
    if (!RUN_STATUSES.includes(final)) throw new OpError(`run finish: status must be one of: ${RUN_STATUSES.join(" ")}`);
    if (run.status !== "covered") run.status = final;
    run.finished = ctx.now;
    if (force) run.force_finish_reason = reason;
    ev(ctx, "run", "", "", final, force ? `forced: ${reason}` : "");
  });
  if (rc !== 0) return rc;
  learningAfterFinish(home, true);
  process.stdout.write((pre.status === "covered" ? "covered" : final) + "\n");
  return 0;
}

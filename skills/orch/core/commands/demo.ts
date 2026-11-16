// Mock demo data: seeds runs that look like real orchestration so the dashboard has something to show.
// Nothing here spawns a harness or spends a token; every log is written, not earned. Adapters are
// passed explicitly, so a seeded demo renders in a state dir whose profiles have changed.
import { existsSync, mkdirSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { env, err, home as ioHome, out } from "../io.ts";
import { nowIso } from "../state/clock.ts";
import { loadRun } from "../state/store.ts";
import { trashPath } from "../state/trash.ts";
import { applyAdd, parseAddArgs, type Ctx } from "../runs/node.ts";
import { mutateRun } from "./node.ts";
import { dispatchSh, learningAfterFinish, memoryAdd } from "./suggest.ts";
import { ensureHome } from "./serve.ts";

export const DEMO_USAGE = "dispatch.sh demo seed [--graph] [--force] | demo reset [--force] | demo advance [--run <id>]";
const MARKER = "demo.marker";
const LOG_TAIL_LINES = 20;

const runsHome = (h: string) => join(h, "runs");
const jobsHome = (h: string) => join(h, "jobs");
const defaultHome = () => join(env().HOME ?? "", ".harness-orch");

function guardHome(forced: boolean): number {
  const home = ioHome();
  if (forced || home !== defaultHome()) return 0;
  err(`demo: ${home} is your real state dir — pass --force, or set HARNESS_ORCH_HOME to a scratch dir\n`);
  return 2;
}

export const isSeededRun = (home: string, run: string) => existsSync(join(runsHome(home), run, MARKER));

export function adapterForProfile(profile: string): string {
  if (profile.startsWith("cursor-")) return "cursor-agent";
  if (profile.startsWith("opencode-")) return "opencode";
  if (profile.startsWith("local-")) return "local-llm";
  return "claude";
}

const STEPS = [
  "Read   src/payments/config.ts",
  'Grep   "createCharge" (23 matches across 9 files)',
  "Read   src/payments/charge.ts",
  "Read   src/payments/refund.ts",
  "Edit   src/payments/charge.ts",
  "Edit   src/payments/types.ts",
  "Bash   bun test payments/ --silent",
  "Read   tests/payments/charge.test.ts",
  "Edit   tests/payments/charge.test.ts",
  "Bash   bun test payments/ --silent",
  "Bash   bun run typecheck",
];

// A transcript with the shape of a real headless session: prompt, a long tail of tool calls, a result.
function mockLog(label: string, profile: string, adapter: string, session: string): string {
  const l: string[] = [`$ ${adapter} -p "${label}" --output-format text --session-id ${session}`, "", `> ${label}`, ""];
  for (const round of [1, 2, 3]) {
    l.push(`--- pass ${round} ---`);
    for (const s of STEPS) l.push(`● ${s}`);
    l.push("", `  ${28 + round * 4} tests passed, 0 failed  (${3 + round}s)`, "");
  }
  l.push(
    "Notes",
    "  · charge.ts split into validate/authorise/capture so each is testable alone",
    "  · the refund path shared a currency assertion; extracted to types.ts",
    "  · one flake in charge.test.ts came from a shared clock; frozen per test",
    "",
    `${label} — done. 4 files touched, 40 tests green, typecheck clean.`,
    "",
    `[${adapter} · profile ${profile} · session ${session}]`,
  );
  return l.join("\n") + "\n";
}

// A job dir shaped like a real one (adapter/profile/session/log/exit_code).
export function jobCreate(home: string, adapter: string, profile: string, label: string, exitCode: string): string {
  const d = new Date();
  const hms = d.toISOString().slice(11, 19).replace(/:/g, "");
  const id = `demo-${hms}-${Math.floor(Math.random() * 32768)}`;
  const dir = join(jobsHome(home), id);
  mkdirSync(dir, { recursive: true });
  const session = crypto.randomUUID();
  writeFileSync(join(dir, "adapter"), adapter + "\n");
  writeFileSync(join(dir, "profile"), profile + "\n");
  writeFileSync(join(dir, "session"), session + "\n");
  writeFileSync(join(dir, "log"), mockLog(label, profile, adapter, session));
  if (exitCode !== "-") writeFileSync(join(dir, "exit_code"), exitCode);
  return id;
}

const jobSession = (home: string, job: string) => {
  try {
    return readFileSync(join(jobsHome(home), job, "session"), "utf8").replace(/\n+$/, "");
  } catch {
    return "";
  }
};

interface StatusExtra {
  job?: string;
  error?: string;
  adapter?: string;
  profile?: string;
  session?: string;
  model?: string;
  modelId?: string;
}

function segClose(n: Record<string, any>, at: string): void {
  if (!n.seg_open) return;
  if (!(n.started_at == null && (n.dispatched_at ?? at) >= at)) {
    n.run_segments = [...(n.run_segments ?? []), { dispatched: n.dispatched_at ?? null, start: n.started_at ?? null, end: at }];
  }
  n.seg_open = false;
}

// The node status mutation every state change goes through (node_set_status in runs.sh).
function setStatus(run: Record<string, any>, ctx: Ctx, id: string, status: string, x: StatusExtra = {}): void {
  const n = run.nodes.find((q: any) => q.id === id);
  if (!n) throw new Error(`node ${id}: unknown node`);
  const at = ctx.now;
  const old = n.status ?? "";
  const terminal = ["done", "error", "skipped", "stopped"].includes(status);
  if (status === "running" && !n.seg_open) {
    n.dispatched_at = at; n.started_at = at; n.finished_at = null; n.seg_open = true;
  } else if (status === "running" && n.started_at == null) {
    n.started_at = n.dispatched_at != null && at < n.dispatched_at ? n.dispatched_at : at;
  } else if (terminal) {
    segClose(n, at);
    n.finished_at = at;
  } else if (status === "waiting") {
    segClose(n, at);
    n.dispatched_at = null; n.started_at = null; n.finished_at = null;
  }
  n.status = status;
  n.updated = at;
  if ((status === "done" || status === "error") && n.started == null) {
    n.started = n.created ?? at;
    n.backfilled = true;
  }
  if (x.job) n.job_id = x.job;
  if (x.error) n.error = x.error;
  if (x.adapter) n.adapter = x.adapter;
  if (x.profile) n.profile = x.profile;
  if (x.session) n.session = x.session;
  if (x.model) n.model = x.model;
  if (x.modelId) n.model_id = x.modelId;
  if (status === "running" && n.started == null) n.started = at;
  if (status === "running") { n.backfilled = false; n.hold = null; }
  if (status === "running" && x.job) n.owner = x.job;
  if (status === "waiting") {
    n.started = null; n.finished = null; n.error = null; n.owner = null; n.job_id = null;
    n.owner_kind = null; n.owner_id = null; n.owner_state = null;
  }
  if (status === "done") { n.unverified = null; n.auto = null; }
  if (terminal && status !== "stopped") n.finished = at;
  if (status === "error" || status === "running" || status === "waiting" || status === "done" || status === "skipped") n.next_retry_at = null;
  ctx.events.push({ at: nowIso(), kind: "status", node: id, from: old || null, to: status, note: x.error || null, by: ctx.by });
}

async function nodeStatus(home: string, run: string, id: string, status: string, x: StatusExtra = {}): Promise<number> {
  return mutateRun(home, run, (r, ctx) => setStatus(r, ctx, id, status, x));
}

async function nodePatch(home: string, run: string, id: string, patch: Record<string, unknown>): Promise<number> {
  return mutateRun(home, run, (r) => {
    const n = r.nodes.find((q: any) => q.id === id);
    if (n) Object.assign(n, patch);
  });
}

async function copyLogTail(home: string, run: string, id: string, job: string): Promise<void> {
  let text = "";
  try {
    text = readFileSync(join(jobsHome(home), job, "log"), "utf8");
  } catch {
    return;
  }
  const lines = text.split("\n");
  if (lines[lines.length - 1] === "") lines.pop();
  await nodePatch(home, run, id, { log_tail: lines.slice(-LOG_TAIL_LINES).filter((l) => l.length > 0) });
}

async function runBegin(home: string, title: string): Promise<string> {
  const d = new Date();
  const ts = nowIso(d).replace(/[-:]/g, "").replace("T", "-").replace("Z", "");
  const run = `${ts}-${Math.floor(Math.random() * 65536).toString(16).padStart(4, "0")}`;
  const dir = join(runsHome(home), run);
  mkdirSync(dir, { recursive: true });
  writeFileSync(
    join(dir, "state.json"),
    JSON.stringify({ run_id: run, title, harness_session: env().CLAUDE_CODE_SESSION_ID ?? "", started: nowIso(), finished: null, status: "running", nodes: [], edges: [] }, null, 2) + "\n",
  );
  writeFileSync(join(dir, MARKER), "");
  return run;
}

async function addNode(home: string, run: string, id: string, label: string, deps: string, profile: string): Promise<number> {
  const a = parseAddArgs([id, label, ...(deps ? ["--after", deps] : []), "--profile", profile]);
  return mutateRun(home, run, (r, ctx) => applyAdd(r, a, ctx));
}

async function demoNode(
  home: string, run: string, id: string, label: string, profile: string, adapter: string, status: string, deps = "", error = "",
): Promise<number> {
  if ((await addNode(home, run, id, label, deps, profile)) !== 0) return 1;
  if (status === "waiting") return 0;
  if (status === "skipped") return nodeStatus(home, run, id, "skipped", { error, adapter, profile });
  const exit = status === "error" ? "1" : status === "running" ? "-" : "0";
  const job = jobCreate(home, adapter, profile, label, exit);
  if ((await nodeStatus(home, run, id, status, { job, error, adapter, profile, session: jobSession(home, job) })) !== 0) return 1;
  await copyLogTail(home, run, id, job);
  return 0;
}

async function runFinish(home: string, run: string): Promise<number> {
  const rc = await mutateRun(home, run, (r, ctx) => {
    const status = r.nodes.some((n: any) => n.status === "error") ? "error" : "done";
    r.status = status;
    r.finished = nowIso();
    ctx.events.push({ at: nowIso(), kind: "run", node: null, from: null, to: status, note: null, by: ctx.by });
  });
  if (rc === 0) learningAfterFinish(home, true);
  return rc;
}

type Spec = [id: string, label: string, profile: string, adapter: string, status: string, deps?: string, error?: string];

async function seedRun(home: string, title: string, nodes: Spec[], finish: boolean): Promise<string | null> {
  const run = await runBegin(home, title);
  for (const [id, label, profile, adapter, status, deps, error] of nodes) {
    await demoNode(home, run, id, label, profile, adapter, status, deps ?? "", error ?? "");
  }
  if (finish && (await runFinish(home, run)) !== 0) return null;
  return run;
}

const seedPayments = (h: string) => seedRun(h, "Ship the payments service", [
  ["survey", "Survey the existing checkout flow", "claude-opus", "claude", "done"],
  ["design", "Design the payments API contract", "claude-opus", "claude", "done", "survey"],
  ["schema", "Write the schema + migrations", "claude-default", "claude", "done", "design"],
  ["handlers", "Implement the payment handlers", "claude-default", "claude", "running", "design"],
  ["fmt", "Format and lint the new files", "claude-haiku", "claude", "done", "design"],
  ["review", "Review the diff on cursor", "cursor-default", "cursor-agent", "waiting", "handlers,schema"],
  ["verify", "Typecheck and run the suite", "claude-default", "claude", "waiting", "review,fmt"],
], false);

const seedBench = (h: string) => seedRun(h, "Nightly benchmark sweep", [
  ["warmup", "Warm the llama_swap model cache", "claude-llm-hub", "claude", "done"],
  ["bench", "Benchmark qwen3.6-35b on 40 prompts", "claude-llm-hub", "claude", "done", "warmup"],
  ["report", "Summarise latency and cost", "claude-haiku", "claude", "done", "bench"],
], true);

const seedMigration = (h: string) => seedRun(h, "Migrate the llm-hub profiles", [
  ["rename", "Rename hub profiles to llm-hub", "claude-default", "claude", "done"],
  ["probe", "Probe the hub endpoint", "cursor-default", "cursor-agent", "error", "rename", "cursor-agent cannot reach a local endpoint"],
  ["rollout", "Roll the change out to profiles.json", "claude-default", "claude", "waiting", "probe"],
], true);

const seedDocs = (h: string) => seedRun(h, "Docs pass on the adapter contract", [
  ["draft", "Draft the adapter contract page", "claude-haiku", "claude", "done"],
  ["screens", "Recapture the dashboard screenshots", "claude-haiku", "claude", "skipped", "draft", "no display available on this host"],
], true);

async function graphState(
  home: string, run: string, id: string, profile: string, adapter: string, status: string, model: string, modelId: string,
  usd: number | null = null, tin = 0, tout = 0, error = "",
): Promise<number> {
  const exit = status === "error" ? "1" : status === "running" ? "-" : "0";
  const job = jobCreate(home, adapter, profile, id, exit);
  if (usd !== null) {
    writeFileSync(
      join(jobsHome(home), job, "usage.json"),
      JSON.stringify({ usd, cost_basis: "list", input_tokens: tin, output_tokens: tout, cache_read_tokens: 0, cache_creation_tokens: 0, models: [] }, null, 2) + "\n",
    );
  }
  if ((await nodeStatus(home, run, id, status, { job, error, adapter, profile, session: jobSession(home, job), model, modelId })) !== 0) return 1;
  await copyLogTail(home, run, id, job);
  if (usd !== null) {
    const cost = JSON.parse(readFileSync(join(jobsHome(home), job, "usage.json"), "utf8"));
    await nodePatch(home, run, id, { cost });
  }
  return 0;
}

async function retryNode(run: string, id: string): Promise<void> {
  await dispatchSh(["node", "retry", run, id, "--no-dispatch"]);
}

// One wide run for the graph pane's screenshot: six stages, every status, five harnesses, costs.
async function seedGraph(home: string): Promise<string | null> {
  const run = await runBegin(home, "Ship multi-tenant billing");
  const adds: Array<[string, string, string, string]> = [
    ["survey", "Survey checkout", "", "claude-opus"],
    ["audit", "Audit tenancy", "", "copilot-planner"],
    ["design", "Design billing API", "survey,audit", "claude-planner"],
    ["threat", "Threat model", "audit", "cursor-default"],
    ["schema", "Schema + migrate", "design", "claude-default"],
    ["api", "Billing handlers", "design", "cursor-default"],
    ["ui", "Invoices UI", "design", "copilot-default"],
    ["sdk", "Client SDK", "design", "opencode-default"],
    ["tests", "Unit tests", "schema", "claude-llm-hub"],
    ["e2e", "E2E suite", "api,ui", "copilot-default"],
    ["docs", "API docs", "sdk", "claude-haiku"],
    ["review", "Security review", "tests,e2e,threat", "cursor-default"],
    ["ship", "Ship it", "review", "claude-default"],
  ];
  for (const [id, label, deps, profile] of adds) if ((await addNode(home, run, id, label, deps, profile)) !== 0) return null;
  await graphState(home, run, "survey", "claude-opus", "claude", "done", "opus", "claude-opus", 1.84, 61200, 9400);
  await graphState(home, run, "audit", "copilot-planner", "copilot", "done", "auto", "copilot-opus-5.5");
  await graphState(home, run, "design", "claude-planner", "claude", "error", "opus", "claude-opus-1m", 0.92, 20100, 2300, "rate limited (429)");
  await retryNode(run, "design");
  await graphState(home, run, "design", "claude-planner", "claude", "done", "opus", "claude-opus-1m", 3.12, 98400, 14100);
  await graphState(home, run, "threat", "cursor-default", "cursor-agent", "done", "auto", "cursor-auto");
  await graphState(home, run, "schema", "claude-default", "claude", "done", "sonnet", "claude-sonnet", 0.46, 30200, 4100);
  await graphState(home, run, "api", "cursor-default", "cursor-agent", "running", "auto", "cursor-auto");
  await graphState(home, run, "ui", "copilot-default", "copilot", "error", "auto", "copilot-auto", null, 0, 0, "exit=1");
  await retryNode(run, "ui");
  await graphState(home, run, "ui", "copilot-default", "copilot", "running", "auto", "copilot-auto");
  await graphState(home, run, "sdk", "opencode-default", "opencode", "error", "", "", null, 0, 0, "tsc: 3 type errors");
  await graphState(home, run, "tests", "claude-llm-hub", "claude", "done", "llama_swap/qwen3.6-35b", "local-qwen3.6-35b", 0, 41800, 6410);
  await nodeStatus(home, run, "docs", "skipped", { error: "blocked by sdk", adapter: "claude", profile: "claude-haiku" });
  return run;
}

function seedMemory(home: string): void {
  const rows = [
    { profile: "claude-haiku", outcome: "success", kind: "format", note: "Formatting and lint passes are reliably fast here." },
    { profile: "claude-opus", outcome: "success", kind: "architecture", note: "Worth the cost on schema design; caught a missing index." },
    { profile: "copilot-llm-hub", outcome: "failure", kind: "review", note: "Needs LLM_HUB_URL exported; failed fast without it." },
  ];
  for (const r of rows) if (memoryAdd(home, { ...r, modelId: "" }, () => {}) !== 0) return;
}

async function demoSeed(args: string[]): Promise<number> {
  let forced = false, graph = false;
  for (const a of args) {
    if (a === "--force") forced = true;
    else if (a === "--graph") graph = true;
    else {
      err(`demo seed: unknown argument ${a}\n  usage: ${DEMO_USAGE}\n`);
      return 2;
    }
  }
  const rc = guardHome(forced);
  if (rc !== 0) return rc;
  const home = ioHome();
  if (!(await ensureHome(home))) return 1;
  if (graph) {
    const run = await seedGraph(home);
    if (!run) return 1;
    out(`demo: seeded graph run ${run} in ${home}\n`);
    return 0;
  }
  for (const seed of [seedPayments, seedBench, seedMigration, seedDocs]) if (!(await seed(home))) return 1;
  seedMemory(home);
  out(`demo: seeded 4 runs in ${home}\n`);
  return 0;
}

async function demoReset(args: string[]): Promise<number> {
  let forced = false;
  for (const a of args) {
    if (a === "--force") forced = true;
    else {
      err(`demo reset: unknown argument ${a}\n  usage: ${DEMO_USAGE}\n`);
      return 2;
    }
  }
  const rc = guardHome(forced);
  if (rc !== 0) return rc;
  const home = ioHome();
  if (!existsSync(runsHome(home))) {
    out("demo: nothing to reset\n");
    return 0;
  }
  let removed = 0;
  for (const run of readdirSync(runsHome(home))) {
    if (!isSeededRun(home, run)) continue;
    await trashPath(home, join(runsHome(home), run));
    removed++;
  }
  if (existsSync(jobsHome(home))) {
    for (const j of readdirSync(jobsHome(home))) if (j.startsWith("demo-")) await trashPath(home, join(jobsHome(home), j));
  }
  out(`demo: removed ${removed} seeded run(s)\n`);
  return 0;
}

function runHasWork(home: string, run: string): boolean {
  try {
    const s = JSON.parse(readFileSync(join(runsHome(home), run, "state.json"), "utf8"));
    return s.nodes.some((n: any) => n.status === "running" || n.status === "waiting");
  } catch {
    return false;
  }
}

// Seeded runs share a second, so directory order is arbitrary: prefer a run with something left to move.
export function firstSeededRun(home: string): string | null {
  let fallback = "";
  if (existsSync(runsHome(home))) {
    for (const run of readdirSync(runsHome(home))) {
      if (!isSeededRun(home, run)) continue;
      if (!fallback) fallback = run;
      if (runHasWork(home, run)) return run;
    }
  }
  if (fallback) return fallback;
  err("demo: no seeded run found — run `demo seed` first\n");
  return null;
}

async function demoAdvance(args: string[]): Promise<number> {
  let run = "";
  for (let i = 0; i < args.length; i++) {
    if (args[i] === "--run") run = args[++i] ?? "";
    else {
      err(`demo advance: unknown argument ${args[i]}\n  usage: ${DEMO_USAGE}\n`);
      return 2;
    }
  }
  const home = ioHome();
  if (!run) {
    const f = firstSeededRun(home);
    if (!f) return 2;
    run = f;
  }
  const st = await loadRun(home, run);
  if (!st) {
    err(`run ${run}: unknown run\n`);
    return 2;
  }
  const running = st.nodes.find((n: any) => n.status === "running");
  if (running) {
    await nodeStatus(home, run, running.id, "done");
    out(`${running.id}\tdone\n`);
    return 0;
  }
  const ready = st.nodes.find(
    (n: any) =>
      n.status === "waiting" &&
      (st.edges ?? []).filter((e: any) => e[1] === n.id).every((e: any) => st.nodes.find((q: any) => q.id === e[0])?.status === "done"),
  );
  if (!ready) {
    out(`demo: ${run} has nothing left to advance\n`);
    return 0;
  }
  const profile = ready.profile ?? "";
  const adapter = adapterForProfile(profile);
  const job = jobCreate(home, adapter, profile, ready.label, "-");
  await nodeStatus(home, run, ready.id, "running", { job, adapter, profile, session: jobSession(home, job) });
  await copyLogTail(home, run, ready.id, job);
  out(`${ready.id}\trunning\n`);
  return 0;
}

export async function demoCommand(args: string[]): Promise<number> {
  const verb = args[0] ?? "";
  const rest = args.slice(1);
  switch (verb) {
    case "seed": return demoSeed(rest);
    case "reset": return demoReset(rest);
    case "advance": return demoAdvance(rest);
    default:
      err(`usage: ${DEMO_USAGE}\n`);
      return 2;
  }
}

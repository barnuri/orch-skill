#!/usr/bin/env bun
// unorch: take an orch run over into the main session. Stops the run from starting more nodes, then
// prints one report of every unfinished node: status, goal, unmet dependencies, job liveness, last log
// lines, handoff, error and the node's unanswered asks. The main session then does the work itself.
// It also writes the work as markdown, the source of truth for the takeover:
//   agent-spec/unorch/<run>/tasks.md (one checkbox per node, owner, branch, notes; checked boxes survive a re-run)
//   agent-spec/unorch/<run>/handoffs/<node>.md (a copy of every node handoff)
//   agent-spec/unorch/<run>/asks.md (pending node asks)
// Usage: bun scripts/unorch.ts [run-id] [--no-pause]
import { copyFileSync, existsSync, mkdirSync, readdirSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { spawnSync } from "node:child_process";

const home = process.env["HARNESS_ORCH_HOME"] ?? join(process.env["HOME"] ?? "", ".harness-orch");
const dispatch = join(import.meta.dir, "..", "skills", "orch", "scripts", "dispatch.ts");
const args = process.argv.slice(2);
const noPause = args.includes("--no-pause");

function newestRun(): string {
  const dirs = readdirSync(join(home, "runs")).filter((d) => existsSync(join(home, "runs", d, "state.json"))).sort().reverse();
  for (const d of dirs) {
    const s = JSON.parse(readFileSync(join(home, "runs", d, "state.json"), "utf8")) as { status?: string };
    if (s.status === "running") return d;
  }
  if (dirs[0] === undefined) throw new Error("no run found");
  return dirs[0];
}

const run = args.find((a) => !a.startsWith("--")) ?? newestRun();
const statePath = join(home, "runs", run, "state.json");
const sh = (a: string[]): string => spawnSync(process.execPath, [dispatch, ...a], { encoding: "utf8" }).stdout.trim();

if (!noPause) {
  console.log(sh(["run", "set", run, "auto_dispatch", "false"]));
  console.log(sh(["run", "pause", run]));
}

interface Node { id: string; status?: string; label?: string; goal?: string; profile?: string; error?: string; job_id?: string; prompt?: string }
const state = JSON.parse(readFileSync(statePath, "utf8")) as { nodes: Node[]; edges?: [string, string][] };
const status = new Map(state.nodes.map((n) => [n.id, n.status ?? ""]));
const open = state.nodes.filter((n) => n.status !== "done" && n.status !== "skipped");
const alive = (pid: number): boolean => { try { process.kill(pid, 0); return true; } catch { return false; } };
const tail = (file: string, n: number): string => {
  if (!existsSync(file)) return "";
  const text = readFileSync(file, "utf8").replace(/\u001b\[[0-9;]*[A-Za-z]/g, "");
  return text.split("\n").filter((l) => l.trim() !== "").slice(-n).join(" / ").slice(0, 400);
};

console.log(`# unorch report for ${run}: ${open.length} unfinished of ${state.nodes.length} nodes\n`);
for (const n of open) {
  const deps = (state.edges ?? []).filter(([, to]) => to === n.id).map(([from]) => from).filter((d) => status.get(d) !== "done");
  const job = n.job_id ? join(home, "jobs", n.job_id) : "";
  const pid = job && existsSync(join(job, "pid")) ? Number(readFileSync(join(job, "pid"), "utf8").trim()) : 0;
  const handoff = join(home, "runs", run, "out", n.id, "handoff.md");
  console.log(`## ${n.id} [${n.status}] profile=${n.profile ?? "-"}`);
  console.log(`goal: ${(n.goal ?? n.label ?? "").slice(0, 300)}`);
  if (deps.length > 0) console.log(`waiting on: ${deps.join(", ")}`);
  if (n.error) console.log(`error: ${n.error}`);
  if (job) console.log(`job: ${n.job_id} ${pid > 0 ? (alive(pid) ? "ALIVE" : "dead") : "no pid"} log: ${tail(join(job, "log.plain"), 3) || tail(join(job, "log"), 3)}`);
  console.log(`handoff: ${existsSync(handoff) && statSync(handoff).size > 0 ? handoff : "none"}\n`);
}

const inbox = join(home, "runs", run, "inbox", "orch");
if (existsSync(inbox)) {
  const asks = readdirSync(inbox).filter((f) => f.endsWith(".json")).map((f) => JSON.parse(readFileSync(join(inbox, f), "utf8")) as { id: string; kind: string; from: string; text: string; answered_at?: string });
  const pending = asks.filter((a) => a.kind === "ask" && !a.answered_at);
  console.log(`# pending node asks: ${pending.length}`);
  for (const a of pending) console.log(`- ${a.id} from ${a.from}: ${a.text.slice(0, 300)}`);
}
console.log("\nNext: do the unfinished nodes here, in dependency order. Do not start nodes with the orch skill.");

// ---- markdown files ----
const outDir = join(import.meta.dir, "..", "agent-spec", "unorch", run);
mkdirSync(join(outDir, "handoffs"), { recursive: true });
const tasksFile = join(outDir, "tasks.md");
const checked = new Set<string>();
if (existsSync(tasksFile)) {
  for (const line of readFileSync(tasksFile, "utf8").split("\n")) {
    const m = /^- \[x\] `([^`]+)`/.exec(line);
    if (m?.[1]) checked.add(m[1]);
  }
}
const notes = new Map<string, string>();
if (existsSync(tasksFile)) {
  for (const line of readFileSync(tasksFile, "utf8").split("\n")) {
    const m = /^- \[[ x]\] `([^`]+)`.*?\| notes: (.*)$/.exec(line);
    if (m?.[1] && m[2]) notes.set(m[1], m[2]);
  }
}
for (const n of state.nodes) {
  const src = join(home, "runs", run, "out", n.id, "handoff.md");
  if (existsSync(src) && statSync(src).size > 0) copyFileSync(src, join(outDir, "handoffs", `${n.id}.md`));
}
const lines = [`# unorch tasks for ${run}`, "", `Generated ${new Date().toISOString()}. Edit the checkboxes and notes; a re-run keeps them. Handoff copies are in handoffs/.`, ""];
for (const n of state.nodes) {
  const done = n.status === "done" || n.status === "skipped";
  const mark = done || checked.has(n.id) ? "x" : " ";
  const hand = existsSync(join(outDir, "handoffs", `${n.id}.md`)) ? `handoffs/${n.id}.md` : "no handoff";
  lines.push(`- [${mark}] \`${n.id}\` [${n.status}] ${hand} | notes: ${notes.get(n.id) ?? ""}`);
}
writeFileSync(tasksFile, lines.join("\n") + "\n");
const askLines = [`# pending node asks for ${run}`, ""];
if (existsSync(inbox)) {
  for (const f of readdirSync(inbox).filter((x) => x.endsWith(".json"))) {
    const a = JSON.parse(readFileSync(join(inbox, f), "utf8")) as { id: string; kind: string; from: string; text: string; answered_at?: string };
    if (a.kind === "ask") askLines.push(`- ${a.answered_at ? "[x]" : "[ ]"} ${a.id} from \`${a.from}\`: ${a.text}`);
  }
}
writeFileSync(join(outDir, "asks.md"), askLines.join("\n") + "\n");
console.log(`\nwrote ${tasksFile}\nwrote ${join(outDir, "asks.md")}\nhandoff copies: ${join(outDir, "handoffs")}`);

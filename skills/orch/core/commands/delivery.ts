// `dispatch.ts delivery run` delivers every queued group. `dispatch.ts delivery status` prints the queue and evidence.
import { existsSync, readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { orchHome } from "../state/home.ts";
import { loadQueue, deliveryMode, groupQueue } from "../delivery/queue.ts";
import { deliverReqQueue, loadReqQueue } from "../delivery/req-delivery.ts";
import { deliverPending, spawnRunner, type Runner } from "../delivery/deliver.ts";

const errLine = (s: string) => process.stderr.write(s + "\n");

// Default branch of a repo: the origin HEAD when set, else the checked-out branch.
async function defaultBranch(repo: string, run: Runner): Promise<string> {
  const o = await run(repo, ["git", "symbolic-ref", "--short", "refs/remotes/origin/HEAD"]);
  if (o.code === 0 && o.out) return o.out.replace(/^origin\//, "");
  const h = await run(repo, ["git", "rev-parse", "--abbrev-ref", "HEAD"]);
  return h.out || "main";
}

function instructionsOf(repo: string): string {
  for (const f of ["CLAUDE.md", "AGENTS.md"]) {
    const p = join(repo, f);
    if (existsSync(p)) return readFileSync(p, "utf8");
  }
  return "";
}

// `delivery run [--run <id>] [--key <req-key>] [--dry-run] [--json]`: deliver every verified requirement (commit or PR), then
// group and deliver every queued commit entry. --run limits both to one run. --key delivers that one requirement entry and
// no commit group. --dry-run prints the plan and writes nothing (no git writes, no queue or ledger change).
export async function deliveryRun(args: string[]): Promise<number> {
  const home = orchHome();
  const dryRun = args.includes("--dry-run");
  const ri = args.indexOf("--run");
  const runFilter = ri >= 0 ? args[ri + 1] : undefined;
  const ki = args.indexOf("--key");
  const keyFilter = ki >= 0 ? args[ki + 1] : undefined;
  if (ki >= 0 && !keyFilter) return (errLine("usage: dispatch.ts delivery run --key <req-key>"), 2);
  if (keyFilter && !loadReqQueue(home).entries[keyFilter]) return (errLine(`delivery run: no requirement entry ${keyFilter}`), 2);
  const reqs = await deliverReqQueue({ home, dryRun, run: runFilter, key: keyFilter });
  const json = args.includes("--json");
  if (!json) {
    if (reqs.length === 0) process.stdout.write("delivery: no verified requirements queued\n");
    for (const r of reqs) {
      process.stdout.write(`${r.key} ${dryRun ? "plan" : r.state}${r.sha ? ` ${r.sha}` : ""}${r.pr_url ? ` ${r.pr_url}` : ""}${r.reason && !dryRun ? ` (${r.reason})` : ""}\n`);
      if (dryRun) {
        process.stdout.write(`  files: ${r.files.join(", ") || "none"}\n  tests: ${r.tests.join("; ") || "none"}\n`);
        if (r.state !== "queued") process.stdout.write(`  would not deliver: ${r.state}: ${r.reason}\n`);
        else for (const p of r.plan) process.stdout.write(`  ${p}\n`);
      }
    }
  }
  const reqBad = reqs.some((r) => r.state === "failed" || (!dryRun && r.state === "blocked"));
  if (keyFilter) {
    if (json) process.stdout.write(JSON.stringify({ requirements: reqs, groups: [] }, null, 2) + "\n");
    return reqBad ? 1 : 0;
  }
  const full = loadQueue(home);
  const q = runFilter ? { ...full, entries: Object.fromEntries(Object.entries(full.entries).filter(([, e]) => e.run === runFilter)) } : full;
  if (dryRun) {
    const { groups, queue } = groupQueue(q, (repo) => deliveryMode(repo, instructionsOf(repo)));
    if (json) process.stdout.write(JSON.stringify({ requirements: reqs, groups, refused: Object.values(queue.entries).filter((e) => e.state === "refused") }, null, 2) + "\n");
    else {
      process.stdout.write(groups.length ? "" : "delivery: no commit groups queued\n");
      for (const g of groups) process.stdout.write(`group ${g.id} ${g.mode} ${g.entries.length} entries ${g.touched.length} files\n`);
    }
    return 0;
  }
  const repos = [...new Set(Object.values(q.entries).map((e) => e.repo))];
  const branches = new Map<string, string>();
  for (const r of repos) branches.set(r, await defaultBranch(r, spawnRunner));
  const results = await deliverPending({
    home,
    run: runFilter,
    now: new Date().toISOString(),
    defaultBranch: "main",
    repoPolicy: (repo) => ({ mode: deliveryMode(repo, instructionsOf(repo)), defaultBranch: branches.get(repo) ?? "main" }),
    openPr: async (cwd, branch, title, base) => {
      const p = Bun.spawn(["ghx", "pr", "create", "--head", branch, "--base", base, "--title", title, "--body", "Automatic orch delivery. Evidence in orch delivery status."], { cwd, stdout: "pipe", stderr: "pipe" });
      const out = (await new Response(p.stdout).text()).trim();
      return (await p.exited) === 0 ? out : "";
    },
  });
  if (json) process.stdout.write(JSON.stringify({ requirements: reqs, groups: results }, null, 2) + "\n");
  else if (results.length === 0) process.stdout.write("delivery: no commit groups queued\n");
  else for (const r of results) process.stdout.write(`${r.group} ${r.mode} ${r.outcome}${r.pr_url ? ` ${r.pr_url}` : ""}${r.refused.length ? ` refused: ${r.refused.join(", ")}` : ""}\n`);
  return reqBad || results.some((r) => r.outcome === "failed" || r.outcome === "blocked") ? 1 : 0;
}

// `delivery status`: counts per entry state, then one line per queued entry and its evidence outcome.
export async function deliveryStatus(args: string[]): Promise<number> {
  const home = orchHome();
  const q = loadQueue(home);
  const entries = Object.values(q.entries).sort((a, b) => a.enqueued_at.localeCompare(b.enqueued_at));
  if (args.includes("--json")) {
    process.stdout.write(JSON.stringify({ entries, requirements: Object.values(loadReqQueue(home).entries), evidence: evidenceList(home) }, null, 2) + "\n");
    return 0;
  }
  const counts: Record<string, number> = {};
  for (const e of entries) counts[e.state] = (counts[e.state] ?? 0) + 1;
  process.stdout.write(`delivery: ${entries.length} entries ${JSON.stringify(counts)}\n`);
  for (const e of entries) {
    process.stdout.write(`${e.state} ${e.key} ${e.repo} ${e.branch} ${e.touched.length} files${e.refused_reason ? ` (${e.refused_reason})` : ""}\n`);
  }
  for (const e of Object.values(loadReqQueue(home).entries)) {
    process.stdout.write(`req ${e.state} ${e.key} ${e.policy} ${e.files.length} files ${e.tests.length} tests${e.sha ? ` ${e.sha}` : ""}${e.pr_url ? ` ${e.pr_url}` : ""}${e.reason ? ` (${e.reason})` : ""}\n`);
  }
  return 0;
}

function evidenceList(home: string): unknown[] {
  const dir = join(home, "delivery", "evidence");
  if (!existsSync(dir)) return [];
  return readdirSync(dir).filter((f) => f.endsWith(".json")).map((f) => JSON.parse(readFileSync(join(dir, f), "utf8")));
}

// `delivery enqueue <run-id> <req-id>`: queue a requirement that is already done (verified) for delivery. Prints the keys added.
// `delivery enqueue <run-id> <req-id> --files <a,b> --test <cmd> [--test <cmd>] [--repo <dir>]`: queue named files and tests
// for a requirement that is in_progress, implemented or done (repo defaults to the git top level of the current folder).
export async function deliveryEnqueue(args: string[]): Promise<number> {
  const [runArg, id] = args;
  if (!runArg || !id) return (errLine("usage: dispatch.ts delivery enqueue <run-id> <req-id> [--files <a,b> --test <cmd> [--repo <dir>]]"), 2);
  const home = orchHome();
  const { resolveRun } = await import("./node.ts");
  const runId = await resolveRun(home, runArg);
  if (!runId) return 1;
  const { loadLedger } = await import("./req.ts");
  const r = (await loadLedger(home, runId)).requirements.find((x) => x.id === id);
  if (!r) return (errLine(`delivery enqueue: ${id} is not in run ${runId}`), 2);
  const fi = args.indexOf("--files");
  const tests = args.flatMap((a, i) => (a === "--test" && args[i + 1] ? [args[i + 1]!] : []));
  if (fi >= 0 || tests.length) {
    if (!["in_progress", "implemented", "done"].includes(r.status)) return (errLine(`delivery enqueue: ${id} is ${r.status}; --files needs in_progress, implemented or done`), 2);
    const files = (fi >= 0 ? args[fi + 1] ?? "" : "").split(",").map((f) => f.trim()).filter(Boolean);
    const rpi = args.indexOf("--repo");
    let repo = rpi >= 0 ? args[rpi + 1] ?? "" : "";
    if (!repo) {
      const p = Bun.spawnSync(["git", "rev-parse", "--show-toplevel"], { cwd: process.cwd() });
      repo = p.exitCode === 0 ? p.stdout.toString().trim() : "";
    }
    if (!repo) return (errLine("delivery enqueue: not in a git repo; pass --repo <dir>"), 2);
    const nodes = process.env.ORCH_NODE_ID && process.env.ORCH_RUN_ID === runId ? [process.env.ORCH_NODE_ID] : [];
    const { enqueueNamedReq } = await import("../delivery/req-delivery.ts");
    const res = await enqueueNamedReq(home, runId, r, repo, files, tests, nodes);
    if ("error" in res) return (errLine(`delivery enqueue: ${res.error}`), 2);
    process.stdout.write(`queued ${res.key}\n`);
    return 0;
  }
  if (r.status !== "done") return (errLine(`delivery enqueue: ${id} is ${r.status}; only a verified (done) requirement is delivered`), 2);
  const { enqueueVerifiedReqReport } = await import("../delivery/req-delivery.ts");
  const rep = await enqueueVerifiedReqReport(home, runId, id);
  if (rep.added.length) process.stdout.write(`queued ${rep.added.join(", ")}\n`);
  if (rep.existing.length) process.stdout.write(`already queued ${rep.existing.join(", ")}\n`);
  for (const f of rep.refused) errLine(`delivery enqueue: refused ${f.key}: ${f.reason}`);
  // Loud failure: nothing queued or already queued means nothing can be delivered.
  return rep.added.length || rep.existing.length ? 0 : 1;
}

// `delivery drop <key> --reason T`: take a requirement entry out of the queue (state failed, with the reason). Nothing is deleted.
export async function deliveryDrop(args: string[]): Promise<number> {
  const key = args[0];
  const ri = args.indexOf("--reason");
  const reason = ri >= 0 ? args[ri + 1] : "";
  if (!key || !reason) return (errLine('usage: dispatch.ts delivery drop <key> --reason "<why>"'), 2);
  const home = orchHome();
  const { saveReqQueue } = await import("../delivery/req-delivery.ts");
  const q = loadReqQueue(home);
  const e = q.entries[key];
  if (!e) return (errLine(`delivery drop: no entry ${key}`), 2);
  Object.assign(e, { state: "failed", reason: `dropped: ${reason}`, updated: new Date().toISOString() });
  saveReqQueue(home, q);
  process.stdout.write(`${key} dropped\n`);
  return 0;
}

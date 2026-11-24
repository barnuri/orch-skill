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

// `delivery run [--run <id>] [--dry-run] [--json]`: deliver every verified requirement (commit or PR), then group and deliver
// every queued commit entry. --dry-run prints the plan and writes nothing (no git writes, no queue or ledger change).
export async function deliveryRun(args: string[]): Promise<number> {
  const home = orchHome();
  const dryRun = args.includes("--dry-run");
  const ri = args.indexOf("--run");
  const runFilter = ri >= 0 ? args[ri + 1] : undefined;
  const reqs = await deliverReqQueue({ home, dryRun, run: runFilter });
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
  const q = loadQueue(home);
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
export async function deliveryEnqueue(args: string[]): Promise<number> {
  const [runArg, id] = args;
  if (!runArg || !id) return (errLine("usage: dispatch.ts delivery enqueue <run-id> <req-id>"), 2);
  const home = orchHome();
  const { resolveRun } = await import("./node.ts");
  const runId = await resolveRun(home, runArg);
  if (!runId) return 1;
  const { loadLedger } = await import("./req.ts");
  const r = (await loadLedger(home, runId)).requirements.find((x) => x.id === id);
  if (!r) return (errLine(`delivery enqueue: ${id} is not in run ${runId}`), 2);
  if (r.status !== "done") return (errLine(`delivery enqueue: ${id} is ${r.status}; only a verified (done) requirement is delivered`), 2);
  const { enqueueVerifiedReq } = await import("../delivery/req-delivery.ts");
  const added = await enqueueVerifiedReq(home, runId, id);
  process.stdout.write(added.length ? `queued ${added.join(", ")}\n` : `${id}: nothing new to queue (no implementer files found, or already queued)\n`);
  return 0;
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

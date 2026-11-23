// `dispatch.ts delivery run` delivers every queued group. `dispatch.ts delivery status` prints the queue and evidence.
import { existsSync, readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { orchHome } from "../state/home.ts";
import { loadQueue, deliveryMode } from "../delivery/queue.ts";
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

// `delivery run`: group and deliver every queued entry. Prints one line per group outcome.
export async function deliveryRun(args: string[]): Promise<number> {
  const home = orchHome();
  const q = loadQueue(home);
  const repos = [...new Set(Object.values(q.entries).map((e) => e.repo))];
  const branches = new Map<string, string>();
  for (const r of repos) branches.set(r, await defaultBranch(r, spawnRunner));
  const results = await deliverPending({
    home,
    now: new Date().toISOString(),
    defaultBranch: "main",
    repoPolicy: (repo) => ({ mode: deliveryMode(repo, instructionsOf(repo)), defaultBranch: branches.get(repo) ?? "main" }),
    openPr: async (cwd, branch, title, base) => {
      const p = Bun.spawn(["gh", "pr", "create", "--head", branch, "--base", base, "--title", title, "--body", "Automatic orch delivery. Evidence in orch delivery status."], { cwd, stdout: "pipe", stderr: "pipe" });
      const out = (await new Response(p.stdout).text()).trim();
      return (await p.exited) === 0 ? out : "";
    },
  });
  if (args.includes("--json")) process.stdout.write(JSON.stringify(results, null, 2) + "\n");
  else if (results.length === 0) process.stdout.write("delivery: nothing queued\n");
  else for (const r of results) process.stdout.write(`${r.group} ${r.mode} ${r.outcome}${r.pr_url ? ` ${r.pr_url}` : ""}${r.refused.length ? ` refused: ${r.refused.join(", ")}` : ""}\n`);
  return results.some((r) => r.outcome === "failed" || r.outcome === "blocked") ? 1 : 0;
}

// `delivery status`: counts per entry state, then one line per queued entry and its evidence outcome.
export async function deliveryStatus(args: string[]): Promise<number> {
  const home = orchHome();
  const q = loadQueue(home);
  const entries = Object.values(q.entries).sort((a, b) => a.enqueued_at.localeCompare(b.enqueued_at));
  if (args.includes("--json")) {
    process.stdout.write(JSON.stringify({ entries, evidence: evidenceList(home) }, null, 2) + "\n");
    return 0;
  }
  const counts: Record<string, number> = {};
  for (const e of entries) counts[e.state] = (counts[e.state] ?? 0) + 1;
  process.stdout.write(`delivery: ${entries.length} entries ${JSON.stringify(counts)}\n`);
  for (const e of entries) {
    process.stdout.write(`${e.state} ${e.key} ${e.repo} ${e.branch} ${e.touched.length} files${e.refused_reason ? ` (${e.refused_reason})` : ""}\n`);
  }
  return 0;
}

function evidenceList(home: string): unknown[] {
  const dir = join(home, "delivery", "evidence");
  if (!existsSync(dir)) return [];
  return readdirSync(dir).filter((f) => f.endsWith(".json")).map((f) => JSON.parse(readFileSync(join(dir, f), "utf8")));
}

// `orch run describe <run> "<text>"` sets the optional run description.
// `orch run overview <run> [--json]` builds the run overview: repos, commits, pull requests, models, skills,
// nodes and handoff evidence used by every node. Without --json it writes <run>/overview.html; with --json it
// prints the same data as JSON (the dashboard reads this) and writes nothing.
import { readFile, stat, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { loadRun, saveRun } from "../state/store.ts";
import { paths, orchHome } from "../state/home.ts";
import { currentRunResolve } from "../state/current-run.ts";
import { out } from "../io.ts";
import { errLine } from "./node.ts";

export const RUN_DESCRIBE_USAGE = 'dispatch.ts run describe <run-id> "<description>"';
export const RUN_OVERVIEW_USAGE = "dispatch.ts run overview <run-id> [--json]";
export const COMMIT_CAP = 20;

export interface OverviewRepo { repo: string; nodes: string[]; commits: number }
export interface OverviewCommit { repo: string; sha: string; subject: string }
export interface OverviewPull { repo: string; url: string }
export interface OverviewCount { name: string; nodes: number }
export interface OverviewNode { id: string; label: string; status: string; profile: string; model: string; repo: string; skills: string[] }
export interface OverviewHandoff { id: string; status: string; state: "yes" | "empty" | "missing"; bytes: number; file: string }

/** The run overview. Mirrored by src/shared/types/run-overview.ts (the dashboard contract); keep both in step. */
export interface RunOverview {
  run_id: string;
  title: string;
  description: string | null;
  status: string;
  started: string | null;
  finished: string | null;
  generated_at: string;
  node_count: number;
  repos: OverviewRepo[];
  /** The first COMMIT_CAP commits of each repo, newest first. */
  commits: OverviewCommit[];
  pull_requests: OverviewPull[];
  /** Repos whose pull requests could not be checked (gh missing, unauthenticated or offline). */
  pull_requests_unavailable: string[];
  models: OverviewCount[];
  skills: OverviewCount[];
  nodes: OverviewNode[];
  handoffs: OverviewHandoff[];
}

async function resolveId(home: string, arg: string): Promise<string | null> {
  try { return await currentRunResolve(home, arg); } catch { return null; }
}

export async function runDescribe(args: string[]): Promise<number> {
  const [arg = "", text = ""] = args;
  if (!arg || !text) return (errLine(`usage: ${RUN_DESCRIBE_USAGE}`), 2);
  const home = orchHome();
  const id = await resolveId(home, arg);
  if (!id) return (errLine(`run describe: no run ${arg}`), 1);
  const run = await loadRun(home, id);
  if (!run) return (errLine(`run describe: no run ${arg}`), 1);
  run.description = text;
  await saveRun(home, id, run);
  out(`described: ${id}\n`);
  return 0;
}

// Skill names read by the agent in a job, from `Read .../skills/<name>/SKILL.md` lines in its log.
export function skillsInLog(log: string): string[] {
  const names = new Set<string>();
  for (const m of log.matchAll(/skills\/([A-Za-z0-9._-]+)\/SKILL\.md/g)) if (m[1]) names.add(m[1]);
  return [...names].sort();
}

/** Runs a command without blocking the event loop (the dashboard builds overviews in-process). */
async function runAsync(cmd: string[], opts: { cwd?: string; timeout?: number } = {}): Promise<{ code: number; stdout: string }> {
  const proc = Bun.spawn(cmd, { cwd: opts.cwd, env: process.env, stdin: "ignore", stdout: "pipe", stderr: "ignore" });
  const timer = opts.timeout ? setTimeout(() => proc.kill(), opts.timeout) : null;
  try {
    const [stdout, code] = await Promise.all([new Response(proc.stdout).text(), proc.exited]);
    return { code, stdout };
  } finally {
    if (timer) clearTimeout(timer);
  }
}

const PULL_PARALLEL = 8;
let pullActive = 0;
const pullWaiting: Array<() => void> = [];
/** Runs `job` once fewer than PULL_PARALLEL others run (process-wide, so concurrent overviews share the limit). */
async function pullGate<T>(job: () => Promise<T>): Promise<T> {
  while (pullActive >= PULL_PARALLEL) await new Promise<void>((resolve) => pullWaiting.push(resolve));
  pullActive++;
  try {
    return await job();
  } finally {
    pullActive--;
    pullWaiting.shift()?.();
  }
}

async function gitLog(repo: string, start: string): Promise<string[]> {
  if (!repo || !start) return [];
  const r = await runAsync(["git", "-C", repo, "log", "--format=%h %s", `${start}..HEAD`]);
  if (r.code !== 0) return [];
  return r.stdout.split("\n").filter((l) => l.trim() !== "");
}

/** `owner/repo` of a GitHub origin remote, or "" when the repo has no GitHub origin. */
export function githubSlug(remote: string): string {
  const m = remote.trim().match(/github\.com[:/]([^/\s]+\/[^/\s]+?)(?:\.git)?\/?$/);
  return m?.[1] ?? "";
}

/** Pull request URLs that contain a commit, from `gh api`. `null` when gh cannot answer (no gh, no auth, offline). */
export async function pullsForCommit(repo: string, slug: string, sha: string): Promise<string[] | null> {
  const r = await runAsync(["gh", "api", `repos/${slug}/commits/${sha}/pulls`, "--jq", ".[].html_url"], { cwd: repo, timeout: 10_000 }).catch(() => null);
  if (r === null || r.code !== 0) return null;
  return r.stdout.split("\n").map((l) => l.trim()).filter((l) => l !== "");
}

/** Handoff state of one node from its out dir: `yes` with bytes, `empty` or `missing`. */
async function handoffOf(outDir: string): Promise<{ state: "yes" | "empty" | "missing"; bytes: number; file: string }> {
  const file = join(outDir, "handoff.md");
  try {
    const st = await stat(file);
    return { state: st.size > 0 ? "yes" : "empty", bytes: st.size, file };
  } catch {
    return { state: "missing", bytes: 0, file };
  }
}

function countBy(items: string[]): OverviewCount[] {
  const m = new Map<string, number>();
  for (const i of items) m.set(i, (m.get(i) ?? 0) + 1);
  return [...m.entries()].sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0])).map(([name, nodes]) => ({ name, nodes }));
}

/** Builds the overview of one run from its state, job files, out dirs and git. `null` when the run does not exist. */
export async function buildRunOverview(home: string, id: string): Promise<RunOverview | null> {
  const run = await loadRun(home, id);
  if (!run) return null;
  const nodes: any[] = run.nodes ?? [];
  const repos = new Map<string, { nodes: string[]; commits: string[]; start: string }>();
  const models: string[] = [];
  const skills: string[] = [];
  const nodeRows: OverviewNode[] = [];
  const handoffs: OverviewHandoff[] = [];

  for (const n of nodes) {
    const jobDir = n.job_id ? join(paths.jobs(home), String(n.job_id)) : "";
    const read = (f: string) => (jobDir ? readFile(join(jobDir, f), "utf8").then((t) => t.trim()).catch(() => "") : Promise.resolve(""));
    const [repo, start, model, log] = await Promise.all([read("repo"), read("start_commit"), read("model_id"), read("log.plain")]);
    const used = skillsInLog(log);
    skills.push(...used);
    if (model) models.push(model);
    if (repo) {
      const r = repos.get(repo) ?? { nodes: [], commits: [], start: "" };
      r.nodes.push(String(n.id));
      if (!r.start && start) r.start = start;
      repos.set(repo, r);
    }
    nodeRows.push({ id: String(n.id), label: String(n.label ?? ""), status: String(n.status ?? ""), profile: String(n.profile ?? ""), model, repo, skills: used });
    const outDir = typeof n.out_dir === "string" && n.out_dir !== "" ? n.out_dir : paths.runOutDir(home, id, String(n.id));
    const h = await handoffOf(outDir);
    handoffs.push({ id: String(n.id), status: String(n.status ?? ""), state: h.state, bytes: h.bytes, file: h.file });
  }

  const repoRows: OverviewRepo[] = [];
  const commits: OverviewCommit[] = [];
  for (const [repo, r] of repos) {
    r.commits = await gitLog(repo, r.start);
    repoRows.push({ repo, nodes: r.nodes, commits: r.commits.length });
    for (const c of r.commits.slice(0, COMMIT_CAP)) {
      const sp = c.indexOf(" ");
      commits.push({ repo, sha: sp < 0 ? c : c.slice(0, sp), subject: sp < 0 ? "" : c.slice(sp + 1) });
    }
  }

  // Every repo and every commit is asked at once, at most PULL_PARALLEL `gh` processes together: the calls are network waits.
  const pulls: OverviewPull[] = [];
  const pullsUnavailable: string[] = [];
  const perRepo = await Promise.all([...repos].map(async ([repo, r]) => {
    const origin = await runAsync(["git", "-C", repo, "remote", "get-url", "origin"]);
    const slug = githubSlug(origin.stdout);
    if (slug === "") return null;
    const shas = r.commits.slice(0, COMMIT_CAP).map((c) => c.split(" ")[0] ?? "").filter((sha) => sha !== "");
    const found = await Promise.all(shas.map((sha) => pullGate(() => pullsForCommit(repo, slug, sha))));
    if (found.some((urls) => urls === null)) return { repo, urls: [] as string[], unavailable: true };
    return { repo, urls: [...new Set(found.flatMap((urls) => urls ?? []))], unavailable: false };
  }));
  for (const row of perRepo) {
    if (row === null) continue;
    if (row.unavailable) pullsUnavailable.push(row.repo);
    for (const u of row.urls) pulls.push({ repo: row.repo, url: u });
  }

  return {
    run_id: id,
    title: String(run.title ?? ""),
    description: run.description ? String(run.description) : null,
    status: String(run.status ?? ""),
    started: run.started ?? null,
    finished: run.finished ?? null,
    generated_at: new Date().toISOString(),
    node_count: nodes.length,
    repos: repoRows,
    commits,
    pull_requests: pulls,
    pull_requests_unavailable: pullsUnavailable,
    models: countBy(models),
    skills: countBy(skills),
    nodes: nodeRows,
    handoffs,
  };
}

const esc = (s: unknown) =>
  String(s ?? "").replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");

function table(head: string[], rows: string[][]): string {
  if (rows.length === 0) return "<p class=\"muted\">none</p>";
  return `<table><tr>${head.map((h) => `<th>${esc(h)}</th>`).join("")}</tr>${rows
    .map((r) => `<tr>${r.map((c) => `<td>${c}</td>`).join("")}</tr>`)
    .join("")}</table>`;
}

/** The overview as one self-contained HTML page. */
export function renderOverviewHtml(o: RunOverview): string {
  const description = o.description ? `<p>${esc(o.description)}</p>` : "<p class=\"muted\">no description</p>";
  const prRows = o.pull_requests.map((p) => [esc(p.repo), `<a href="${esc(p.url)}">${esc(p.url)}</a>`]);
  for (const repo of o.pull_requests_unavailable) prRows.push([esc(repo), "<span class=\"muted\">gh unavailable: pull requests not checked</span>"]);
  return `<!doctype html><html><head><meta charset="utf-8"><title>${esc(o.title)}</title>
<style>body{font-family:-apple-system,system-ui,sans-serif;margin:24px;color:#1a1a1a}h1{font-size:20px}h2{font-size:15px;margin-top:24px}table{border-collapse:collapse;width:100%;font-size:13px}th,td{border-bottom:1px solid #ddd;padding:4px 8px;text-align:left;vertical-align:top}th{background:#f4f4f4}.muted{color:#888}code{font-size:12px}</style></head><body>
<h1>${esc(o.title)} <span class="muted">${esc(o.run_id)}</span></h1>
${description}
<p>status: <b>${esc(o.status)}</b> · started ${esc(o.started ?? "")} · finished ${esc(o.finished ?? "-")} · nodes ${o.node_count}</p>
<h2>Repos</h2>${table(["repo", "nodes", "commits"], o.repos.map((r) => [esc(r.repo), esc(r.nodes.join(", ")), String(r.commits)]))}
<h2>Commits (first ${COMMIT_CAP} per repo)</h2>${table(["repo", "commit"], o.commits.map((c) => [esc(c.repo), esc(`${c.sha} ${c.subject}`.trim())]))}
<h2>Pull requests (per commit, GitHub repos)</h2>${table(["repo", "pull request"], prRows)}
<h2>Models</h2>${table(["model", "nodes"], o.models.map((m) => [esc(m.name), String(m.nodes)]))}
<h2>Skills</h2>${table(["skill", "nodes"], o.skills.map((s) => [esc(s.name), String(s.nodes)]))}
<h2>Nodes</h2>${table(["node", "label", "status", "profile", "model", "repo", "skills"], o.nodes.map((n) => [esc(n.id), esc(n.label), esc(n.status), esc(n.profile), esc(n.model), esc(n.repo), esc(n.skills.join(", "))]))}
<h2>Handoff evidence</h2>${table(["node", "status", "handoff.md", "file"], o.handoffs.map((h) => [esc(h.id), esc(h.status), h.state === "yes" ? `yes (${h.bytes} bytes)` : h.state, `<code>${esc(h.file)}</code>`]))}
</body></html>
`;
}

export async function runOverview(args: string[]): Promise<number> {
  const json = args.includes("--json");
  const arg = args.find((a) => !a.startsWith("--")) ?? "";
  if (!arg) return (errLine(`usage: ${RUN_OVERVIEW_USAGE}`), 2);
  const home = orchHome();
  const id = await resolveId(home, arg);
  if (!id) return (errLine(`run overview: no run ${arg}`), 1);
  const overview = await buildRunOverview(home, id);
  if (!overview) return (errLine(`run overview: no run ${arg}`), 1);
  if (json) {
    out(`${JSON.stringify(overview)}\n`);
    return 0;
  }
  const file = join(paths.runs(home), id, "overview.html");
  await writeFile(file, renderOverviewHtml(overview));
  out(`${file}\n`);
  return 0;
}

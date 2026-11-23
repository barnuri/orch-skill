// `orch run describe <run> "<text>"` sets the optional run description.
// `orch run overview <run>` writes <run>/overview.html: repos, commits, models and skills used by every node.
import { readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { loadRun, saveRun } from "../state/store.ts";
import { paths, orchHome } from "../state/home.ts";
import { currentRunResolve } from "../state/current-run.ts";
import { out } from "../io.ts";
import { errLine } from "./node.ts";

export const RUN_DESCRIBE_USAGE = 'dispatch.ts run describe <run-id> "<description>"';
export const RUN_OVERVIEW_USAGE = "dispatch.ts run overview <run-id>";
const COMMIT_CAP = 20;

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
  for (const m of log.matchAll(/skills\/([A-Za-z0-9._-]+)\/SKILL\.md/g)) names.add(m[1]);
  return [...names].sort();
}

function gitLog(repo: string, start: string): string[] {
  if (!repo || !start) return [];
  const r = Bun.spawnSync(["git", "-C", repo, "log", "--format=%h %s", `${start}..HEAD`]);
  if (r.exitCode !== 0) return [];
  return new TextDecoder().decode(r.stdout).split("\n").filter((l) => l.trim() !== "");
}

const esc = (s: unknown) =>
  String(s ?? "").replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");

function countBy(items: string[]): [string, number][] {
  const m = new Map<string, number>();
  for (const i of items) m.set(i, (m.get(i) ?? 0) + 1);
  return [...m.entries()].sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]));
}

function table(head: string[], rows: string[][]): string {
  if (rows.length === 0) return "<p class=\"muted\">none</p>";
  return `<table><tr>${head.map((h) => `<th>${esc(h)}</th>`).join("")}</tr>${rows
    .map((r) => `<tr>${r.map((c) => `<td>${c}</td>`).join("")}</tr>`)
    .join("")}</table>`;
}

export async function runOverview(args: string[]): Promise<number> {
  const arg = args[0] ?? "";
  if (!arg) return (errLine(`usage: ${RUN_OVERVIEW_USAGE}`), 2);
  const home = orchHome();
  const id = await resolveId(home, arg);
  if (!id) return (errLine(`run overview: no run ${arg}`), 1);
  const run = await loadRun(home, id);
  if (!run) return (errLine(`run overview: no run ${arg}`), 1);

  const nodes: any[] = run.nodes ?? [];
  const repos = new Map<string, { nodes: string[]; commits: string[]; start: string }>();
  const models: string[] = [];
  const skills: string[] = [];
  const nodeRows: string[][] = [];

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
    nodeRows.push([
      esc(n.id),
      esc(n.label ?? ""),
      esc(n.status ?? ""),
      esc(n.profile ?? ""),
      esc(model),
      esc(repo),
      esc(used.join(", ")),
    ]);
  }

  const repoRows: string[][] = [];
  for (const [repo, r] of repos) {
    const commits = gitLog(repo, r.start);
    r.commits = commits;
    repoRows.push([esc(repo), esc(r.nodes.join(", ")), String(commits.length)]);
  }
  const commitRows: string[][] = [];
  for (const [repo, r] of repos) {
    for (const c of r.commits.slice(0, COMMIT_CAP)) commitRows.push([esc(repo), esc(c)]);
  }

  const description = run.description ? `<p>${esc(run.description)}</p>` : "<p class=\"muted\">no description</p>";
  const html = `<!doctype html><html><head><meta charset="utf-8"><title>${esc(run.title)}</title>
<style>body{font-family:-apple-system,system-ui,sans-serif;margin:24px;color:#1a1a1a}h1{font-size:20px}h2{font-size:15px;margin-top:24px}table{border-collapse:collapse;width:100%;font-size:13px}th,td{border-bottom:1px solid #ddd;padding:4px 8px;text-align:left;vertical-align:top}th{background:#f4f4f4}.muted{color:#888}code{font-size:12px}</style></head><body>
<h1>${esc(run.title)} <span class="muted">${esc(run.run_id)}</span></h1>
${description}
<p>status: <b>${esc(run.status)}</b> · started ${esc(run.started ?? "")} · finished ${esc(run.finished ?? "-")} · nodes ${nodes.length}</p>
<h2>Repos</h2>${table(["repo", "nodes", "commits"], repoRows)}
<h2>Commits (first ${COMMIT_CAP} per repo)</h2>${table(["repo", "commit"], commitRows)}
<h2>Models</h2>${table(["model", "nodes"], countBy(models).map(([m, c]) => [esc(m), String(c)]))}
<h2>Skills</h2>${table(["skill", "nodes"], countBy(skills).map(([s, c]) => [esc(s), String(c)]))}
<h2>Nodes</h2>${table(["node", "label", "status", "profile", "model", "repo", "skills"], nodeRows)}
</body></html>
`;
  const file = join(paths.runs(home), id, "overview.html");
  await writeFile(file, html);
  out(`${file}\n`);
  return 0;
}

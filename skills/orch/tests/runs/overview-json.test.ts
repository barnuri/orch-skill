import { test, expect } from "bun:test";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { orch, seedHome, autoCleanup } from "../helpers";
import { renderOverviewHtml, type RunOverview } from "../../core/commands/overview.ts";
autoCleanup();

const base: RunOverview = {
  run_id: "R1",
  title: "Ship overview",
  description: "Run page overview",
  status: "done",
  started: "2026-11-23T10:00:00Z",
  finished: "2026-11-23T11:00:00Z",
  generated_at: "2026-11-23T11:00:01Z",
  node_count: 1,
  repos: [{ repo: "/r/orch", nodes: ["a"], commits: 2 }],
  commits: [{ repo: "/r/orch", sha: "abc1234", subject: "add overview" }],
  pull_requests: [{ repo: "/r/orch", url: "https://github.com/acme/orch/pull/7" }],
  pull_requests_unavailable: ["/r/other"],
  models: [{ name: "claude-x", nodes: 1 }],
  skills: [{ name: "code-gen", nodes: 1 }],
  nodes: [{ id: "a", label: "Node A", status: "done", profile: "hub", model: "claude-x", repo: "/r/orch", skills: ["code-gen"] }],
  handoffs: [{ id: "a", status: "done", state: "yes", bytes: 7, file: "/x/handoff.md" }],
};

test("renderOverviewHtml renders every section from the overview data", () => {
  const html = renderOverviewHtml(base);
  for (const h of ["Repos", "Commits (first 20 per repo)", "Pull requests (per commit, GitHub repos)", "Models", "Skills", "Nodes", "Handoff evidence"]) {
    expect(html).toContain(`<h2>${h}</h2>`);
  }
  expect(html).toContain("https://github.com/acme/orch/pull/7");
  expect(html).toContain("gh unavailable: pull requests not checked");
  expect(html).toContain("abc1234 add overview");
  expect(html).toContain("yes (7 bytes)");
});

test("renderOverviewHtml escapes text from the run", () => {
  const html = renderOverviewHtml({ ...base, title: "<script>x</script>" });
  expect(html).not.toContain("<script>x</script>");
  expect(html).toContain("&lt;script&gt;");
});

test("run overview --json prints the overview data and writes no overview.html", () => {
  const home = seedHome();
  const o = orch(home, {});
  const R = o("run", "start", "json run", "--description", "Json check").out.trim();
  o("node", "add", R, "a", "Node A");
  mkdirSync(join(home, "runs", R, "out", "a"), { recursive: true });
  writeFileSync(join(home, "runs", R, "out", "a", "handoff.md"), "# done\n");

  const res = o("run", "overview", R, "--json");
  expect(res.rc).toBe(0);
  const data = JSON.parse(res.out) as RunOverview;
  expect(data.run_id).toBe(R);
  expect(data.title).toBe("json run");
  expect(data.description).toBe("Json check");
  expect(data.node_count).toBe(1);
  expect(data.nodes[0]).toMatchObject({ id: "a", label: "Node A" });
  expect(data.handoffs).toEqual([expect.objectContaining({ id: "a", state: "yes", bytes: 7 })]);
  expect(Array.isArray(data.pull_requests)).toBe(true);
  expect(existsSync(join(home, "runs", R, "overview.html"))).toBe(false);
});

test("run overview --json exits 1 for an unknown run", () => {
  const home = seedHome();
  expect(orch(home, {})("run", "overview", "20260101-000000-zzzz", "--json").rc).toBe(1);
});

test("run overview without --json still writes overview.html", () => {
  const home = seedHome();
  const o = orch(home, {});
  const R = o("run", "start", "html run").out.trim();
  expect(o("run", "overview", R).rc).toBe(0);
  expect(readFileSync(join(home, "runs", R, "overview.html"), "utf8")).toContain("<h2>Handoff evidence</h2>");
});

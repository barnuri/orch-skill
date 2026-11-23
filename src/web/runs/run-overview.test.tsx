import { describe, expect, test } from "bun:test";
import { renderToStaticMarkup } from "react-dom/server";
import type { RunOverview } from "../../shared/types/run-overview";
import { OVERVIEW_OPEN_KEY, OverviewSections, RunOverview as RunOverviewPanel, overviewPageHref } from "./RunOverview";

const { QueryClient, QueryClientProvider } = await import("@tanstack/react-query");

const overview: RunOverview = {
  run_id: "R1",
  title: "Ship overview",
  description: null,
  status: "done",
  started: null,
  finished: null,
  generated_at: "2026-11-23T11:00:01Z",
  node_count: 2,
  repos: [{ repo: "/r/orch", nodes: ["a", "b"], commits: 3 }],
  commits: [{ repo: "/r/orch", sha: "abc1234", subject: "add overview" }],
  pull_requests: [{ repo: "/r/orch", url: "https://github.com/acme/orch/pull/7" }],
  pull_requests_unavailable: ["/r/other"],
  models: [{ name: "claude-x", nodes: 2 }],
  skills: [{ name: "code-gen", nodes: 1 }],
  nodes: [
    { id: "a", label: "Node A", status: "done", profile: "hub", model: "claude-x", repo: "/r/orch", skills: ["code-gen"] },
    { id: "b", label: "Node B", status: "running", profile: "hub", model: "claude-x", repo: "/r/orch", skills: [] },
  ],
  handoffs: [
    { id: "a", status: "done", state: "yes", bytes: 7, file: "/x/a/handoff.md" },
    { id: "b", status: "running", state: "missing", bytes: 0, file: "/x/b/handoff.md" },
  ],
};

describe("OverviewSections", () => {
  test("renders the repos, commits, pull requests, models, skills, nodes and handoffs", () => {
    const html = renderToStaticMarkup(<OverviewSections overview={overview} />);
    for (const h of ["Repos", "Commits (first 20 per repo)", "Pull requests", "Models", "Skills", "Nodes", "Handoffs"]) {
      expect(html).toContain(`<h3>${h}</h3>`);
    }
    expect(html).toContain("/r/orch");
    expect(html).toContain("<code>abc1234</code>");
    expect(html).toContain('href="https://github.com/acme/orch/pull/7"');
    expect(html).toContain("gh unavailable: not checked");
    expect(html).toContain("claude-x");
    expect(html).toContain("code-gen");
    expect(html).toContain("yes (7 bytes)");
    expect(html).toContain(">missing<");
  });

  test("overviewPageHref points at the server page and encodes the run id", () => {
    expect(overviewPageHref("20260101-000000-abcd")).toBe("/api/runs/20260101-000000-abcd/overview.html");
    expect(overviewPageHref("a b")).toBe("/api/runs/a%20b/overview.html");
  });

  test("the panel is collapsed by default and fetches nothing until opened", () => {
    const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
    const html = renderToStaticMarkup(
      <QueryClientProvider client={client}>
        <RunOverviewPanel runId="R1" />
      </QueryClientProvider>,
    );
    expect(OVERVIEW_OPEN_KEY).toBe("orch.run.overview.open");
    expect(html).toContain('aria-expanded="false"');
    expect(html).toContain('data-expanded="false"');
    expect(html).not.toContain("<h3>Repos</h3>");
    expect(html).not.toContain("overview-page");
    expect(client.getQueryCache().getAll().every((q) => q.state.fetchStatus === "idle" && q.state.data === undefined)).toBe(true);
  });

  test("shows none for an empty list", () => {
    const html = renderToStaticMarkup(<OverviewSections overview={{ ...overview, models: [], pull_requests: [], pull_requests_unavailable: [] }} />);
    expect(html).toContain('<p class="muted">none</p>');
  });
});

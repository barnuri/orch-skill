import { test, expect } from "bun:test";
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { autoCleanup, tempDir } from "../helpers";
import { auditRun, handoffKind, overlap } from "../../../../scripts/unorch-audit.ts";

autoCleanup();

test("handoffKind tells an agent's report from one orch wrote", () => {
  expect(handoffKind("# Handoff from commit log\n\nb138f1f ui lanes")).toBe("commit-log");
  expect(handoffKind("# Generated recovery handoff\n\nx")).toBe("generated");
  expect(handoffKind("# Done\n\nadded the GitHub icon")).toBe("own");
  expect(handoffKind("  \n")).toBe("missing");
});

test("overlap is 0 for a handoff about something else", () => {
  expect(overlap("GitHub bug report icons", "b138f1f ui lanes: working Docker Compose integration lane")).toBeLessThan(0.2);
  expect(overlap("GitHub bug report icons", "Added the GitHub icon and the bug report icon to the header")).toBeGreaterThan(0.5);
});

test("a requirement closed by settle over a commit-log handoff is flagged as unproven", () => {
  const home = tempDir("unorch-audit-");
  const dir = join(home, "runs", "r1");
  mkdirSync(join(dir, "out", "n1"), { recursive: true });
  writeFileSync(join(dir, "out", "n1", "handoff.md"), "# Handoff from commit log\n\nb138f1f ui lanes\n");
  writeFileSync(join(dir, "state.json"), JSON.stringify({ nodes: [{ id: "n1", status: "done", label: "Icons", result: { verdict: "full", summary: "Job added commits during the run." } }] }));
  writeFileSync(join(dir, "requirements.json"), JSON.stringify({ requirements: [{ id: "R1", text: "GitHub bug report icons", status: "done", forced: "settled", nodes: ["n1"], evidence: [{ note: "settled by the main session" }] }] }));
  const rules = auditRun(home, "r1").findings.map((f) => f.rule);
  expect(rules).toEqual(expect.arrayContaining(["closed-without-check", "evidence-is-not-the-agents-report", "handoff-is-about-something-else", "result-written-by-the-system", "no-independent-verifier"]));
});

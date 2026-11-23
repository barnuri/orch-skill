import { test, expect } from "bun:test";
import { writeFileSync } from "node:fs";
import { join } from "node:path";
import { finalizeQualityReport } from "../../core/quality/contract.ts";
import { parseCrMarkdown, parseGeneric } from "../../core/quality/adapters.ts";
import { exportReports, redactText } from "../../core/quality/export.ts";
import { seedHome, orch, tempDir, autoCleanup } from "../helpers";
autoCleanup();

const CTX = { runId: "R1", nodeId: "a", id: "q1", now: "2026-01-01T00:00:00.000Z", adapter: "generic" };
const GOOD = { stage: "review", skill_id: "demo", verdict: { value: "fail", score: 40 }, confidence: 90, findings: [{ severity: "high", category: "bug", title: "Off by one", evidence: "i <= n", file: "src/a.ts", line: 12, confidence: 85 }] };

test("finalize builds a report with ids, timestamps and finding ids", () => {
  const r = finalizeQualityReport(GOOD, CTX);
  expect(r.id).toBe("q1");
  expect(r.findings[0]!.id).toBe("F1");
  expect(r.timestamps.created_at).toBe(CTX.now);
  expect(r.model).toEqual({ requested: null, actual: null });
  expect(r.verdict.score).toBe(40);
});

test("finalize rejects bad stage, severity, score and line", () => {
  expect(() => finalizeQualityReport({ ...GOOD, stage: "qa" }, CTX)).toThrow("stage must be one of");
  expect(() => finalizeQualityReport({ ...GOOD, verdict: { value: "x", score: 101 } }, CTX)).toThrow("verdict.score");
  expect(() => finalizeQualityReport({ ...GOOD, findings: [{ ...GOOD.findings[0], severity: "blocker" }] }, CTX)).toThrow("severity must be one of");
  expect(() => finalizeQualityReport({ ...GOOD, findings: [{ ...GOOD.findings[0], line: 0 }] }, CTX)).toThrow("line must be");
});

test("cr-markdown maps confidence-scored lines and keeps the verdict marker", () => {
  const md = [
    "## Review",
    "[CR-1] [src/a.ts:12] (confidence 85) P1 Off by one — i <= n reads past the end",
    "[CR-2] [src/b.ts] (confidence 90) P3 Missing test for empty input",
    "not a finding",
  ].join("\n");
  const d = parseCrMarkdown(md);
  expect(d.verdict).toEqual({ value: "open-findings", score: null });
  const f = d.findings as any[];
  expect(f).toHaveLength(2);
  expect(f[0]).toMatchObject({ severity: "high", title: "Off by one", file: "src/a.ts", line: 12, confidence: 85, evidence: "i <= n reads past the end" });
  expect(f[1]).toMatchObject({ severity: "low", file: "src/b.ts", line: null, confidence: 90 });
  expect(parseCrMarkdown("REVIEW SATISFIED — no open issues").verdict.value).toBe("satisfied");
});

test("generic adapter accepts JSON objects only", () => {
  expect(() => parseGeneric("not json")).toThrow("not valid JSON");
  expect(() => parseGeneric("[1]")).toThrow("JSON object");
  expect(parseGeneric(JSON.stringify(GOOD)).skill_id).toBe("demo");
});

test("export redacts secrets, scrubs the home path and clips evidence", () => {
  const long = "x".repeat(600);
  const r = finalizeQualityReport({ ...GOOD, source_artifact: "/home/me/out/review.md", findings: [{ severity: "info", category: "c", title: "t", evidence: `token=abcdefghijklmnop ${long}`, file: "/home/me/src/a.ts", line: null, confidence: null }] }, CTX);
  const out = exportReports([r], "/home/me");
  expect(out.schema).toBe("orch.quality.v1");
  const f = out.reports[0]!.findings[0]!;
  expect(out.reports[0]!.source_artifact).toBe("~/out/review.md");
  expect(f.file).toBe("~/src/a.ts");
  expect(f.evidence).not.toContain("abcdefghijklmnop");
  expect(f.evidence.length).toBeLessThanOrEqual(400);
  expect(redactText("key sk-abcdefghijklmnopqrstuv")).toBe("key [REDACTED]");
});

test("CLI append, list, show, export round trip per run, node and model", () => {
  const home = seedHome(), o = orch(home);
  const R = o("run", "start", "quality demo").out.trim();
  expect(o.in('{"op":"add","id":"a","goal":"Alpha"}\n', "node", "batch", R).rc).toBe(0);
  const dir = tempDir();
  const crFile = join(dir, "review.md");
  writeFileSync(crFile, "[CR-1] [src/a.ts:3] (confidence 88) P2 Null check missing\n");
  const add = o("node", "quality", "append", R, "a", "--file", crFile, "--adapter", "cr-markdown", "--stage", "review", "--skill", "cr", "--model-requested", "hub/m1", "--model-actual", "hub/m1-b", "--reviewer-model", "hub/m2");
  expect(add.rc).toBe(0);
  expect(add.out).toContain("quality q1 recorded for node a: verdict open-findings, 1 findings");
  expect(o("node", "quality", "append", R, "a", "--file", crFile, "--stage", "qa", "--skill", "cr").rc).toBe(2);
  const list = o("node", "quality", "list", R, "--model", "hub/m1-b");
  expect(list.rc).toBe(0);
  expect(list.out).toContain("q1  a  review  cr  hub/m1-b  verdict=open-findings score=- confidence=- findings=1");
  expect(o("node", "quality", "list", R, "--model", "other").out).toBe("");
  const show = JSON.parse(o("node", "quality", "show", R, "a").out);
  expect(show[0].findings[0]).toMatchObject({ severity: "medium", file: "src/a.ts", line: 3, confidence: 88 });
  expect(show[0].source_artifact).toBe(crFile);
  const exp = JSON.parse(o("node", "quality", "export", R).out);
  expect(exp.schema).toBe("orch.quality.v1");
  expect(exp.reports[0].id).toBe("q1");
  expect(o("node", "quality", "show", R, "a", "--id", "q9").rc).toBe(2);
});

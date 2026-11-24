import { test, expect, setDefaultTimeout } from "bun:test";
import { join } from "node:path";
import { mkdirSync, mkdtempSync, existsSync, readFileSync, utimesSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { orch, seedHome, fakeBin, nodeOf, autoCleanup, waitUntil } from "../helpers";
import { withHandoffFooter } from "../../core/commands/dispatch.ts";
autoCleanup();
setDefaultTimeout(120000);

const FOOTER_MARK = "agent-spec/ is not the handoff";
const count = (s: string, sub: string) => s.split(sub).length - 1;
const lastLine = (s: string) => s.trim().split("\n").pop()!;
const exited = (home: string, job: string): boolean => {
  try { return readFileSync(join(home, "jobs", job, "exit_code"), "utf8").trim() !== ""; } catch { return false; }
};

test("withHandoffFooter adds one footer and skips a prompt that already has one", () => {
  const f = withHandoffFooter("Do X", "/o/n", "R1", "n");
  expect(count(f, FOOTER_MARK)).toBe(1);
  expect(f).toContain("/o/n/handoff.md");
  expect(f).toContain("dispatch.ts node result R1 n ");
  expect(f.length - f.indexOf("---")).toBeLessThan(400);
  expect(withHandoffFooter(f, "/o/n", "R1", "n")).toBe(f);
  expect(withHandoffFooter("Write $ORCH_NODE_OUT/handoff.md", "/o/n", "R1", "n")).toBe("Write $ORCH_NODE_OUT/handoff.md");
});

test("node dispatch appends the handoff footer once, and retry and resume do not duplicate it", async () => {
  const bin = fakeBin({ claude: `printf "%s\\n" "$@"` });
  const home = seedHome();
  const o = orch(home, { PATH: `${bin}:${process.env.PATH}`, ORCH_HEALTH_MONITOR: "0", ORCH_OWNER_FILL: "0" });
  const R = o("run", "start", "footer").out.trim();
  o("node", "add", R, "a", "A");
  const job = lastLine(o("node", "dispatch", R, "a", "claude", "TASK ONE").out);
  await waitUntil(() => exited(home, job), 30);
  const log1 = readFileSync(join(home, "jobs", job, "log"), "utf8");
  const outDir = o("node", "out", R, "a").out.trim();
  expect(log1).toContain("TASK ONE");
  expect(count(log1, FOOTER_MARK)).toBe(1);
  expect(log1).toContain(`${outDir}/handoff.md`);
  expect(log1).toContain(`dispatch.ts node result ${R} a `);
  expect(log1.length - log1.indexOf(FOOTER_MARK)).toBeLessThan(400);
  expect(nodeOf(home, R, "a").prompt).toBe("TASK ONE");

  // A stored prompt is never changed: the footer lives only in the dispatched text.
  expect(o("node", "update", R, "a", "done").rc).toBe(0);
  const retry = o("node", "retry", R, "a", "--early-end");
  expect(retry.rc).toBe(0);
  const job2 = lastLine(retry.out);
  await waitUntil(() => exited(home, job2), 30);
  const log2 = readFileSync(join(home, "jobs", job2, "log"), "utf8");
  // The resumed session already has the footer; the continuation names $ORCH_NODE_OUT, so no second footer.
  expect(count(log2, FOOTER_MARK)).toBe(0);
  expect(log2).toContain("You ended early.");
  expect(nodeOf(home, R, "a").prompt).toBe("TASK ONE");
});

test("a prompt that already names ORCH_NODE_OUT gets no footer", async () => {
  const bin = fakeBin({ claude: `printf "%s\\n" "$@"` });
  const home = seedHome();
  const o = orch(home, { PATH: `${bin}:${process.env.PATH}`, ORCH_HEALTH_MONITOR: "0", ORCH_OWNER_FILL: "0" });
  const R = o("run", "start", "own out").out.trim();
  o("node", "add", R, "b", "B");
  const job = lastLine(o("node", "dispatch", R, "b", "claude", "Write $ORCH_NODE_OUT/handoff.md").out);
  await waitUntil(() => exited(home, job), 30);
  const log = readFileSync(join(home, "jobs", job, "log"), "utf8");
  expect(count(log, FOOTER_MARK)).toBe(0);
});

test("run sync copies a fresh agent-spec handoff into $ORCH_NODE_OUT instead of ending the node early", () => {
  const home = seedHome();
  const o = orch(home, { ORCH_HEALTH_MONITOR: "0", ORCH_OWNER_FILL: "0" });
  const R = o("run", "start", "spec copy").out.trim();
  for (const n of ["s"]) o("node", "add", R, n, n.toUpperCase());
  const repo = mkdtempSync(join(tmpdir(), "spec-repo-"));
  const job = `specjob-${process.pid}`;
  mkdirSync(join(home, "jobs", job), { recursive: true });
  writeFileSync(join(home, "jobs", job, "exit_code"), "0\n");
  writeFileSync(join(home, "jobs", job, "log"), "");
  writeFileSync(join(home, "jobs", job, "repo"), `${repo}\n`);
  o("node", "update", R, "s", "running", "--job", job);
  // The job writes its handoff after the attempt started, into the repo's agent-spec/.
  mkdirSync(join(repo, "agent-spec", "my-slug"), { recursive: true });
  writeFileSync(join(repo, "agent-spec", "my-slug", "handoff.md"), "## Done\nchanged a.ts\n");

  o("run", "sync", R, "--no-retry");
  const n = nodeOf(home, R, "s");
  expect(n.status).toBe("done");
  expect(n.error ?? null).toBeNull();
  const copied = readFileSync(join(o("node", "out", R, "s").out.trim(), "handoff.md"), "utf8");
  expect(copied.split("\n")[0]).toContain(join(repo, "agent-spec", "my-slug", "handoff.md"));
  expect(copied).toContain("changed a.ts");
});

test("run sync still ends the node early when agent-spec has no handoff newer than the attempt", () => {
  const home = seedHome();
  const o = orch(home, { ORCH_HEALTH_MONITOR: "0", ORCH_OWNER_FILL: "0" });
  const R = o("run", "start", "spec stale").out.trim();
  o("node", "add", R, "t", "T");
  const repo = mkdtempSync(join(tmpdir(), "spec-stale-"));
  mkdirSync(join(repo, "agent-spec", "old"), { recursive: true });
  writeFileSync(join(repo, "agent-spec", "old", "handoff.md"), "old work\n");
  const past = new Date(Date.now() - 3600_000);
  utimesSync(join(repo, "agent-spec", "old", "handoff.md"), past, past);
  const job = `staleajob-${process.pid}`;
  mkdirSync(join(home, "jobs", job), { recursive: true });
  writeFileSync(join(home, "jobs", job, "exit_code"), "0\n");
  writeFileSync(join(home, "jobs", job, "log"), "");
  writeFileSync(join(home, "jobs", job, "repo"), `${repo}\n`);
  o("node", "update", R, "t", "running", "--job", job);

  o("run", "sync", R, "--no-retry");
  expect(nodeOf(home, R, "t").error).toBe("ended early without handoff");
  expect(nodeOf(home, R, "t").status).toBe("error");
  expect(existsSync(join(home, "runs", R, "out", "t", "handoff.md")) ? readFileSync(join(home, "runs", R, "out", "t", "handoff.md"), "utf8") : "").not.toContain("old work");
});

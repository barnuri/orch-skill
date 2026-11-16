import { test, expect, setDefaultTimeout } from "bun:test";
import { join } from "node:path";
import { readFileSync } from "node:fs";
import { runHome, setNode } from "./common";
import { fakeBin, autoCleanup, events, waitUntil } from "../helpers";
setDefaultTimeout(120000);
autoCleanup();

const exited = (home: string, job: string): boolean => { try { return readFileSync(join(home, "jobs", job, "exit_code"), "utf8").trim() !== ""; } catch { return false; } };
const finish = async (home: string, job: string): Promise<void> => void expect(await waitUntil(() => exited(home, job), 30)).toBe(true);
const log = (home: string, job: string) => readFileSync(join(home, "jobs", job, "log"), "utf8");
const lastLine = (s: string) => s.trim().split("\n").pop()!;

// P7: the agent ended its turn with text only, the job exited 0, no handoff.md.
test("P7 early end: node retry --early-end resumes the claude session with the continue message, counts it, stops at 2", async () => {
  const bin = fakeBin({ claude: `printf "%s\\n" "$@"` });
  const t = runHome({ PATH: `${bin}:${process.env.PATH}` });
  t.o("node", "add", "r1", "e", "E");
  const job = lastLine(t.o("node", "dispatch", "r1", "e", "claude", "TASK ONE").out);
  await finish(t.home, job);
  const session = t.node("e").session;
  expect(session).toMatch(/^[0-9a-f-]{36}$/);
  expect(t.o("node", "update", "r1", "e", "done").rc).toBe(0);
  expect(t.node("e").unverified).toBe(true);

  const r = t.o("node", "retry", "r1", "e", "--early-end");
  expect(r.rc).toBe(0);
  const job2 = lastLine(r.out);
  await finish(t.home, job2);
  const text = log(t.home, job2);
  expect(text).toContain(`--resume\n${session}`);
  expect(text).toContain("You ended early. Read your task and handoff notes, continue, and write handoff.md in $ORCH_NODE_OUT before you finish");
  expect(text).not.toContain("TASK ONE");
  const n = t.node("e");
  expect([n.resumes, n.attempts.length, n.attempts[0].retry_mode, n.attempts[0].retry_session, n.prompt, n.unverified ?? null]).toEqual([1, 1, "resumed", session, "TASK ONE", null]);
  const resumed = events(t.home, "r1").filter((e) => e.kind === "resumed");
  expect(resumed).toHaveLength(1);
  expect(resumed[0].node).toBe("e");
  expect(resumed[0].note).toContain("1 of 2");

  t.o("node", "update", "r1", "e", "done");
  expect(t.o("node", "retry", "r1", "e", "--early-end").rc).toBe(0);
  expect(t.node("e").resumes).toBe(2);
  await finish(t.home, t.node("e").job_id);
  t.o("node", "update", "r1", "e", "done");
  const third = t.o("node", "retry", "r1", "e", "--early-end");
  expect(third.rc).toBe(2);
  expect(third.err).toMatch(/already resumed 2 times/);
  expect(t.node("e").status).toBe("done");
});

test("P7 early end on opencode resumes the bound ses_ session; without one it restarts with the original task", async () => {
  const bin = fakeBin({ opencode: `printf "%s\\n" "$@"` });
  const t = runHome({ PATH: `${bin}:${process.env.PATH}` });
  t.o("node", "add", "r1", "c", "C");
  t.o("node", "add", "r1", "d", "D");
  const j1 = lastLine(t.o("node", "dispatch", "r1", "c", "opencode", "TASK TWO").out);
  await finish(t.home, j1);
  setNode(t.home, "c", { owner_kind: "session", owner_id: "ses_realabc123", owner_bind: "job" });
  t.o("node", "update", "r1", "c", "done");
  const r = t.o("node", "retry", "r1", "c", "--early-end");
  expect(r.rc).toBe(0);
  const j2 = lastLine(r.out);
  await finish(t.home, j2);
  expect(log(t.home, j2)).toContain("--session\nses_realabc123");
  expect([t.node("c").attempts[0].retry_mode, t.node("c").attempts[0].retry_session]).toEqual(["resumed", "ses_realabc123"]);

  // No ses_ id known (a uuid only): opencode cannot resume it, so the retry restarts with the task text.
  const j3 = lastLine(t.o("node", "dispatch", "r1", "d", "opencode", "TASK THREE").out);
  await finish(t.home, j3);
  t.o("node", "update", "r1", "d", "done");
  const r2 = t.o("node", "retry", "r1", "d", "--early-end");
  expect(r2.rc).toBe(0);
  const j4 = lastLine(r2.out);
  await finish(t.home, j4);
  const text = log(t.home, j4);
  expect(text).not.toContain("--session");
  expect(text).toContain("TASK THREE");
  expect(text).toContain("You ended early.");
  expect([t.node("d").attempts[0].retry_mode, t.node("d").resumes]).toEqual(["restarted", 1]);
});

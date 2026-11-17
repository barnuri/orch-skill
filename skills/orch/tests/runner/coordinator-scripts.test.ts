import { test, expect } from "bun:test";
import { join } from "node:path";
import { mkdirSync, writeFileSync } from "node:fs";
import { REPO_ROOT, tempDir, runCmd, autoCleanup } from "../helpers";
autoCleanup();

const script = (n: string) => join(REPO_ROOT, "scripts", n);

function fakeHome() {
  const home = tempDir();
  mkdirSync(join(home, "runs", "r1"), { recursive: true });
  writeFileSync(join(home, "runs", "r1", "state.json"), JSON.stringify({
    status: "running", paused: true,
    nodes: [{ id: "a", status: "done" }, { id: "b", status: "running", job: "j2" }, { id: "c", status: "waiting" }, { id: "d", status: "skipped" }],
  }));
  for (const [j, code] of [["j1", "0"], ["j2", ""]] as const) {
    mkdirSync(join(home, "jobs", j), { recursive: true });
    writeFileSync(join(home, "jobs", j, "log.plain"), `log of ${j}\nlast line ${j}\n`);
    writeFileSync(join(home, "jobs", j, "profile"), "p1");
    if (code) writeFileSync(join(home, "jobs", j, "exit_code"), code);
  }
  const idFile = join(home, "run-id");
  writeFileSync(idFile, "r1\n");
  return { home, env: { HARNESS_ORCH_HOME: home, ORCH_RUN_ID_FILE: idFile } };
}

test("run-nodes groups, filters and reads the run id file", () => {
  const { env } = fakeHome();
  const r = runCmd(["bun", script("run-nodes.ts")], { env });
  expect(r.out).toContain("run r1 running (paused), 4 nodes");
  expect(r.out).toContain("running(1): b");
  expect(runCmd(["bun", script("run-nodes.ts"), "--open"], { env }).out.trim().split("\n")).toEqual(["b running", "c waiting"]);
  expect(runCmd(["bun", script("run-nodes.ts"), "r1", "--status", "waiting"], { env }).out.trim()).toBe("c");
});

test("job-tail shows newest job, a prefix, or a node's job", () => {
  const { env } = fakeHome();
  expect(runCmd(["bun", script("job-tail.ts")], { env }).out).toContain("job j2 profile=p1 exit=running");
  const r = runCmd(["bun", script("job-tail.ts"), "j1", "--bytes", "12"], { env });
  expect(r.out).toContain("exit=0");
  expect(r.out).toContain("last line j1");
  expect(r.out).not.toContain("log of j1");
  expect(runCmd(["bun", script("job-tail.ts"), "--node", "b"], { env }).out).toContain("job j2");
});

test("o.ts substitutes @run, unsets the home, batches set, tails output", () => {
  const { home, env } = fakeHome();
  const fake = join(home, "fake-dispatch.ts");
  writeFileSync(fake, `console.log("home=" + (process.env.HARNESS_ORCH_HOME ?? "unset"));\nconsole.log("args=" + process.argv.slice(2).join(" "));\nif (process.argv.includes("bad")) process.exit(3);\n`);
  const e = { ...env, ORCH_DISPATCH: fake };
  const r = runCmd(["bun", script("o.ts"), "run", "status", "@run"], { env: e });
  expect(r.out).toContain("home=unset");
  expect(r.out).toContain("args=run status r1");
  expect(runCmd(["bun", script("o.ts"), "run", "x", "--test-home", "--tail", "1"], { env: e }).out.trim()).toBe("args=run x");
  const s = runCmd(["bun", script("o.ts"), "set", "done", "a", "bad"], { env: e });
  expect(s.out).toContain("args=node update r1 a done");
  expect(s.all).toContain("FAILED done: bad");
  expect(s.rc).toBe(1);
});

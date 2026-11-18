import { test, expect } from "bun:test";
import { join } from "node:path";
import { mkdirSync, writeFileSync } from "node:fs";
import { orch, seedHome, nodeOf, editJson, fakeBin, autoCleanup } from "../helpers";
autoCleanup();

test("run sync and tail fall back to `hc read` when the job log is empty", () => {
  const home = seedHome();
  const bin = fakeBin({ hc: `[ "$1" = read ] && [ "$2" = t7 ] && { printf 'hello\\nfrom hc\\n'; exit 0; }\nexit 1` });
  const o = orch(home, { PATH: `${bin}:${process.env.PATH}`, ORCH_HC: "1" });
  o("run", "start", "hc tail", "--id", "hct");
  o("node", "add", "hct", "a", "x");
  const job = join(home, "jobs", "hcjob");
  mkdirSync(job, { recursive: true });
  writeFileSync(join(job, "log"), "");
  writeFileSync(join(job, "hc_term"), "t7\n");
  editJson(join(home, "runs/hct/state.json"), (s) => { Object.assign(s.nodes[0], { status: "running", job_id: "hcjob", adapter: "claude-native" }); });
  o("run", "sync", "hct", "--no-retry");
  expect(nodeOf(home, "hct", "a").log_tail).toEqual(["hello", "from hc"]);
  expect(o("tail", "hcjob").out).toBe("hello\nfrom hc\n");
  writeFileSync(join(job, "log"), "real log\n");
  expect(o("tail", "hcjob").out).toBe("real log\n");
});

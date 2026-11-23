import { test, expect } from "bun:test";
import { join } from "node:path";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { autoCleanup, orch, seedHome, runState, nodeOf, readJson } from "../helpers";

autoCleanup();

test("run merge moves selected nodes, requirements and owners without stopping jobs", () => {
  const home = seedHome();
  const o = orch(home);
  const source = o("run", "start", "Source", "--id", "merge-source").out.trim();
  const destination = o("run", "start", "Destination", "--id", "merge-destination").out.trim();

  o("node", "add", source, "a", "Node A");
  o("node", "add", source, "b", "Node B");
  o("node", "add", destination, "keep", "Keep node");
  o("node", "update", source, "a", "running", "--job", "job-a", "--owner", "ses_ownera", "--force");

  const outDir = join(home, "runs", source, "out", "a");
  mkdirSync(outDir, { recursive: true });
  writeFileSync(join(outDir, "handoff.md"), "running handoff\n");

  const jobDir = join(home, "jobs", "job-a");
  mkdirSync(jobDir, { recursive: true });
  writeFileSync(join(jobDir, "status"), "running\n");

  o("req", "add", source, "Both nodes", "--node", "a,b", "--id", "R1");
  o("req", "add", source, "Only A", "--node", "a", "--id", "R2");
  o("req", "add", source, "Only B", "--node", "b", "--id", "R3");
  o("req", "add", destination, "Destination requirement", "--id", "RD");

  expect(o("run", "merge", source, destination, "--nodes", "a").rc).toBe(0);

  expect(nodeOf(home, source, "a")).toBeUndefined();
  expect(nodeOf(home, source, "b")?.id).toBe("b");
  const moved = nodeOf(home, destination, "a");
  expect(moved?.status).toBe("running");
  expect(moved?.job_id).toBe("job-a");
  expect(moved?.owner_id).toBe("ses_ownera");
  expect(moved?.out_dir).toBe(outDir);
  expect(readFileSync(join(outDir, "handoff.md"), "utf8").trim()).toBe("running handoff");
  expect(readJson(join(home, "owners", "ses_ownera.json")).run).toBe(destination);
  expect(existsSync(jobDir)).toBe(true);
  expect(readFileSync(join(jobDir, "status"), "utf8").trim()).toBe("running");

  const sourceLedger = readJson(join(home, "runs", source, "requirements.json"));
  expect(sourceLedger.requirements.map((r: any) => r.id).sort()).toEqual(["R1", "R3"]);
  expect(sourceLedger.requirements.find((r: any) => r.id === "R1").nodes).toEqual(["b"]);

  const destinationLedger = readJson(join(home, "runs", destination, "requirements.json"));
  expect(destinationLedger.requirements.map((r: any) => r.id).sort()).toEqual(["R1", "R2", "RD"]);
  expect(destinationLedger.requirements.find((r: any) => r.id === "R1").nodes).toEqual(["a"]);
  expect(runState(home, destination).edges ?? []).toBeDefined();
}, 300000);

test("run merge moves all nodes and internal edges", () => {
  const home = seedHome();
  const o = orch(home);
  const source = o("run", "start", "Source all", "--id", "merge-source-all").out.trim();
  const destination = o("run", "start", "Destination all", "--id", "merge-destination-all").out.trim();
  o("node", "add", source, "a", "A", "--after", "");
  o("node", "add", source, "b", "B", "--after", "a");
  o("req", "add", source, "All nodes", "--node", "a,b", "--id", "RA");

  expect(o("run", "merge", source, destination).rc).toBe(0);
  expect(nodeOf(home, source, "a")).toBeUndefined();
  expect(nodeOf(home, source, "b")).toBeUndefined();
  expect(nodeOf(home, destination, "a")?.id).toBe("a");
  expect(nodeOf(home, destination, "b")?.id).toBe("b");
  expect(runState(home, destination).edges).toContainEqual(["a", "b"]);
  expect(readJson(join(home, "runs", destination, "requirements.json")).requirements.map((r: any) => r.id)).toEqual(["RA"]);
}, 300000);

test("run merge rejects missing nodes and duplicate destination nodes", () => {
  const home = seedHome();
  const o = orch(home);
  const source = o("run", "start", "Source", "--id", "merge-source-2").out.trim();
  const destination = o("run", "start", "Destination", "--id", "merge-destination-2").out.trim();
  o("node", "add", source, "a", "Node A");
  o("node", "add", destination, "a", "Node A in destination");

  expect(o("run", "merge", source, destination, "--nodes", "missing").all).toContain("not in source run");
  expect(o("run", "merge", source, destination, "--nodes", "a").all).toContain("already in destination run");
  expect(nodeOf(home, source, "a")?.id).toBe("a");
}, 300000);

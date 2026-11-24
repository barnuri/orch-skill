import { test, expect } from "bun:test";
import { join } from "node:path";
import { writeFileSync } from "node:fs";
import { orch, seedHome, editJson, runState, readJson, readText, autoCleanup, handoff } from "../helpers";
import { spawnEchoHub } from "../helpers/hub-proc.ts";
autoCleanup();

test("profile pick, flags, plan apply and advance, msg", async () => {
  const home = seedHome(), o = orch(home);
  const pf = join(home, "profiles.json");
  editJson(pf, (p) => { p.settings.disabled_harnesses = ["claude"]; });
  expect(o("profile", "pick", "refactor the whole auth layer across services", "--complexity", "large").all).not.toMatch(/^profile=claude/m);
  editJson(pf, (p) => { p.settings.disabled_harnesses = []; p.profiles["copilot-default"].flags = ["--yolo --no-ask-user", "--autopilot"]; });
  o("profile", "list");
  expect(readJson(pf).profiles["copilot-default"].flags).toEqual(["--yolo", "--no-ask-user", "--autopilot"]);
  editJson(pf, (p) => {
    p.settings.disabled_harnesses = ["claude", "opencode", "cursor-agent"]; p.profiles["local-llm-fast"].enabled = true;
    p.settings.default_profile = "local-llm-fast"; p.settings.planner_profile = "local-llm-fast"; p.defaults.max_parallel = 2; p.settings.max_nodes = 5;
  });
  const st = () => runState(home, "plan-1");
  o("run", "start", "Planned", "--id", "plan-1");
  expect(o.env({ LLM_HUB_URL: "http://127.0.0.1:9" }, "plan", "plan-1", "Ship the widget").rc).toBe(0);
  expect([st().plan.node, st().plan.profile]).toEqual(["plan", "local-llm-fast"]);
  const prompt = readText(join(home, "runs/plan-1/prompts/plan.md"));
  expect(prompt).toMatch(/Ship the widget/);
  expect(prompt).toMatch(/At most 5 tasks. At most 2 run at the same time/);
  expect(prompt).toMatch(/^- local-llm-fast \(default\)/m);
  expect(prompt).not.toMatch(/^- claude-default/m);
  o("node", "update", "plan-1", "plan", "done");
  const po = join(home, "runs/plan-1/out/plan");
  const apply = (obj: any) => { writeFileSync(join(po, "bad.json"), JSON.stringify(obj)); return o("plan", "apply", "plan-1", "--file", join(po, "bad.json")); };
  let r = apply({ tasks: [{ id: "a", prompt: "x", after: ["b"] }, { id: "b", prompt: "y", after: ["a"] }] });
  expect(r.rc).toBe(2); expect(r.all).toMatch(/dependency cycle among: a, b/);
  r = apply({ tasks: [{ id: "a", prompt: "x", after: ["zz"] }, { id: "plan", prompt: "y" }, { id: "c" }] });
  expect(r.all).toMatch(/task a depends on unknown task zz/);
  expect(r.all).toMatch(/task id plan collides with an existing node/);
  expect(r.all).toMatch(/task c has no prompt/);
  r = apply({ tasks: ["a", "b", "c", "d", "e", "f"].map((id) => ({ id, prompt: "x" })) });
  expect(r.all).toMatch(/plan has 6 tasks; settings.max_nodes is 5/);
  expect(st().nodes.length).toBe(1);
  writeFileSync(join(po, "plan.json"), JSON.stringify({ summary: "three then merge", tasks: [
    { id: "a", label: "Part A", prompt: "do A" }, { id: "b", label: "Part B", profile: "claude-default", prompt: "do B" },
    { id: "c", label: "Part C", prompt: "do C" }, { id: "merge", label: "Integrate", after: ["a", "b", "c"], prompt: "merge them" }] }));
  const hub = await spawnEchoHub(1000);
  const env = { LLM_HUB_URL: hub.url };
  r = o.env(env, "run", "advance", "plan-1");
  expect(r.rc).toBe(0);
  expect(r.all).toMatch(/applied: 4 task\(s\)/);
  expect(r.all).toMatch(/stages: a\+b\+c -> merge/);
  expect(r.all).toMatch(/profile claude-default is disabled or not for orch runs, using local-llm-fast/);
  expect(r.out).toMatch(/^dispatched: a,b$/m);
  expect(r.out).toMatch(/^queued: c$/m);
  const edges = JSON.stringify(st().edges);
  expect(edges).toContain('["plan","a"]'); expect(edges).toContain('["c","merge"]');
  expect(st().plan.tasks).toBe(4);
  const tp = readText(join(home, "runs/plan-1/prompts/merge.md"));
  expect(tp).toMatch(/^merge them/);
  expect(tp).toMatch(/out\/a, .*out\/b, .*out\/c/);
  expect(tp).toMatch(/msg send plan-1 --to orch/);
  const sync = o("run", "sync", "plan-1").out;
  const running = sync.split("\n").filter((l) => l.endsWith("\trunning")).length;
  expect(sync).toMatch(new RegExp(`^slots: ${2 - running}$`, "m"));
  // The echo-hub nodes write no handoff; the run gate (run verify) needs one per done node.
  for (const id of ["plan", "a", "b", "c", "merge"]) {
    handoff(home, "plan-1", id);
    o("node", "result", "plan-1", id, "--verdict", "full", "--summary", "ok", "--follow-up", "none");
  }
  o("node", "update", "plan-1", "plan", "done"); // re-check: clears unverified now that the handoff exists
  // The run needs a recorded request, and the merge node's handoff must be newer than its latest attempt.
  o("req", "add", "plan-1", "Integrate the three parts", "--node", "merge", "--id", "R1");
  // Waived, so the lifecycle does not add a verifier node to this scheduling test.
  o("req", "status", "plan-1", "R1", "waived", "--reason", "scheduling test");
  r = o.env(env, "run", "advance", "plan-1", "--until-done", "--no-finish", "--interval", "1", "--timeout", "60");
  expect(r.rc).toBe(0);
  handoff(home, "plan-1", "merge");
  o("node", "update", "plan-1", "merge", "done");
  r = o.env(env, "run", "advance", "plan-1", "--until-done", "--interval", "1", "--timeout", "60");
  expect(r.rc).toBe(0);
  expect(r.out).toMatch(/^finished: done$/m);
  expect(st().nodes.map((n: any) => n.status).join(" ")).toBe("done done done done done");
  expect(readText(join(home, "runs/plan-1/prompts/a.md"))).toMatch(/ORCH_DISPATCH/);
  hub.stop();
  expect(o("plan", "apply", "plan-1").rc).toBe(2);
  const oa = orch(home, { ORCH_RUN_ID: "plan-1", ORCH_NODE_ID: "a" });
  expect(oa("msg", "send", "plan-1", "--to", "orch", "need the schema").rc).toBe(0);
  o("msg", "send", "plan-1", "--to", "all", "heads up: API renamed");
  o("msg", "send", "plan-1", "--to", "b", "only for b");
  let m = o("msg", "read", "plan-1").out;
  expect(m).toMatch(/^1\t.*\ta -> orch\tneed the schema$/m);
  expect(m).not.toMatch(/heads up/);
  m = orch(home, { ORCH_RUN_ID: "plan-1", ORCH_NODE_ID: "c" })("msg", "read", "plan-1").out;
  expect(m).toMatch(/orch -> all\theads up: API renamed/);
  expect(m).not.toMatch(/only for b/);
  expect(o("msg", "read", "plan-1", "--for", "b", "--since", "2").out).toMatch(/^3\t.*only for b$/m);
  expect(o("msg", "send", "plan-1", "--to", "nobody", "x").rc).toBe(2);
}, 300000);

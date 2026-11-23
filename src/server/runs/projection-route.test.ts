import { expect, test } from "bun:test";
import { writeFileSync } from "node:fs";
import { join } from "node:path";
import { autoCleanup, nodeOf, orch, runState, seedHome } from "../../../skills/orch/tests/helpers";
import { loadRunProjection } from "../../../skills/orch/core/runs/projection";
import { decide } from "./auto-dispatch";
import { readRunProjectionHandler } from "./projection-route";
import type { ServerContext } from "../types/server-context";

autoCleanup();

const ENV = { ORCH_HEALTH_MONITOR: "0", ORCH_OWNER_FILL: "0", ORCH_NO_DONE_GATE: "0" };

function setup() {
  const home = seedHome();
  const o = orch(home, ENV);
  const R = o("run", "start", "identity run").out.trim();
  o("node", "add", R, "a", "A", "--profile", "p");
  o("node", "add", R, "b", "B", "--after", "a", "--profile", "p");
  o("node", "add", R, "c", "C", "--profile", "p");
  o("req", "add", R, "ask one", "--node", "a");
  o("req", "add", R, "ask two", "--node", "c");
  return { home, o, R };
}

// The supervisor starts what decide() says and the projection calls ready: both must name the same nodes.
async function supervisorStarts(home: string, R: string): Promise<string[]> {
  const state = runState(home, R);
  state.auto_dispatch = true;
  state.default_profile = "p";
  return decide(state, Number.POSITIVE_INFINITY).filter((d) => d.action === "start").map((d) => d.node).sort();
}

test("API body, CLI projection and loader are identical for the same state", async () => {
  const { home, o, R } = setup();
  const handler = readRunProjectionHandler({ paths: { home } } as unknown as ServerContext);
  const apiBody = await (await handler(new Request("http://127.0.0.1/api/runs/x/projection"), { id: R })).json();
  const cli = JSON.parse(o("run", "status", R, "--json").out).projection;
  const loaded = await loadRunProjection(home, R);
  expect(apiBody).toEqual(cli);
  expect(cli).toEqual(loaded);
  expect(apiBody.ready).toEqual(["a", "c"]);
  expect(apiBody.open_requirements).toEqual(["R1", "R2"]);
});

test("the supervisor starts exactly the projection's ready nodes, before and after a dependency finishes", async () => {
  const { home, o, R } = setup();
  expect(await supervisorStarts(home, R)).toEqual((await loadRunProjection(home, R))!.ready);
  o("node", "update", R, "a", "running", "--owner", "coordinator");
  writeFileSync(join(o("node", "out", R, "a").out.trim(), "handoff.md"), "done\n");
  o("node", "result", R, "a", "--verdict", "full", "--summary", "ok", "--follow-up", "none");
  o("node", "update", R, "a", "done");
  expect(nodeOf(home, R, "a").status).toBe("done");
  const ready = (await loadRunProjection(home, R))!.ready;
  expect(ready).toEqual(["b", "c"]);
  expect(await supervisorStarts(home, R)).toEqual(ready);
});

test("an unknown run answers no projection", async () => {
  const handler = readRunProjectionHandler({ paths: { home: seedHome() } } as unknown as ServerContext);
  expect((await handler(new Request("http://127.0.0.1/api/runs/x/projection"), { id: "missing" })).status).toBe(404);
});

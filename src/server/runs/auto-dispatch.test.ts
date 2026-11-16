import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { existsSync, readFileSync } from "node:fs";
import { join, resolve } from "node:path";

import { TempHome } from "../test-support/temp-home";
import { decide, notifyFile, RunEngine, subscribeNodeChanges, type NodeChange, type RunState } from "./auto-dispatch";

const FAKE = resolve(import.meta.dir, "../test-support/fake-dispatch.sh");
let prevDispatch: string | undefined;
beforeAll(() => {
  prevDispatch = process.env["ORCH_DISPATCH"];
  process.env["ORCH_DISPATCH"] = FAKE;
});
afterAll(() => {
  if (prevDispatch === undefined) {
    delete process.env["ORCH_DISPATCH"];
  } else {
    process.env["ORCH_DISPATCH"] = prevDispatch;
  }
});

function run(patch: Partial<RunState>): RunState {
  return {
    run_id: "r1",
    status: "running",
    auto_dispatch: true,
    nodes: [
      { id: "a", status: "done", label: "A", profile: "p" },
      { id: "b", status: "waiting", label: "B", profile: "p" },
      { id: "c", status: "waiting", label: "C", profile: "p" },
    ],
    edges: [["a", "b"], ["b", "c"]],
    ...patch,
  };
}

function homeWith(state: RunState, serve?: Record<string, unknown>): TempHome {
  const home = TempHome.create();
  home.write("runs/r1/state.json", JSON.stringify(state));
  if (serve !== undefined) {
    home.write("serve.json", JSON.stringify(serve));
  }
  return home;
}

function calls(home: TempHome): string[] {
  const f = home.resolve("fake-dispatch.calls");
  return existsSync(f) ? readFileSync(f, "utf8").split("\n").filter((l) => l !== "") : [];
}

async function settle(engine: RunEngine): Promise<void> {
  await Promise.all([...engine.inflight]);
}

describe("auto-dispatch", () => {
  test("a ready node starts once through the fake dispatch, a blocked node does not", async () => {
    const home = homeWith(run({}));
    const logs: string[] = [];
    const engine = new RunEngine(home.path, { log: (l) => void logs.push(l) });
    engine.evaluate("r1");
    await settle(engine);
    expect(calls(home)).toEqual(["r1 b p"]);
    expect(logs).toContain("start r1 b --profile p");
    expect(logs).toContain("skip r1 c: waiting on b");
    home.dispose();
  });

  test("a failed start frees its claim and is retried, then stops after 3 tries", async () => {
    const home = homeWith(run({}));
    const logs: string[] = [];
    let tries = 0;
    const engine = new RunEngine(home.path, {
      log: (l) => void logs.push(l),
      retryMs: 20,
      start: async () => {
        tries += 1;
        return tries < 2 ? 1 : 0;
      },
    });
    engine.evaluate("r1");
    await settle(engine);
    await new Promise((r) => setTimeout(r, 120));
    await settle(engine);
    expect(tries).toBe(2);
    expect(logs.some((l) => l.includes("retry 1/2"))).toBe(true);

    const always = new RunEngine(homeWith(run({})).path, { log: (l) => void logs.push(l), retryMs: 10, start: async () => 1 });
    always.evaluate("r1");
    await new Promise((r) => setTimeout(r, 200));
    await settle(always);
    expect(logs.some((l) => l.includes("gave up after 3 tries"))).toBe(true);
  });

  test("a double event starts the node once", async () => {
    const home = homeWith(run({}));
    const engine = new RunEngine(home.path, { log: () => {} });
    engine.evaluate("r1");
    engine.evaluate("r1");
    // a second engine (a restarted server) over the same state starts nothing either
    new RunEngine(home.path, { log: () => {} }).evaluate("r1");
    await settle(engine);
    expect(calls(home)).toEqual(["r1 b p"]);
    home.dispose();
  });

  test("a paused or stopped run starts nothing", async () => {
    for (const patch of [{ paused: true }, { stopped: true }]) {
      const home = homeWith(run(patch));
      const logs: string[] = [];
      const engine = new RunEngine(home.path, { log: (l) => void logs.push(l) });
      engine.evaluate("r1");
      await settle(engine);
      expect(calls(home)).toEqual([]);
      expect(logs.some((l) => /^skip r1 b: run (paused|stopped)$/.test(l))).toBe(true);
      home.dispose();
    }
  });

  test("a run without auto_dispatch true starts nothing", async () => {
    const home = homeWith(run({ auto_dispatch: undefined }));
    const engine = new RunEngine(home.path, { log: () => {} });
    engine.evaluate("r1");
    await settle(engine);
    expect(calls(home)).toEqual([]);
    home.dispose();
  });

  test("the per-run cap from serve.json holds, counting running nodes", async () => {
    const nodes = [
      { id: "r", status: "running", profile: "p" },
      ...["n1", "n2", "n3", "n4"].map((id) => ({ id, status: "waiting", profile: "p" })),
    ];
    const home = homeWith(run({ nodes, edges: [] }), { auto_dispatch_max_parallel: 3 });
    const logs: string[] = [];
    const engine = new RunEngine(home.path, { log: (l) => void logs.push(l) });
    engine.evaluate("r1");
    await settle(engine);
    expect(calls(home)).toEqual(["r1 n1 p", "r1 n2 p"]);
    expect(logs).toContain("skip r1 n3: cap 3 reached");
    home.dispose();
  });

  test("the default cap is 4 and the run profile is the fallback", () => {
    const nodes = ["n1", "n2", "n3", "n4", "n5"].map((id) => ({ id, status: "waiting" }));
    const out = decide(run({ nodes, edges: [], default_profile: "dflt" }), 4);
    expect(out.filter((d) => d.action === "start").map((d) => (d.action === "start" ? d.profile : ""))).toEqual(["dflt", "dflt", "dflt", "dflt"]);
  });

  test("the prompt is the stored prompt, else agent-rules plus the goal", () => {
    const out = decide(run({ nodes: [{ id: "x", status: "waiting", profile: "p", prompt: "stored" }, { id: "y", status: "waiting", profile: "p", label: "the goal" }], edges: [] }), 4);
    const prompts = out.map((d) => (d.action === "start" ? d.prompt : ""));
    expect(prompts[0]).toBe("stored");
    expect(prompts[1]).toContain("Shared subagent rules");
    expect(prompts[1]).toContain("the goal");
  });

  test("a node turning done or error writes one notification line and one bus event", () => {
    const home = homeWith(run({ auto_dispatch: false }));
    const seen: NodeChange[] = [];
    const off = subscribeNodeChanges((c) => void seen.push(c));
    const engine = new RunEngine(home.path, { log: () => {} });
    engine.evaluate("r1");
    home.write("runs/r1/state.json", JSON.stringify(run({ auto_dispatch: false, nodes: [{ id: "a", status: "done" }, { id: "b", status: "error" }, { id: "c", status: "running" }] })));
    engine.evaluate("r1");
    engine.evaluate("r1");
    off();
    expect(seen.map((c) => `${c.node} ${c.from}->${c.to}`)).toEqual(["b waiting->error"]);
    const lines = readFileSync(notifyFile(home.path, "r1"), "utf8").trim().split("\n");
    expect(lines.length).toBe(1);
    expect(JSON.parse(lines[0] ?? "{}")).toMatchObject({ run: "r1", node: "b", to: "error" });
    home.dispose();
  });

  test("a state.json write is picked up by the watcher (debounced)", async () => {
    const home = homeWith(run({ auto_dispatch: false }));
    const engine = new RunEngine(home.path, { log: () => {} });
    engine.begin();
    try {
      expect(calls(home)).toEqual([]);
      home.write("runs/r1/state.json", JSON.stringify(run({})));
      const deadline = Date.now() + 5000;
      while (calls(home).length === 0 && Date.now() < deadline) {
        await Bun.sleep(50);
        await settle(engine);
      }
      expect(calls(home)).toEqual(["r1 b p"]);
      expect(existsSync(join(home.path, "autodispatch", "r1", "claims", "b@0"))).toBe(true);
    } finally {
      engine.stop();
      home.dispose();
    }
  });
});

import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { existsSync, readFileSync } from "node:fs";
import { join, resolve } from "node:path";

import { TempHome } from "../test-support/temp-home";
import { decide, maxParallel, notifyFile, profileCapOf, RunEngine, subscribeNodeChanges, type NodeChange, type RunState } from "./auto-dispatch";

const FAKE = resolve(import.meta.dir, "../test-support/fake-dispatch.ts");
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
    home.write("profiles.json", "{}");
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

  test("a dependency that finished seconds ago without a handoff does not unblock its dependents yet", () => {
    const just = new Date().toISOString();
    const state = run({ nodes: [{ id: "a", status: "done", label: "A", profile: "p", finished: just } as never, { id: "b", status: "waiting", label: "B", profile: "p" }], edges: [["a", "b"]] });
    expect(decide(state, 4, () => false)).toEqual([{ node: "b", action: "skip", reason: "waiting on a" }]);
    expect(decide(state, 4, () => true)[0]?.action).toBe("start");
  });

  test("a waiting node with an open question for the user is never started", () => {
    const state = run({ nodes: [{ id: "a", status: "waiting", label: "A", profile: "p", needs_user: "Which region?" } as never, { id: "b", status: "blocked-user", label: "B", profile: "p", needs_user: "Ship?" } as never] });
    expect(decide(state, 4)).toEqual([{ node: "a", action: "skip", reason: "needs the user" }]);
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
    expect(calls(home).sort()).toEqual(["r1 n1 p", "r1 n2 p"]);
    expect(logs).toContain("skip r1 n3: cap 3 reached");
    home.dispose();
  });

  test("the default cap is 4 and the run profile is the fallback", () => {
    const nodes = ["n1", "n2", "n3", "n4", "n5"].map((id) => ({ id, status: "waiting" }));
    const out = decide(run({ nodes, edges: [], default_profile: "dflt" }), 4);
    expect(out.filter((d) => d.action === "start").map((d) => (d.action === "start" ? d.profile : ""))).toEqual(["dflt", "dflt", "dflt", "dflt"]);
  });

  test("the per-profile cap holds even when the run cap has room", () => {
    const nodes = [
      { id: "r", status: "running", profile: "p" },
      { id: "n1", status: "waiting", profile: "p" },
      { id: "n2", status: "waiting", profile: "q" },
    ];
    const out = decide(run({ nodes, edges: [] }), 7, () => true, (p) => (p === "p" ? 1 : 7));
    expect(out[0]).toEqual({ node: "n1", action: "skip", reason: "profile p cap 1 reached" });
    expect(out[1]).toMatchObject({ node: "n2", action: "start", profile: "q" });
  });

  test("maxParallel reads defaults.max_parallel, then settings.max_parallel, then serve.json, then 30", () => {
    const h = TempHome.create();
    h.write("profiles.json", "{}");
    expect(maxParallel(h.path)).toBe(30);
    h.write("serve.json", JSON.stringify({ auto_dispatch_max_parallel: 3 }));
    expect(maxParallel(h.path)).toBe(3);
    h.write("profiles.json", JSON.stringify({ settings: { max_parallel: 5 } }));
    expect(maxParallel(h.path)).toBe(5);
    h.write("profiles.json", JSON.stringify({ defaults: { max_parallel: 7 }, settings: { max_parallel: 5 } }));
    expect(maxParallel(h.path)).toBe(7);
    h.write("profiles.json", JSON.stringify({ defaults: { max_parallel: -1 } }));
    expect(maxParallel(h.path)).toBe(Number.POSITIVE_INFINITY);
    h.dispose();
  });

  test("a profile's own max_parallel overrides the defaults cap for its nodes only", () => {
    const cap = profileCapOf({
      defaults: { max_parallel: 7 },
      profiles: { slow: { max_parallel: 2 }, fast: {} },
    });
    expect(cap("slow")).toBe(2);
    expect(cap("fast")).toBe(7);
    expect(cap("unknown")).toBe(7);
  });

  describe("effective run cap: min(global, per-run)", () => {
    const ready = (n: number) => Array.from({ length: n }, (_, i) => ({ id: `n${i}`, status: "waiting", profile: "p" }));
    const capped = async (global: unknown, perRun: number | undefined, waiting: number): Promise<{ started: number; logs: string[] }> => {
      const home = homeWith(run({ nodes: ready(waiting), edges: [], max_parallel: perRun } as Partial<RunState>));
      home.write("profiles.json", JSON.stringify({ defaults: { max_parallel: global }, profiles: { p: { max_parallel: 30 } } }));
      const logs: string[] = [];
      const engine = new RunEngine(home.path, { log: (l) => void logs.push(l) });
      engine.evaluate("r1");
      await settle(engine);
      const started = calls(home).length;
      home.dispose();
      return { started, logs };
    };

    test("the lower of global and per-run wins, both ways", async () => {
      expect((await capped(4, 2, 6)).started).toBe(2);
      expect((await capped(3, 10, 6)).started).toBe(3);
      expect((await capped(4, undefined, 6)).started).toBe(4);
    });

    test("a per-run cap below the global cap is logged as the cap reached", async () => {
      expect((await capped(4, 2, 6)).logs).toContain("skip r1 n2: cap 2 reached");
    });

    test("per-run -1 is unlimited for the run but still bounded by the global cap", async () => {
      expect((await capped(3, -1, 6)).started).toBe(3);
    });

    test("global -1 with per-run -1 starts every ready node", async () => {
      expect((await capped(-1, -1, 8)).started).toBe(8);
    });

    test("global -1 with a per-run number is bounded by the per-run number", async () => {
      expect((await capped(-1, 5, 8)).started).toBe(5);
    });

    test("the cap is re-read on each evaluate: raising the per-run cap starts more nodes", async () => {
      const home = homeWith(run({ nodes: ready(4), edges: [], max_parallel: 1 } as Partial<RunState>));
      home.write("profiles.json", JSON.stringify({ defaults: { max_parallel: 30 }, profiles: { p: { max_parallel: 30 } } }));
      const engine = new RunEngine(home.path, { log: () => {} });
      engine.evaluate("r1");
      await settle(engine);
      expect(calls(home).length).toBe(1);
      home.write("runs/r1/state.json", JSON.stringify(run({ nodes: ready(4), edges: [], max_parallel: 3 } as Partial<RunState>)));
      engine.evaluate("r1");
      await settle(engine);
      expect(calls(home).length).toBe(3);
      home.dispose();
    });
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

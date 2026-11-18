import { describe, expect, test } from "bun:test";
import { resolve } from "node:path";

import { TempHome } from "../test-support/temp-home.ts";

// The repo copy; install.ts links it into ~/.config/opencode/plugins.
const plugin = await import(resolve(import.meta.dir, "../../../mods/opencode/orch-nodes.js"));
const DISPATCH: string = resolve(import.meta.dir, "../../../skills/orch/scripts/dispatch.ts");

describe("orch-nodes opencode plugin", () => {
  test("mapEvent maps idle, error and busy; ignores the rest", () => {
    expect(plugin.mapEvent({ type: "session.idle", properties: { sessionID: "ses_a" } })).toEqual({ id: "ses_a", kind: "finished", note: "" });
    expect(plugin.mapEvent({ type: "session.error", properties: { sessionID: "ses_a", error: { data: { message: "boom" } } } })).toEqual({ id: "ses_a", kind: "failed", note: "boom" });
    expect(plugin.mapEvent({ type: "session.status", properties: { sessionID: "ses_a", status: { type: "busy" } } })?.kind).toBe("alive");
    expect(plugin.mapEvent({ type: "session.status", properties: { sessionID: "ses_a", status: { type: "idle" } } })).toBeNull();
    expect(plugin.mapEvent({ type: "tool.execute.before", properties: { sessionID: "ses_a" } })).toBeNull();
    expect(plugin.mapEvent({ type: "session.idle", properties: {} })).toBeNull();
  });

  test("note is clipped to 300 chars", () => {
    const m = plugin.mapEvent({ type: "session.idle", properties: { sessionID: "s", lastAssistantText: "x".repeat(900) } });
    expect(m.note.length).toBe(300);
  });

  test("no registry file: nothing is spawned", () => {
    const calls: string[][] = [];
    const h = plugin.createHandler({ exists: () => false, run: (c: string, a: string[]) => calls.push(a), env: { ORCH_DISPATCH: "/d.ts" } });
    expect(h({ type: "session.idle", properties: { sessionID: "ses_x" } })).toBe(false);
    expect(calls.length).toBe(0);
  });

  test("registered session: spawns owner event; alive throttled to 30 s", () => {
    const calls: string[][] = [];
    let t = 1_000_000;
    const h = plugin.createHandler({ exists: () => true, run: (c: string, a: string[]) => calls.push(a), now: () => t, env: { ORCH_DISPATCH: "/d.ts" } });
    h({ type: "session.idle", properties: { sessionID: "ses_x" } });
    expect(calls[0]).toEqual(["/d.ts", "owner", "event", "ses_x", "finished", "--harness", "opencode"]);
    const busy = { type: "session.status", properties: { sessionID: "ses_x", status: { type: "busy" } } };
    expect(h(busy)).toBe(true);
    t += 10_000;
    expect(h(busy)).toBe(false);
    t += 25_000;
    expect(h(busy)).toBe(true);
  });

  test("findDispatch prefers env, then .dispatch-path, else null", () => {
    expect(plugin.findDispatch({ ORCH_DISPATCH: "/a" }, "/h")).toBe("/a");
    expect(plugin.findDispatch({}, "/h", () => "/b\n")).toBe("/b");
    expect(plugin.findDispatch({}, "/h", () => { throw new Error("x"); })).toBeNull();
  });

  const created = (id: string, parent: string | undefined, title = "Fix tests") => ({
    type: "session.created",
    properties: { info: { id, parentID: parent, title, time: { created: 1_700_000_000_000 } } },
  });

  test("mapChild needs a parentID and reads info", () => {
    expect(plugin.mapChild(created("ses_c", "ses_p"))).toEqual({ child: "ses_c", parent: "ses_p", title: "Fix tests", created_ms: 1_700_000_000_000 });
    expect(plugin.mapChild(created("ses_c", undefined))).toBeNull();
    expect(plugin.mapChild({ type: "session.idle", properties: { sessionID: "x" } })).toBeNull();
  });

  test("createRunIndex keeps running runs with an opencode session and caches 5 s", () => {
    let reads = 0;
    let t = 0;
    const idx = plugin.createRunIndex({
      home: "/h",
      now: () => t,
      readdir: () => ["r1", "r2", "r3"],
      read: (p: string) => {
        reads += 1;
        if (p.includes("r1")) return JSON.stringify({ run_id: "r1", status: "running", harness_session: "ses_p" });
        if (p.includes("r2")) return JSON.stringify({ run_id: "r2", status: "done", harness_session: "ses_q" });
        return JSON.stringify({ run_id: "r3", status: "running", harness_session: "pid-9" });
      },
    });
    expect([...idx()]).toEqual([["ses_p", "r1"]]);
    idx();
    expect(reads).toBe(3);
    t = 6000;
    idx();
    expect(reads).toBe(6);
  });

  test("child of an active run: pending file written, bind-owners spawned once; unrelated child ignored", () => {
    const calls: string[][] = [];
    const files: Record<string, string> = {};
    const h = plugin.createHandler({
      exists: () => true,
      run: (_c: string, a: string[]) => calls.push(a),
      env: { ORCH_DISPATCH: "/d.ts", HARNESS_ORCH_HOME: "/h" },
      runIndex: () => new Map([["ses_p", "r1"]]),
      write: (path: string, text: string) => (files[path] = text),
    });
    expect(h(created("ses_other", "ses_zzz"))).toBe(false);
    expect(calls.length).toBe(0);
    expect(h(created("ses_c", "ses_p"))).toBe(true);
    const rec = JSON.parse(files["/h/owners/pending/ses_c.json"] ?? "{}");
    expect(rec).toMatchObject({ child: "ses_c", parent: "ses_p", title: "Fix tests", created_ms: 1_700_000_000_000 });
    expect(calls).toEqual([["/d.ts", "node", "bind-owners", "--run", "r1"]]);
    h({ type: "session.updated", properties: { info: { id: "ses_c", parentID: "ses_p", title: "Better title" } } });
    expect(calls.length).toBe(1);
    expect(JSON.parse(files["/h/owners/pending/ses_c.json"] ?? "{}").title).toBe("Better title");
    h({ type: "session.status", properties: { sessionID: "ses_c", status: { type: "busy" } } });
    expect(calls[1]).toEqual(["/d.ts", "owner", "event", "ses_c", "started", "--harness", "opencode"]);
    expect(calls[2]?.[4]).toBe("alive");
  });

  test("nodeOf reads the registry, else the dispatched node from the env", () => {
    const read = (p: string) => {
      if (p === "/h/owners/ses_r.json") return JSON.stringify({ run: "r1", node: "a", since: "x" });
      throw new Error("missing");
    };
    expect(plugin.nodeOf("/h", "ses_r", { env: {}, read })).toEqual({ run: "r1", node: "a" });
    expect(plugin.nodeOf("/h", "ses_x", { env: { ORCH_RUN_ID: "r2", ORCH_NODE_ID: "b" }, read })).toEqual({ run: "r2", node: "b" });
    expect(plugin.nodeOf("/h", "ses_x", { env: {}, read })).toBeNull();
  });

  test("formatMessages: one line per message, answers name the ask", () => {
    expect(plugin.formatMessages([
      { id: "m1", from: "orch", kind: "tell", text: "stop" },
      { id: "m2", from: "orch", kind: "answer", reply_to: "a1", text: "yes" },
    ])).toBe("[orch message m1 from orch] stop\n[orch answer a1 from orch] yes");
  });

  test("usageTerms: tool, plus skill or subagent names; bad names dropped", () => {
    expect(plugin.usageTerms("bash", {})).toEqual(["tool.bash"]);
    expect(plugin.usageTerms("skill", { name: "code-gen" })).toEqual(["tool.skill", "skill.code-gen"]);
    expect(plugin.usageTerms("task", { subagent_type: "explore" })).toEqual(["tool.task", "subagent.explore"]);
    expect(plugin.usageTerms("mcp server/tool", {})).toEqual(["tool.mcp_server_tool"]);
    expect(plugin.usageTerms("", {})).toEqual([]);
  });

  test("usage: counts batch into one node usage call, flushed after 30 s or on idle", () => {
    const calls: string[][] = [];
    let t = 0;
    const u = plugin.createUsage({ env: { ORCH_DISPATCH: "/d.ts", ORCH_RUN_ID: "r1", ORCH_NODE_ID: "a" }, now: () => t, run: (_c: string, a: string[]) => calls.push(a) });
    u.count("ses_a", "bash", {});
    u.count("ses_a", "bash", {});
    u.count("ses_a", "read", {});
    expect(calls.length).toBe(0);
    t = 31_000;
    u.count("ses_a", "bash", {});
    expect(calls).toEqual([["/d.ts", "node", "usage", "r1", "a", "--add", "tool.bash=3", "--add", "tool.read=1"]]);
    u.count("ses_a", "edit", {});
    expect(u.flush("ses_a")).toBe(true);
    expect(calls[1]).toEqual(["/d.ts", "node", "usage", "r1", "a", "--add", "tool.edit=1"]);
    expect(u.flush("ses_a")).toBe(false);
  });

  test("usage: a session that is no orch node counts nothing", () => {
    const calls: string[][] = [];
    const u = plugin.createUsage({ env: { ORCH_DISPATCH: "/d.ts", HARNESS_ORCH_HOME: "/nonexistent" }, run: (_c: string, a: string[]) => calls.push(a) });
    expect(u.count("ses_z", "bash", {})).toBe(false);
    expect(u.flush("ses_z")).toBe(false);
  });

  test("inbox: no pending file, no CLI call; throttled to one look per 5 s", () => {
    const calls: string[][] = [];
    let t = 0;
    let files: string[] = [];
    const inbox = plugin.createInbox({
      env: { ORCH_DISPATCH: "/d.ts", HARNESS_ORCH_HOME: "/h", ORCH_RUN_ID: "r1", ORCH_NODE_ID: "a" },
      now: () => t,
      readdir: () => files,
      read: (p: string) => {
        if (p.endsWith("1.json")) return JSON.stringify({ status: "pending" });
        throw new Error("missing");
      },
      runSync: (_c: string, a: string[]) => {
        calls.push(a);
        return JSON.stringify([{ id: "m1", from: "orch", kind: "tell", text: "hi" }]);
      },
    });
    expect(inbox("ses_a")).toBeNull();
    expect(calls.length).toBe(0);
    files = ["1.json"];
    t = 1_000;
    expect(inbox("ses_a")).toBeNull();
    t = 6_000;
    expect(inbox("ses_a")).toBe("[orch message m1 from orch] hi");
    expect(calls).toEqual([["/d.ts", "node", "inbox", "r1", "a", "--json", "--via", "plugin"]]);
  });

  test("inbox and usage against the real dispatch.ts", () => {
    const home = TempHome.create();
    try {
      const env = { ...process.env, HARNESS_ORCH_HOME: home.path, ORCH_NO_ANNOUNCE: "1", ORCH_HERDR: "0" };
      const sh = (...args: string[]) => Bun.spawnSync([process.execPath, DISPATCH, ...args], { env }).stdout.toString().trim();
      const run = sh("run", "start", "plugin inbox");
      sh("node", "add", run, "a", "Node a");
      sh("node", "tell", run, "a", "read the plan first");
      let t = 0;
      const penv = { HARNESS_ORCH_HOME: home.path, ORCH_DISPATCH: DISPATCH, ORCH_RUN_ID: run, ORCH_NODE_ID: "a" };
      const inbox = plugin.createInbox({ env: penv, now: () => t, runSync: (c: string, a: string[]) => {
        const r = Bun.spawnSync([c, ...a], { env: { ...env } });
        return r.exitCode === 0 ? r.stdout.toString() : null;
      } });
      expect(inbox("ses_a")).toMatch(/^\[orch message \S+ from orch\] read the plan first$/);
      t = 10_000;
      expect(inbox("ses_a")).toBeNull();
      const msgs = JSON.parse(sh("run", "messages", run, "--json"));
      expect(msgs[0]).toMatchObject({ status: "delivered", via: "plugin" });

      const usage = plugin.createUsage({ env: penv, run: (c: string, a: string[]) => Bun.spawnSync([c, ...a], { env }) });
      usage.count("ses_a", "bash", {});
      usage.count("ses_a", "skill", { name: "cr" });
      usage.flush("ses_a");
      const state = JSON.parse(home.read(`runs/${run}/state.json`));
      expect(state.nodes.find((n: { id: string }) => n.id !== "done-gate").usage).toMatchObject({ tool: { bash: 1, skill: 1 }, skill: { cr: 1 } });
    } finally {
      home.dispose();
    }
  }, 60_000);
});

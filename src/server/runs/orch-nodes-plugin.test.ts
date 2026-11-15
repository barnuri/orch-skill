import { describe, expect, test } from "bun:test";
import { homedir } from "node:os";
import { join } from "node:path";

const plugin = await import(join(homedir(), ".config/opencode/plugins/orch-nodes.js"));

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
    const h = plugin.createHandler({ exists: () => false, run: (c: string, a: string[]) => calls.push(a), env: { ORCH_DISPATCH: "/d.sh" } });
    expect(h({ type: "session.idle", properties: { sessionID: "ses_x" } })).toBe(false);
    expect(calls.length).toBe(0);
  });

  test("registered session: spawns owner event; alive throttled to 30 s", () => {
    const calls: string[][] = [];
    let t = 1_000_000;
    const h = plugin.createHandler({ exists: () => true, run: (c: string, a: string[]) => calls.push(a), now: () => t, env: { ORCH_DISPATCH: "/d.sh" } });
    h({ type: "session.idle", properties: { sessionID: "ses_x" } });
    expect(calls[0]).toEqual(["/d.sh", "owner", "event", "ses_x", "finished", "--harness", "opencode"]);
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
      env: { ORCH_DISPATCH: "/d.sh", HARNESS_ORCH_HOME: "/h" },
      runIndex: () => new Map([["ses_p", "r1"]]),
      write: (path: string, text: string) => (files[path] = text),
    });
    expect(h(created("ses_other", "ses_zzz"))).toBe(false);
    expect(calls.length).toBe(0);
    expect(h(created("ses_c", "ses_p"))).toBe(true);
    const rec = JSON.parse(files["/h/owners/pending/ses_c.json"] ?? "{}");
    expect(rec).toMatchObject({ child: "ses_c", parent: "ses_p", title: "Fix tests", created_ms: 1_700_000_000_000 });
    expect(calls).toEqual([["/d.sh", "node", "bind-owners", "--run", "r1"]]);
    h({ type: "session.updated", properties: { info: { id: "ses_c", parentID: "ses_p", title: "Better title" } } });
    expect(calls.length).toBe(1);
    expect(JSON.parse(files["/h/owners/pending/ses_c.json"] ?? "{}").title).toBe("Better title");
    h({ type: "session.status", properties: { sessionID: "ses_c", status: { type: "busy" } } });
    expect(calls[1]).toEqual(["/d.sh", "owner", "event", "ses_c", "started", "--harness", "opencode"]);
    expect(calls[2]?.[4]).toBe("alive");
  });
});

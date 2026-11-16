import { describe, expect, test } from "bun:test";

import type { SpawnResult } from "./health-watcher";
import { HerdrWatcher, herdrEverySec, parseHerdrHealth } from "./herdr-watcher";

const OK = JSON.stringify({ state: "ok", enabled: true, reason: "on", env_id: "orch-skill", pid: 7, pid_alive: true, socket_ok: true, registry: "ok", registry_path: "/r", web: "listed", web_url: "u", nudged: false, at: "t", problems: [] });

function spawner(results: SpawnResult[]): { calls: string[][]; spawn: (args: readonly string[]) => Promise<SpawnResult> } {
  const calls: string[][] = [];
  return {
    calls,
    spawn: async (args) => {
      calls.push([...args]);
      return results.shift() ?? { code: 2, stdout: "", stderr: "none" };
    },
  };
}

describe("herdr watcher", () => {
  test("parses the contract and rejects anything else", () => {
    expect(parseHerdrHealth(OK)?.state).toBe("ok");
    expect(parseHerdrHealth('{"state":"weird"}')).toBeNull();
    expect(parseHerdrHealth("nope")).toBeNull();
  });

  test("the loop nudges; a failed check keeps the last good one", async () => {
    const s = spawner([{ code: 0, stdout: OK, stderr: "" }, { code: 2, stdout: "", stderr: "boom" }]);
    const w = new HerdrWatcher(s.spawn, () => {});
    expect((await w.check(true))?.state).toBe("ok");
    expect(s.calls[0]).toEqual(["herdr", "health", "--json", "--nudge"]);
    expect((await w.check(true))?.state).toBe("ok");
    expect(w.latest()?.pid).toBe(7);
  });

  test("read runs one plain check, then answers from memory", async () => {
    const s = spawner([{ code: 3, stdout: OK.replace('"ok"', '"down"'), stderr: "" }]);
    const w = new HerdrWatcher(s.spawn, () => {});
    expect((await w.read())?.state).toBe("down");
    expect(s.calls[0]).toEqual(["herdr", "health", "--json"]);
    await w.read();
    expect(s.calls.length).toBe(1);
  });

  test("a failing first read is not retried by every poll", async () => {
    const s = spawner([]);
    const w = new HerdrWatcher(s.spawn, () => {});
    expect(await w.read()).toBeNull();
    expect(await w.read()).toBeNull();
    expect(s.calls.length).toBe(1);
  });

  test("interval: env override, floor, default", () => {
    expect(herdrEverySec({})).toBe(60);
    expect(herdrEverySec({ ORCH_HERDR_HEALTH_EVERY_SEC: "2" })).toBe(10);
    expect(herdrEverySec({ ORCH_HERDR_HEALTH_EVERY_SEC: "90" })).toBe(90);
  });
});

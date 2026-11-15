import { afterAll, afterEach, describe, expect, test } from "bun:test";
import { existsSync, mkdtempSync, readFileSync, readdirSync, utimesSync, mkdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";

import { sweepPromptDirs, TurnSession } from "./sessions/turn-session";

// A private TMPDIR: the prompt-folder assertions must not see orch-chat-* dirs other workers create.
const REAL_TMPDIR: string | undefined = process.env.TMPDIR;
const PRIVATE_TMP: string = mkdtempSync(join(tmpdir(), "turn-session-tmp-"));
process.env.TMPDIR = PRIVATE_TMP;
afterAll(() => {
  if (REAL_TMPDIR === undefined) {
    delete process.env.TMPDIR;
  } else {
    process.env.TMPDIR = REAL_TMPDIR;
  }
  Bun.spawnSync(["trash", PRIVATE_TMP], { stdout: "ignore", stderr: "ignore" });
});

const TREE = resolve(import.meta.dir, "testing/fake-dispatch-tree.sh");

afterEach(() => {
  delete process.env.FAKE_TREE_PIDS;
  delete process.env.FAKE_TREE_STUBBORN;
  delete process.env.FAKE_TREE_PROMPT;
});

const alive = (pid: number): boolean => {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
};
const pids = (file: string): number[] => (existsSync(file) ? readFileSync(file, "utf8").split("\n").filter(Boolean).map(Number) : []);
const promptDirs = (): string[] => readdirSync(tmpdir()).filter((n) => n.startsWith("orch-chat-"));

async function startTurn(stubborn: boolean): Promise<{ session: TurnSession; done: Promise<void>; child: number; before: Set<string> }> {
  const dir = mkdtempSync(join(tmpdir(), "tree-test-"));
  const file = join(dir, "pids");
  process.env.FAKE_TREE_PIDS = file;
  if (stubborn) {
    process.env.FAKE_TREE_STUBBORN = "1";
  }
  const before = new Set(promptDirs());
  const session = new TurnSession({ chatId: "c", home: dir, harness: "pi", profile: "p", modelId: null, cwd: dir, resumeSessionId: null }, TREE);
  const done = (async () => {
    for await (const ev of session.send("hello", [])) {
      void ev;
    }
  })();
  for (let i = 0; i < 100 && pids(file).length === 0; i++) {
    await Bun.sleep(50);
  }
  const child = pids(file)[0] as number;
  expect(child).toBeGreaterThan(0);
  expect(alive(child)).toBe(true);
  return { session, done, child, before };
}

describe("TurnSession.stop (F1)", () => {
  test("kills the agent the shell started and resolves promptly", async () => {
    const { session, done, child } = await startTurn(false);
    const t0 = Date.now();
    await session.stop();
    await done;
    expect(Date.now() - t0).toBeLessThan(3000);
    expect(alive(child)).toBe(false);
  }, 20000);

  test("a child that ignores SIGTERM is killed after the grace period", async () => {
    const { session, done, child } = await startTurn(true);
    const t0 = Date.now();
    await session.stop();
    await done;
    expect(Date.now() - t0).toBeLessThan(6000);
    expect(alive(child)).toBe(false);
  }, 20000);

  test("dispose (server shutdown) ends the tailer but leaves the agent running", async () => {
    const { session, done, child } = await startTurn(false);
    await session.dispose();
    await done;
    expect(alive(child)).toBe(true);
    process.kill(-child, "SIGKILL");
    try {
      process.kill(child, "SIGKILL");
    } catch {
      // already gone
    }
  }, 20000);
});

describe("prompt folders (F5)", () => {
  test("the prompt now lives in the turn folder of the home, so no orch-chat temp folder is made", async () => {
    const { session, done, before } = await startTurn(false);
    expect(promptDirs().filter((n) => !before.has(n))).toEqual([]);
    await session.stop();
    await done;
  }, 20000);

  test("sweepPromptDirs removes only old orch-chat-* folders", () => {
    const root = mkdtempSync(join(tmpdir(), "sweep-root-"));
    const old = join(root, "orch-chat-old");
    const fresh = join(root, "orch-chat-fresh");
    const other = join(root, "keep-me");
    for (const d of [old, fresh, other]) {
      mkdirSync(d);
    }
    const past = new Date(Date.now() - 2 * 60 * 60 * 1000);
    utimesSync(old, past, past);
    utimesSync(other, past, past);
    expect(sweepPromptDirs(60 * 60 * 1000, root)).toBe(1);
    expect([existsSync(old), existsSync(fresh), existsSync(other)]).toEqual([false, true, true]);
  });
});

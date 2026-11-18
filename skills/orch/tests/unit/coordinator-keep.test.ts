import { test, expect, setDefaultTimeout } from "bun:test";
setDefaultTimeout(120000);
import { join } from "node:path";
import { mkdirSync, writeFileSync, utimesSync } from "node:fs";
import { tempDir, autoCleanup } from "../helpers";
import { coordSessionAlive } from "../../core/commands/inbox.ts";
autoCleanup();

// A recorded coordinator session stays unless it is dead: its activity file is stale and no pane on the socket hosts it.
const setup = () => {
  const home = tempDir("orch-keep-");
  mkdirSync(join(home, "activity"), { recursive: true });
  const sock = join(home, "missing.sock");
  return { home, sock, activity: (sid: string, ageSecs: number) => {
    const f = join(home, "activity", `${sid}.json`);
    writeFileSync(f, "{}");
    const t = (Date.now() - ageSecs * 1000) / 1000;
    utimesSync(f, t, t);
  } };
};

test("a session with a fresh activity file is alive", async () => {
  const t = setup();
  t.activity("ses_A", 5);
  expect(await coordSessionAlive(t.home, "ses_A", t.sock)).toBe(true);
});

test("a session with a stale activity file and no pane is dead", async () => {
  const t = setup();
  t.activity("ses_B", 600);
  expect(await coordSessionAlive(t.home, "ses_B", t.sock)).toBe(false);
  expect(await coordSessionAlive(t.home, "", t.sock)).toBe(false);
});

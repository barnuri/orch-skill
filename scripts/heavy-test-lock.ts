#!/usr/bin/env bun
// Machine-wide limit on heavy test runs (the full bash suite, the full bun suite, test-all.ts).
//
//   bun scripts/heavy-test-lock.ts run -- <command...>   take a slot, run the command, free the slot
//   import { heavyLockAcquire } from "./heavy-test-lock"  take a slot until release()
//
// Slots are lock directories ${TMPDIR}/orch-test-heavy.<N>.d (N = 1..ORCH_TEST_SLOTS, default 2),
// created atomically with mkdir; the holder writes "<pid> <command>" inside. A slot whose holder pid is
// dead is taken over, so a crashed holder never keeps a slot. ORCH_TEST_LOCK=0 skips the lock; nested
// calls see ORCH_TEST_LOCK_HELD and do not ask again.
import { mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { runInherit, sleep, tmpDir } from "./lib/util.ts";

function alive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (e) {
    return (e as NodeJS.ErrnoException).code === "EPERM";
  }
}

function holder(dir: string): { pid: number; cmd: string } {
  try {
    const [pid, ...rest] = readFileSync(join(dir, "holder"), "utf8").trim().split(" ");
    return { pid: Number(pid), cmd: rest.join(" ") };
  } catch {
    return { pid: 0, cmd: "" };
  }
}

export async function heavyLockAcquire(cmdLabel: string): Promise<() => void> {
  if (process.env["ORCH_TEST_LOCK"] === "0" || process.env["ORCH_TEST_LOCK_HELD"]) return () => {};
  const slots = Number(process.env["ORCH_TEST_SLOTS"] ?? 2) || 2;
  const base = tmpDir();
  let said = false;
  for (;;) {
    for (let n = 1; n <= slots; n++) {
      const dir = join(base, `orch-test-heavy.${n}.d`);
      try {
        mkdirSync(dir);
      } catch {
        const h = holder(dir);
        if (h.pid && alive(h.pid)) continue;
        // Dead or half-written holder: take the slot over. mkdir below is atomic, so one taker wins.
        try {
          rmSync(dir, { recursive: true, force: true }); // lock artifact, not user data
          mkdirSync(dir);
        } catch {
          continue;
        }
      }
      writeFileSync(join(dir, "holder"), `${process.pid} ${cmdLabel}\n`);
      process.env["ORCH_TEST_LOCK_HELD"] = dir;
      const release = (): void => {
        try {
          rmSync(dir, { recursive: true, force: true });
        } catch {}
      };
      process.on("exit", release);
      return release;
    }
    if (!said) {
      const who = Array.from({ length: slots }, (_, i) => {
        const h = holder(join(base, `orch-test-heavy.${i + 1}.d`));
        return `; held by pid ${h.pid}: ${h.cmd}`;
      }).join("");
      process.stderr.write(`waiting for a heavy-test slot (${slots} busy${who})\n`);
      said = true;
    }
    await sleep(2000);
  }
}

if (import.meta.main) {
  const args = process.argv.slice(2);
  if (args[0] === "run") args.shift();
  if (args[0] === "--") args.shift();
  if (args.length === 0) {
    process.stderr.write("usage: heavy-test-lock.ts run -- <command...>\n");
    process.exit(2);
  }
  const release = await heavyLockAcquire(args.join(" "));
  const code = await runInherit(args);
  release();
  process.exit(code);
}

import { test, expect } from "bun:test";
import { join } from "node:path";
import { mkdirSync, writeFileSync, readFileSync, existsSync } from "node:fs";
import { tempHome, autoCleanup } from "../helpers";
import { OrchLock, lockFile } from "../../core/state/lock.ts";
autoCleanup();

test("single-flight locks", async () => {
  const H = tempHome();
  mkdirSync(join(H, "locks"), { recursive: true });
  const demo = new OrchLock(H, "demo");
  expect(await demo.acquire()).toBe(true);
  expect(readFileSync(lockFile(H, "demo"), "utf8").trim()).toBe(String(process.pid));
  expect(await demo.acquire()).toBe(true);

  const holder = Bun.spawn(["sleep", "30"]);
  writeFileSync(lockFile(H, "busy"), `${holder.pid}\n`);
  const busy = new OrchLock(H, "busy");
  expect(await busy.acquire()).toBe(false);
  holder.kill(); await holder.exited;
  expect(await busy.acquire()).toBe(true);

  await demo.release();
  expect(existsSync(lockFile(H, "demo"))).toBe(true);
  expect(readFileSync(lockFile(H, "demo"), "utf8")).toBe("");
  expect(await demo.acquire()).toBe(true);

  expect(await new OrchLock(H, "a/b c").acquire()).toBe(true);
  expect(existsSync(join(H, "locks", "a_b_c.pid"))).toBe(true);
});

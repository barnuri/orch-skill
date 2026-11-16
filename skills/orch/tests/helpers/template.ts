// One initialised orch home per checkout state, built once and shared by every test file and every runner.
// No bun:test import, so the runner can use it too.
import { existsSync, mkdtempSync, readdirSync, renameSync } from "node:fs";
import { join, resolve } from "node:path";
import { tmpdir } from "node:os";

const ORCH_DIR = resolve(import.meta.dir, "../..");

// Changes whenever a source or template file changes, so a stale template is never reused.
function templateKey(): string {
  let newest = 0;
  const walk = (d: string) => {
    for (const e of readdirSync(d, { withFileTypes: true })) {
      const f = join(d, e.name);
      if (e.isDirectory()) walk(f);
      else if (/\.(ts|json)$/.test(e.name)) newest = Math.max(newest, Bun.file(f).lastModified);
    }
  };
  walk(join(ORCH_DIR, "core"));
  walk(join(ORCH_DIR, "templates"));
  return String(Math.floor(newest));
}

let cached: string | undefined;
export function templateHome(): string {
  const given = process.env.ORCH_TEST_HOME_TEMPLATE;
  if (given && existsSync(join(given, "profiles.json"))) return given;
  if (cached) return cached;
  const root = join((process.env.TMPDIR || tmpdir()).replace(/\/+$/, ""), `orch-ts-test-home.${templateKey()}`);
  const ready = join(root, "home");
  if (!existsSync(join(ready, "profiles.json"))) {
    const stage = mkdtempSync(`${root}.stage-`);
    const env: Record<string, string> = { ...(process.env as Record<string, string>), HARNESS_ORCH_HOME: join(stage, "home"), ORCH_NO_ANNOUNCE: "1", ORCH_HERDR: "0" };
    delete env.ORCH_DISPATCH;
    Bun.spawnSync([process.execPath, join(ORCH_DIR, "scripts/dispatch.ts"), "init"], { env });
    try { renameSync(stage, root); } catch { Bun.spawnSync(["trash", stage]); }
  }
  return (cached = ready);
}

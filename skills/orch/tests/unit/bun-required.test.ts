import { test, expect } from "bun:test";
import { join } from "node:path";
import { DISPATCH, runCmd, tempDir, autoCleanup } from "../helpers";
autoCleanup();

test("dispatch.sh exits 127 without bun and prints the install hint", () => {
  const scratch = tempDir();
  const bin = join(scratch, "bin");
  Bun.spawnSync(["mkdir", "-p", bin]);
  for (const t of ["dirname", "readlink", "cat", "env"]) { const p = Bun.which(t); if (p) Bun.spawnSync(["ln", "-s", p, join(bin, t)]); }
  const r = runCmd(["/bin/bash", DISPATCH, "--version"], { home: join(scratch, "orch"), env: { PATH: bin, HOME: join(scratch, "home") } });
  expect(r.rc).toBe(127);
  expect(r.all).toMatch(/orch needs bun: install it from https:\/\/bun\.sh/);
});

test("doctor runs the Bun CLI", () => {
  const home = join(tempDir(), "orch");
  const r = runCmd(["bash", DISPATCH, "doctor"], { home });
  expect(r.rc).toBe(0);
  expect(r.out).toMatch(/^bun: \d/m);
  expect(r.out).toContain(`home: ${home}`);
  expect(r.out).toMatch(/^herdr: /m);
});

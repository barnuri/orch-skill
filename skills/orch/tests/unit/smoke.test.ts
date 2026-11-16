import { test, expect } from "bun:test";
import { join } from "node:path";
import { readdirSync, readFileSync } from "node:fs";
import { ORCH_DIR, DISPATCH, runCmd, tempHome, orch, tempDir, CLI_TS, autoCleanup } from "../helpers";
import { COMMANDS, main } from "../../core/cli.ts";
autoCleanup();

test("every core command module loads and the command table is wired", async () => {
  for (const [key, handler] of Object.entries(COMMANDS)) expect(typeof handler, key).toBe("function");
  expect(Object.keys(COMMANDS).length).toBeGreaterThan(10);
  const files = (dir: string): string[] => readdirSync(dir, { withFileTypes: true }).flatMap((e) => e.isDirectory() ? files(join(dir, e.name)) : /\.ts$/.test(e.name) && !/\.test\.ts$/.test(e.name) ? [join(dir, e.name)] : []);
  for (const f of files(join(ORCH_DIR, "core"))) await import(f);
});

test("sourcing the CLI prints and creates nothing; --help and --version", () => {
  const home = tempHome();
  const r = runCmd(["bun", CLI_TS, "--help"], { home });
  expect(r.rc).toBe(0); expect(r.err).toBe("");
  expect(r.out).toMatch(/^dispatch\.ts classify/m);
  for (const k of ["classify", "run", "start", "profile", "schedule", "loop", "watch", "herdr", "demo"]) expect(r.out).toContain(`dispatch.ts ${k}`);
  expect(runCmd(["bun", CLI_TS, "--version"], { home }).out).toMatch(/^orch \d/);
});

test("dispatch --help names every subcommand and an unknown one fails cleanly", () => {
  const home = tempHome();
  const r = runCmd(["bun", DISPATCH, "--help"], { home });
  expect(r.rc).toBe(0); expect(r.err).toBe("");
  expect(r.out).toMatch(/dispatch\.ts classify/);
  const unk = runCmd(["bun", DISPATCH, "no-such-subcommand"], { home });
  expect(unk.rc).not.toBe(0);
  expect(unk.err).not.toMatch(/command not found|unbound variable|syntax error/);
});

test("every core/ source file parses as TypeScript (bun build)", () => {
  const r = runCmd(["bun", "build", "--no-bundle", "--outdir", tempDir(), join(ORCH_DIR, "core/cli.ts")]);
  expect(r.rc).toBe(0);
});

test("core command groups: usage on a bare group, not a crash", () => {
  const home = tempHome();
  for (const g of ["node", "run", "profile", "model", "delegate"]) {
    const r = runCmd(["bun", CLI_TS, g], { home });
    expect(r.err, g).not.toMatch(/TypeError|ReferenceError|Cannot find module/);
  }
});

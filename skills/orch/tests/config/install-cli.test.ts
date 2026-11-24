import { test, expect, setDefaultTimeout } from "bun:test";
import { join } from "node:path";
import { lstatSync, mkdirSync, readFileSync, readlinkSync, writeFileSync } from "node:fs";
import { DISPATCH, REPO_ROOT, runCmd, tempDir, autoCleanup } from "../helpers";
autoCleanup();
setDefaultTimeout(60000);

// The `orch` short name in README.md and SKILL.md is a real command: `install.ts` links
// <bin-dir>/orch to dispatch.ts. This installs into a temp HOME, bin dir, state dir and config link,
// then runs `orch` from PATH.
function install(extra: string[] = [], env: Record<string, string> = {}) {
  const root = tempDir("orch-install-");
  const home = join(root, "home"), bin = join(root, "bin"), state = join(root, "state");
  mkdirSync(home, { recursive: true });
  const base = {
    HOME: home, HARNESS_ORCH_HOME: state, ORCH_BIN_DIR: bin, ORCH_BIN_NAME: undefined,
    ORCH_CONFIG_LINK: join(root, "config"), XDG_CONFIG_HOME: join(home, ".config"),
    OPENCODE_PLUGIN_DIR: join(root, "opencode-plugins"), CLAUDE_CONFIG_DIR: join(home, ".claude"),
  };
  const r = runCmd(["bun", join(REPO_ROOT, "install.ts"), "--cli-only", "--no-restart", ...extra], { env: { ...base, ...env } });
  return { r, root, home, bin, state };
}

test("install --cli-only puts a working `orch` on PATH", () => {
  const { r, home, bin, state } = install();
  expect(r.rc).toBe(0);
  const cli = join(bin, "orch");
  expect(lstatSync(cli).isSymbolicLink()).toBe(true);
  expect(readlinkSync(cli)).toBe(DISPATCH);
  expect(JSON.parse(readFileSync(join(state, "cli.json"), "utf8"))).toEqual({ name: "orch", bin_dir: bin });
  expect(readFileSync(join(home, ".zshrc"), "utf8")).toContain(`export PATH="${bin}:$PATH"`);
  const run = Bun.spawnSync(["orch", "profile", "list"], {
    env: { PATH: `${bin}:${process.execPath.replace(/\/bun$/, "")}:/usr/bin:/bin`, HOME: home, HARNESS_ORCH_HOME: state, ORCH_HERDR: "0", ORCH_NO_ANNOUNCE: "1" },
  });
  expect(run.exitCode).toBe(0);
  expect(run.stdout.toString()).toMatch(/default/);
});

test("install --bin-name renames the command and a second run is idempotent", () => {
  const first = install(["--bin-name", "orx"]);
  expect(first.r.rc).toBe(0);
  expect(readlinkSync(join(first.bin, "orx"))).toBe(DISPATCH);
  const again = runCmd(["bun", join(REPO_ROOT, "install.ts"), "--cli-only", "--no-restart"], {
    env: {
      HOME: first.home, HARNESS_ORCH_HOME: first.state, ORCH_BIN_DIR: first.bin, ORCH_CONFIG_LINK: join(first.root, "config"),
      XDG_CONFIG_HOME: join(first.home, ".config"), OPENCODE_PLUGIN_DIR: join(first.root, "opencode-plugins"),
    },
  });
  expect(again.rc).toBe(0);
  expect(again.out).toMatch(/already points at this checkout/);
});

test("install refuses to replace a real file at the command path", () => {
  const root = tempDir("orch-install-"), bin = join(root, "bin");
  mkdirSync(bin, { recursive: true });
  writeFileSync(join(bin, "orch"), "#!/bin/sh\n");
  const { r } = install([], { ORCH_BIN_DIR: bin });
  expect(r.rc).toBe(1);
  expect(r.err).toMatch(/exists and is not a symlink/);
});

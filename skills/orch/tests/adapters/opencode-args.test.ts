import { test, expect } from "bun:test";
import { opencodeArgs, OPENCODE_ORCH_VALUE_FLAGS, OPENCODE_ORCH_BOOL_FLAGS } from "../../core/adapters/spawn";
import { orch, seedHome, fakeBin, autoCleanup } from "../helpers";
autoCleanup();

test("orchestration-only flags never reach opencode, in space and = form", () => {
  const args = [
    "--prompt", "ignored", "--role=validation", "--tier", "efficiency", "--acceptance=tests pass",
    "--plan-backed", "--after", "a,b", "--origin=loop", "--plan", "p.md", "--task", "t1",
    "--pure", "--standalone", "-m", "llama/x", "--variant", "high",
  ];
  const r = opencodeArgs(args);
  expect(r.rest).toEqual(["-m", "llama/x", "--variant", "high"]);
  expect(r.server).toBe("--standalone");
});

test("every declared orchestration flag is filtered", () => {
  for (const f of OPENCODE_ORCH_VALUE_FLAGS) {
    expect(opencodeArgs([f, "v", "keep"]).rest).toEqual(["keep"]);
    expect(opencodeArgs([`${f}=v`, "keep"]).rest).toEqual(["keep"]);
  }
  for (const f of OPENCODE_ORCH_BOOL_FLAGS) expect(opencodeArgs([f, "keep"]).rest).toEqual(["keep"]);
});

test("a value flag at the end of args drops nothing else", () => {
  expect(opencodeArgs(["keep", "--prompt"]).rest).toEqual(["keep"]);
});

test("--server disables --standalone and passes through", () => {
  const r = opencodeArgs(["--server", "http://127.0.0.1:4096", "--pure"]);
  expect(r).toEqual({ server: "", rest: ["--server", "http://127.0.0.1:4096"] });
  expect(opencodeArgs(["--server=http://x"]).server).toBe("");
});

test("argv reaching the opencode binary carries no orchestration flag", () => {
  const home = seedHome();
  const sh = fakeBin({ opencode: `printf "%s\\n" "$@"` });
  const o = orch(home, { PATH: `${sh}:${process.env.PATH}` });
  const out = o("run", "opencode", "x", "--role=validation", "--prompt", "ignored", "--tier=efficiency", "--plan-backed", "--acceptance", "green", "--model", "m1").out;
  const argv = out.split("\n").filter(Boolean);
  expect(argv.join(" ")).not.toMatch(/--role|--prompt|--tier|--plan-backed|--acceptance|ignored|validation|efficiency|green/);
  expect(argv).toContain("--auto");
}, 60000);

test("opencode dispatch never receives prompt or role flags", () => {
  const home = seedHome();
  const sh = fakeBin({ opencode: `printf "%s\\n" "$@"` });
  const o = orch(home, { PATH: `${sh}:${process.env.PATH}` });
  o("run", "r1", "n1", "opencode", "implementation task", "--role", "implementation", "--prompt", "dispatch prompt");
  const out = o("run", "opencode", "implementation task", "--role", "implementation", "--prompt", "dispatch prompt").out;
  const argv = out.split("\n").filter(Boolean);
  expect(argv).not.toContain("--role");
  expect(argv).not.toContain("--prompt");
  expect(argv).not.toContain("implementation");
  expect(argv).not.toContain("dispatch prompt");
});

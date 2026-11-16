// `opencode run` rejects --dir ("Unrecognized flag"): the chat folder must reach opencode as the process cwd only.
import { expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";

test("the opencode chat session never passes --dir and spawns in the chat folder", () => {
  const src = readFileSync(join(import.meta.dir, "sessions/opencode-session.ts"), "utf8");
  expect(src).not.toMatch(/args\.push\(\s*"--dir"/);
  expect(src).toContain("cwd: this.params.cwd");
});

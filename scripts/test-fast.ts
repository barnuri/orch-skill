#!/usr/bin/env bun
// Run the fast tier of the bun suite: every src test file except the slow ones.
// A file is slow when its first line is `// test-tier: slow (...)`: it spawns the real
// dispatch, a real server process or a real harness CLI. `bun run test` still runs all of them.
// Extra arguments go to `bun test` (for example --watch or a name filter).
import { Glob } from "bun";
import { readFileSync } from "node:fs";
import { REPO_DIR, runInherit } from "./lib/util.ts";

// Slow files that cannot carry the marker yet because another session has uncommitted edits in them.
const SLOW_UNMARKED = new Set(["src/server/routes/runs-routes.test.ts", "src/server/chats/model-offer.test.ts"]);

const files: string[] = [];
for (const f of new Glob("src/**/*.test.{ts,tsx}").scanSync({ cwd: REPO_DIR })) {
  if (f.includes("node_modules/") || SLOW_UNMARKED.has(f)) continue;
  const first = readFileSync(`${REPO_DIR}/${f}`, "utf8").split("\n", 1)[0] ?? "";
  if (first.startsWith("// test-tier: slow")) continue;
  files.push(`./${f}`);
}
files.sort();
if (files.length === 0) {
  console.error("test-fast: no fast test files found");
  process.exit(1);
}
console.error(`test-fast: ${files.length} files`);
process.exit(
  await runInherit([process.execPath, "test", "--timeout", "30000", "--parallel=6", ...process.argv.slice(2), ...files], {
    cwd: REPO_DIR,
    env: { ORCH_HERDR: "0" },
  }),
);

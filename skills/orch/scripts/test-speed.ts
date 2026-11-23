// Validates test speed: the whole suite under TOTAL_MAX_S seconds, and every test under TEST_MAX_MS.
// usage: bun scripts/test-speed.ts [paths...]   (default: tests/runs tests/announce)
// Exits 1 and lists each violation when a limit is broken.
const TOTAL_MAX_S = Number(process.env.TEST_TOTAL_MAX_S ?? 30);
const TEST_MAX_MS = Number(process.env.TEST_MAX_MS ?? 1000);
const paths = process.argv.slice(2).length ? process.argv.slice(2) : ["tests/runs", "tests/announce"];

const proc = Bun.spawn(["bun", "test", ...paths], { stdout: "pipe", stderr: "pipe" });
const out = (await new Response(proc.stdout).text()) + (await new Response(proc.stderr).text());
await proc.exited;

const tests: { name: string; ms: number }[] = [];
for (const m of out.matchAll(/^\((pass|fail)\) (.+?) \[([0-9.]+)(ms|s)\]/gm)) {
  tests.push({ name: m[2]!, ms: Number(m[3]) * (m[4] === "s" ? 1000 : 1) });
}
const wall = /Ran \d+ tests across \d+ files\. \[([0-9.]+)(ms|s)\]/.exec(out);
const totalS = wall ? Number(wall[1]) * (wall[2] === "s" ? 1 : 0.001) : NaN;

const slow = tests.filter((t) => t.ms >= TEST_MAX_MS).sort((a, b) => b.ms - a.ms);
console.log(`tests: ${tests.length}  total: ${totalS.toFixed(1)} s (limit ${TOTAL_MAX_S} s)  slowest test: ${Math.max(0, ...tests.map((t) => t.ms)).toFixed(0)} ms (limit ${TEST_MAX_MS} ms)`);
for (const t of slow) console.log(`  SLOW ${t.ms.toFixed(0)} ms  ${t.name}`);
const fails = [...(Number.isNaN(totalS) || totalS > TOTAL_MAX_S ? ["total over limit or not measured"] : []), ...slow.map((t) => `per-test ${t.ms.toFixed(0)} ms: ${t.name}`)];
if (fails.length) {
  console.log(`FAIL: ${fails.length} violation(s)`);
  process.exit(1);
}
console.log("PASS");

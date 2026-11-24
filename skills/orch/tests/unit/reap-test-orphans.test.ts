import { expect, test } from "bun:test";
import { join } from "node:path";
import { isTestHerdrServer, matchTestHerdrServers, matchOrphans, parseEtime, parsePs } from "../../../../scripts/reap-test-orphans.ts";

const ps = `
  101     1 30:00:10 /Users/x/llm-hub/target/debug/llm-hub serve
  102     1    20:00 /Users/x/llm-hub/llvm-cov-target/debug/llm-hub serve
  103     1    20:00 bun -e const s = Bun.serve({ port: 0 })
  104     1    20:00 /Users/x/llm-hub/target/release/llm-hub serve
  105     1     1:00 /Users/x/llm-hub/target/debug/llm-hub serve
  106  5000    20:00 /Users/x/llm-hub/target/debug/llm-hub serve
  107     1  2-01:00:00 opencode /tmp/x
  108     1    20:00 bun src/server/chats/testing/fake-claude-slow.ts
  109     1    20:00 /Applications/herdr /tmp/herdr
  110     1    20:00 bun /var/folders/21/abc/T/orch-x/fake.ts
  111     1    20:00 /Users/x/llm-hub/target/debug/llm-hub serve
`;

test("parseEtime", () => {
  expect([parseEtime("00:05"), parseEtime("1:02:03"), parseEtime("2-01:00:00")]).toEqual([5, 3723, 176400]);
});

test("matcher picks old orphans of test patterns only", () => {
  const hits = matchOrphans(parsePs(ps), new Set([111])).map((p) => p.pid);
  expect(hits).toEqual([101, 102, 103, 108, 110]);
});

test("a fake exits within 3 s when its parent is SIGKILLed", async () => {
  const helper = join(import.meta.dir, "../helpers/hub-proc.ts");
  const child = Bun.spawn(["bun", "-e", `import { spawnEchoHub } from ${JSON.stringify(helper)}; const h = await spawnEchoHub(); const pid = (globalThis as any).__pid; console.log("go"); await Bun.sleep(60000);`], { stdout: "pipe" });
  await child.stdout.getReader().read();
  const kids = Bun.spawnSync(["pgrep", "-P", String(child.pid)]).stdout.toString().trim().split("\n").filter(Boolean).map(Number);
  expect(kids.length).toBe(1);
  child.kill("SIGKILL");
  const alive = (p: number) => { try { process.kill(p, 0); return true; } catch { return false; } };
  const end = Date.now() + 3500;
  while (Date.now() < end && alive(kids[0]!)) await Bun.sleep(100);
  expect(alive(kids[0]!)).toBe(false);
}, 20000);

test("herdr server with a temp-home HOME is reaped, the live one is not", () => {
  const link = (p: string) => (p.endsWith("-aaa") ? "/var/folders/21/q6/T/orch-t-x/home/herdr/home" : p.endsWith("-bbb") ? "/Users/x/.harness-orch/herdr/home" : null);
  expect(isTestHerdrServer("herdr server", "/tmp/orch-herdr-501-aaa", link)).toBe(true);
  expect(isTestHerdrServer("herdr server", "/tmp/orch-herdr-501-bbb", link)).toBe(false);
  expect(isTestHerdrServer("herdr server", "/tmp/orch-herdr-501-ccc", link)).toBe(true);
  expect(isTestHerdrServer("herdr server", "/Users/x", link)).toBe(false);
  const procs = parsePs("  201     1  2-01:00:00 herdr server\n  202     1  2-01:00:00 herdr server\n  203  9    20:00 herdr server\n");
  const homes: Record<number, string> = { 201: "/tmp/orch-herdr-501-aaa", 202: "/tmp/orch-herdr-501-bbb", 203: "/tmp/orch-herdr-501-aaa" };
  expect(matchTestHerdrServers(procs, 600, (pid) => homes[pid] ?? null, link).map((p) => p.pid)).toEqual([201]);
});

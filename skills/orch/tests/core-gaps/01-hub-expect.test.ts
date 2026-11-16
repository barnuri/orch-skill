import { test, expect, setDefaultTimeout } from "bun:test";
import { join } from "node:path";
import { writeFileSync } from "node:fs";
import { orch, seedHome, runState, fakeBin, readText, tempDir, autoCleanup } from "../helpers";
setDefaultTimeout(120000);
autoCleanup();

test("node dispatch records the hub expectation (model, tier, role) for the worker run/node/attempt", async () => {
  const posts = join(tempDir(), "posts");
  writeFileSync(posts, "");
  const hub = Bun.spawn(["bun", join(import.meta.dir, "../helpers/smart-auto-hub.ts")], { env: { ...process.env, HUB_POSTS: posts }, stdout: "pipe", stderr: "ignore" });
  try {
    const port = Number((await hub.stdout.getReader().read().then((r) => new TextDecoder().decode(r.value))).trim());
    const home = seedHome();
    const shims = fakeBin({ opencode: `printf "%s\\n" "$@"`, copilot: `printf "%s\\n" "$@"` });
    writeFileSync(join(home, "env"), `LLM_HUB_URL=http://127.0.0.1:${port}\nLLM_HUB_KEY=k\n`);
    const o = orch(home, { PATH: `${shims}:${process.env.PATH}` });
    o("profile", "list");
    expect(o("hub", "setup").rc).toBe(0);
    o("run", "start", "Hub", "--id", "hub-1");
    o("node", "add", "hub-1", "plan", "Plan", "--role", "planning");
    const job = o("node", "dispatch", "hub-1", "plan", "do it").out.trim();
    o("wait", job, "--timeout", "60", "--interval", "1");
    const n = runState(home, "hub-1").nodes[0];
    expect(n.hub.expected.model).toBe("expected/intelligence");
    expect(n.hub.expected.tier).toBe("intelligence");
    expect(n.hub.expected.role).toBe("planning");
    expect(readText(posts)).toMatch(/\/api\/smart-auto\/resolve .*"worker":"hub-1\/plan\/1"/);
  } finally {
    hub.kill();
  }
});

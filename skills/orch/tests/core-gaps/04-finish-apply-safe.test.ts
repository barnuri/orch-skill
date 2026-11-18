import { test, expect, setDefaultTimeout } from "bun:test";
import { join } from "node:path";
import { writeFileSync } from "node:fs";
import { seedHome, orch, readJson, autoCleanup } from "../helpers";
setDefaultTimeout(120000);
autoCleanup();

test("run finish applies pending safe suggestions after the scan", () => {
  const home = seedHome();
  const o = orch(home);
  writeFileSync(join(home, "suggestions.json"), JSON.stringify({
    generated_at: "2026-01-01T00:00:00Z",
    suggestions: [{ id: "s-mem", kind: "memory_record", status: "pending", action: { type: "memory_record", memory: { profile: "claude-default", outcome: "success", task_kind: "gap", note: "from-finish" } } }],
  }));
  o("run", "start", "Fin", "--id", "r1");
  o("node", "add", "r1", "a", "A", "--profile", "claude-default");
  o("node", "update", "r1", "a", "running");
  o("node", "update", "r1", "a", "done");
  expect(o("run", "finish", "r1", "--force", "--reason", "test node has no handoff").out.trim()).toBe("done");
  const sug = readJson(join(home, "suggestions.json")).suggestions.find((s: any) => s.id === "s-mem");
  expect(sug?.status).toBe("applied");
  expect(readJson(join(home, "memory.json")).some((m: any) => m.note === "from-finish")).toBe(true);
});

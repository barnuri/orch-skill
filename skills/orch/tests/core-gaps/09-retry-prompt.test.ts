import { test, expect, setDefaultTimeout } from "bun:test";
import { join } from "node:path";
import { readFileSync } from "node:fs";
import { runHome, setNode } from "./common";
import { fakeBin, autoCleanup } from "../helpers";
setDefaultTimeout(120000);
autoCleanup();

test("node retry without a prompt reuses the stored prompt and prepends unread answers", () => {
  const bin = fakeBin({ claude: `printf "%s\\n" "$@"` });
  const t = runHome({ PATH: `${bin}:${process.env.PATH}` });
  t.o("node", "update", "r1", "a", "running");
  setNode(t.home, "a", { prompt: "ORIGINAL TASK TEXT" });
  expect(t.o("node", "ask", "r1", "a", "which db?").rc).toBe(0);
  expect(t.o("node", "answer", "r1", "a", "use postgres").rc).toBe(0);
  t.o("node", "update", "r1", "a", "error", "--error", "boom");
  const r = t.o("node", "retry", "r1", "a");
  expect(r.rc).toBe(0);
  const job = r.out.trim().split("\n").pop()!;
  t.o("wait", job, "--timeout", "30", "--interval", "0.1");
  const log = readFileSync(join(t.home, "jobs", job, "log"), "utf8");
  expect(log).toMatch(/Unread answers from the coordinator:\n- .*use postgres/);
  expect(log).toMatch(/ORIGINAL TASK TEXT/);
  expect(t.node("a").prompt).toBe("ORIGINAL TASK TEXT");
});

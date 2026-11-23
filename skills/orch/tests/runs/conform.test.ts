import { test, expect } from "bun:test";
import { planTasks } from "../../core/commands/conform.ts";

test("plan table: task id and its files_touched", () => {
  const plan = [
    "| Task | Files |",
    "|---|---|",
    "| T9 | src/services/local_serving/watchdog.rs, src/routes/proxy.rs |",
    "| T10 | tests/local_serving_watchdog.rs |",
    "| note | not a task |",
  ].join("\n");
  const tasks = planTasks(plan);
  expect(tasks.map((t) => t.id)).toEqual(["T9", "T10"]);
  expect(tasks[0]!.files).toEqual(["src/services/local_serving/watchdog.rs", "src/routes/proxy.rs"]);
});

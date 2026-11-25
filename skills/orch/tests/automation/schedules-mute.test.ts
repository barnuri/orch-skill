import { test, expect } from "bun:test";
import { join } from "node:path";
import { orch, orchSpawn, seedHome, fakeBin, readJson, readText, runState, autoCleanup } from "../helpers";
autoCleanup();

test("schedule mute and unmute set the flag, list shows it", () => {
  const home = seedHome();
  const o = orch(home);
  const id = o("schedule", "add", "--name", "quiet", "--cron", "0 9 * * *", "--command", "echo x").out.trim();
  const file = join(home, "schedules", id, "schedule.json");
  expect(readJson(file).muted).toBe(false);
  expect(o("schedule", "mute", id).out).toContain(`${id}: muted`);
  expect(readJson(file).muted).toBe(true);
  expect(o("schedule", "list").out).toContain("muted");
  expect(JSON.parse(o("schedule", "list", "--json").out)[0].muted).toBe(true);
  expect(o("schedule", "unmute", id).out).toContain(`${id}: unmuted`);
  expect(readJson(file).muted).toBe(false);
  expect(o("schedule", "mute", "sch-nope").rc).toBe(2);
});

test("a run and a job started under ORCH_MUTED carry the flag", () => {
  const home = seedHome();
  const o = orch(home);
  const plain = o("run", "start", "plain").out.trim();
  expect(runState(home, plain).muted).toBeUndefined();
  const muted = o.env({ ORCH_MUTED: "1" }, "run", "start", "quiet run").out.trim();
  expect(runState(home, muted).muted).toBe(true);
});

test("a muted prompt schedule starts its job with ORCH_MUTED and a muted marker", () => {
  const home = seedHome();
  const sh = fakeBin({ claude: 'printf "ran\\n"' });
  const o = orch(home, { PATH: `${sh}:${process.env.PATH}`, ORCH_HERDR: "0" });
  const id = o("schedule", "add", "--name", "q", "--cron", "0 9 * * *", "--prompt", "hi", "--profile", "claude-default").out.trim();
  o("schedule", "mute", id);
  expect(o("schedule", "run", id).rc).toBe(0);
  const job = readJson(join(home, "schedules", id, "schedule.json")).runs[0].ref as string;
  expect(readText(join(home, "jobs", job, "muted")).trim()).toBe("1");
  o("schedule", "unmute", id);
  o("schedule", "run", id);
  const jobs = readJson(join(home, "schedules", id, "schedule.json")).runs.map((r: any) => r.ref);
  expect(readText(join(home, "jobs", jobs[0], "muted"))).toBe("");
});

test("msg send skips the Herdr notification for a muted run", async () => {
  const home = seedHome();
  const log = join(home, "herdr.log");
  const bin = fakeBin({ herdr: `echo "$@" >> "${log}"` });
  const o = orchSpawn(home, { PATH: `${bin}:${process.env.PATH}`, HERDR_ENV: "1" });
  const plain = (await o("run", "start", "plain")).out.trim();
  const muted = (await o.env({ ORCH_MUTED: "1" }, "run", "start", "quiet")).out.trim();
  expect((await o("msg", "send", plain, "--to", "orch", "hello")).rc).toBe(0);
  expect(readText(log)).toContain("notification show");
  const before = readText(log);
  expect((await o("msg", "send", muted, "--to", "orch", "hello")).rc).toBe(0);
  expect(readText(log)).toBe(before);
}, 30000);

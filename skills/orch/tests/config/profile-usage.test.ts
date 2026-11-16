import { test, expect } from "bun:test";
import { join, dirname } from "node:path";
import { orch, seedHome, fakeBin, editJson, readJson, autoCleanup } from "../helpers";
autoCleanup();

function setup() {
  const home = seedHome();
  editJson(join(home, "profiles.json"), (p) => {
    p.settings.default_profile = "p-both";
    p.settings.planner_profile = "p-both";
    p.settings.disabled_harnesses = [];
    p.models = { "m-s": { slug: "sonnet", harnesses: ["claude", "opencode"] } };
    p.profiles = {
      "p-both": { harness: "claude", model: "m-s", priority: 5 },
      "p-chat": { harness: "claude", model: "m-s", priority: 9, usage: ["chat"] },
      "p-runs": { harness: "claude", model: "m-s", priority: 1, usage: ["runs"] },
      "p-oc": { harness: "opencode", model: "m-s" },
    };
  });
  const bin = fakeBin({ claude: `printf '{"result":"OK","is_error":false,"total_cost_usd":0}'`, opencode: "echo hi" });
  const o = orch(home, { ORCH_BIN_DIRS: bin, PATH: `${bin}:${dirname(process.execPath)}:/usr/bin:/bin`, CLAUDE_USAGE_SNAPSHOT: "/nonexistent/s.json" });
  return { home, o };
}

test("profile list --for and --json follow profile AND harness usage", () => {
  const { home, o } = setup();
  const names = (r: { out: string }) => r.out.split("\n").filter(Boolean).map((l) => l.replace(/^\*/, "").split("\t")[0]).sort();
  expect(names(o("profile", "list"))).toEqual(["p-both", "p-chat", "p-oc", "p-runs"]);
  expect(names(o("profile", "list", "--for", "chat"))).toEqual(["p-both", "p-chat", "p-oc"]);
  expect(names(o("profile", "list", "--for", "runs"))).toEqual(["p-both", "p-oc", "p-runs"]);
  expect(o("profile", "list", "--for", "x").rc).toBe(2);
  expect(o("harness", "set-usage", "opencode", "chat").rc).toBe(0);
  expect(names(o("profile", "list", "--for", "runs"))).toEqual(["p-both", "p-runs"]);
  const rows = JSON.parse(o("profile", "list", "--json").out);
  const oc = rows.find((r: any) => r.name === "p-oc");
  expect(oc.usage).toEqual(["chat", "runs"]);
  expect(oc.harness_usage).toEqual(["chat"]);
  expect(oc.available).toEqual({ chat: true, runs: false });
  expect(readJson(join(home, "profiles.json")).settings.harness_usage).toEqual({ opencode: ["chat"] });
});

test("set-usage commands write through the state writer and validate", () => {
  const { home, o } = setup();
  const file = join(home, "profiles.json");
  expect(o("profile", "set-usage", "p-both", "runs").out).toContain("usage = runs");
  expect(readJson(file).profiles["p-both"].usage).toEqual(["runs"]);
  expect(o("profile", "set-usage", "p-both", "both").rc).toBe(0);
  expect(readJson(file).profiles["p-both"].usage).toBeUndefined();
  expect(o("profile", "set-usage", "nope", "chat").rc).toBe(2);
  expect(o("profile", "set-usage", "p-both", "sometimes").rc).toBe(2);
  expect(o("harness", "set-usage", "nope", "chat").rc).toBe(2);
  expect(o("harness", "set-usage", "claude", "runs").rc).toBe(0);
  expect(o("harness", "set-usage", "claude", "both").rc).toBe(0);
  expect(readJson(file).settings.harness_usage).toBeUndefined();
});

test("defaults.usage is inherited, and both stays explicit when the default narrows it", () => {
  const { home, o } = setup();
  const file = join(home, "profiles.json");
  editJson(file, (p) => { p.defaults = { ...(p.defaults ?? {}), usage: ["runs"] }; });
  expect(o("profile", "list", "--for", "chat").out).toContain("p-chat");
  expect(o("profile", "list", "--for", "chat").out).not.toContain("p-both");
  o("profile", "set-usage", "p-both", "both");
  expect(readJson(file).profiles["p-both"].usage).toEqual(["chat", "runs"]);
  expect(o("profile", "list", "--for", "chat").out).toContain("p-both");
});

test("profile pick skips chat-only profiles and chat-only harnesses", () => {
  const { o } = setup();
  const pick = () => o("profile", "pick", "fix a typo", "--complexity", "small").out.split("\n")[0];
  expect(pick()).toBe("profile=p-both");
  o("profile", "set-usage", "p-both", "chat");
  expect(pick()).not.toBe("profile=p-both");
  expect(pick()).not.toBe("profile=p-chat");
  o("harness", "set-usage", "claude", "chat");
  expect(pick()).toBe("profile=p-oc");
});

test("run, start, loop, schedule and watch refuse a chat-only profile or harness and name the setting", () => {
  const { o } = setup();
  let r = o("run", "--profile", "p-chat", "hello");
  expect(r.rc).toBe(2);
  expect(r.err).toContain("profile p-chat is chat-only");
  expect(r.err).toContain("profiles.p-chat.usage");
  expect(o("start", "--profile", "p-chat", "hello").err).toContain("profile p-chat is chat-only");
  expect(o("loop", "start", "--every", "1m", "--profile", "p-chat", "x").err).toContain("is chat-only");
  expect(o("schedule", "add", "--name", "n", "--cron", "0 * * * *", "--prompt", "x", "--profile", "p-chat").err).toContain("is chat-only");
  expect(o("watch", "start", "--name", "w", "echo hi", "--on-match", "x", "--profile", "p-chat").err).toContain("is chat-only");
  expect(o("run", "--profile", "p-both", "hello").rc).toBe(0);
  o("harness", "set-usage", "opencode", "chat");
  r = o("run", "--profile", "p-oc", "hello");
  expect(r.rc).toBe(2);
  expect(r.err).toContain("harness opencode is chat-only");
  expect(r.err).toContain("settings.harness_usage.opencode");
});

test("a chat turn (ORCH_USE=chat) runs chat-only profiles and refuses runs-only ones", () => {
  const { o } = setup();
  expect(o.env({ ORCH_USE: "chat" }, "run", "--profile", "p-chat", "hello").rc).toBe(0);
  const r = o.env({ ORCH_USE: "chat" }, "run", "--profile", "p-runs", "hello");
  expect(r.rc).toBe(2);
  expect(r.err).toContain("profile p-runs is runs-only");
});

test("a runs-only profile still runs outside chat", () => {
  const { o } = setup();
  expect(o("run", "--profile", "p-runs", "hello").rc).toBe(0);
});

test("profile sanity warns when the planner or default profile is not runs-enabled", () => {
  const { home, o } = setup();
  expect(JSON.parse(o("profile", "sanity", "--profile", "p-both").out).warnings).toEqual([]);
  editJson(join(home, "profiles.json"), (p) => { p.settings.planner_profile = "p-chat"; p.settings.default_profile = "p-chat"; });
  const w = JSON.parse(o("profile", "sanity", "--profile", "p-both").out).warnings as string[];
  expect(w.length).toBe(2);
  expect(w[0]).toContain("settings.planner_profile");
  expect(w[0]).toContain("chat-only");
});

test("harness list --json carries usage", () => {
  const { o } = setup();
  o("harness", "set-usage", "pi", "runs");
  const out = JSON.parse(o("harness", "list", "--json").out);
  expect(out.harnesses.find((h: any) => h.id === "pi").usage).toEqual(["runs"]);
  expect(out.harnesses.find((h: any) => h.id === "claude").usage).toEqual(["chat", "runs"]);
});

test("the committed template stays generic: no usage limits", () => {
  const tpl = readJson(join(import.meta.dir, "../../templates/profiles.json"));
  expect(JSON.stringify(tpl)).not.toContain('"usage"');
  expect(JSON.stringify(tpl)).not.toContain("harness_usage");
});

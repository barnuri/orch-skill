import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";

import { profilesIssues } from "./profiles-validator";

const HARNESSES = ["claude", "cursor-agent", "opencode", "local-llm", "copilot", "pi"];
type Obj = Record<string, any>;

function doc(patch: (d: Obj) => void): Obj {
  const d = JSON.parse(readFileSync(resolve(import.meta.dir, "../../../skills/orch/templates/profiles.json"), "utf8")) as Obj;
  d.settings = { default_profile: "x" };
  d.models = { m: { slug: "sonnet", harnesses: ["claude"] } };
  d.profiles = { x: { harness: "claude", model: "m", usage: ["runs"] } };
  patch(d);
  return d;
}
const paths = (d: Obj) => profilesIssues(d, HARNESSES).map((i) => `${i.path}: ${i.reason}`);

describe("usage validation", () => {
  test("valid values pass", () => {
    expect(paths(doc((d) => { d.profiles.x.usage = ["chat"]; d.defaults = { usage: ["chat", "runs"] }; d.settings.harness_usage = { claude: ["runs"] }; }))).toEqual([]);
  });
  test("a profile usage must be a non-empty array of chat and runs", () => {
    expect(paths(doc((d) => { d.profiles.x.usage = []; }))).toEqual(['profiles.x.usage: must not be empty; use ["chat","runs"] for both']);
    expect(paths(doc((d) => { d.profiles.x.usage = "chat"; }))).toEqual(['profiles.x.usage: must be a non-empty array of "chat" and/or "runs"']);
    expect(paths(doc((d) => { d.profiles.x.usage = ["chat", "web"]; }))).toEqual(['profiles.x.usage[1]: must be "chat" or "runs"']);
    expect(paths(doc((d) => { d.profiles.x.usage = ["chat", "chat"]; }))).toEqual(["profiles.x.usage[1]: duplicate entry"]);
  });
  test("a profile without usage is rejected", () => {
    expect(paths(doc((d) => { delete d.profiles.x.usage; }))).toEqual(['profiles.x.usage: required; use ["chat"], ["runs"] or ["chat","runs"]']);
  });
  test("defaults.usage follows the same rule", () => {
    expect(paths(doc((d) => { d.defaults = { usage: ["x"] }; }))).toEqual(['defaults.usage[0]: must be "chat" or "runs"']);
  });
  test("harness_usage needs known harness ids and valid arrays", () => {
    expect(paths(doc((d) => { d.settings.harness_usage = { nope: ["chat"] }; }))[0]).toContain("settings.harness_usage.nope: unknown harness");
    expect(paths(doc((d) => { d.settings.harness_usage = { claude: [] }; }))).toEqual(['settings.harness_usage.claude: must not be empty; use ["chat","runs"] for both']);
    expect(paths(doc((d) => { d.settings.harness_usage = []; }))).toEqual(["settings.harness_usage: must be an object"]);
  });
});

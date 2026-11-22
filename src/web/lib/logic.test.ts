import { describe, expect, test } from "bun:test";
import type { Schedule } from "../../shared/types/schedule";
import type { Suggestion } from "../../shared/types/suggestion";
import { allowedByEntries, setAnyModels, toggleAllowedModel } from "./allowed-models";
import { matchIssues } from "./issue-match";
import { draftErrors, draftOf, healthOf, modelText, scheduleEditPayload, scheduleModelOptions, schedulePayload, emptyScheduleDraft, soonestNext, timeoutText, visibleSchedules } from "./schedule-logic";
import { mergeResults, statusOf, summaryText } from "./sanity-logic";
import { applyToastFor, filtersActive, isApplicable, matchesFilters, sortSuggestions } from "./suggestion-logic";
import { parseRoute, routeKey } from "../router/route";
import { activePillText } from "../shell/ActivePill";
import { freshnessLevel } from "../shell/Freshness";
import { offReason, visibleProfiles } from "./profile-filter";

const models = { "a-1": { slug: "a1", harnesses: ["claude"] }, "a-2": { slug: "a2", harnesses: ["claude"] }, "b-1": { slug: "b1", harnesses: ["claude"] } };

function schedule(patch: Partial<Schedule>): Schedule {
  return { id: "s", name: "n", cron: "* * * * *", kind: "prompt", enabled: true, created_at: "", prompt: "p", profile: "x", command: null, workdir: null, timeout: 0, next_at: null, last_run_at: null, last_status: null, runs: [], ...patch };
}

describe("router", () => {
  test("keeps the deep links", () => {
    expect(parseRoute("#/profiles")).toEqual({ kind: "profiles" });
    expect(parseRoute("#/feedback")).toEqual({ kind: "feedback" });
    expect(parseRoute("#/run/abc%20d")).toEqual({ kind: "run", runId: "abc d" });
    expect(parseRoute("#/run/%E0%A4%A")).toEqual({ kind: "list" });
    expect(parseRoute("")).toEqual({ kind: "list" });
    expect(routeKey({ kind: "run", runId: "x" })).toBe("run:x");
  });
});

describe("issue matching", () => {
  test("pins to the longest covering path and lists the rest", () => {
    const m = matchIssues(["profiles.a", "profiles.a.env"], [
      { path: "profiles.a.env.FOO", reason: "bad" },
      { path: "profiles.a.flags[2]", reason: "x" },
      { path: "$", reason: "root" },
    ]);
    expect(m.byPath.get("profiles.a.env")).toEqual(["FOO: bad"]);
    expect(m.byPath.get("profiles.a")).toEqual(["flags[2]: x"]);
    expect(m.unmatched).toEqual([{ path: "$", reason: "root" }]);
  });
});

describe("allowed models", () => {
  test("clearing a pattern-covered model expands the pattern", () => {
    const next = toggleAllowedModel(["a*"], "a-1", false, ["a-1", "a-2", "b-1"], models);
    expect(next).toEqual(["a-2"]);
    expect(allowedByEntries(models, next, "a-1")).toBe(false);
  });
  test("any drops the list, un-any seeds it", () => {
    expect(setAnyModels({ harness: "claude", model: "a-2" }, false, ["a-1", "a-2"])).toEqual(["a-2"]);
    expect(setAnyModels({ harness: "claude", allowed_models: ["a-1"] }, true, [])).toBeUndefined();
  });
});

describe("schedules", () => {
  test("a prompt draft carries its model: omitted on create when default, null on edit when default", () => {
    const draft = draftOf(schedule({ kind: "prompt", prompt: "p", profile: "pr", model: "m-1", name: "n", cron: "* * * * *" }));
    expect(draft.model).toBe("m-1");
    expect(schedulePayload(draft)).toEqual({ name: "n", cron: "* * * * *", kind: "prompt", prompt: "p", profile: "pr", model: "m-1" });
    expect(schedulePayload({ ...draft, model: "" })).toEqual({ name: "n", cron: "* * * * *", kind: "prompt", prompt: "p", profile: "pr" });
    expect(scheduleEditPayload({ ...draft, model: "" })).toMatchObject({ model: null });
    expect(draftOf(schedule({ kind: "prompt", model: null })).model).toBe("");
    expect([modelText({ model: null }), modelText({}), modelText({ model: "x" })]).toEqual(["profile default", "profile default", "x"]);
  });

  test("model options: profile default first, then the profile's models, keeping a stored model no longer offered", () => {
    const models = [{ id: "a", label: "a", slug: "sa", description: "", default: true }, { id: "b", label: "b", slug: "sb", description: "d", default: false }];
    const options = { harnesses: [{ id: "claude", label: "C", enabled: true, available: true, persistent: true, profiles: [{ name: "p", description: "", enabled: true, configured: true, problem: null, models }] }], default_harness: null, default_profile: null };
    expect(scheduleModelOptions(options, "p", "").map((o) => o.value)).toEqual(["", "a", "b"]);
    expect(scheduleModelOptions(options, "p", "")[0]?.detail).toBe("a");
    expect(scheduleModelOptions(options, "p", "gone").map((o) => o.value)).toEqual(["", "gone", "a", "b"]);
    expect(scheduleModelOptions(undefined, "p", "").map((o) => o.value)).toEqual([""]);
  });

  test("an edit draft is prefilled from the schedule and sends clears explicitly", () => {
    const draft = draftOf(schedule({ kind: "command", command: "ls", workdir: "/tmp", timeout: 300, name: "n", cron: "* * * * *" }));
    expect(draft).toMatchObject({ kind: "command", command: "ls", workdir: "/tmp", timeout: "5m", name: "n" });
    expect(scheduleEditPayload({ ...draft, workdir: " ", timeout: "" })).toEqual({ name: "n", description: "", cron: "* * * * *", kind: "command", command: "ls", workdir: "", timeout: "0" });
    expect([timeoutText(0), timeoutText(7200), timeoutText(90)]).toEqual(["", "2h", "90s"]);
    expect(Object.keys(draftErrors({ ...emptyScheduleDraft(), kind: "command", timeout: "soon" })).sort()).toEqual(["command", "name", "timeout"]);
  });
  test("health, order and soonest", () => {
    const list = [schedule({ id: "p", enabled: false }), schedule({ id: "f", last_status: "failed", next_at: 50 }), schedule({ id: "o", last_status: "ok", next_at: 20 })];
    expect(healthOf(list[0] as Schedule)).toBe("paused");
    expect(visibleSchedules(list, "all").map((s) => s.id)).toEqual(["f", "o", "p"]);
    expect(visibleSchedules(list, "failing").map((s) => s.id)).toEqual(["f"]);
    expect(soonestNext(list)).toBe(20);
  });
  test("payload omits empty optional command fields", () => {
    expect(schedulePayload({ ...emptyScheduleDraft(), kind: "command", name: " n ", command: "ls", workdir: " ", timeout: "5m" })).toEqual({ name: "n", cron: "0 9 * * 1-5", kind: "command", command: "ls", timeout: "5m" });
  });
});

describe("sanity", () => {
  const row = (profile: string, ok: boolean, ms = 10) => ({ profile, ok, ms, harness: "h", model_id: "", slug: "", exit_code: 0, bytes: 1, error: "" });
  test("merge keeps older rows, summary counts", () => {
    const merged = mergeResults({ generated_at: "1", results: [row("a", true), row("b", false)] }, { generated_at: "2", results: [row("b", true)] });
    expect(merged.results.map((r) => r.profile)).toEqual(["b", "a"]);
    expect(summaryText(merged)).toBe("2/2 passed · total 20 ms");
    expect(statusOf({ ...row("c", false), status: "unconfigured" })).toBe("unconfigured");
  });
});

describe("suggestions", () => {
  const s = (patch: Partial<Suggestion>): Suggestion => ({ id: "i", status: "pending", created: "2026-01-01", confidence: "high", kind: "memory_record", title: "t", reason: "r", evidence: [], action: { type: "x" }, fingerprint: "f", ...patch });
  test("filters, applicability, order, toasts", () => {
    expect(filtersActive({ status: "pending", kind: "", confidence: "" })).toBe(false);
    expect(matchesFilters(s({ status: "applied" }), { status: "pending", kind: "", confidence: "" })).toBe(false);
    expect(isApplicable(s({ kind: "other" }))).toBe(false);
    expect(sortSuggestions([s({ id: "old", status: "applied", created: "2027" }), s({ id: "new" })]).map((x) => x.id)).toEqual(["new", "old"]);
    expect(applyToastFor({ ok: true, applied: 2, failed: 1, results: [] })).toEqual({ kind: "error", text: "Applied 2, 1 failed" });
  });
});

describe("profile filter and shell text", () => {
  test("a profile on a disabled harness is off and hidden", () => {
    const off = new Set(["codex"]);
    expect(offReason({ harness: "codex" }, off)).toBe("harness");
    expect(offReason({ harness: "claude", enabled: false }, off)).toBe("profile");
    expect(visibleProfiles({ a: { harness: "codex" }, b: { harness: "claude" } }, true, off).map(([n]) => n)).toEqual(["b"]);
  });
  test("pill and freshness", () => {
    expect(activePillText([{ kind: "loop" }, { kind: "watch" }, { kind: "watch" }] as never)).toBe("1 loop · 2 monitors");
    expect(freshnessLevel(1000, null)).toBe("");
    expect(freshnessLevel(20000, null)).toBe(" stale");
    expect(freshnessLevel(1, "x")).toBe(" dead");
  });
});

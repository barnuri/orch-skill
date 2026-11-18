import { describe, expect, test } from "bun:test";

import { AUTOMATION_INSTRUCTION, durationSecs, goalClosing, guessMonitor, onceCron, parseSlash, parseWhen, presetCron, urlProblem } from "./chat-automation";

describe("presets", () => {
  test("presets map to cron", () => {
    expect(presetCron("daily")).toBe("0 9 * * *");
    expect(presetCron("weekdays")).toBe("0 9 * * 1-5");
    expect(presetCron("sunday")).toBe("0 9 * * 0");
    expect(presetCron("hourly")).toBe("0 * * * *");
    expect(presetCron("custom", { custom: " */10 * * * * " })).toBe("*/10 * * * *");
    expect(presetCron("custom", { custom: "" })).toBeNull();
    expect(presetCron("once", { once: "2026-12-24T18:30" })).toBe("30 18 24 12 *");
    expect(onceCron("nope")).toBeNull();
  });

  test("the agent line is short enough for the shared budget", () => {
    expect(AUTOMATION_INSTRUCTION.length).toBeLessThan(200);
  });
});

describe("parseWhen", () => {
  test.each([
    ["every day at 09:00 summarise", "0 9 * * *", "summarise"],
    ["daily at 7pm check mail", "0 19 * * *", "check mail"],
    ["weekdays at 9:30 stand-up notes", "30 9 * * 1-5", "stand-up notes"],
    ["every sunday plan the week", "0 9 * * 0", "plan the week"],
    ["every hour ping", "0 * * * *", "ping"],
    ["every 15 minutes poll", "*/15 * * * *", "poll"],
    ["0 8 * * 1 weekly report", "0 8 * * 1", "weekly report"],
  ])("%s", (text, cron, rest) => {
    expect(parseWhen(text)).toEqual({ cron, rest });
  });

  test("no time phrase gives null", () => {
    expect(parseWhen("summarise the news")).toBeNull();
    expect(parseWhen("every day at 25:00 x")).toBeNull();
  });
});

describe("parseSlash", () => {
  test("plain text is not a command", () => {
    expect(parseSlash("hello")).toBeNull();
    expect(parseSlash("/other thing")).toBeNull();
  });

  test("open-the-sheet commands", () => {
    expect(parseSlash("/schedules")).toEqual({ cmd: "schedules" });
    expect(parseSlash(" /loops ")).toEqual({ cmd: "loops" });
    expect(parseSlash("/monitors")).toEqual({ cmd: "monitors" });
  });

  test("/schedule needs a time and a prompt", () => {
    expect(parseSlash("/schedule every day at 09:00 summarise the news")).toEqual({ cmd: "schedule", cron: "0 9 * * *", prompt: "summarise the news" });
    expect(parseSlash("/schedule summarise")?.cmd).toBe("error");
    expect(parseSlash("/schedule every day at 09:00")?.cmd).toBe("error");
  });

  test("/loop and /watch", () => {
    expect(parseSlash("/loop 10m check the build")).toEqual({ cmd: "loop", every: "10m", prompt: "check the build" });
    expect(parseSlash("/loop every 2 h poll")).toEqual({ cmd: "loop", every: "2h", prompt: "poll" });
    expect(parseSlash("/loop 5s too fast")?.cmd).toBe("error");
    expect(parseSlash("/watch https://example.com")).toEqual({ cmd: "watch", what: "https://example.com" });
    expect(parseSlash("/watch")?.cmd).toBe("error");
  });

  test("guessMonitor picks the type", () => {
    expect(guessMonitor("https://a.b/c").type).toBe("url");
    expect(guessMonitor("~/notes.md").type).toBe("file");
    expect(guessMonitor("pgrep -f server").type).toBe("command");
  });

  test("durations", () => {
    expect(durationSecs("10m")).toBe(600);
    expect(durationSecs("1h")).toBe(3600);
    expect(durationSecs("x")).toBeNull();
  });
});

describe("urlProblem", () => {
  test("http and https only", () => {
    expect(urlProblem("https://example.com/x")).toBeNull();
    expect(urlProblem("http://127.0.0.1:8080")).toBeNull();
    expect(urlProblem("file:///etc/passwd")).toMatch(/http and https/);
    expect(urlProblem("ftp://x")).toMatch(/http and https/);
    expect(urlProblem("nope")).toMatch(/not a valid/);
  });

  test("link-local and metadata addresses are blocked unless allowed", () => {
    for (const u of ["http://169.254.169.254/latest/meta-data", "http://[fe80::1]/", "http://metadata.google.internal/", "http://100.100.100.200/", "http://[::ffff:169.254.169.254]/"]) {
      expect(urlProblem(u)).toMatch(/blocked/);
      expect(urlProblem(u, true)).toBeNull();
    }
  });

  test("credentials in the URL are refused", () => {
    expect(urlProblem("https://user:pw@example.com")).toMatch(/user name/);
  });
});

describe("parseSlash: /goal and /feedback", () => {
  test("/goal with an objective starts a goal, keeping case and punctuation", () => {
    expect(parseSlash("/goal Ship the Feedback page, all tests green")).toEqual({ cmd: "goal", objective: "Ship the Feedback page, all tests green" });
  });

  test("/goal stop and /goal alone are the stop and show commands", () => {
    expect(parseSlash("/goal stop")).toEqual({ cmd: "goal-stop" });
    expect(parseSlash("/GOAL   STOP ")).toEqual({ cmd: "goal-stop" });
    expect(parseSlash("/goal")).toEqual({ cmd: "goal-show" });
  });

  test("/feedback with text adds it, list and work are their own commands", () => {
    expect(parseSlash("/feedback The run list is slow")).toEqual({ cmd: "feedback-add", text: "The run list is slow" });
    expect(parseSlash("/feedback list")).toEqual({ cmd: "feedback-list" });
    expect(parseSlash("/feedback work")).toEqual({ cmd: "feedback-work" });
  });

  test("/feedback without text is an error, not an empty item", () => {
    expect(parseSlash("/feedback")).toEqual({ cmd: "error", message: "Say the feedback, or use /feedback list or /feedback work" });
  });

  test("words that only start with a command name are not commands", () => {
    expect(parseSlash("/goals are hard")).toBeNull();
    expect(parseSlash("/feedbacks")).toBeNull();
  });

  test("the first-turn hint mentions /goal and /feedback", () => {
    expect(AUTOMATION_INSTRUCTION).toContain("/goal");
    expect(AUTOMATION_INSTRUCTION).toContain("/feedback");
  });
});

describe("goalClosing", () => {
  test("agent stop means the goal was met", () => {
    expect(goalClosing("Goal: ship it", "agent", 3)).toBe("Goal met after 3 iterations.");
    expect(goalClosing("Goal: ship it", "agent", 1)).toBe("Goal met after 1 iteration.");
  });

  test("the iteration cap means the goal was not met", () => {
    expect(goalClosing("Goal: ship it", "max", 20)).toBe("Goal not met: stopped at the maximum of 20 iterations.");
  });

  test("a user stop and other ends are reported", () => {
    expect(goalClosing("Goal: ship it", "stopped", 2)).toBe("Goal stopped by you.");
    expect(goalClosing("Goal: ship it", "failures", 2)).toBe("Goal not met: loop ended (failures).");
  });

  test("a loop that is not a goal keeps the default closing line", () => {
    expect(goalClosing("Loop: news", "agent", 3)).toBeNull();
  });
});

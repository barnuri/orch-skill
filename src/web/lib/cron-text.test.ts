import { describe, expect, test } from "bun:test";
import { describeCron } from "./cron-text";

const text = (expr: string): string | undefined => {
  const result = describeCron(expr);
  return result?.ok ? result.text : undefined;
};

describe("describeCron", () => {
  test.each([
    ["*/15 * * * *", "Every 15 minutes"],
    ["0 9 * * 1-5", "At 09:00, Monday through Friday"],
    ["* * * * *", "Every minute"],
    ["0 9 * * *", "At 09:00"],
    ["0 * * * *", "At minute 0 of every hour"],
    ["30 8 1 * *", "At 08:30, on day 1"],
    ["0 9 * * 1", "At 09:00, Monday"],
    ["0 9 * * 1,3,5", "At 09:00, Monday, Wednesday and Friday"],
    ["0 0 1 1 *", "At 00:00, on day 1, in January"],
    ["0 0 * 1-3 *", "At 00:00, in January through March"],
    ["0 0 * * 7", "At 00:00, Sunday"],
    ["5/20 * * * *", "At minutes 5, 25 and 45 of every hour"],
    ["0 9-17/2 * * 1-5", "At minute 0 of hours 9, 11, 13, 15 and 17, Monday through Friday"],
    ["*/15 9-17 * * *", "At minutes 0, 15, 30 and 45 of hours 9 through 17"],
    ["0 0 1 * 1", "At 00:00, on day 1 or Monday"],
    ["* 9 * * *", "Every minute, between 09:00 and 09:59"],
    ["  */15   * * * *  ", "Every 15 minutes"],
  ])("%s means %s", (expr, expected) => {
    expect(text(expr)).toBe(expected);
  });

  test.each([
    "* * * *",
    "* * * * * *",
    "60 * * * *",
    "*/0 * * * *",
    "5-3 * * * *",
    "* * 32 * *",
    "* * 0 * *",
    "* * * 13 *",
    "* * * * 8",
    "a * * * *",
    "0 9 * * MON",
    "@daily",
    "0 0 31 2 *",
  ])("%j is invalid", (expr) => {
    expect(describeCron(expr)?.ok).toBe(false);
  });

  test("an empty input has no meaning", () => {
    expect(describeCron("   ")).toBeNull();
  });
});

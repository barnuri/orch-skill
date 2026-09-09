import { afterEach, describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { orchPaths } from "../files/paths";
import { MAX_LOG_BYTES, readJobLog, readJobSession } from "./job-log-reader";

const homes: string[] = [];

function homeWithJob(jobId: string, files: Readonly<Record<string, string>>): string {
  const home = mkdtempSync(join(tmpdir(), "orch-joblog-"));
  homes.push(home);
  mkdirSync(join(home, "jobs", jobId), { recursive: true });
  for (const [name, content] of Object.entries(files)) {
    writeFileSync(join(home, "jobs", jobId, name), content);
  }
  return home;
}

afterEach(() => {
  homes.splice(0);
});

describe("readJobLog", () => {
  test("returns the whole log, not a tail", () => {
    const lines = Array.from({ length: 400 }, (_, i) => `line ${i}`).join("\n");
    const result = readJobLog(orchPaths(homeWithJob("j1", { log: lines })), "j1");
    expect(result.kind).toBe("ok");
    if (result.kind !== "ok") {
      return;
    }
    expect(result.truncated).toBe(false);
    expect(result.text.split("\n")).toHaveLength(400);
    expect(result.text).toContain("line 0");
    expect(result.text).toContain("line 399");
  });

  test("a missing job is missing, not an empty log", () => {
    expect(readJobLog(orchPaths(homeWithJob("j1", { log: "x" })), "nope").kind).toBe("missing");
  });

  test("a job dir with no log file is missing", () => {
    expect(readJobLog(orchPaths(homeWithJob("j1", { adapter: "claude" })), "j1").kind).toBe("missing");
  });

  // A job id reaches this from a URL path, so the traversal guard matters more than the size cap.
  test("an id that could escape the jobs dir is refused", () => {
    const paths = orchPaths(homeWithJob("j1", { log: "x" }));
    for (const bad of ["../profiles.json", "..", ".hidden", "a/b", ""]) {
      expect(readJobLog(paths, bad).kind).toBe("invalid");
    }
  });

  describe("over the size cap", () => {
    // The tail is kept: for a transcript the end is the part you came for.
    const oversized = "A".repeat(MAX_LOG_BYTES) + "THE-END";

    test("it is reported as truncated with the real size on disk", () => {
      const result = readJobLog(orchPaths(homeWithJob("big", { log: oversized })), "big");
      expect(result.kind).toBe("ok");
      if (result.kind !== "ok") {
        return;
      }
      expect(result.truncated).toBe(true);
      expect(result.bytes).toBe(oversized.length);
      expect(result.text.length).toBe(MAX_LOG_BYTES);
    });

    test("the end of the log survives, not the beginning", () => {
      const result = readJobLog(orchPaths(homeWithJob("big", { log: oversized })), "big");
      expect(result.kind === "ok" && result.text.endsWith("THE-END")).toBe(true);
    });
  });
});

describe("readJobSession", () => {
  test("the recorded session id is returned trimmed", () => {
    const paths = orchPaths(homeWithJob("j1", { log: "x", session: "  abc-123\n" }));
    expect(readJobSession(paths, "j1")).toBe("abc-123");
  });

  test("a job with no session file has none", () => {
    expect(readJobSession(orchPaths(homeWithJob("j1", { log: "x" })), "j1")).toBeNull();
  });

  test("an empty session file is null, not an empty string", () => {
    const paths = orchPaths(homeWithJob("j1", { log: "x", session: "\n" }));
    expect(readJobSession(paths, "j1")).toBeNull();
  });

  test("a traversal id is refused", () => {
    expect(readJobSession(orchPaths(homeWithJob("j1", { log: "x" })), "../x")).toBeNull();
  });
});

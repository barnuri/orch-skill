import { afterEach, describe, expect, test } from "bun:test";

import { ApiClient } from "../../dashboard/src/api/api-client";
import { IslandSource } from "../../dashboard/src/api/island-source";
import type { IslandHost } from "../../dashboard/src/api/island-host";
import { islandElementId } from "../../shared/island-id";
import type { RunEnvelope } from "../../shared/types/run-envelope";
import type { RunsEnvelope } from "../../shared/types/runs-envelope";
import { orchPaths } from "../files/paths";
import { TempHome } from "../test-support/temp-home";
import type { ServerContext } from "../types/server-context";
import { IslandBuilder } from "./island-builder";
import type { IslandSet } from "./island-builder";

const RUN_ID: string = "20260915-120000-aaaa";
const OTHER_RUN_ID: string = "20260915-130000-bbbb";
const JOB_ID: string = "20260915-120001-pid-1-1-1";

const homes: TempHome[] = [];

function runState(runId: string, jobId: string | null): string {
  return JSON.stringify({
    run_id: runId,
    title: `run ${runId}`,
    harness_session: "s1",
    started: `2026-09-15T12:00:00Z`,
    finished: null,
    status: "running",
    nodes: [
      {
        id: "n1",
        label: "first",
        status: "running",
        profile: "p1",
        adapter: "claude",
        job_id: jobId,
        started: "2026-09-15T12:00:01Z",
        finished: null,
        error: null,
        log_tail: [],
      },
    ],
    edges: [],
  });
}

function homeWithRuns(): TempHome {
  const home = TempHome.create();
  homes.push(home);
  home.write(`runs/${RUN_ID}/state.json`, runState(RUN_ID, JOB_ID));
  home.write(`runs/${OTHER_RUN_ID}/state.json`, runState(OTHER_RUN_ID, null));
  home.write(`jobs/${JOB_ID}/log`, "line one\nline two\n");
  return home;
}

function contextFor(home: TempHome): ServerContext {
  return {
    paths: orchPaths(home.path),
    bindHost: "127.0.0.1",
    hostname: "artifact",
    tokenDigest: new Uint8Array(),
    requireToken: false,
    requireRemoteToken: false,
    harnesses: ["claude"],
    outcomes: ["success", "failure", "partial"],
  };
}

/** The page the emitter produces, reduced to what the dashboard's island reader consumes. */
function hostForIslands(islands: IslandSet): IslandHost {
  const byId = new Map(
    Object.entries(islands).map(([name, value]) => [islandElementId(name), JSON.stringify(value)]),
  );
  return { getElementById: (id: string) => (byId.has(id) ? { textContent: byId.get(id) ?? null } : null) };
}

afterEach(() => {
  homes.splice(0);
});

describe("IslandBuilder.forRun", () => {
  test("embeds the run, its job log and every document", async () => {
    const built = await new IslandBuilder(contextFor(homeWithRuns())).forRun(RUN_ID);
    expect(built.kind).toBe("ok");
    if (built.kind !== "ok") {
      throw new Error("expected ok");
    }
    const names = Object.keys(built.islands);
    expect(names).toContain(`run-${RUN_ID}`);
    expect(names).toContain("runs");
    expect(names).toContain(`job-${JOB_ID}-log`);
    expect(names).toContain("profiles");
    expect(names).toContain("memory");
  });

  test("a document with no file on disk is skipped, not fatal", async () => {
    // TempHome seeds profiles.json and memory.json exactly as `ensureHome` does — and like an
    // older real state dir, it has no suggestions.json.
    const built = await new IslandBuilder(contextFor(homeWithRuns())).forRun(RUN_ID);
    expect(built.kind).toBe("ok");
    if (built.kind !== "ok") {
      throw new Error("expected ok");
    }
    expect(Object.keys(built.islands)).not.toContain("suggestions");
    expect(Object.keys(built.islands)).toContain("profiles");
  });

  test("never embeds health — it carries the state path and server pid", async () => {
    const built = await new IslandBuilder(contextFor(homeWithRuns())).forRun(RUN_ID);
    if (built.kind !== "ok") {
      throw new Error("expected ok");
    }
    expect(Object.keys(built.islands)).not.toContain("health");
  });

  test("the runs list is narrowed to the snapshotted run, so no link dangles", async () => {
    const built = await new IslandBuilder(contextFor(homeWithRuns())).forRun(RUN_ID);
    if (built.kind !== "ok") {
      throw new Error("expected ok");
    }
    const listed = built.islands["runs"] as RunsEnvelope;
    expect(listed.runs.map((summary) => summary.run_id)).toEqual([RUN_ID]);
  });

  test("a node that was never dispatched contributes no log island", async () => {
    const built = await new IslandBuilder(contextFor(homeWithRuns())).forRun(OTHER_RUN_ID);
    if (built.kind !== "ok") {
      throw new Error("expected ok");
    }
    expect(Object.keys(built.islands).filter((name) => name.startsWith("job-"))).toEqual([]);
  });

  test("an unknown run id is reported, not emitted", async () => {
    const built = await new IslandBuilder(contextFor(homeWithRuns())).forRun("20260101-000000-ffff");
    expect(built).toEqual({ kind: "missing-run", runId: "20260101-000000-ffff" });
  });
});

describe("the emitted islands drive the real ApiClient", () => {
  test("every read the dashboard makes is answered from the page", async () => {
    const built = await new IslandBuilder(contextFor(homeWithRuns())).forRun(RUN_ID);
    if (built.kind !== "ok") {
      throw new Error("expected ok");
    }
    const client = new ApiClient(new IslandSource(hostForIslands(built.islands)));

    const runs = await client.getRuns(null);
    expect(runs.kind).toBe("ok");

    const run = await client.getRun(RUN_ID, null);
    expect(run.kind).toBe("ok");
    if (run.kind !== "ok") {
      throw new Error("expected ok");
    }
    expect((run.body as RunEnvelope).run.run_id).toBe(RUN_ID);

    const log = await client.getJobLog(JOB_ID, null);
    expect(log.kind).toBe("ok");
    if (log.kind !== "ok") {
      throw new Error("expected ok");
    }
    expect(log.body.text).toContain("line one");

    expect((await client.getDocument("profiles", null)).kind).toBe("ok");
    expect((await client.getDocument("memory", null)).kind).toBe("ok");
  });

  test("a save from the snapshot is refused instead of hitting a dead network", async () => {
    const built = await new IslandBuilder(contextFor(homeWithRuns())).forRun(RUN_ID);
    if (built.kind !== "ok") {
      throw new Error("expected ok");
    }
    const client = new ApiClient(new IslandSource(hostForIslands(built.islands)));
    const saved = await client.putDocument("profiles", {}, '"etag"');
    expect(saved.kind).toBe("error");
    if (saved.kind !== "error") {
      throw new Error("expected an error");
    }
    expect(saved.status).toBe(405);
  });
});

import { afterEach, beforeEach, describe, expect, test } from "bun:test";

import type { HarnessesEnvelope } from "../../../shared/types/harness-status";
import type { HealthResponse } from "../../../shared/types/health-response";
import type { JobLogEnvelope } from "../../../shared/types/job-log-envelope";
import type { ProfilesEnvelope } from "../../../shared/types/profiles-envelope";
import type { RunEnvelope } from "../../../shared/types/run-envelope";
import type { RunsEnvelope } from "../../../shared/types/runs-envelope";
import { ApiClient } from "./api-client.ts";
import { IslandSource } from "./island-source.ts";
import type { IslandHost } from "./island-host.ts";

const GENERATED_AT: string = "2026-09-15T12:00:00Z";
const RUN_ID: string = "20260915-120000-aaaa";
const JOB_ID: string = "20260915-120001-pid-1-1-1";

const RUNS: RunsEnvelope = {
  generated_at: GENERATED_AT,
  runs: [
    {
      run_id: RUN_ID,
      title: "snapshot me",
      status: "running",
      started: GENERATED_AT,
      finished: null,
      harness_session: "s1",
      counts: { waiting: 0, running: 1, done: 0, error: 0, skipped: 0 },
    },
  ],
};

const RUN: RunEnvelope = {
  generated_at: GENERATED_AT,
  run: {
    run_id: RUN_ID,
    title: "snapshot me",
    harness_session: "s1",
    started: GENERATED_AT,
    finished: null,
    status: "running",
    nodes: [],
    edges: [],
  },
};

const JOB_LOG: JobLogEnvelope = {
  job_id: JOB_ID,
  session: null,
  text: "hello",
  truncated: false,
  bytes: 5,
};

const PROFILES: ProfilesEnvelope = {
  document: null,
  harnesses: ["claude"],
  issues: [],
  limits: { max_body_bytes: 1024 },
};

const HEALTH: HealthResponse = { ok: true, pid: 1, home: "/tmp/home", version: "1.4.2" };

const HARNESSES: HarnessesEnvelope = { probed_at: GENERATED_AT, harnesses: [] };

function hostWith(elements: Readonly<Record<string, string>>): IslandHost {
  return {
    getElementById: (elementId: string) =>
      elementId in elements ? { textContent: elements[elementId] ?? null } : null,
  };
}

/** A snapshot always carries `runs`, so this is what makes the source active. */
function snapshotHost(extra: Readonly<Record<string, string>> = {}): IslandHost {
  return hostWith({ "orch-island-runs": JSON.stringify(RUNS), ...extra });
}

function clientOn(host: IslandHost): ApiClient {
  return new ApiClient(new IslandSource(host));
}

describe("ApiClient in island mode", () => {
  test("getRuns is answered from the runs island", async () => {
    const result = await clientOn(snapshotHost()).getRuns(null);
    expect(result).toEqual({ kind: "ok", body: RUNS, etag: null });
  });

  test("getRun reads the island named for its id", async () => {
    const client = clientOn(snapshotHost({ [`orch-island-run-${RUN_ID}`]: JSON.stringify(RUN) }));
    expect(await client.getRun(RUN_ID, null)).toEqual({ kind: "ok", body: RUN, etag: null });
  });

  test("getJobLog reads the job's log island", async () => {
    const client = clientOn(
      snapshotHost({ [`orch-island-job-${JOB_ID}-log`]: JSON.stringify(JOB_LOG) }),
    );
    expect(await client.getJobLog(JOB_ID, null)).toEqual({
      kind: "ok",
      body: JOB_LOG,
      etag: null,
    });
  });

  test("getDocument reads the island named after the kind", async () => {
    const client = clientOn(snapshotHost({ "orch-island-profiles": JSON.stringify(PROFILES) }));
    expect(await client.getDocument("profiles", null)).toEqual({
      kind: "ok",
      body: PROFILES,
      etag: null,
    });
  });

  test("health and harnesses have their own islands", async () => {
    const client = clientOn(
      snapshotHost({
        "orch-island-health": JSON.stringify(HEALTH),
        "orch-island-harnesses": JSON.stringify(HARNESSES),
      }),
    );
    expect(await client.health()).toEqual({ kind: "ok", body: HEALTH, etag: null });
    expect(await client.getHarnesses()).toEqual({ kind: "ok", body: HARNESSES, etag: null });
  });
});

describe("ApiClient write refusal in island mode", () => {
  test("putDocument is refused with a message the views can show", async () => {
    const result = await clientOn(snapshotHost()).putDocument("profiles", {}, '"etag"');
    expect(result.kind).toBe("error");
    if (result.kind !== "error") {
      throw new Error("expected an error result");
    }
    expect(result.status).toBe(405);
    expect(result.body?.error).toContain("published snapshot");
  });

  test("POST actions are refused too", async () => {
    const client = clientOn(snapshotHost());
    for (const result of [
      await client.profileSanity(["p1"]),
      await client.scanSuggestions(),
      await client.applySuggestions(undefined, true),
      await client.applySuggestion("s1"),
      await client.dismissSuggestion("s1"),
    ]) {
      expect(result.kind).toBe("error");
    }
  });
});

describe("ApiClient with no islands", () => {
  const originalFetch = globalThis.fetch;
  let requested: string[] = [];

  // Only the fetch path reads the token, and `bun test` has no localStorage. A stub keeps the
  // gap in the test rather than in token-store, which the browser satisfies for real.
  const tokenStorage = {
    getItem: (): string | null => null,
    setItem: (): void => {},
    removeItem: (): void => {},
  };

  beforeEach(() => {
    requested = [];
    Object.defineProperty(globalThis, "localStorage", {
      value: tokenStorage,
      configurable: true,
      writable: true,
    });
    globalThis.fetch = ((input: string | URL | Request): Promise<Response> => {
      requested.push(String(input));
      return Promise.resolve(
        new Response(JSON.stringify(RUNS), {
          status: 200,
          headers: { "Content-Type": "application/json", ETag: '"live"' },
        }),
      );
    }) as typeof fetch;
  });

  afterEach(() => {
    globalThis.fetch = originalFetch;
  });

  test("a page with no islands goes to the network", async () => {
    const result = await new ApiClient(new IslandSource(null)).getRuns(null);
    expect(requested).toEqual(["/api/runs"]);
    expect(result).toEqual({ kind: "ok", body: RUNS, etag: '"live"' });
  });

  test("writes are not refused when there are no islands", async () => {
    await new ApiClient(new IslandSource(null)).putDocument("profiles", {}, '"etag"');
    expect(requested).toEqual(["/api/profiles"]);
  });

  test("an island-mode GET whose own island is absent still falls through to fetch", async () => {
    const result = await clientOn(snapshotHost()).getRun("missing", null);
    expect(requested).toEqual(["/api/runs/missing"]);
    expect(result.kind).toBe("ok");
  });
});

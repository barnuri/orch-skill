import { afterEach, describe, expect, test } from "bun:test";

import { startTestServer } from "../test-support/test-server";
import type { TestServerHandle } from "../types/test-server-handle";

const TRANSCRIPT: string = Array.from({ length: 120 }, (_, i) => `● step ${i}`).join("\n");
const SESSION: string = "fc409ed5-1c42-4426-a940-a4b6c19fb826";

const servers: TestServerHandle[] = [];

function serverWithJob(jobId: string = "job-1"): TestServerHandle {
  const srv = startTestServer();
  servers.push(srv);
  srv.home.write(`jobs/${jobId}/log`, TRANSCRIPT);
  srv.home.write(`jobs/${jobId}/session`, `${SESSION}\n`);
  return srv;
}

afterEach(() => {
  for (const srv of servers.splice(0)) {
    srv.stop();
  }
});

describe("GET /api/jobs/:id/log", () => {
  test("returns the whole transcript and the session to resume", async () => {
    const srv = serverWithJob();
    const res = await srv.api("/api/jobs/job-1/log");
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.job_id).toBe("job-1");
    expect(body.session).toBe(SESSION);
    expect(body.truncated).toBe(false);
    expect(body.text.split("\n")).toHaveLength(120);
  });

  test("a job with no session file reports null rather than omitting the field", async () => {
    const srv = startTestServer();
    servers.push(srv);
    srv.home.write("jobs/bare/log", "one line");
    const body = await (await srv.api("/api/jobs/bare/log")).json();
    expect(body.session).toBeNull();
  });

  test("an unchanged transcript answers 304", async () => {
    const srv = serverWithJob();
    const etag = (await srv.api("/api/jobs/job-1/log")).headers.get("etag") ?? "";
    expect(etag).not.toBe("");
    const second = await srv.api("/api/jobs/job-1/log", { headers: { "If-None-Match": etag } });
    expect(second.status).toBe(304);
  });

  test("an unknown job is 404", async () => {
    const srv = serverWithJob();
    expect((await srv.api("/api/jobs/nope/log")).status).toBe(404);
  });

  // The id comes off a URL path, so a traversal attempt must not reach outside jobs/.
  test("a traversal id cannot read another file", async () => {
    const srv = serverWithJob();
    for (const bad of ["..%2F..%2Fprofiles.json", "..", ".hidden"]) {
      expect((await srv.api(`/api/jobs/${bad}/log`)).status).toBe(404);
    }
  });

  test("the transcript still needs the token", async () => {
    const srv = serverWithJob();
    expect((await srv.api("/api/jobs/job-1/log", {}, false)).status).toBe(401);
  });

  test("only GET is allowed", async () => {
    const srv = serverWithJob();
    expect((await srv.api("/api/jobs/job-1/log", { method: "PUT" })).status).toBe(405);
  });
});

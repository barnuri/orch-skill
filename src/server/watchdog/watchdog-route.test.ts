import { afterAll, describe, expect, test } from "bun:test";

import type { WatchdogStatus } from "../../shared/types/watchdog";
import { startTestServer } from "../test-support/test-server";

describe("GET /api/watchdog", () => {
  const srv = startTestServer();
  afterAll(() => srv.stop());

  test("answers the watchdog's state, actions from actions.log, counters and flags", async () => {
    const res = await srv.api("/api/watchdog");
    expect(res.status).toBe(200);
    const body = (await res.json()) as WatchdogStatus;
    expect(body.state).toBe("off");
    expect(Array.isArray(body.last_actions)).toBe(true);
    expect(Array.isArray(body.flags)).toBe(true);
    expect(typeof body.runs).toBe("object");
  });

  test("needs the token when the loopback bypass is off", async () => {
    const res = await srv.api("/api/watchdog", {}, false);
    expect(res.status).toBe(401);
  });
});

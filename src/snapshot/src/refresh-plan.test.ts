import { describe, expect, test } from "bun:test";

import { refreshPlanFor } from "./refresh-plan";
import type { Route } from "./router";

const ROUTES: Route[] = [
  { kind: "list" },
  { kind: "run", runId: "20261115-101010-abcd" },
  { kind: "profiles" },
  { kind: "harnesses" },
  { kind: "schedules" },
  { kind: "memory" },
  { kind: "suggestions" },
];

describe("refreshPlanFor", () => {
  test("every page also refreshes the header's active-items pill", () => {
    for (const route of ROUTES) {
      expect(refreshPlanFor(route).etags).toContain("active");
    }
  });

  test("the runs list and one run clear their own tags", () => {
    expect(refreshPlanFor({ kind: "list" }).etags).toContain("runs");
    expect(refreshPlanFor({ kind: "run", runId: "x" }).etags).toContain("run");
    expect(refreshPlanFor({ kind: "schedules" }).etags).toContain("schedules");
  });

  test("a document page clears its own document and nothing else", () => {
    expect(refreshPlanFor({ kind: "profiles" }).document).toBe("profiles");
    expect(refreshPlanFor({ kind: "memory" }).document).toBe("memory");
    expect(refreshPlanFor({ kind: "suggestions" }).document).toBe("suggestions");
    expect(refreshPlanFor({ kind: "list" }).document).toBeNull();
  });

  test("the harnesses page reloads profiles too and skips the probe cache", () => {
    const plan = refreshPlanFor({ kind: "harnesses" });
    expect(plan.document).toBe("profiles");
    expect(plan.forceHarnesses).toBe(true);
  });

  test("only the harnesses page forces the probe", () => {
    expect(ROUTES.filter((r) => refreshPlanFor(r).forceHarnesses).map((r) => r.kind)).toEqual(["harnesses"]);
  });
});

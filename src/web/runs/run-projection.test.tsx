import { afterAll, afterEach, describe, expect, test } from "bun:test";
import { installDom } from "../test/dom";
import { buildRunProjection, type ProjectionInput, type RunProjection } from "../../../skills/orch/core/runs/projection";

const uninstall = installDom();
const { render, screen, cleanup } = await import("@testing-library/react");
const { NextActions } = await import("./RunNextActions");
const { ReadyNotice } = await import("./RunHealth");
const { RequirementsPanel } = await import("./RunRequirements");
const { runProjectionSchema } = await import("./schemas");

afterEach(cleanup);
afterAll(uninstall);

// One state, fed to the same builder the server and CLI use. The UI gets it through the API body (JSON).
const input = (): ProjectionInput => ({
  run: {
    run_id: "r1",
    status: "running",
    edges: [["a", "b"]],
    nodes: [
      { id: "a", status: "running", job_id: "j1" },
      { id: "b", status: "waiting" },
      { id: "c", status: "waiting" },
      { id: "d", status: "error" },
    ],
  },
  requirements: [
    { id: "R1", text: "fast", status: "partly", nodes: ["a"], evidence: [{ note: "bench", file: null, test: null, at: "2026-11-23T10:00:00Z" }] },
    { id: "R2", text: "docs", status: "not", nodes: ["d"] },
  ],
  handoffs: {},
  flags: [],
});

/** The API body is the projection's JSON; the UI parses it with the schema and renders from the parsed value. */
const fromApi = async (p: RunProjection): Promise<RunProjection> => (await runProjectionSchema.parseAsync(JSON.parse(JSON.stringify(p)))) as RunProjection;

describe("run page reads the projection", () => {
  test("the parsed API body is identical to the projection the CLI and server build", async () => {
    const p = buildRunProjection(input());
    expect(await fromApi(p)).toEqual(p);
  });

  test("ready notice names exactly the projection's ready nodes", async () => {
    const p = await fromApi(buildRunProjection(input()));
    render(<ReadyNotice ready={p.ready} />);
    expect(screen.getByRole("status").textContent).toBe("1 node ready to start: c");
    expect(p.ready).toEqual(["c"]);
  });

  test("next actions list the projection's actions in its order", async () => {
    const p = await fromApi(buildRunProjection(input()));
    render(<NextActions actions={p.next_actions} />);
    const items = [...document.querySelectorAll(".run-next li")].map((li) => li.getAttribute("data-kind"));
    expect(items).toEqual(p.next_actions.slice(0, 5).map((a) => a.kind));
    expect(items).toContain("fix_error");
  });

  test("requirements panel shows the projection's open count and statuses", async () => {
    const p = await fromApi(buildRunProjection(input()));
    const store = new Map<string, string>([["orch.run.requirements.open", "1"]]);
    const g = globalThis as { localStorage?: unknown };
    const before = g.localStorage;
    g.localStorage = { getItem: (k: string) => store.get(k) ?? null, setItem: (k: string, v: string) => void store.set(k, v) };
    try {
      render(<RequirementsPanel requirements={p.requirements} />);
      expect(screen.getByLabelText("Requirements").textContent).toContain(`${p.requirements.filter((r) => !r.ok).length} of ${p.requirements.length} open`);
      expect(screen.getByTestId("req-status-R1").textContent).toBe("partly");
      expect(screen.getByTestId("req-status-R2").textContent).toBe("not");
    } finally {
      g.localStorage = before;
    }
  });
});

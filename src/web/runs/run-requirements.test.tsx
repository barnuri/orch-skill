import { describe, expect, test } from "bun:test";
import { renderToStaticMarkup } from "react-dom/server";
import { RequirementsPanel } from "./RunRequirements";

const req = (over: object) => ({ id: "R1", text: "make it fast", status: "not", reason: null, ok: false, bucket: "open" as const, blocked: false, nodes: [], evidence: [], ...over });

describe("RequirementsPanel", () => {
  test("renders nothing without a ledger", () => {
    expect(renderToStaticMarkup(<RequirementsPanel requirements={[]} />)).toBe("");
  });
  test("is collapsed by default and shows the count only", () => {
    const html = renderToStaticMarkup(<RequirementsPanel requirements={[req({})]} />);
    expect(html).toContain("1 of 1 open");
    expect(html).toContain('aria-expanded="false"');
    expect(html).not.toContain("req-status-");
  });
  test("each row carries a tone class so the rail colour names the status, not a hex value", () => {
    const store = new Map<string, string>([["orch.run.requirements.open", "1"]]);
    const g = globalThis as { localStorage?: unknown };
    const before = g.localStorage;
    g.localStorage = { getItem: (k: string) => store.get(k) ?? null, setItem: (k: string, v: string) => void store.set(k, v) };
    try {
      const html = renderToStaticMarkup(<RequirementsPanel requirements={[req({}), req({ id: "R2", status: "handled", ok: true })]} />);
      expect(html).toContain('class="req-err"');
      expect(html).toContain('class="req-ok"');
    } finally {
      g.localStorage = before;
    }
  });
  test("shows status chip, linked node marks and evidence when the saved state is open", () => {
    const store = new Map<string, string>([["orch.run.requirements.open", "1"]]);
    const g = globalThis as { localStorage?: unknown };
    const before = g.localStorage;
    g.localStorage = { getItem: (k: string) => store.get(k) ?? null, setItem: (k: string, v: string) => void store.set(k, v) };
    let html: string;
    try {
    html = renderToStaticMarkup(
      <RequirementsPanel
        requirements={[
          req({ nodes: [{ id: "n1", status: "done", done: true, handoff: true, unverified: false }, { id: "n2", status: "done", done: true, handoff: false, unverified: true }], evidence: [{ note: "bench ok", file: "a.ts", test: "bun test a", at: "t" }] }),
          req({ id: "R2", status: "handled", ok: true }),
        ]}
      />,
    );
    expect(html).toContain("1 of 2 open");
    expect(html).toContain("n1 ✓");
    expect(html).toContain("n2 ⚠");
    expect(html).toContain("bench ok");
    expect(html).toContain('aria-label="n2: done, no handoff, unverified"');
    } finally {
      g.localStorage = before;
    }
    expect(html).toContain('aria-live="polite"');
    expect(html).toContain('data-testid="req-status-R2"');
  });
});

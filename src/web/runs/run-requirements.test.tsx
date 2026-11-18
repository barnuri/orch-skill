import { describe, expect, test } from "bun:test";
import { renderToStaticMarkup } from "react-dom/server";
import { RequirementsPanel } from "./RunRequirements";

const req = (over: object) => ({ id: "R1", text: "make it fast", status: "not", reason: null, ok: false, nodes: [], evidence: [], ...over });

describe("RequirementsPanel", () => {
  test("renders nothing without a ledger", () => {
    expect(renderToStaticMarkup(<RequirementsPanel requirements={[]} />)).toBe("");
  });
  test("shows status chip, linked node marks and evidence", () => {
    const html = renderToStaticMarkup(
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
    expect(html).toContain('aria-live="polite"');
    expect(html).toContain('data-testid="req-status-R2"');
  });
});

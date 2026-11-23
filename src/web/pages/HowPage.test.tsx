import { describe, expect, test, afterAll } from "bun:test";
import { installDom } from "../test/dom";
import { parseRoute, NAV_LINKS, SECTION_HREF } from "../router/route";

const uninstall = installDom();
const { render, screen, cleanup, within } = await import("@testing-library/react");
const { HowPage } = await import("./HowPage");

afterAll(uninstall);

describe("How orch works page", () => {
  test("#/how routes to the page and is listed in the sidebar", () => {
    expect(parseRoute("#/how")).toEqual({ kind: "how" });
    expect(SECTION_HREF.how).toBe("#/how");
    expect(NAV_LINKS.at(-1)).toEqual({ href: "#/how", label: "How orch works" });
  });

  test("renders the main flow with eight steps and six swim lanes", () => {
    render(<HowPage />);
    const flow = screen.getByRole("heading", { name: "Main flow" }).closest("section");
    if (flow === null) {
      throw new Error("main flow section missing");
    }
    for (const code of ["S1", "S2", "S3", "S4", "S5", "S6", "S7", "S8"]) {
      expect(within(flow).getByText(code)).toBeTruthy();
    }
    for (const lane of ["User", "Orchestrator", "State", "Supervisor", "Harness jobs", "Gate and delivery"]) {
      expect(within(flow).getByText(lane, { selector: ".how-lane-name" })).toBeTruthy();
    }
    cleanup();
  });

  test("status legend covers the six statuses", () => {
    render(<HowPage />);
    const legend = screen.getByRole("list", { name: "Status legend" });
    expect(within(legend).getAllByRole("listitem")).toHaveLength(6);
    cleanup();
  });

  test("renders five recovery flows, each with Detect, Act and End", () => {
    render(<HowPage />);
    const recovery = screen.getByRole("heading", { name: "Recovery flows" }).closest("section");
    if (recovery === null) {
      throw new Error("recovery section missing");
    }
    for (const title of ["Stalled or dead node", "Missing handoff", "CLI or source error", "Owner unknown", "Feedback"]) {
      expect(within(recovery).getByRole("heading", { name: title })).toBeTruthy();
    }
    expect(within(recovery).getAllByText("Detect")).toHaveLength(5);
    expect(within(recovery).getAllByText("Act")).toHaveLength(5);
    expect(within(recovery).getAllByText("End")).toHaveLength(5);
    cleanup();
  });
});

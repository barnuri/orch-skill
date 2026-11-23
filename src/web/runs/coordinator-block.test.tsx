import { afterAll, afterEach, describe, expect, test } from "bun:test";
import { installDom } from "../test/dom";

const uninstall = installDom();
const { render, screen, fireEvent, cleanup } = await import("@testing-library/react");
const { QueryClient, QueryClientProvider } = await import("@tanstack/react-query");
const { ToastProvider } = await import("../components/Toast");
const { CoordinatorBlock } = await import("./CoordinatorBlock");

afterEach(cleanup);
afterAll(uninstall);

const base = { pane_id: "p1", reachable: true, unreachable_since: null, unreachable_reason: null, pending_asks: 0, last_repoint: null, candidates: [] };

function show(state: Parameters<typeof CoordinatorBlock>[0]["state"]) {
  return render(
    <QueryClientProvider client={new QueryClient()}>
      <ToastProvider>
        <CoordinatorBlock runId="r1" state={state} />
      </ToastProvider>
    </QueryClientProvider>,
  );
}

describe("CoordinatorBlock", () => {
  test("renders nothing without an orchestrator", () => {
    const { container } = show(null);
    expect(container.textContent).toBe("");
  });

  test("reachable with an open question: shows the count and no choose button", () => {
    show({ ...base, pending_asks: 2 });
    expect(screen.getByText("2 pending orchestrator questions")).toBeTruthy();
    expect(screen.queryByText("Choose orchestrator")).toBeNull();
  });

  test("one open question uses the singular orchestrator wording", () => {
    show({ ...base, pending_asks: 1 });
    expect(screen.getByText("1 pending orchestrator question")).toBeTruthy();
    expect(screen.queryByText("Choose orchestrator")).toBeNull();
  });

  test("reachable with no open question: the block does not render", () => {
    const { container } = show({ ...base, pending_asks: 0 });
    expect(container.textContent).toBe("");
    expect(screen.queryByText("Choose orchestrator")).toBeNull();
  });

  test("unreachable without an open question: warning shown, no choose button", () => {
    const cand = { socket_path: "/s", pane_id: "p9", workspace_id: "w", cwd: "/repo", session_id: "", agent: "opencode" };
    const { container } = show({ ...base, reachable: false, unreachable_since: "T", unreachable_reason: "gone", candidates: [cand] });
    expect(container.querySelector(".coordinator-unreachable")).toBeTruthy();
    expect(screen.queryByText("Choose orchestrator")).toBeNull();
    expect(container.textContent).not.toContain("question");
  });

  test("unreachable with an open question: amber warning and a candidate list behind the button", () => {
    const cand = { socket_path: "/s", pane_id: "p9", workspace_id: "w", cwd: "/repo", session_id: "", agent: "opencode" };
    const { container } = show({ ...base, pending_asks: 1, reachable: false, unreachable_since: "T", unreachable_reason: "gone", candidates: [cand] });
    expect(container.querySelector(".coordinator-unreachable")).toBeTruthy();
    fireEvent.click(screen.getByText("Choose orchestrator"));
    expect(screen.getByText(/p9 · opencode · \/repo/)).toBeTruthy();
  });

  test("the block shows the count only for open asks and never offers a choice for tells alone", () => {
    const { container } = show({ ...base, pending_asks: 0, reachable: false, unreachable_since: "T", unreachable_reason: "gone" });
    expect(screen.queryByText("Choose orchestrator")).toBeNull();
    expect(container.textContent).not.toContain("pending");
  });

  test("shows the word orchestrator only, never coordinator", () => {
    const cand = { socket_path: "/s", pane_id: "p9", workspace_id: "w", cwd: "/repo", session_id: "", agent: "opencode" };
    const { container } = show({ ...base, pending_asks: 1, reachable: false, unreachable_since: "T", unreachable_reason: "gone", candidates: [cand] });
    fireEvent.click(screen.getByText("Choose orchestrator"));
    expect(container.textContent).toContain("orchestrator p1");
    expect(container.textContent?.toLowerCase()).not.toContain("coordinator");
  });
});

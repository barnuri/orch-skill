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
  test("renders nothing without a coordinator", () => {
    const { container } = show(null);
    expect(container.textContent).toBe("");
  });

  test("reachable: shows the pending count and no choose button", () => {
    show({ ...base, pending_asks: 2 });
    expect(screen.getByText("2 pending node questions")).toBeTruthy();
    expect(screen.queryByText("Choose coordinator")).toBeNull();
  });

  test("unreachable: amber warning and a candidate list behind the button", () => {
    const cand = { socket_path: "/s", pane_id: "p9", workspace_id: "w", cwd: "/repo", session_id: "", agent: "opencode" };
    const { container } = show({ ...base, reachable: false, unreachable_since: "T", unreachable_reason: "gone", candidates: [cand] });
    expect(container.querySelector(".coordinator-unreachable")).toBeTruthy();
    fireEvent.click(screen.getByText("Choose coordinator"));
    expect(screen.getByText(/p9 · opencode · \/repo/)).toBeTruthy();
  });
});

import { afterAll, afterEach, describe, expect, test } from "bun:test";
import type { RunNode } from "../../shared/types/run-node";
import { installDom } from "../test/dom";

const uninstall = installDom();
const { render, screen, cleanup } = await import("@testing-library/react");
const { ToastProvider } = await import("../components/Toast");
const { NodeActions, NodeWarnings } = await import("./NodeActions");

afterEach(cleanup);
afterAll(uninstall);

const node = (over: Partial<RunNode>): RunNode =>
  ({ id: "n1", label: "n1", status: "pending", profile: null, adapter: null, job_id: null, started: null, finished: null, error: null, log_tail: [], ...over }) as RunNode;
const actions = (n: RunNode) =>
  render(
    <ToastProvider>
      <NodeActions runId="r1" node={n} confirmStop={() => true} />
    </ToastProvider>,
  );

describe("NodeActions", () => {
  test("error node: Retry and Tell, no Stop", () => {
    actions(node({ status: "error" }));
    expect(screen.queryByRole("button", { name: "Retry" })).not.toBeNull();
    expect(screen.queryByRole("button", { name: "Tell" })).not.toBeNull();
    expect(screen.queryByRole("button", { name: "Stop" })).toBeNull();
  });
  test("skipped node has Retry", () => {
    actions(node({ status: "skipped" }));
    expect(screen.queryByRole("button", { name: "Retry" })).not.toBeNull();
  });
  test("running node: Stop, no Retry", () => {
    actions(node({ status: "running" }));
    expect(screen.queryByRole("button", { name: "Stop" })).not.toBeNull();
    expect(screen.queryByRole("button", { name: "Retry" })).toBeNull();
  });
  test("warnings render one line each", () => {
    render(<NodeWarnings node={node({ status: "error", error: "boom" })} />);
    expect(screen.getByText("Error: boom")).not.toBeNull();
  });
});

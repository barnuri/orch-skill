import { afterAll, afterEach, describe, expect, test } from "bun:test";
import type { RunNode } from "../../shared/types/run-node";
import type { RunState } from "../../shared/types/run-state";
import { installDom } from "../test/dom";

const uninstall = installDom();
const { render, cleanup } = await import("@testing-library/react");
const { QueryClient, QueryClientProvider } = await import("@tanstack/react-query");
const { ToastProvider } = await import("../components/Toast");
const { NodePanel } = await import("./NodePanel");

afterEach(cleanup);
afterAll(uninstall);

const node: RunNode = { id: "n1", label: "Node one", status: "running", profile: null, adapter: null, job_id: null, started: new Date().toISOString(), finished: null, error: null, log_tail: [] } as RunNode;
const run: RunState = { run_id: "r1", title: "T", harness_session: "", started: new Date().toISOString(), finished: null, status: "running", nodes: [node], edges: [] };

describe("node terminal layout", () => {
  test("the status line is the last row, below the composer", () => {
    const { container } = render(
      <QueryClientProvider client={new QueryClient()}>
        <ToastProvider>
          <NodePanel run={run} selectedId="n1" maxAttempts={5} flash={0} />
        </ToastProvider>
      </QueryClientProvider>,
    );
    const terminal = container.querySelector(".node-terminal");
    expect(terminal).not.toBeNull();
    const kids = [...(terminal?.children ?? [])];
    expect(kids[kids.length - 1]?.classList.contains("node-statusline")).toBe(true);
    const composer = container.querySelector(".node-messages");
    const status = container.querySelector(".node-statusline");
    expect(composer).not.toBeNull();
    expect(composer !== null && status !== null && (composer.compareDocumentPosition(status) & Node.DOCUMENT_POSITION_FOLLOWING) !== 0).toBe(true);
  });
});

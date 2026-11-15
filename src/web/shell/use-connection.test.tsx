import { afterAll, afterEach, beforeEach, describe, expect, test } from "bun:test";
import { installDom } from "../test/dom";

const uninstall = installDom();
const { render, act, cleanup } = await import("@testing-library/react");
const { connection } = await import("../api/status");
const { useAuthRequired } = await import("./use-connection");

afterEach(cleanup);
beforeEach(() => {
  (connection as unknown as { status: unknown }).status = { lastOkAt: null, lastError: null, authRequired: false };
});
afterAll(uninstall);

describe("useAuthRequired", () => {
  test("a successful poll does not re-render the shell; the token gate does", () => {
    let renders = 0;
    function Probe() {
      renders += 1;
      return <span>{String(useAuthRequired())}</span>;
    }
    const view = render(<Probe />);
    const before = renders;
    act(() => {
      connection.ok(1);
      connection.ok(2);
      connection.ok(3);
    });
    expect(renders).toBe(before);
    act(() => {
      connection.requireAuth();
    });
    expect(renders).toBe(before + 1);
    expect(view.container.textContent).toBe("true");
  });
});

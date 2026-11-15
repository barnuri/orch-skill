import { afterAll, afterEach, beforeEach, describe, expect, test } from "bun:test";
import { installDom } from "../test/dom";

const uninstall = installDom();
const { render, screen, act, cleanup } = await import("@testing-library/react");
const { Freshness, freshnessLevel } = await import("./Freshness");
const { connection } = await import("../api/status");

afterEach(cleanup);
beforeEach(() => {
  (connection as unknown as { status: unknown }).status = { lastOkAt: null, lastError: null, authRequired: false };
});
afterAll(() => {
  cleanup();
  uninstall();
});

describe("Freshness", () => {
  test("reads waiting, then Live once any GET succeeded, then offline", () => {
    render(<Freshness />);
    expect(screen.getByText("waiting for server…")).toBeTruthy();
    act(() => {
      connection.ok();
    });
    expect(screen.getByText(/^Live · /)).toBeTruthy();
    act(() => {
      connection.network();
    });
    expect(screen.getByText(/offline/)).toBeTruthy();
  });

  test("levels", () => {
    expect(freshnessLevel(0, null)).toBe("");
    expect(freshnessLevel(0, "x")).toBe(" dead");
  });
});

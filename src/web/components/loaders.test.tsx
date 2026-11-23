import { afterAll, afterEach, expect, test } from "bun:test";
import { installDom } from "../test/dom";

const uninstall = installDom();
const { cleanup, render, screen, act } = await import("@testing-library/react");
const { ErrorBoundary } = await import("./ErrorBoundary");
const { PageLoader, Skeleton } = await import("./Skeleton");

afterEach(cleanup);
afterAll(uninstall);

function Boom(): never {
  throw new Error("kaboom");
}

test("a render error shows a recoverable page, not a blank app", () => {
  const original = console.error;
  console.error = () => undefined;
  try {
    render(
      <ErrorBoundary resetKey="#/a">
        <Boom />
      </ErrorBoundary>,
    );
  } finally {
    console.error = original;
  }
  expect(screen.getByRole("alert").textContent).toContain("kaboom");
  expect(screen.getByRole("button", { name: "Try again" })).toBeTruthy();
});

test("a loader says it is slow after the threshold and offers a retry", async () => {
  let retried = 0;
  render(<PageLoader label="Loading run…" slowMs={20} onRetry={() => (retried += 1)} />);
  expect(screen.getByRole("status").textContent).toContain("Loading run…");
  await act(async () => {
    await new Promise((r) => setTimeout(r, 60));
  });
  const retry = screen.getByRole("button", { name: "Retry" });
  retry.click();
  expect(retried).toBe(1);
});

test("a skeleton without a retry offers a reload when slow", async () => {
  render(<Skeleton rows={2} slowMs={20} />);
  await act(async () => {
    await new Promise((r) => setTimeout(r, 60));
  });
  expect(screen.getByRole("button", { name: "Reload" })).toBeTruthy();
});

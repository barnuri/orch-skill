import { afterEach, describe, expect, test } from "bun:test";
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { Reasoning } from "./Reasoning";
import { ThinkingContext } from "./thread-live";

afterEach(cleanup);

describe("Reasoning", () => {
  test("live: shows the Thinking header with dots and the streaming text, capped", () => {
    render(<Reasoning text="שלב 1: בודק" live />);
    expect(screen.getByRole("button", { name: /Thinking/ })).not.toBeNull();
    const body = screen.getByTestId("reasoning-body");
    expect(body.getAttribute("dir")).toBe("auto");
    expect(body.className).toContain("is-capped");
    expect(document.querySelector(".working-dots")).not.toBeNull();
  });

  test("live without any text shows only the label and the dots", () => {
    render(<Reasoning text="" live />);
    expect(screen.queryByTestId("reasoning-body")).toBeNull();
    expect(document.querySelector(".working-dots")).not.toBeNull();
  });

  test("done: one muted line that expands to the full thoughts and collapses again", () => {
    render(<Reasoning text="full thoughts" startedAt="2026-01-01T00:00:00Z" finishedAt="2026-01-01T00:00:12Z" />);
    const toggle = screen.getByRole("button", { name: /Thought for 12s/ });
    expect(screen.queryByTestId("reasoning-body")).toBeNull();
    fireEvent.click(toggle);
    expect(screen.getByTestId("reasoning-body").textContent).toBe("full thoughts");
    expect(screen.getByTestId("reasoning-body").className).not.toContain("is-capped");
    fireEvent.click(toggle);
    expect(screen.queryByTestId("reasoning-body")).toBeNull();
  });

  test("the thread names the one thought that is streaming; the others stay collapsed", () => {
    render(
      <ThinkingContext.Provider value="b">
        <Reasoning id="a" text="old thought" />
        <Reasoning id="b" text="new thought" />
      </ThinkingContext.Provider>,
    );
    const rows = screen.getAllByTestId("reasoning");
    expect(rows.map((r) => r.getAttribute("data-live"))).toEqual(["false", "true"]);
  });

  test("the thought colour is the muted token and the rule is on the inline start", () => {
    const css = readFileSync(join(import.meta.dir, "reasoning.css"), "utf8");
    expect(css).toMatch(/\.reasoning-body \{[^}]*border-inline-start: 1px solid/);
    expect(css).toMatch(/\.reasoning-body \{[^}]*color: var\(--tx3\)/);
    expect(css).not.toMatch(/#[0-9a-fA-F]{3,8}\b/);
  });
});

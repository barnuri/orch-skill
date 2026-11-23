import { afterAll, describe, expect, test } from "bun:test";
import { installDom } from "../test/dom";

// The DOM must exist before @testing-library/react is imported, so these are top-level awaits.
const uninstall = installDom();
const { render, cleanup } = await import("@testing-library/react");
const { Chip } = await import("./Chip");
const { STATUS_KEYS, STATUS_PALETTE } = await import("../../shared/status-palette");

afterAll(() => {
  cleanup();
  uninstall();
});

describe("status chip per palette key", () => {
  for (const key of STATUS_KEYS) {
    test(`${key}: visible text, palette class, non-empty name`, () => {
      const { container, unmount } = render(<Chip status={key} />);
      const chip = container.querySelector(`.chip.status-${key}`);
      expect(chip).not.toBeNull();
      expect(chip?.textContent).toBe(key === "covered" ? STATUS_PALETTE.covered.label : key);
      unmount();
    });
  }

  test("a word outside the palette keeps only its own class", () => {
    const { container, unmount } = render(<Chip status="running" />);
    expect(container.querySelector(".chip")?.className).toBe("chip running");
    unmount();
  });

  test("blocked-user: the node status word, amber palette class, not the error red", () => {
    const { container, unmount } = render(<Chip status="blocked-user" />);
    const chip = container.querySelector(".chip");
    expect(chip?.textContent).toBe("blocked-user");
    expect(chip?.className).toBe("chip blocked-user status-blocked-user");
    expect(STATUS_PALETTE["blocked-user"].tone).toBe("amber");
    expect(STATUS_PALETTE["blocked-user"].tone).not.toBe(STATUS_PALETTE.error.tone);
    unmount();
  });
});

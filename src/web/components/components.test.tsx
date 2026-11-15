import { afterAll, describe, expect, test } from "bun:test";
import { installDom } from "../test/dom";

// The DOM must exist before @testing-library/react is imported, so these are top-level awaits.
const uninstall = installDom();
const { render, screen, fireEvent, cleanup } = await import("@testing-library/react");
const { Chip, EmptyState, KpiTile, Toggle } = await import("./index");
const { Select, nextActive } = await import("./Select");
const { Segmented, arrowStep } = await import("./Segmented");

afterAll(() => {
  cleanup();
  uninstall();
});

describe("pure helpers", () => {
  test("keyboard steps", async () => {
    expect(nextActive("ArrowDown", 2, 3)).toBe(2);
    expect(nextActive("Home", 2, 3)).toBe(0);
    expect(nextActive("ArrowUp", 0, 3)).toBe(0);
    expect(arrowStep("ArrowLeft")).toBe(-1);
    expect(arrowStep("x")).toBe(0);
  });
});

describe("components", () => {
  test("Toggle flips and respects disabled", async () => {
    const seen: boolean[] = [];
    const { rerender } = render(<Toggle label="Pause x" on onChange={(v) => seen.push(v)} />);
    fireEvent.click(screen.getByRole("switch", { name: "Pause x" }));
    rerender(<Toggle label="Pause x" on onChange={(v) => seen.push(v)} disabled />);
    fireEvent.click(screen.getByRole("switch", { name: "Pause x" }));
    expect(seen).toEqual([false]);
  });

  test("Select opens, picks with the keyboard and keeps a blank label for an unknown value", async () => {
    const picked: string[] = [];
    render(<Select aria-label="Pick" value="zzz" options={[{ value: "a", label: "A" }, { value: "b", label: "B" }]} onChange={(v) => picked.push(v)} />);
    const button = screen.getByRole("button", { name: "Pick" });
    expect(button.textContent).toBe("");
    fireEvent.keyDown(button, { key: "ArrowDown" });
    expect(button.getAttribute("aria-expanded")).toBe("true");
    fireEvent.keyDown(button, { key: "ArrowDown" });
    fireEvent.keyDown(button, { key: "Enter" });
    expect(picked).toEqual(["b"]);
  });

  test("Segmented moves with arrows", async () => {
    const picked: string[] = [];
    render(<Segmented label="View" value="a" options={[{ value: "a", label: "A" }, { value: "b", label: "B" }]} onChange={(v) => picked.push(v)} />);
    fireEvent.keyDown(screen.getByRole("radio", { name: "A" }), { key: "ArrowRight" });
    expect(picked).toEqual(["b"]);
  });

  test("EmptyState, KpiTile and Chip render their text", async () => {
    render(
      <>
        <EmptyState title="Nothing">fix it</EmptyState>
        <KpiTile label="Active" value="2/2" meta="all good" tone="ok" />
        <Chip status="failed" />
      </>,
    );
    expect(screen.getByText("Nothing")).toBeTruthy();
    expect(screen.getByText("2/2").parentElement?.className).toBe("kpi is-ok");
    expect(screen.getByText("failed").className).toBe("chip failed");
  });
});

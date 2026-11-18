import { afterAll, afterEach, beforeEach, describe, expect, test } from "bun:test";
import { installDom } from "../test/dom";

const uninstall = installDom();
const { render, screen, fireEvent, cleanup, waitFor } = await import("@testing-library/react");
const { Composer } = await import("./Composer");
const { skillsApi } = await import("../api/skills");

const realList = skillsApi.list;
beforeEach(() => {
  window.sessionStorage.clear();
  Object.assign(skillsApi, {
    list: async () => ({ kind: "ok" as const, body: { skills: [{ name: "orch", description: "orchestrate work" }] }, etag: null }),
  });
});
afterEach(() => {
  cleanup();
  Object.assign(skillsApi, { list: realList });
});
afterAll(uninstall);

function renderComposer(onSend = async (_text: string) => null) {
  render(<Composer chatId="c1" blocked={null} running={false} onSend={(t) => onSend(t)} onStop={() => {}} onOpenImage={() => {}} storage={window.sessionStorage} />);
  return screen.getByRole("combobox", { name: "Message" }) as HTMLTextAreaElement;
}

describe("slash menu in the composer", () => {
  test("typing a slash first shows commands and skills in a listbox", async () => {
    const area = renderComposer();
    fireEvent.change(area, { target: { value: "/" } });
    area.setSelectionRange(1, 1);
    fireEvent.select(area);
    const list = await screen.findByRole("listbox", { name: "Commands and skills" });
    expect(list.querySelectorAll("[role='option']").length).toBeGreaterThan(5);
    await waitFor(() => expect(screen.getByText("/orch")).toBeTruthy());
    expect(area.getAttribute("aria-expanded")).toBe("true");
  });

  test("the arrow keys move the highlight and Enter inserts the command with a space", async () => {
    const area = renderComposer();
    fireEvent.change(area, { target: { value: "/sch" } });
    area.setSelectionRange(4, 4);
    fireEvent.select(area);
    await screen.findByRole("listbox");
    fireEvent.keyDown(area, { key: "ArrowDown" });
    const options = screen.getAllByRole("option");
    expect(options[1]!.getAttribute("aria-selected")).toBe("true");
    fireEvent.keyDown(area, { key: "ArrowUp" });
    fireEvent.keyDown(area, { key: "Enter" });
    expect(area.value).toBe("/schedule ");
    expect(screen.queryByRole("listbox")).toBeNull();
  });

  test("a slash after a space offers skills only and Tab inserts /skill-name", async () => {
    const area = renderComposer();
    fireEvent.change(area, { target: { value: "run /or" } });
    area.setSelectionRange(7, 7);
    fireEvent.select(area);
    await waitFor(() => expect(screen.getAllByRole("option").every((o) => o.getAttribute("data-kind") === "skill")).toBe(true));
    fireEvent.keyDown(area, { key: "Tab" });
    expect(area.value).toBe("run /orch ");
  });

  test("Escape closes the menu and Enter then sends the message", async () => {
    let sent = "";
    const area = renderComposer(async (t) => {
      sent = t;
      return null;
    });
    fireEvent.change(area, { target: { value: "/loo" } });
    area.setSelectionRange(4, 4);
    fireEvent.select(area);
    await screen.findByRole("listbox");
    fireEvent.keyDown(area, { key: "Escape" });
    expect(screen.queryByRole("listbox")).toBeNull();
    fireEvent.keyDown(area, { key: "Enter" });
    await waitFor(() => expect(sent).toBe("/loo"));
  });

  test("clicking a row inserts it", async () => {
    const area = renderComposer();
    fireEvent.change(area, { target: { value: "/wat" } });
    area.setSelectionRange(4, 4);
    fireEvent.select(area);
    const row = (await screen.findAllByRole("option")).find((o) => o.textContent?.includes("/watch"))!;
    fireEvent.click(row);
    expect(area.value).toBe("/watch ");
  });
});

import { afterAll, afterEach, describe, expect, test } from "bun:test";
import { useState } from "react";
import { installDom } from "../test/dom";

const uninstall = installDom();
const { render, screen, fireEvent, cleanup } = await import("@testing-library/react");
const { useSessionState, clearSessionState } = await import("./session-state");

afterEach(cleanup);
afterAll(() => {
  cleanup();
  uninstall();
});

function Form({ onDone }: { onDone: () => void }) {
  const [text, setText] = useSessionState("draft", "");
  return (
    <div>
      <input aria-label="t" value={text} onChange={(e) => setText(e.target.value)} />
      <button
        onClick={() => {
          setText("");
          onDone();
        }}
      >
        create
      </button>
    </div>
  );
}

function Host() {
  const [open, setOpen] = useState(true);
  return open ? <Form onDone={() => setOpen(false)} /> : <button onClick={() => setOpen(true)}>reopen</button>;
}

describe("useSessionState", () => {
  test("a reset made in the same batch as an unmount is still stored", () => {
    clearSessionState();
    render(<Host />);
    fireEvent.change(screen.getByLabelText("t"), { target: { value: "old draft" } });
    fireEvent.click(screen.getByText("create"));
    fireEvent.click(screen.getByText("reopen"));
    expect((screen.getByLabelText("t") as HTMLInputElement).value).toBe("");
  });

  test("a value survives unmount and remount", () => {
    clearSessionState();
    const first = render(<Host />);
    fireEvent.change(screen.getByLabelText("t"), { target: { value: "kept" } });
    first.unmount();
    render(<Host />);
    expect((screen.getByLabelText("t") as HTMLInputElement).value).toBe("kept");
  });
});

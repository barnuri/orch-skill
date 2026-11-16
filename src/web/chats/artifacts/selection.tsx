import { type RefObject, useEffect, useState } from "react";

export interface SelectionInfo {
  quote: string;
  lines: [number, number] | null;
  x: number;
  y: number;
}

const lineOf = (node: Node | null): number | null => {
  const el = node instanceof Element ? node : (node?.parentElement ?? null);
  const raw = el?.closest("[data-line]")?.getAttribute("data-line");
  return raw === null || raw === undefined ? null : Number(raw);
};

/** The text selected inside `container` and, for a code view, the lines it spans; null when nothing is selected there. */
export function selectionInfo(container: HTMLElement): SelectionInfo | null {
  const sel = window.getSelection();
  if (sel === null || sel.rangeCount === 0 || sel.isCollapsed) {
    return null;
  }
  const range = sel.getRangeAt(0);
  if (!container.contains(range.commonAncestorContainer)) {
    return null;
  }
  const quote = sel.toString().trim();
  if (quote === "") {
    return null;
  }
  const a = lineOf(range.startContainer);
  const b = lineOf(range.endContainer);
  const rect = range.getBoundingClientRect();
  return { quote: quote.slice(0, 600), lines: a === null || b === null ? null : [Math.min(a, b), Math.max(a, b)], x: rect.left + rect.width / 2, y: rect.top };
}

/** A floating Comment button over the selection inside `containerRef`. */
export function SelectionComment({ containerRef, onComment }: { containerRef: RefObject<HTMLElement | null>; onComment: (info: SelectionInfo) => void }) {
  const [info, setInfo] = useState<SelectionInfo | null>(null);
  useEffect(() => {
    const check = (): void => {
      const el = containerRef.current;
      setInfo(el === null ? null : selectionInfo(el));
    };
    document.addEventListener("selectionchange", check);
    return () => {
      document.removeEventListener("selectionchange", check);
    };
  }, [containerRef]);
  if (info === null) {
    return null;
  }
  return (
    <button
      type="button"
      className="art-comment"
      data-testid="art-comment"
      style={{ left: Math.max(8, info.x - 40), top: Math.max(8, info.y - 44) }}
      onMouseDown={(e) => { e.preventDefault(); }}
      onClick={() => {
        onComment(info);
        window.getSelection()?.removeAllRanges();
        setInfo(null);
      }}
    >
      Comment
    </button>
  );
}

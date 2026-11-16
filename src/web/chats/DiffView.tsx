import { useEffect, useState } from "react";

interface Line { kind: "add" | "del" | "same"; text: string }

/** Adapter over the `diff` package (jsdiff), loaded on first use so it stays out of the main bundle. */
export default function DiffView({ path, before, after }: { path: string; before: string; after: string }) {
  const [lines, setLines] = useState<Line[] | null>(null);
  useEffect(() => {
    let live = true;
    void import("diff").then(({ diffLines }) => {
      if (!live) {
        return;
      }
      const out: Line[] = [];
      for (const ch of diffLines(before, after)) {
        const kind = ch.added === true ? "add" : ch.removed === true ? "del" : "same";
        for (const text of ch.value.replace(/\n$/, "").split("\n")) {
          out.push({ kind, text });
        }
      }
      setLines(out);
    });
    return () => {
      live = false;
    };
  }, [before, after]);
  const added = lines?.filter((l) => l.kind === "add").length ?? 0;
  const removed = lines?.filter((l) => l.kind === "del").length ?? 0;
  return (
    <div className="diff-view" data-testid="diff-view">
      <div className="diff-head mono"><span className="diff-path">{path}</span>{lines === null ? null : <span className="diff-count"><span className="diff-add-n">+{added}</span> <span className="diff-del-n">−{removed}</span></span>}</div>
      <pre className="diff-body mono">
        {(lines ?? [{ kind: "same" as const, text: after }]).map((l, i) => (
          <span key={i} className={`diff-line is-${l.kind}`}>
            <span className="diff-sign" aria-hidden="true">{l.kind === "add" ? "+" : l.kind === "del" ? "-" : " "}</span>
            {l.text}
            {"\n"}
          </span>
        ))}
      </pre>
    </div>
  );
}

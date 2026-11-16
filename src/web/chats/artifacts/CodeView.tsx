import { useEffect, useMemo, useState } from "react";

const MAX_HIGHLIGHT_LINES = 4000;

/** Source with line numbers and per-line highlighting. `changed` lines carry a quiet highlight that fades by itself. */
export default function CodeView({ text, lang, changed }: { text: string; lang: string; changed: ReadonlySet<number> }) {
  const lines = useMemo(() => text.replace(/\n$/, "").split("\n"), [text]);
  const [highlight, setHighlight] = useState<((code: string, lang: string) => string | null) | null>(null);
  useEffect(() => {
    let live = true;
    void import("../highlight").then((mod) => {
      if (live) {
        setHighlight(() => mod.highlightCode);
      }
    });
    return () => {
      live = false;
    };
  }, []);
  const html = useMemo(() => (highlight === null || lines.length > MAX_HIGHLIGHT_LINES ? null : lines.map((l) => highlight(l, lang))), [highlight, lines, lang]);
  return (
    <div className="art-code mono" data-testid="art-code">
      {lines.map((line, i) => (
        <div key={i} className={changed.has(i + 1) ? "art-line is-changed" : "art-line"} data-line={i + 1}>
          <span className="art-ln" aria-hidden="true">{i + 1}</span>
          {html?.[i] != null ? <span className="art-lc" dangerouslySetInnerHTML={{ __html: html[i] as string }} /> : <span className="art-lc">{line}</span>}
        </div>
      ))}
    </div>
  );
}

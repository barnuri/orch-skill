import { useEffect, useState } from "react";

let counter = 0;

/** Renders a Mermaid diagram to an SVG image. The library is loaded on first use; the result is shown as an image, so it cannot run script. */
export default function MermaidView({ text }: { text: string }) {
  const [url, setUrl] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  useEffect(() => {
    let live = true;
    let made: string | null = null;
    void (async () => {
      try {
        const mermaid = (await import("mermaid")).default;
        const dark = document.documentElement.getAttribute("data-theme") === "dark" || (document.documentElement.getAttribute("data-theme") === null && window.matchMedia("(prefers-color-scheme: dark)").matches);
        mermaid.initialize({ startOnLoad: false, securityLevel: "strict", theme: dark ? "dark" : "default", flowchart: { htmlLabels: false }, htmlLabels: false });
        const { svg } = await mermaid.render(`art-mmd-${++counter}`, text);
        if (live) {
          made = URL.createObjectURL(new Blob([svg], { type: "image/svg+xml" }));
          setUrl(made);
          setError(null);
        }
      } catch (err) {
        if (live) {
          setError(err instanceof Error ? err.message : "could not render the diagram");
        }
      }
    })();
    return () => {
      live = false;
      if (made !== null) {
        URL.revokeObjectURL(made);
      }
    };
  }, [text]);
  if (error !== null) {
    return <p className="art-note" role="status" data-testid="art-mermaid-error">Could not render this diagram: {error}. The Code view shows the source.</p>;
  }
  return url === null ? <p className="art-note">Rendering…</p> : <img className="art-img art-mermaid" data-testid="art-mermaid" src={url} alt="Mermaid diagram" />;
}

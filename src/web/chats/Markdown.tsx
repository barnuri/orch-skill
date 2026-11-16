import { useEffect, useState } from "react";
import type { ReactNode } from "react";
import { Streamdown } from "streamdown";

// Adapter: the only file that imports the streaming markdown library. Streamdown sanitizes and hardens raw HTML and links itself.

function textOf(node: ReactNode): string {
  if (typeof node === "string") {
    return node;
  }
  if (Array.isArray(node)) {
    return node.map(textOf).join("");
  }
  return "";
}

function CodeBlock({ lang, code }: { lang: string; code: string }) {
  const [html, setHtml] = useState<string | null>(null);
  const [copied, setCopied] = useState(false);
  useEffect(() => {
    let live = true;
    void import("./highlight").then((mod) => {
      if (live) {
        setHtml(mod.highlightCode(code, lang));
      }
    });
    return () => {
      live = false;
    };
  }, [code, lang]);
  return (
    <div className="code-block">
      <div className="code-head">
        <span className="code-lang">{lang === "" ? "text" : lang}</span>
        <button
          type="button"
          className="code-copy"
          onClick={() => {
            void navigator.clipboard.writeText(code).then(() => {
              setCopied(true);
              setTimeout(() => {
                setCopied(false);
              }, 1500);
            });
          }}
        >
          {copied ? "Copied" : "Copy"}
        </button>
      </div>
      <pre>
        {html === null ? <code>{code}</code> : <code className="hljs" dangerouslySetInnerHTML={{ __html: html }} />}
      </pre>
    </div>
  );
}

export default function Markdown({ text, live = false }: { text: string; live?: boolean }) {
  return (
    <div className={live ? "md is-live" : "md"}>
      <Streamdown
        mode={live ? "streaming" : "static"}
        isAnimating={live}
        dir="auto"
        controls={false}
        components={{
          a: ({ href, children }) => (
            <a href={href} target="_blank" rel="noopener noreferrer nofollow">
              {children}
            </a>
          ),
          pre: ({ children }) => <>{children}</>,
          input: ({ checked, type }) =>
            type === "checkbox" ? <input type="checkbox" className="task-box" checked={checked === true} readOnly disabled aria-label={checked === true ? "done" : "not done"} /> : null,
          code: ({ className, children }) => {
            const lang = /language-([\w+-]+)/.exec(className ?? "")?.[1] ?? "";
            const code = textOf(children);
            const block = lang !== "" || code.includes("\n");
            return block ? <CodeBlock lang={lang} code={code.replace(/\n$/, "")} /> : <code className="inline-code">{children}</code>;
          },
          table: ({ children }) => (
            <div className="md-table">
              <table>{children}</table>
            </div>
          ),
        }}
      >
        {text}
      </Streamdown>
    </div>
  );
}

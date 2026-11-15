import { useEffect, useState } from "react";
import type { ReactNode } from "react";
import ReactMarkdown from "react-markdown";
import rehypeSanitize from "rehype-sanitize";
import remarkGfm from "remark-gfm";

const REMARK = [remarkGfm];
// Raw HTML is never enabled in react-markdown; the sanitizer is a second wall for anything the parser lets through.
const REHYPE = [rehypeSanitize];

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
      <ReactMarkdown
        remarkPlugins={REMARK}
        rehypePlugins={REHYPE}
        components={{
          a: ({ href, children }) => (
            <a href={href} target="_blank" rel="noopener noreferrer nofollow">
              {children}
            </a>
          ),
          pre: ({ children }) => <>{children}</>,
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
      </ReactMarkdown>
    </div>
  );
}

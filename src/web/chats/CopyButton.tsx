import { useState } from "react";

/** Copies `text` to the clipboard; the label turns to "Copied" for a moment. */
export function CopyButton({ text, label = "Copy", className = "copy-btn" }: { text: string; label?: string; className?: string }) {
  const [copied, setCopied] = useState(false);
  return (
    <button
      type="button"
      className={className}
      aria-label={label}
      data-testid="copy-btn"
      onClick={() => {
        void navigator.clipboard.writeText(text).then(() => {
          setCopied(true);
          setTimeout(() => {
            setCopied(false);
          }, 1500);
        });
      }}
    >
      {copied ? "Copied" : label}
    </button>
  );
}

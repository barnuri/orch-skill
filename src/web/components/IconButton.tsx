import type { ButtonHTMLAttributes, ReactNode } from "react";

interface IconButtonProps extends Omit<ButtonHTMLAttributes<HTMLButtonElement>, "children"> {
  label: string;
  spinning?: boolean;
  children: ReactNode;
}

/** A 32px (44px on touch) square button that holds one icon; `label` is its accessible name and tooltip. */
export function IconButton({ label, spinning = false, className, children, ...rest }: IconButtonProps) {
  const klass = ["icon-btn", spinning ? "is-spinning" : "", className ?? ""].filter(Boolean).join(" ");
  return (
    <button type="button" className={klass} aria-label={label} title={label} aria-busy={spinning || undefined} {...rest}>
      {children}
    </button>
  );
}

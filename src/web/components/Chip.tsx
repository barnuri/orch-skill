import type { ReactNode } from "react";

interface ChipProps {
  status: string;
  children?: ReactNode;
  title?: string;
}

/** The status pill; `status` picks the colour class, the text defaults to the status itself. */
export function Chip({ status, children, title }: ChipProps) {
  return (
    <span className={`chip ${status}`} title={title}>
      {children ?? status}
    </span>
  );
}

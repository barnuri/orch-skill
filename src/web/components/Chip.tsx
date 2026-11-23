import type { ReactNode } from "react";
import { paletteClass } from "../../shared/status-palette";

interface ChipProps {
  status: string;
  children?: ReactNode;
  title?: string;
}

/** The status pill; `status` picks the colour class, the text defaults to the status itself. */
export function Chip({ status, children, title }: ChipProps) {
  const cls = `${status} ${paletteClass(status)}`.trim();
  return (
    <span className={`chip ${cls}`} title={title}>
      {children ?? (status === "covered" ? "Covered" : status)}
    </span>
  );
}

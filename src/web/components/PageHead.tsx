import type { ReactNode } from "react";

interface PageHeadProps {
  title: string;
  subtitle: string;
  toolbar?: ReactNode;
}

/** Consistent page title block: heading, subtitle, optional right-side toolbar. */
export function PageHead({ title, subtitle, toolbar }: PageHeadProps) {
  return (
    <div className="page-head">
      <div className="titles">
        <h1>{title}</h1>
        <p className="sub">{subtitle}</p>
      </div>
      {toolbar === undefined ? null : <div className="toolbar">{toolbar}</div>}
    </div>
  );
}

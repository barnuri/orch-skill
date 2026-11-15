export type KpiTone = "neutral" | "acc" | "ok" | "er" | "pu";

interface KpiTileProps {
  label: string;
  value: string;
  meta: string;
  tone?: KpiTone;
  /** Epoch seconds: the value then ticks down as a live countdown (see Countdown). */
  valueNode?: React.ReactNode;
}

/** A small label, one large mono number and exactly one meta line. */
export function KpiTile({ label, value, meta, tone = "neutral", valueNode }: KpiTileProps) {
  return (
    <div className={`kpi${tone === "neutral" ? "" : ` is-${tone}`}`}>
      <div className="kpi-label">{label}</div>
      <div className="kpi-value">{valueNode ?? value}</div>
      <div className="kpi-meta">{meta}</div>
    </div>
  );
}

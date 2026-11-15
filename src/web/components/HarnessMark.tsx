import { markFor, MARKS } from "../lib/harness-marks";

/** One glyph per harness, so the same harness always reads the same way on a card and a row. */
export function HarnessMark({ id, size = 16 }: { id: string; size?: number }) {
  const mark = markFor(id);
  const known = MARKS[id] !== undefined;
  return (
    <svg
      className="harness-mark-icon"
      width={size}
      height={size}
      viewBox={`0 0 ${mark.box} ${mark.box}`}
      role="img"
      aria-label={`${id} harness`}
    >
      <g className={`harness-mark ${mark.filled ? "is-filled" : "is-stroked"} ${known ? `mark-${id}` : "mark-unknown"}`}>
        {mark.paths.map((d) => (
          <path key={d} d={d} />
        ))}
        {(mark.rects ?? []).map((rect) => (
          <rect key={`${rect.x}-${rect.y}`} x={rect.x} y={rect.y} width={rect.width} height={rect.height} rx={rect.rx} />
        ))}
        {(mark.circles ?? []).map((circle) => (
          <circle key={`${circle.cx}-${circle.cy}`} cx={circle.cx} cy={circle.cy} r={circle.r} />
        ))}
      </g>
    </svg>
  );
}

// Plain-text meaning of a 5-field cron expression. The grammar and the day rules follow
// skills/orch/core/commands/schedules.ts: fields `*`, `n`, `a-b`, `*/s`,
// `n/s`, `a-b/s` and comma lists; day of week 0 and 7 are Sunday; when neither day field is `*`,
// a day matches when either field matches. The `@daily` style aliases are not supported here.

export type CronText = { ok: true; text: string } | { ok: false; error: string };

const RANGES: readonly (readonly [number, number])[] = [
  [0, 59],
  [0, 23],
  [1, 31],
  [1, 12],
  [0, 7],
];
const DAYS_IN_MONTH = [31, 29, 31, 30, 31, 30, 31, 31, 30, 31, 30, 31];
const DAY_NAMES = ["Sunday", "Monday", "Tuesday", "Wednesday", "Thursday", "Friday", "Saturday"];
const MONTH_NAMES = ["January", "February", "March", "April", "May", "June", "July", "August", "September", "October", "November", "December"];
const PART = /^(\*|\d+|\d+-\d+)(\/\d+)?$/;
const STAR = /^\*(\/1)?$/;

/** The set of values a field matches, or null when the field is invalid. Day of week 7 becomes 0. */
function expand(field: string, index: number): Set<number> | null {
  const [min, max] = RANGES[index] as readonly [number, number];
  const out = new Set<number>();
  for (const part of field.split(",")) {
    const match = PART.exec(part);
    if (match === null) {
      return null;
    }
    const body = match[1] as string;
    const step = match[2] === undefined ? 1 : Number(match[2].slice(1));
    if (step < 1) {
      return null;
    }
    let lo: number;
    let hi: number;
    if (body === "*") {
      lo = min;
      hi = max;
    } else if (body.includes("-")) {
      const [a, b] = body.split("-").map(Number) as [number, number];
      lo = a;
      hi = b;
    } else {
      lo = Number(body);
      hi = match[2] === undefined ? lo : max;
    }
    if (lo < min || hi > max || lo > hi) {
      return null;
    }
    for (let v = lo; v <= hi; v += step) {
      out.add(index === 4 && v === 7 ? 0 : v);
    }
  }
  return out;
}

function joinList(items: string[]): string {
  if (items.length <= 1) {
    return items[0] ?? "";
  }
  return `${items.slice(0, -1).join(", ")} and ${items[items.length - 1]}`;
}

/** Sorted values as text: runs of three or more become "a through b", the rest are listed. */
function describeValues(values: number[], label: (n: number) => string): string {
  const groups: string[] = [];
  let i = 0;
  while (i < values.length) {
    let j = i;
    while (j + 1 < values.length && values[j + 1] === (values[j] as number) + 1) {
      j++;
    }
    if (j - i >= 2) {
      groups.push(`${label(values[i] as number)} through ${label(values[j] as number)}`);
    } else {
      for (let k = i; k <= j; k++) {
        groups.push(label(values[k] as number));
      }
    }
    i = j + 1;
  }
  return joinList(groups);
}

/** The step s when the values are exactly 0, s, 2s, ... below `max`, with at least two values. */
function stepOf(values: number[], max: number): number | null {
  if (values.length < 2 || values[0] !== 0) {
    return null;
  }
  const step = (values[1] as number) - 0;
  for (let v = 0, k = 0; v < max; v += step, k++) {
    if (values[k] !== v) {
      return null;
    }
  }
  return values.length === Math.ceil(max / step) ? step : null;
}

const pad = (n: number): string => String(n).padStart(2, "0");

function describeTime(minutes: number[], hours: number[]): string {
  const everyMinute = minutes.length === 60;
  const everyHour = hours.length === 24;
  if (minutes.length === 1 && hours.length === 1) {
    return `At ${pad(hours[0] as number)}:${pad(minutes[0] as number)}`;
  }
  if (everyMinute && everyHour) {
    return "Every minute";
  }
  if (everyHour) {
    const step = stepOf(minutes, 60);
    if (step !== null) {
      return `Every ${step} minutes`;
    }
    if (minutes.length === 1) {
      return `At minute ${minutes[0]} of every hour`;
    }
    return `At minutes ${describeValues(minutes, String)} of every hour`;
  }
  if (everyMinute && hours.length === 1) {
    return `Every minute, between ${pad(hours[0] as number)}:00 and ${pad(hours[0] as number)}:59`;
  }
  return `At ${minutes.length === 1 ? `minute ${minutes[0]}` : `minutes ${describeValues(minutes, String)}`} of hours ${describeValues(hours, String)}`;
}

function describeDays(dom: string, dow: string, domValues: number[], dowValues: number[]): string | null {
  const domStar = STAR.test(dom);
  const dowStar = STAR.test(dow);
  const domText = domValues.length === 31 && domStar ? null : `on ${domValues.length === 1 ? "day" : "days"} ${describeValues(domValues, String)}`;
  const dowText = dowValues.length === 7 && dowStar ? null : describeValues(dowValues, (n) => DAY_NAMES[n] as string);
  if (domStar || dowStar) {
    return domStar ? dowText : domText;
  }
  return `${domText} or ${dowText}`;
}

/** Plain-text meaning of a cron expression; null for an empty input, `ok: false` when invalid. */
export function describeCron(expr: string): CronText | null {
  const trimmed = expr.trim();
  if (trimmed === "") {
    return null;
  }
  const fields = trimmed.split(/\s+/);
  if (fields.length !== 5) {
    return { ok: false, error: "expected 5 fields: minute hour day month weekday" };
  }
  const sets = fields.map((field, index) => expand(field, index));
  if (sets.some((set) => set === null)) {
    return { ok: false, error: "a field is out of range or malformed" };
  }
  const [minutes, hours, dom, months, dow] = sets as Set<number>[];
  const minuteValues = [...(minutes as Set<number>)].sort((a, b) => a - b);
  const hourValues = [...(hours as Set<number>)].sort((a, b) => a - b);
  const domValues = [...(dom as Set<number>)].sort((a, b) => a - b);
  const monthValues = [...(months as Set<number>)].sort((a, b) => a - b);
  const dowValues = [...(dow as Set<number>)].sort((a, b) => a - b);

  const domStar = STAR.test(fields[2] as string);
  const dowStar = STAR.test(fields[4] as string);
  if (domStar || dowStar) {
    // Both day fields must match: a day that never exists (for example 31 February) never runs.
    const reachable = domValues.some((d) => monthValues.some((m) => d <= (DAYS_IN_MONTH[m - 1] as number)));
    if (!reachable) {
      return { ok: false, error: "never matches: no day in the chosen months" };
    }
  }

  const parts = [describeTime(minuteValues, hourValues)];
  const days = describeDays(fields[2] as string, fields[4] as string, domValues, dowValues);
  if (days !== null) {
    parts.push(days);
  }
  if (monthValues.length < 12) {
    parts.push(`in ${describeValues(monthValues, (n) => MONTH_NAMES[n - 1] as string)}`);
  }
  return { ok: true, text: parts.join(", ") };
}

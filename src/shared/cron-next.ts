/** Cron evaluation shared by the CLI, the server and the web. Five fields or an @alias, in local time or in an IANA zone. */

const ALIAS: Record<string, string> = { "@hourly": "0 * * * *", "@daily": "0 0 * * *", "@weekly": "0 0 * * 0", "@monthly": "0 0 1 * *" };
const RANGE: Array<[number, number]> = [[0, 59], [0, 23], [1, 31], [1, 12], [0, 7]];
const NEXT_DAYS = 366;

export interface ParsedCron { set: Array<Set<number>>; star: boolean[] }

export function parseCron(exprIn: string): ParsedCron | null {
  const expr = ALIAS[exprIn] ?? exprIn;
  const f = expr.split(/\s+/).filter((x) => x !== "");
  if (f.length !== 5) return null;
  const set: Array<Set<number>> = [];
  const star: boolean[] = [];
  for (let i = 0; i < 5; i++) {
    const [min, max] = RANGE[i]!;
    const ok = new Set<number>();
    star[i] = /^\*(\/1)?$/.test(f[i]!);
    for (const part of f[i]!.split(",")) {
      const slash = part.indexOf("/");
      const r = slash < 0 ? part : part.slice(0, slash);
      const sraw = slash < 0 ? undefined : part.slice(slash + 1);
      const s = sraw === undefined ? 1 : /^\d+$/.test(sraw) ? Number(sraw) : NaN;
      if (!Number.isFinite(s) || s < 1) return null;
      let lo: number, hi: number;
      let m: RegExpExecArray | null;
      if (r === "*") [lo, hi] = [min, max];
      else if ((m = /^(\d+)-(\d+)$/.exec(r))) [lo, hi] = [Number(m[1]), Number(m[2])];
      else if (/^\d+$/.test(r)) [lo, hi] = [Number(r), sraw !== undefined ? max : Number(r)];
      else return null;
      if (lo < min || hi > max || lo > hi) return null;
      for (let v = lo; v <= hi; v += s) ok.add(i === 4 && v === 7 ? 0 : v);
    }
    set[i] = ok;
  }
  return { set, star };
}

export const machineZone = (): string => Intl.DateTimeFormat().resolvedOptions().timeZone;

export function validZone(tz: string): boolean {
  try {
    new Intl.DateTimeFormat("en-US", { timeZone: tz });
    return true;
  } catch {
    return false;
  }
}

interface Fields { minute: number; hour: number; day: number; month: number; dow: number }

const WEEK: Record<string, number> = { Sun: 0, Mon: 1, Tue: 2, Wed: 3, Thu: 4, Fri: 5, Sat: 6 };
const formatters = new Map<string, Intl.DateTimeFormat>();

function zoned(ms: number, tz: string): Fields {
  let fmt = formatters.get(tz);
  if (fmt === undefined) {
    fmt = new Intl.DateTimeFormat("en-US", { timeZone: tz, hourCycle: "h23", year: "numeric", month: "numeric", day: "numeric", hour: "numeric", minute: "numeric", weekday: "short" });
    formatters.set(tz, fmt);
  }
  const o: Record<string, string> = {};
  for (const p of fmt.formatToParts(new Date(ms))) o[p.type] = p.value;
  return { minute: Number(o.minute), hour: Number(o.hour) % 24, day: Number(o.day), month: Number(o.month), dow: WEEK[o.weekday!] ?? 0 };
}

function local(ms: number): Fields {
  const d = new Date(ms);
  return { minute: d.getMinutes(), hour: d.getHours(), day: d.getDate(), month: d.getMonth() + 1, dow: d.getDay() };
}

/**
 * First matching minute after `from` (epoch seconds) in zone `tz` (the machine's zone when omitted), or null for a
 * bad or never-matching expression. A wall-clock time that does not exist on a spring-forward day is skipped;
 * one that happens twice on a fall-back day fires once, at its first occurrence.
 */
export function cronNextIn(exprIn: string, from: number, tz?: string, days = NEXT_DAYS): number | null {
  const p = parseCron(exprIn);
  if (p === null) return null;
  const { set, star } = p;
  const fields = tz === undefined ? local : (ms: number) => zoned(ms, tz);
  let t = (from - (from % 60) + 60) * 1000;
  const end = t + days * 86400_000;
  while (t < end) {
    const f = fields(t);
    const dayOk = star[2] || star[4] ? set[2]!.has(f.day) && set[4]!.has(f.dow) : set[2]!.has(f.day) || set[4]!.has(f.dow);
    if (!dayOk || !set[3]!.has(f.month)) {
      // Jump toward the next local midnight, short by an hour so a 23 h day cannot skip its first hour.
      t += Math.max(1, 1440 - f.hour * 60 - f.minute - 60) * 60_000;
      continue;
    }
    if (!set[1]!.has(f.hour)) {
      t += Math.max(1, 60 - f.minute) * 60_000;
      continue;
    }
    if (set[0]!.has(f.minute)) {
      const hourAgo = fields(t - 3600_000);
      const repeated = hourAgo.hour === f.hour && hourAgo.minute === f.minute && hourAgo.day === f.day;
      if (!repeated) return Math.floor(t / 1000);
    }
    t += 60_000;
  }
  return null;
}

/** The next `n` runs after `from`. */
export function nextRuns(expr: string, from: number, n: number, tz?: string): number[] {
  const out: number[] = [];
  let at = from;
  for (let i = 0; i < n; i++) {
    const next = cronNextIn(expr, at, tz);
    if (next === null) break;
    out.push(next);
    at = next;
  }
  return out;
}

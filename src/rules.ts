// What a block's rules mean for the hours someone needs. Schedules come from the pipeline as
// week-minute intervals (0 = Monday 00:00, Pittsburgh wall-clock time); a window is two instants.
// Everything here is pure so it can be tested and run over every schedule on each change.

export const TZ = "America/New_York";
const WEEK = 7 * 1440;
export const MAX_WINDOW_MIN = 7 * 1440;

export type Meter = {
  kind: "meter";
  pay: [number, number, number | null][]; // [start, end, cents per hour or null when unknown]
  max: number | null; // minutes
  no: [number, number][]; // no parking at all, e.g. rush hour
  dynamic: boolean;
  assumed: boolean;
};
export type Permit = { kind: "permit"; lim: [number, number][]; grace: number; assumed: boolean };
export type Schedule = Meter | Permit;

export type Status = "free" | "paid" | "limit" | "no" | "unknown";
export type Verdict = {
  status: Status;
  cents: number | null; // what the window costs, when it costs and the rate is known
  note: string;
  until?: number; // epoch ms: when the car has to move (limit) or when paying starts
};

export type Window = { from: number; to: number };

// --- time ------------------------------------------------------------------------------------

const parts = new Intl.DateTimeFormat("en-US", {
  timeZone: TZ,
  hourCycle: "h23",
  weekday: "short",
  year: "numeric",
  month: "2-digit",
  day: "2-digit",
  hour: "2-digit",
  minute: "2-digit",
});
const WEEKDAY: Record<string, number> = { Mon: 0, Tue: 1, Wed: 2, Thu: 3, Fri: 4, Sat: 5, Sun: 6 };

function wall(t: number) {
  const p: Record<string, string> = {};
  for (const { type, value } of parts.formatToParts(t)) p[type] = value;
  return { y: +p.year, mo: +p.month, d: +p.day, h: +p.hour, mi: +p.minute, wd: WEEKDAY[p.weekday] };
}

/** Pittsburgh's UTC offset at an instant, in minutes (-240 in summer, -300 in winter). */
export function offset(t: number): number {
  const w = wall(t);
  return Math.round((Date.UTC(w.y, w.mo - 1, w.d, w.h, w.mi) - Math.floor(t / 60000) * 60000) / 60000);
}

/** Week minute (Pittsburgh time) of an instant. */
export function weekMinute(t: number): number {
  const w = wall(t);
  return w.wd * 1440 + w.h * 60 + w.mi;
}

/** '2026-10-21T14:00' read as Pittsburgh time -> epoch ms. */
export function fromLocal(s: string): number {
  const [d, tm] = s.split("T");
  const [y, mo, da] = d.split("-").map(Number);
  const [h, mi] = (tm || "0:0").split(":").map(Number);
  const guess = Date.UTC(y, mo - 1, da, h, mi);
  // Two passes settle the offset on either side of a DST change.
  let t = guess - offset(guess) * 60000;
  t = guess - offset(t) * 60000;
  return t;
}

/** Epoch ms -> '2026-10-21T14:00' in Pittsburgh time, for datetime-local inputs. */
export function toLocal(t: number): string {
  const w = wall(t);
  const p = (n: number) => String(n).padStart(2, "0");
  return `${w.y}-${p(w.mo)}-${p(w.d)}T${p(w.h)}:${p(w.mi)}`;
}

/** Week minute for each minute of the window, so DST changes inside it are honored. */
function minutes(win: Window): Int16Array {
  const n = Math.max(0, Math.min(MAX_WINDOW_MIN, Math.round((win.to - win.from) / 60000)));
  const out = new Int16Array(n);
  let hourStart = -1;
  let base = 0;
  for (let i = 0; i < n; i++) {
    const t = win.from + i * 60000;
    // One timezone lookup per hour; the minutes in between just count up.
    if (hourStart < 0 || i - hourStart >= 60) {
      hourStart = i;
      base = weekMinute(t);
    }
    out[i] = (base + (i - hourStart)) % WEEK;
  }
  return out;
}

// --- evaluation --------------------------------------------------------------------------------

type Mask = { rate: Int32Array }; // per week minute: -2 none, -1 enforced at unknown rate, >= 0 cents/hr

function weekMask(intervals: [number, number, (number | null)?][]): Int32Array {
  const m = new Int32Array(WEEK).fill(-2);
  for (const [s, e, r] of intervals) {
    for (let x = s; x < e; x++) m[x % WEEK] = r == null ? -1 : r;
  }
  return m;
}

const masks = new WeakMap<Schedule, { pay: Int32Array; no: Int32Array }>();
function maskFor(s: Schedule) {
  let m = masks.get(s);
  if (!m) {
    m = s.kind === "meter" ? { pay: weekMask(s.pay), no: weekMask(s.no) } : { pay: weekMask(s.lim.map(([a, b]) => [a, b, 0])), no: weekMask([]) };
    masks.set(s, m);
  }
  return m;
}

/** Runs of consecutive enforced minutes within the window: [startIndex, length]. */
function runs(mins: Int16Array, enforced: Int32Array): [number, number][] {
  const out: [number, number][] = [];
  let start = -1;
  for (let i = 0; i <= mins.length; i++) {
    const on = i < mins.length && enforced[mins[i]] !== -2;
    if (on && start < 0) start = i;
    if (!on && start >= 0) {
      out.push([start, i - start]);
      start = -1;
    }
  }
  return out;
}

const hrs = (min: number) => (min % 60 ? `${(min / 60).toFixed(1).replace(/\.0$/, "")} hr` : `${min / 60} hr`);

export function evaluate(s: Schedule, win: Window, mins = minutes(win)): Verdict {
  const { pay, no } = maskFor(s);
  if (!mins.length) return { status: "unknown", cents: null, note: "Pick a time window" };

  const blocked = mins.findIndex((m) => no[m] !== -2);
  if (blocked >= 0) {
    return { status: "no", cents: null, note: `No parking from ${clock(win.from + blocked * 60000)}`, until: win.from + blocked * 60000 };
  }

  const stretches = runs(mins, pay);
  if (s.kind === "permit") {
    const longest = stretches.reduce((a, [, n]) => Math.max(a, n), 0);
    const tail = s.assumed ? " (posted hours unknown; check the sign)" : "";
    if (!stretches.length) return { status: "free", cents: 0, note: `Permit zone, not enforced then${tail}` };
    if (longest <= s.grace) return { status: "free", cents: 0, note: `Permit zone, within the ${hrs(s.grace)} visitor limit${tail}` };
    const over = stretches.find(([, n]) => n > s.grace)!;
    const until = win.from + (over[0] + s.grace) * 60000;
    return { status: "limit", cents: null, note: `Permit zone: ${hrs(s.grace)} limit without a permit; move by ${clock(until)}${tail}`, until };
  }

  if (!stretches.length) return { status: "free", cents: 0, note: "Meter's off then" };
  if (s.max != null) {
    const over = stretches.find(([, n]) => n > s.max!);
    if (over) {
      const until = win.from + (over[0] + s.max) * 60000;
      return { status: "limit", cents: null, note: `${hrs(s.max)} max at the meter; move by ${clock(until)}`, until };
    }
  }
  let cents = 0;
  let known = true;
  let paid = 0;
  for (const m of mins) {
    const r = pay[m];
    if (r === -2) continue;
    paid++;
    if (r < 0) known = false;
    else cents += r / 60;
  }
  const first = win.from + stretches[0][0] * 60000;
  const starts = stretches[0][0] > 0 ? ` from ${clock(first)}` : "";
  const rateText = s.dynamic ? "Demand-priced meter; see the meter" : known ? `${rateLabel(s)}${starts}` : `Metered${starts}; rate not listed`;
  const assumed = s.assumed ? " (hours assumed)" : "";
  return {
    status: "paid",
    cents: known && !s.dynamic ? Math.round(cents) : null,
    note: `${rateText} · ${hrs(paid)} paid${assumed}`,
    until: first,
  };
}

function rateLabel(s: Meter): string {
  const rates = [...new Set(s.pay.map(([, , r]) => r).filter((r): r is number => r != null))].sort((a, b) => a - b);
  return rates.map((r) => `${money(r)}/hr`).join("–");
}

/** Every schedule's verdict for one window; the map and the list both read from this. */
export function evaluateAll(schedules: Schedule[], win: Window): Verdict[] {
  const mins = minutes(win);
  return schedules.map((s) => evaluate(s, win, mins));
}

// --- text ------------------------------------------------------------------------------------

export function money(cents: number): string {
  return cents % 100 ? `$${(cents / 100).toFixed(2)}` : `$${cents / 100}`;
}

const clockFmt = new Intl.DateTimeFormat("en-US", { timeZone: TZ, hour: "numeric", minute: "2-digit" });
const dayFmt = new Intl.DateTimeFormat("en-US", { timeZone: TZ, weekday: "short" });

/** '4:00 PM', with the weekday when it isn't today. */
export function clock(t: number, now = Date.now()): string {
  const same = toLocal(t).slice(0, 10) === toLocal(now).slice(0, 10);
  return same ? clockFmt.format(t) : `${dayFmt.format(t)} ${clockFmt.format(t)}`;
}

const DAY_NAMES = ["Mon", "Tue", "Wed", "Thu", "Fri", "Sat", "Sun"];
const hm = (m: number) => {
  m %= 1440;
  const h = Math.floor(m / 60);
  const mi = m % 60;
  const h12 = h % 12 || 12;
  return `${h12}${mi ? `:${String(mi).padStart(2, "0")}` : ""}${h < 12 ? "a" : "p"}`;
};

/** 'Mon–Sat 8a–6p', grouping days that share hours. */
export function hoursText(intervals: [number, number, ...unknown[]][]): string {
  const byHours = new Map<string, number[]>();
  for (const [s, e] of intervals) {
    const key = `${hm(s)}–${hm(e)}`;
    byHours.set(key, [...(byHours.get(key) ?? []), Math.floor(s / 1440)]);
  }
  return [...byHours]
    .map(([h, ds]) => {
      ds.sort((a, b) => a - b);
      const groups: string[] = [];
      for (let i = 0; i < ds.length; ) {
        let j = i;
        while (j + 1 < ds.length && ds[j + 1] === ds[j] + 1) j++;
        groups.push(j > i ? `${DAY_NAMES[ds[i]]}–${DAY_NAMES[ds[j]]}` : DAY_NAMES[ds[i]]);
        i = j + 1;
      }
      return `${groups.join(", ")} ${h}`;
    })
    .join(" · ");
}

/** The standing rules, independent of any window: 'Mon–Sat 8a–6p · $3/hr · 2 hr max'. */
export function describe(s: Schedule): string {
  if (s.kind === "permit") {
    return `Permit ${hoursText(s.lim)} · ${hrs(s.grace)} without a permit${s.assumed ? " (assumed)" : ""}`;
  }
  const bits = [hoursText(s.pay)];
  bits.push(s.dynamic ? "demand-priced" : rateLabel(s) || "rate not listed");
  if (s.max) bits.push(`${hrs(s.max)} max`);
  if (s.no.length) bits.push(`no parking ${hoursText(s.no)}`);
  return bits.join(" · ");
}

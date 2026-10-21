// The built data (pipeline/build.py), and what a window and a pin make of it.
import { evaluateAll, Schedule, Status, Verdict, Window } from "./rules";

export const BASE = import.meta.env.BASE_URL + "data/";

export type Kind = "f" | "m" | "p" | "u" | "x";
export type BlockProps = { k: Kind; n: string; w: number[]; s?: number; z?: string; e?: [string, string] };
export type LotProps = { k: "ppa" | "garage" | "lot"; n: string; w: number[]; s?: number; f?: string; h?: string; o?: string; c?: string; cu?: 1 };
type Line = GeoJSON.Feature<GeoJSON.LineString, BlockProps>;
type Pt = GeoJSON.Feature<GeoJSON.Point, LotProps>;

export type Data = {
  blocks: { type: "FeatureCollection"; schedules: Schedule[]; features: Line[] };
  lots: { type: "FeatureCollection"; features: Pt[] };
  zones: GeoJSON.FeatureCollection<GeoJSON.MultiPolygon, { z: string; a: string; s: number }>;
  meta: { built: string; sources: { name: string; url: string; asOf: string }[] };
};

export async function load(): Promise<Data> {
  const get = (name: string) =>
    fetch(BASE + name).then((r) => {
      if (!r.ok) throw new Error(`Couldn't load ${name} (${r.status})`);
      return r.json();
    });
  const [blocks, lots, zones, meta] = await Promise.all([get("parking.json"), get("lots.json"), get("zones.json"), get("meta.json")]);
  // Ids let the map highlight a block by index.
  blocks.features.forEach((f: Line, i: number) => (f.id = i));
  lots.features.forEach((f: Pt, i: number) => (f.id = i));
  return { blocks, lots, zones, meta };
}

const FIXED: Record<"f" | "u" | "x", Verdict> = {
  f: { status: "free", cents: 0, note: "No meter or permit zone on record" },
  u: { status: "unknown", cents: null, note: "Main road with no parking data; check the signs" },
  x: { status: "no", cents: null, note: "No parking, per OpenStreetMap" },
};

export function blockVerdict(p: BlockProps, verdicts: Verdict[]): Verdict {
  if (p.k === "m" || p.k === "p") return verdicts[p.s!];
  return FIXED[p.k];
}

export function lotVerdict(p: LotProps, verdicts: Verdict[]): Verdict {
  if (p.k === "ppa") {
    const v = verdicts[p.s!];
    return v.status === "free" ? { ...v, note: "Parking Authority lot, free then" } : { ...v, note: `Parking Authority lot · ${v.note}` };
  }
  const what = p.k === "garage" ? "Garage" : "Lot";
  const who = p.cu ? ", customers only" : "";
  if (p.f === "no") return { status: p.cu ? "unknown" : "free", cents: 0, note: `Free ${what.toLowerCase()}${who}` };
  if (p.f === "yes") return { status: "paid", cents: null, note: `Paid ${what.toLowerCase()}${p.c ? ` · ${p.c}` : ""}; rate not listed${who}` };
  return { status: "unknown", cents: null, note: `${what}; fees unknown${who}` };
}

export function verdictsFor(data: Data, win: Window): Verdict[] {
  return evaluateAll(data.blocks.schedules, win);
}

export type Option = {
  kind: "block" | "lot";
  id: number;
  name: string;
  between: string;
  seconds: number;
  node: number;
  verdict: Verdict;
  schedule?: Schedule;
  lot?: LotProps;
  zone?: string;
};

export type Results = { free: Option[]; paid: Option[]; misfit: Option[]; unknown: number };

const FREE_MAX = 8;
const PAID_MAX = 6;
const MISFIT_MAX = 8;

/** The nearest options by walk time, nearest block per street so one long street can't fill the list. */
export function rank(data: Data, verdicts: Verdict[], time: Float32Array, cutoff = 1500): Results {
  const best = (w: number[]) => {
    let t = Infinity;
    let node = -1;
    for (const n of w) {
      if (time[n] < t) {
        t = time[n];
        node = n;
      }
    }
    return [t, node] as const;
  };
  const all: Option[] = [];
  data.blocks.features.forEach((f, id) => {
    const p = f.properties;
    const [seconds, node] = best(p.w);
    if (!(seconds <= cutoff)) return;
    const [a, b] = p.e ?? ["", ""];
    const name = p.n || (a || b ? `Alley off ${a || b}` : "Unnamed street");
    const between = p.n && a && b ? `${a} to ${b}` : p.n && (a || b) ? `at ${a || b}` : "";
    all.push({
      kind: "block", id, name, between, seconds, node,
      verdict: blockVerdict(p, verdicts),
      schedule: p.s != null ? data.blocks.schedules[p.s] : undefined,
      zone: p.z,
    });
  });
  data.lots.features.forEach((f, id) => {
    const p = f.properties;
    const [seconds, node] = best(p.w);
    if (!(seconds <= cutoff)) return;
    all.push({
      kind: "lot", id, name: p.n, between: p.o ?? "", seconds, node,
      verdict: lotVerdict(p, verdicts),
      schedule: p.s != null ? data.blocks.schedules[p.s] : undefined,
      lot: p,
    });
  });
  all.sort((x, y) => x.seconds - y.seconds);

  const pick = (want: (s: Status) => boolean, max: number) => {
    const seen = new Set<string>();
    const out: Option[] = [];
    for (const o of all) {
      if (!want(o.verdict.status)) continue;
      const key = `${o.kind}:${o.name}:${o.verdict.status}`;
      if (seen.has(key)) continue;
      seen.add(key);
      out.push(o);
      if (out.length >= max) break;
    }
    return out;
  };
  return {
    free: pick((s) => s === "free", FREE_MAX),
    paid: pick((s) => s === "paid", PAID_MAX),
    misfit: pick((s) => s === "limit" || s === "no", MISFIT_MAX),
    unknown: all.filter((o) => o.verdict.status === "unknown" && o.kind === "block").length,
  };
}

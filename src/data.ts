// The built data (pipeline/build.py), and what a window and a pin make of it.
import { evaluateAll, Schedule, Status, Verdict, Who, Window } from "./rules";

export const BASE = import.meta.env.BASE_URL + "data/";

export type Kind = "f" | "m" | "p" | "u" | "x";
// c: one of the CMU campus meter streets (sources in meta.campus)
export type BlockProps = { k: Kind; n: string; w: number[]; s?: number; z?: string; e?: [string, string]; c?: 1 };
// cmu: a CMU facility, hand-checked: g garage, src source keys, m campus-map id, sp spaces, a address, nt note, po permit-only
export type LotProps = {
  k: "ppa" | "garage" | "lot" | "cmu"; n: string; w: number[]; s?: number; f?: string; h?: string; o?: string; c?: string; cu?: 1;
  g?: boolean; src?: string[]; m?: number; sp?: number; a?: string; nt?: string; po?: 1;
};
export type Source = { name: string; url: string; checked?: string; asOf?: string };
export type Campus = { checked: string; sources: Record<string, Source>; mapLink: string; streetNote: string; streetSources: string[]; overnight: string };
type Line = GeoJSON.Feature<GeoJSON.LineString, BlockProps>;
type Pt = GeoJSON.Feature<GeoJSON.Point, LotProps>;

export type Data = {
  blocks: { type: "FeatureCollection"; schedules: Schedule[]; features: Line[] };
  lots: { type: "FeatureCollection"; features: Pt[] };
  zones: GeoJSON.FeatureCollection<GeoJSON.MultiPolygon, { z: string; a: string; s: number }>;
  meta: { built: string; sources: Source[]; campus: Campus };
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
  if (p.k === "cmu") return verdicts[p.s!];
  if (p.k === "ppa") {
    const v = verdicts[p.s!];
    return v.status === "free" ? { ...v, note: "Parking Authority lot, free then" } : { ...v, note: `Parking Authority lot · ${v.note}` };
  }
  const what = p.k === "garage" ? "Garage" : "Lot";
  const who = p.cu ? ", customers only" : "";
  // Garages tagged free in OSM are usually campus or hospital decks with fees the tag missed.
  if (p.f === "no" && p.k === "garage") return { status: "unknown", cents: null, note: `Garage tagged free in OpenStreetMap; check before you rely on it${who}` };
  if (p.f === "no") return { status: p.cu ? "unknown" : "free", cents: 0, note: `Free lot per OpenStreetMap${who}` };
  if (p.f === "yes") return { status: "paid", cents: null, note: `Paid ${what.toLowerCase()}${p.c ? ` · ${p.c}` : ""}; rate not listed${who}` };
  return { status: "unknown", cents: null, note: `${what}; fees unknown${who}` };
}

export function verdictsFor(data: Data, win: Window, who: Who): Verdict[] {
  return evaluateAll(data.blocks.schedules, win, who);
}

/** Where a block or lot's rules come from, for the "check it yourself" links. Only campus places
 *  have their own; everything else cites the footer's citywide sources. */
export function sourcesFor(data: Data, o: { lot?: LotProps; campus?: boolean }): Source[] {
  const c = data.meta.campus;
  if (o.lot?.k === "cmu") {
    const own = (o.lot.src ?? []).map((k) => c.sources[k]).filter(Boolean);
    return o.lot.m ? [{ name: `${o.lot.n} on CMU's campus map`, url: c.mapLink.replace("{}", String(o.lot.m)), checked: c.checked }, ...own.filter((s) => s.url !== c.sources.map?.url)] : own;
  }
  if (o.campus) return c.streetSources.map((k) => c.sources[k]).filter(Boolean);
  return [];
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
  campus?: boolean; // a CMU campus meter street
  note?: string; // standing notes from the source, e.g. how to pay
};

export type Results = { free: Option[]; paid: Option[]; misfit: Option[]; unknown: number };

const FREE_MAX = 8;
const PAID_MAX = 6;
const MISFIT_MAX = 8;

/** The nearest options by walk time, nearest block per street so one long street can't fill the list. */
export function rank(data: Data, verdicts: Verdict[], time: Float32Array, show: Set<Status>, cutoff = 1500): Results {
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
    // Unnamed blocks are mostly alleys, where parking is rarely legal; they stay on the map, off the list.
    if (!p.n) return;
    const name = p.n;
    const between = a && b ? `${a} to ${b}` : a || b ? `at ${a || b}` : "";
    all.push({
      kind: "block", id, name, between, seconds, node,
      verdict: blockVerdict(p, verdicts),
      schedule: p.s != null ? data.blocks.schedules[p.s] : undefined,
      zone: p.z,
      campus: !!p.c,
      note: p.c ? data.meta.campus.streetNote : undefined,
    });
  });
  data.lots.features.forEach((f, id) => {
    const p = f.properties;
    const [seconds, node] = best(p.w);
    // Permit-only lots stay on the map but would only crowd the list.
    if (!(seconds <= cutoff) || p.po) return;
    all.push({
      kind: "lot", id, name: p.n, between: p.k === "cmu" ? (p.sp ? `CMU · ${p.sp} spaces` : "CMU") : p.o ?? "", seconds, node, note: p.nt,
      verdict: lotVerdict(p, verdicts),
      schedule: p.s != null ? data.blocks.schedules[p.s] : undefined,
      lot: p,
    });
  });
  all.sort((x, y) => x.seconds - y.seconds);

  const pick = (want: (s: Status) => boolean, max: number) => {
    if (![...show].some(want)) return [];
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

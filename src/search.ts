// Search that never leaves the device: streets, intersections, CMU facilities and named places,
// matched in the browser against data the page already serves.
import type { Data } from "./data";

export type Hit = { name: string; sub: string; at: [number, number] };
type Entry = Hit & { key: string; rank: number; mids?: [number, number][] };

const ABBR: Record<string, string> = {
  avenue: "ave", street: "st", boulevard: "blvd", drive: "dr", road: "rd", place: "pl", lane: "ln", terrace: "ter",
  square: "sq", court: "ct", parkway: "pkwy", way: "way", north: "n", south: "s", east: "e", west: "w", saint: "st", mount: "mt",
};
export const norm = (s: string) =>
  s
    .toLowerCase()
    .normalize("NFD")
    .replace(/[̀-ͯ]/g, "")
    .replace(/[^a-z0-9 ]+/g, " ")
    .split(/\s+/)
    .filter(Boolean)
    .map((w) => ABBR[w] ?? w)
    .join(" ");

const KIND: Record<string, string> = {
  university: "University", college: "College", hospital: "Hospital", museum: "Museum", park: "Park", stadium: "Stadium",
  library: "Library", theatre: "Theater", cinema: "Cinema", supermarket: "Grocery", restaurant: "Restaurant", cafe: "Café",
  hotel: "Hotel", school: "School", neighbourhood: "Neighborhood", parking: "Parking", place_of_worship: "Place of worship",
};

/** Everything searchable. Places come from the basemap and load on first search. */
export function buildIndex(data: Data, places: [string, string, number, number][]): Entry[] {
  const out: Entry[] = [];
  const streets = new Map<string, [number, number][]>();
  const corners = new Map<string, [number, number]>();
  for (const f of data.blocks.features) {
    const { n, e } = f.properties;
    if (!n) continue;
    const c = f.geometry.coordinates;
    const mid = c[Math.floor(c.length / 2)] as [number, number];
    streets.set(n, [...(streets.get(n) ?? []), mid]);
    e?.forEach((other, i) => {
      if (!other) return;
      const pair = [n, other].sort().join(" & ");
      if (!corners.has(pair)) corners.set(pair, (i === 0 ? c[0] : c[c.length - 1]) as [number, number]);
    });
  }
  // A street is all of its blocks; `pickAt` chooses the one nearest where you're looking.
  for (const [name, mids] of streets) out.push({ name, sub: "Street", at: mids[0], key: norm(name), rank: 2, mids });
  for (const [pair, at] of corners) out.push({ name: pair, sub: "Intersection", at, key: norm(pair), rank: 3 });
  for (const f of data.lots.features) {
    if (f.properties.k !== "cmu") continue;
    out.push({ name: f.properties.n, sub: "CMU parking", at: f.geometry.coordinates as [number, number], key: norm(f.properties.n), rank: 0 });
  }
  for (const [name, kind, lon, lat] of places) {
    out.push({ name, sub: KIND[kind] ?? kind.replace(/_/g, " ").replace(/^./, (m) => m.toUpperCase()), at: [lon, lat], key: norm(name), rank: kind === "university" || kind === "hospital" || kind === "neighbourhood" ? 0 : 1 });
  }
  return out;
}

const dist2 = (a: [number, number], b: [number, number]) => ((a[0] - b[0]) * 0.76) ** 2 + (a[1] - b[1]) ** 2;

/** Best matches for `q`, near `center` first among equals. "forbes & morewood" finds the corner. */
export function search(index: Entry[], q: string, center: [number, number], limit = 6): Hit[] {
  const parts = q.split(/\s*(?:&|\+|\/|\band\b|\bat\b)\s*/i).map(norm).filter(Boolean);
  if (!parts.length || parts.join("").length < 2) return [];
  const words = parts.join(" ").split(" ");
  const scored: [number, Entry][] = [];
  for (const e of index) {
    let score: number;
    if (parts.length > 1) {
      // Each side of an intersection has to match one of its streets.
      if (e.sub !== "Intersection") continue;
      const sides = e.key.split(" & ");
      if (!parts.every((p) => sides.some((s) => s.startsWith(p) || s.includes(` ${p}`)))) continue;
      score = 0;
    } else if (e.key.startsWith(parts[0])) score = 0;
    else if (words.every((w) => e.key.split(" ").some((t) => t.startsWith(w)))) score = 1;
    else continue;
    scored.push([score * 10 + e.rank + Math.min(dist2(e.at, center) * 400, 4), e]);
  }
  scored.sort((a, b) => a[0] - b[0]);
  const seen = new Set<string>();
  const hits: Hit[] = [];
  for (const [, e] of scored) {
    const id = `${e.name}|${e.sub}`;
    if (seen.has(id)) continue;
    seen.add(id);
    const at = e.mids ? e.mids.reduce((best, m) => (dist2(m, center) < dist2(best, center) ? m : best)) : e.at;
    hits.push({ name: e.name, sub: e.sub, at });
    if (hits.length >= limit) break;
  }
  return hits;
}

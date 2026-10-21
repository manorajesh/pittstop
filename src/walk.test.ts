import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { decode, dijkstra, edgeTime, Graph, project, route, snap } from "./walk";

/** A tiny graph in the pipeline's binary layout: nodes along a line 100 m apart, the last edge steps. */
function toy(elevs: number[], stepsLast = false): Graph {
  const n = elevs.length;
  const lons = elevs.map((_, i) => -79.95 + (i * 100) / (111320 * Math.cos((40.44 * Math.PI) / 180)));
  const adj: [number, number][][] = elevs.map(() => []);
  for (let i = 0; i + 1 < n; i++) {
    const f = stepsLast && i === n - 2 ? 1 : 0;
    adj[i].push([i + 1, f]);
    adj[i + 1].push([i, f]);
  }
  const targets = adj.flatMap((a) => a.map(([t]) => t));
  const flags = adj.flatMap((a) => a.map(([, f]) => f));
  const m = targets.length;
  let size = 12 + 8 * n + 2 * n;
  size += (4 - (size % 4)) % 4;
  const elevStart = 12 + 8 * n;
  const offStart = size;
  size += 4 * (n + 1) + 4 * m + Math.ceil(m / 8);
  const buf = new ArrayBuffer(size);
  const dv = new DataView(buf);
  "PSW1".split("").forEach((c, i) => dv.setUint8(i, c.charCodeAt(0)));
  dv.setUint32(4, n, true);
  dv.setUint32(8, m, true);
  let prevLon = 0;
  let prevLat = 0;
  lons.forEach((lon, i) => {
    const ml = Math.round(lon * 1e6);
    const mt = Math.round(40.44 * 1e6);
    dv.setInt32(12 + 4 * i, ml - prevLon, true);
    dv.setInt32(12 + 4 * n + 4 * i, mt - prevLat, true);
    prevLon = ml;
    prevLat = mt;
    dv.setInt16(elevStart + 2 * i, Math.round(elevs[i] * 10), true);
  });
  let o = 0;
  adj.forEach((a, i) => {
    dv.setUint32(offStart + 4 * i, o, true);
    o += a.length;
  });
  dv.setUint32(offStart + 4 * n, o, true);
  targets.forEach((t, i) => dv.setUint32(offStart + 4 * (n + 1) + 4 * i, t, true));
  flags.forEach((f, i) => {
    const p = offStart + 4 * (n + 1) + 4 * m + (i >> 3);
    dv.setUint8(p, dv.getUint8(p) | (f << (i & 7)));
  });
  return decode(buf);
}

describe("walk", () => {
  it("walks a flat street at about 1.3 m/s", () => {
    const g = toy([300, 300, 300]);
    const t = dijkstra(g, 0);
    expect(t.time[2]).toBeCloseTo(200 / 1.3, 0);
  });
  it("is slower uphill than down", () => {
    const g = toy([250, 270]);
    expect(edgeTime(g, 0, g.off[0])).toBeGreaterThan(edgeTime(g, 1, g.off[1]));
  });
  it("counts flights of steps and climb along a route", () => {
    const g = toy([250, 252, 280], true);
    const r = route(g, dijkstra(g, 0), 2)!;
    expect(r.flights).toBe(1);
    expect(r.climb).toBeCloseTo(30, 0);
    expect(r.meters).toBeCloseTo(200, -1);
  });
  it("snaps to the nearest node", () => {
    const g = toy([0, 0, 0]);
    const [x] = project(g.lon[1], g.lat[1]);
    expect(x).toBeCloseTo(100, 0);
    expect(snap(g, g.lon[1] + 0.0001, 40.44).node).toBe(1);
  });
  it("decodes the real network", () => {
    let buf: Buffer;
    try {
      buf = readFileSync(new URL("../public/data/walk.bin", import.meta.url));
    } catch {
      return; // not built yet
    }
    const g = decode(new Uint8Array(buf).buffer);
    // Hamerschlag Hall, CMU, is in Pittsburgh, on a hill, and walkable.
    const s = snap(g, -79.9446, 40.4424);
    expect(s.meters).toBeLessThan(80);
    expect(g.elev[s.node]).toBeGreaterThan(250);
    const t = dijkstra(g, s.node);
    const cathedral = snap(g, -79.9532, 40.4443).node;
    const minutes = t.time[cathedral] / 60;
    expect(minutes).toBeGreaterThan(8);
    expect(minutes).toBeLessThan(20);
  });
});

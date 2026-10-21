// The walking network the pipeline writes (pipeline/build.py write_walk), and walk times over it.
// Pittsburgh is steep, so time comes from Tobler's hiking function on each edge's grade, and city
// steps are their own, slower thing.

export type Graph = {
  n: number;
  lon: Float64Array;
  lat: Float64Array;
  x: Float32Array; // meters on a local plane, for lengths and snapping
  y: Float32Array;
  elev: Float32Array; // meters
  off: Uint32Array;
  to: Uint32Array;
  steps: Uint8Array; // per half-edge
  grid: Map<number, number[]>;
};

const LAT0 = 40.44;
const LON0 = -79.95;
const KX = 111320 * Math.cos((LAT0 * Math.PI) / 180);
const KY = 110540;
const CELL = 60;

export const project = (lon: number, lat: number): [number, number] => [(lon - LON0) * KX, (lat - LAT0) * KY];
const cellKey = (cx: number, cy: number) => (cx + 2000) * 4000 + (cy + 2000);

export function decode(buf: ArrayBuffer): Graph {
  const dv = new DataView(buf);
  if (String.fromCharCode(dv.getUint8(0), dv.getUint8(1), dv.getUint8(2), dv.getUint8(3)) !== "PSW1") throw new Error("Not a walk graph");
  const n = dv.getUint32(4, true);
  const m = dv.getUint32(8, true);
  let p = 12;
  const dlon = new Int32Array(buf, p, n);
  p += 4 * n;
  const dlat = new Int32Array(buf, p, n);
  p += 4 * n;
  const elev10 = new Int16Array(buf, p, n);
  p += 2 * n;
  p += (4 - (p % 4)) % 4;
  const off = new Uint32Array(buf, p, n + 1);
  p += 4 * (n + 1);
  const to = new Uint32Array(buf, p, m);
  p += 4 * m;
  const bits = new Uint8Array(buf, p, Math.ceil(m / 8));

  const lon = new Float64Array(n);
  const lat = new Float64Array(n);
  const x = new Float32Array(n);
  const y = new Float32Array(n);
  const elev = new Float32Array(n);
  const grid = new Map<number, number[]>();
  let ax = 0;
  let ay = 0;
  for (let i = 0; i < n; i++) {
    ax += dlon[i];
    ay += dlat[i];
    lon[i] = ax / 1e6;
    lat[i] = ay / 1e6;
    [x[i], y[i]] = project(lon[i], lat[i]);
    elev[i] = elev10[i] / 10;
    const k = cellKey(Math.floor(x[i] / CELL), Math.floor(y[i] / CELL));
    const cell = grid.get(k);
    if (cell) cell.push(i);
    else grid.set(k, [i]);
  }
  const steps = new Uint8Array(m);
  for (let e = 0; e < m; e++) steps[e] = (bits[e >> 3] >> (e & 7)) & 1;
  return { n, lon, lat, x, y, elev, off, to, steps, grid };
}

/** The graph node nearest a point, and how far off it is in meters. */
export function snap(g: Graph, lon: number, lat: number): { node: number; meters: number } {
  const [px, py] = project(lon, lat);
  const cx = Math.floor(px / CELL);
  const cy = Math.floor(py / CELL);
  let best = -1;
  let bd = Infinity;
  for (let r = 0; r < 30; r++) {
    for (let dx = -r; dx <= r; dx++) {
      for (let dy = -r; dy <= r; dy++) {
        if (Math.max(Math.abs(dx), Math.abs(dy)) !== r) continue;
        for (const i of g.grid.get(cellKey(cx + dx, cy + dy)) ?? []) {
          const d = (g.x[i] - px) ** 2 + (g.y[i] - py) ** 2;
          if (d < bd) {
            bd = d;
            best = i;
          }
        }
      }
    }
    // Anything in a farther ring is at least r cells away.
    if (best >= 0 && Math.sqrt(bd) <= r * CELL) break;
  }
  return { node: best, meters: Math.sqrt(bd) };
}

const FLAT = 1.3; // m/s on level ground

/** Seconds to walk one half-edge. */
export function edgeTime(g: Graph, u: number, e: number): number {
  const v = g.to[e];
  const len = Math.hypot(g.x[v] - g.x[u], g.y[v] - g.y[u]);
  const dz = g.elev[v] - g.elev[u];
  if (g.steps[e]) return len / 1.0 + Math.max(dz, 0) * 2.5;
  const grade = Math.max(-0.5, Math.min(0.5, dz / Math.max(len, 1)));
  // Tobler, scaled so a flat street walks at FLAT; fastest just downhill.
  return len / (FLAT * Math.exp(-3.5 * (Math.abs(grade + 0.05) - 0.05)));
}

export type Tree = { time: Float64Array; prev: Int32Array; prevEdge: Int32Array };

/** Walk times in seconds from `source` to every node within `cutoff` (others are Infinity). */
export function dijkstra(g: Graph, source: number, start = 0, cutoff = 1800): Tree {
  const time = new Float64Array(g.n).fill(Infinity);
  const prev = new Int32Array(g.n).fill(-1);
  const prevEdge = new Int32Array(g.n).fill(-1);
  const heap = new Heap();
  time[source] = start;
  heap.push(source, start);
  while (heap.size) {
    const [u, t] = heap.pop();
    if (t > time[u]) continue;
    if (t > cutoff) break;
    for (let e = g.off[u]; e < g.off[u + 1]; e++) {
      const v = g.to[e];
      const nt = t + edgeTime(g, u, e);
      if (nt < time[v]) {
        time[v] = nt;
        prev[v] = u;
        prevEdge[v] = e;
        heap.push(v, nt);
      }
    }
  }
  return { time, prev, prevEdge };
}

export type Route = { coords: [number, number][]; meters: number; climb: number; flights: number; seconds: number };

/** The path from the source to `node`, walked forward. */
export function route(g: Graph, tree: Tree, node: number): Route | null {
  if (!isFinite(tree.time[node])) return null;
  const path: number[] = [];
  const stepEdges: boolean[] = [];
  for (let v = node; v >= 0; v = tree.prev[v]) {
    path.push(v);
    stepEdges.push(tree.prevEdge[v] >= 0 && g.steps[tree.prevEdge[v]] === 1);
  }
  path.reverse();
  stepEdges.reverse();
  let meters = 0;
  let climb = 0;
  let flights = 0;
  for (let i = 1; i < path.length; i++) {
    const [a, b] = [path[i - 1], path[i]];
    meters += Math.hypot(g.x[b] - g.x[a], g.y[b] - g.y[a]);
    climb += Math.max(0, g.elev[b] - g.elev[a]);
    if (stepEdges[i] && !stepEdges[i - 1]) flights++;
  }
  return { coords: path.map((i) => [g.lon[i], g.lat[i]]), meters, climb, flights, seconds: tree.time[node] };
}

class Heap {
  private ids: number[] = [];
  private keys: number[] = [];
  get size() {
    return this.ids.length;
  }
  push(id: number, key: number) {
    const { ids, keys } = this;
    let i = ids.length;
    ids.push(id);
    keys.push(key);
    while (i > 0) {
      const p = (i - 1) >> 1;
      if (keys[p] <= key) break;
      ids[i] = ids[p];
      keys[i] = keys[p];
      i = p;
    }
    ids[i] = id;
    keys[i] = key;
  }
  pop(): [number, number] {
    const { ids, keys } = this;
    const top: [number, number] = [ids[0], keys[0]];
    const id = ids.pop()!;
    const key = keys.pop()!;
    if (ids.length) {
      let i = 0;
      const n = ids.length;
      for (;;) {
        let c = 2 * i + 1;
        if (c >= n) break;
        if (c + 1 < n && keys[c + 1] < keys[c]) c++;
        if (keys[c] >= key) break;
        ids[i] = ids[c];
        keys[i] = keys[c];
        i = c;
      }
      ids[i] = id;
      keys[i] = key;
    }
    return top;
  }
}

// Holds the walking network off the main thread. Messages:
//   { type: "walk", id, lon, lat }  -> { id, time: Float32Array, snapMeters }  walk seconds to every node
//   { type: "route", id, node }     -> { id, route }                           the path to one node, from the last walk
import { decode, dijkstra, Graph, route, snap, Tree } from "./walk";

let graph: Promise<Graph> | null = null;

/** The file is gzipped, but some hosts already undo that in transit (Content-Encoding); inflate only
 *  if the gzip magic bytes are still there. */
async function inflate(buf: ArrayBuffer): Promise<ArrayBuffer> {
  const b = new Uint8Array(buf, 0, 2);
  if (b[0] !== 0x1f || b[1] !== 0x8b) return buf;
  return new Response(new Blob([buf]).stream().pipeThrough(new DecompressionStream("gzip"))).arrayBuffer();
}
let tree: Tree | null = null;

const ctx = self as unknown as Worker;

ctx.onmessage = async (e: MessageEvent) => {
  const msg = e.data;
  try {
    if (msg.type === "load") {
      graph ??= fetch(msg.url)
        .then((r) => {
          if (!r.ok) throw new Error(`Walking network: ${r.status}`);
          return r.arrayBuffer();
        })
        .then(inflate)
        .then(decode);
      await graph;
      ctx.postMessage({ id: msg.id });
    } else if (msg.type === "walk") {
      const g = await graph!;
      const s = snap(g, msg.lon, msg.lat);
      // The stretch from the pin to the network counts at walking pace.
      tree = dijkstra(g, s.node, s.meters / 1.3, 1800);
      const time = Float32Array.from(tree.time);
      ctx.postMessage({ id: msg.id, time, snapMeters: s.meters }, [time.buffer]);
    } else if (msg.type === "route") {
      const g = await graph!;
      ctx.postMessage({ id: msg.id, route: tree ? route(g, tree, msg.node) : null });
    }
  } catch (err) {
    ctx.postMessage({ id: msg.id, error: String((err as Error).message || err) });
  }
};

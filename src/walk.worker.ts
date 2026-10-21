// Holds the walking network off the main thread. Messages:
//   { type: "walk", id, lon, lat }  -> { id, time: Float32Array, snapMeters }  walk seconds to every node
//   { type: "route", id, node }     -> { id, route }                           the path to one node, from the last walk
import { decode, dijkstra, Graph, route, snap, Tree } from "./walk";

let graph: Promise<Graph> | null = null;
let tree: Tree | null = null;

const ctx = self as unknown as Worker;

ctx.onmessage = async (e: MessageEvent) => {
  const msg = e.data;
  try {
    if (msg.type === "load") {
      graph ??= fetch(msg.url).then((r) => {
        if (!r.ok) throw new Error(`Walking network: ${r.status}`);
        return r.arrayBuffer();
      }).then(decode);
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

// The map: basemap, parking blocks colored for the current window, lots, permit zones, the pin and
// a walking route. The page drives it through a few methods, the way city-steps drives its scene.
import { ExpressionSpecification, GeoJSONSource, Map as MLMap, Marker, setWorkerUrl } from "maplibre-gl";
import "maplibre-gl/dist/maplibre-gl.css";
import workerUrl from "maplibre-gl/dist/maplibre-gl-worker.mjs?url";
import { basemap, FONT } from "./basemap";
import { blockVerdict, Data, lotVerdict } from "./data";
import type { Status, Verdict } from "./rules";

export const COLORS: Record<Status, string> = {
  free: "#ffb612", // Pittsburgh gold
  paid: "#d8d8d8",
  limit: "#8a6a2a",
  no: "#8f3b33",
  unknown: "#3a3a3a",
};

// Oakland, with the city in reach.
const HOME: [number, number] = [-79.9495, 40.4435];
const BOUNDS: [[number, number], [number, number]] = [[-80.2, 40.3], [-79.75, 40.58]];

export type MapEvents = {
  pin: (lon: number, lat: number) => void;
  hover: (info: { name: string; verdict: Verdict; x: number; y: number } | null) => void;
  ready: () => void;
};

// MapLibre looks for its tile worker next to its own module, which bundling moves; point it at the copy.
setWorkerUrl(new URL(workerUrl, location.href).href);

export class ParkingMap {
  map: MLMap;
  private marker: Marker | null = null;
  private data: Data | null = null;
  private verdicts: Verdict[] = [];

  constructor(el: HTMLElement, private on: MapEvents) {
    this.map = new MLMap({
      container: el,
      style: basemap(),
      center: HOME,
      zoom: 15,
      minZoom: 10.5,
      maxZoom: 19,
      maxBounds: BOUNDS,
      attributionControl: false,
      dragRotate: false,
      pitchWithRotate: false,
      fadeDuration: 0,
    });
    this.map.touchZoomRotate.disableRotation();
    this.map.on("click", (e) => this.on.pin(e.lngLat.lng, e.lngLat.lat));
    this.map.on("load", () => this.on.ready());
    this.map.on("mousemove", (e) => {
      if (!this.data) return;
      const hit = this.map.queryRenderedFeatures([[e.point.x - 4, e.point.y - 4], [e.point.x + 4, e.point.y + 4]], {
        layers: ["lots", "blocks", "blocks-permit"].filter((l) => this.map.getLayer(l)),
      })[0];
      this.map.getCanvas().style.cursor = "crosshair";
      if (!hit) return this.on.hover(null);
      const isLot = hit.layer.id === "lots";
      const f = isLot ? this.data.lots.features[hit.id as number] : this.data.blocks.features[hit.id as number];
      const p = f.properties as never;
      const verdict = isLot ? lotVerdict(p, this.verdicts) : blockVerdict(p, this.verdicts);
      const name = (f.properties as { n: string }).n || "Unnamed street";
      this.on.hover({ name, verdict, x: e.point.x, y: e.point.y });
    });
    this.map.on("mouseout", () => this.on.hover(null));
  }

  /** Add the parking layers once both the style and the data are in. */
  setData(data: Data) {
    this.data = data;
    const m = this.map;
    m.addSource("zones", { type: "geojson", data: data.zones });
    m.addSource("blocks", { type: "geojson", data: data.blocks as never, tolerance: 0.3 });
    m.addSource("lots", { type: "geojson", data: data.lots as never });
    m.addSource("route", { type: "geojson", data: empty() });
    m.addSource("focus", { type: "geojson", data: empty() });

    const below = "street-label";
    m.addLayer({ id: "zones-fill", type: "fill", source: "zones", paint: { "fill-color": COLORS.free, "fill-opacity": 0.025 } }, below);
    m.addLayer({ id: "zones-line", type: "line", source: "zones", paint: { "line-color": COLORS.free, "line-opacity": 0.14, "line-width": 0.8, "line-dasharray": [2, 3] } }, below);
    const width: ExpressionSpecification = ["interpolate", ["exponential", 1.5], ["zoom"], 11, 0.5, 14, 1.6, 16, 3.2, 19, 8];
    m.addLayer({ id: "focus", type: "line", source: "focus", layout: { "line-cap": "round" }, paint: { "line-color": "#ffffff", "line-width": ["interpolate", ["linear"], ["zoom"], 12, 6, 18, 18], "line-opacity": 0.14, "line-blur": 3 } }, below);
    m.addLayer({ id: "blocks", type: "line", source: "blocks", filter: ["!=", ["get", "k"], "p"], layout: { "line-cap": "round", "line-join": "round" }, paint: { "line-color": COLORS.unknown, "line-width": width } }, below);
    m.addLayer({ id: "blocks-permit", type: "line", source: "blocks", filter: ["==", ["get", "k"], "p"], layout: { "line-join": "round" }, paint: { "line-color": COLORS.unknown, "line-width": width, "line-dasharray": [1.6, 1.1] } }, below);
    m.addLayer({ id: "route", type: "line", source: "route", layout: { "line-cap": "round", "line-join": "round" }, paint: { "line-color": "#ffffff", "line-width": ["interpolate", ["linear"], ["zoom"], 12, 1.5, 18, 4], "line-dasharray": [0.1, 2], "line-opacity": 0.9 } });
    m.addLayer({
      id: "lots",
      type: "circle",
      source: "lots",
      minzoom: 13,
      paint: {
        // Garages a little larger than lots.
        "circle-radius": ["interpolate", ["linear"], ["zoom"], 13, ["case", ["any", ["==", ["get", "k"], "garage"], ["==", ["get", "g"], true]], 3.5, 2.5], 17, ["case", ["any", ["==", ["get", "k"], "garage"], ["==", ["get", "g"], true]], 8, 6]],
        "circle-color": "#0b0b0b",
        "circle-stroke-width": ["interpolate", ["linear"], ["zoom"], 13, 1, 17, 2],
        "circle-stroke-color": COLORS.unknown,
      },
    });
    m.addLayer({
      id: "zones-label",
      type: "symbol",
      source: "zones",
      minzoom: 14.5,
      layout: { "text-field": ["concat", "Permit zone ", ["get", "z"]], "text-font": FONT, "text-size": 10, "text-letter-spacing": 0.1, "text-transform": "uppercase" },
      paint: { "text-color": COLORS.free, "text-opacity": 0.35, "text-halo-color": "#0b0b0b", "text-halo-width": 1 },
    });
  }

  /** Recolor every block and lot for a new window, and show only the statuses in `show`. */
  setVerdicts(verdicts: Verdict[], show: Set<Status>) {
    this.verdicts = verdicts;
    if (!this.data || !this.map.getLayer("blocks")) return;
    const bySchedule: string[] = [];
    verdicts.forEach((v, i) => bySchedule.push(i as never, v.status));
    const sched = (fallback: Status): ExpressionSpecification =>
      bySchedule.length ? (["match", ["coalesce", ["get", "s"], -1], ...bySchedule, fallback] as unknown as ExpressionSpecification) : (fallback as never);
    const blockStatus: ExpressionSpecification = ["match", ["get", "k"], "f", "free", "u", "unknown", "x", "no", sched("unknown")];
    // Lots without a schedule follow their OSM fee tag.
    const lotStatus: ExpressionSpecification = [
      "case",
      ["has", "s"], sched("unknown"),
      ["all", ["==", ["get", "f"], "no"], ["!", ["has", "cu"]], ["!=", ["get", "k"], "garage"]], "free",
      ["==", ["get", "f"], "yes"], "paid",
      "unknown",
    ];
    const color = (status: ExpressionSpecification): ExpressionSpecification =>
      ["match", status, ...(Object.entries(COLORS).flat() as string[]), COLORS.unknown] as unknown as ExpressionSpecification;
    const shown = (status: ExpressionSpecification): ExpressionSpecification => ["in", status, ["literal", [...show]]];
    this.map.setPaintProperty("blocks", "line-color", color(blockStatus));
    this.map.setPaintProperty("blocks-permit", "line-color", color(blockStatus));
    this.map.setPaintProperty("lots", "circle-stroke-color", color(lotStatus));
    this.map.setFilter("blocks", ["all", ["!=", ["get", "k"], "p"], shown(blockStatus)]);
    this.map.setFilter("blocks-permit", ["all", ["==", ["get", "k"], "p"], shown(blockStatus)]);
    this.map.setFilter("lots", shown(lotStatus));
  }

  setPin(lonlat: [number, number] | null, fly = false) {
    if (!lonlat) {
      this.marker?.remove();
      this.marker = null;
      return;
    }
    if (!this.marker) {
      const el = document.createElement("div");
      el.className = "ps-pin";
      el.innerHTML = "<i></i>";
      this.marker = new Marker({ element: el, anchor: "bottom" });
    }
    this.marker.setLngLat(lonlat).addTo(this.map);
    if (fly) this.map.easeTo({ center: lonlat, zoom: Math.max(this.map.getZoom(), 15.5), duration: 700 });
  }

  setRoute(coords: [number, number][] | null) {
    (this.map.getSource("route") as GeoJSONSource | undefined)?.setData(coords ? { type: "Feature", properties: {}, geometry: { type: "LineString", coordinates: coords } } : empty());
  }

  focus(target: { kind: "block" | "lot"; id: number } | null) {
    const src = this.map.getSource("focus") as GeoJSONSource | undefined;
    if (!src || !this.data) return;
    if (!target) return src.setData(empty());
    const f = target.kind === "block" ? this.data.blocks.features[target.id] : this.data.lots.features[target.id];
    src.setData(f as never);
  }

  /** Keep the pin and a destination both in view, clear of the sheet. */
  frame(points: [number, number][], padding: { top: number; right: number; bottom: number; left: number }) {
    if (!points.length) return;
    let [w, s, e, n] = [Infinity, Infinity, -Infinity, -Infinity];
    for (const [x, y] of points) {
      w = Math.min(w, x);
      e = Math.max(e, x);
      s = Math.min(s, y);
      n = Math.max(n, y);
    }
    this.map.fitBounds([[w, s], [e, n]], { padding, maxZoom: 17, duration: 600 });
  }

  dispose() {
    this.map.remove();
  }
}

function empty(): GeoJSON.FeatureCollection {
  return { type: "FeatureCollection", features: [] };
}

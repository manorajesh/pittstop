// A quiet dark basemap. Tiles and label glyphs are this site's own copy of Pittsburgh from the
// Protomaps build (pipeline/basemap.py), so no tile server sees where anyone looks.
import type { StyleSpecification } from "maplibre-gl";

const C = {
  bg: "#0b0b0b",
  water: "#0e1317",
  park: "#0e120e",
  building: "#131313",
  minor: "#1a1a1a",
  major: "#222222",
  label: "#5c5c5c",
  labelHalo: "#0b0b0b",
  place: "#7a7a7a",
};

export const FONT = ["Noto Sans Regular"];

// MapLibre needs absolute templates; URL() would escape the braces.
const here = () => location.origin + import.meta.env.BASE_URL;

export function basemap(): StyleSpecification {
  return {
    version: 8,
    glyphs: here() + "glyphs/{fontstack}/{range}.pbf",
    sources: {
      pgh: {
        type: "vector",
        tiles: [here() + "tiles/{z}/{x}/{y}.mvt"],
        minzoom: 0,
        maxzoom: 15,
        bounds: [-80.105, 40.355, -79.855, 40.505],
        attribution: '<a href="https://protomaps.com">Protomaps</a> © <a href="https://www.openstreetmap.org/copyright">OpenStreetMap</a>',
      },
    },
    layers: [
      { id: "bg", type: "background", paint: { "background-color": C.bg } },
      {
        id: "park",
        type: "fill",
        source: "pgh",
        "source-layer": "landuse",
        filter: ["in", ["get", "kind"], ["literal", ["park", "grass", "wood", "garden", "forest", "nature_reserve", "cemetery", "golf_course", "recreation_ground", "meadow", "scrub"]]],
        paint: { "fill-color": C.park },
      },
      { id: "water", type: "fill", source: "pgh", "source-layer": "water", filter: ["==", ["geometry-type"], "Polygon"], paint: { "fill-color": C.water } },
      { id: "building", type: "fill", source: "pgh", "source-layer": "buildings", minzoom: 14, paint: { "fill-color": C.building, "fill-opacity": ["interpolate", ["linear"], ["zoom"], 14, 0, 15.5, 1] } },
      {
        id: "road-minor",
        type: "line",
        source: "pgh",
        "source-layer": "roads",
        filter: ["in", ["get", "kind"], ["literal", ["minor_road", "path", "other"]]],
        layout: { "line-cap": "round", "line-join": "round" },
        paint: {
          "line-color": C.minor,
          "line-width": ["interpolate", ["exponential", 1.6], ["zoom"], 12, 0.5, 16, ["match", ["get", "kind"], "path", 1.5, 6], 19, ["match", ["get", "kind"], "path", 4, 22]],
        },
      },
      {
        id: "road-major",
        type: "line",
        source: "pgh",
        "source-layer": "roads",
        filter: ["in", ["get", "kind"], ["literal", ["major_road", "highway"]]],
        layout: { "line-cap": "round", "line-join": "round" },
        paint: { "line-color": C.major, "line-width": ["interpolate", ["exponential", 1.6], ["zoom"], 10, 0.6, 16, 10, 19, 32] },
      },
      {
        id: "rail",
        type: "line",
        source: "pgh",
        "source-layer": "roads",
        filter: ["==", ["get", "kind"], "rail"],
        paint: { "line-color": "#191919", "line-width": 1, "line-dasharray": [3, 3] },
      },
      {
        id: "street-label",
        type: "symbol",
        source: "pgh",
        "source-layer": "roads",
        minzoom: 15,
        filter: ["in", ["get", "kind"], ["literal", ["minor_road", "major_road", "highway"]]],
        layout: {
          "symbol-placement": "line",
          "text-field": ["get", "name"],
          "text-font": FONT,
          "text-size": ["interpolate", ["linear"], ["zoom"], 15, 10, 18, 13],
          "text-letter-spacing": 0.04,
        },
        paint: { "text-color": C.label, "text-halo-color": C.labelHalo, "text-halo-width": 1.4 },
      },
      {
        id: "place-label",
        type: "symbol",
        source: "pgh",
        "source-layer": "places",
        filter: ["in", ["get", "kind"], ["literal", ["neighbourhood", "macrohood", "locality"]]],
        maxzoom: 15.5,
        layout: {
          "text-field": ["coalesce", ["get", "name:en"], ["get", "name"]],
          "text-font": FONT,
          "text-size": ["interpolate", ["linear"], ["zoom"], 11, 10, 14, 12],
          "text-transform": "uppercase",
          "text-letter-spacing": 0.12,
          "text-max-width": 8,
        },
        paint: { "text-color": C.place, "text-halo-color": C.labelHalo, "text-halo-width": 1.2, "text-opacity": 0.75 },
      },
    ],
  };
}

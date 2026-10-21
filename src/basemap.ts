// A quiet dark basemap over OpenFreeMap's OpenMapTiles vectors: just enough land, water, parks and
// streets to find your way, so the parking lines carry the color.
import type { StyleSpecification } from "maplibre-gl";

const C = {
  bg: "#0b0b0b",
  water: "#0e1317",
  park: "#0e120e",
  building: "#131313",
  minor: "#1a1a1a",
  major: "#222222",
  casing: "#0b0b0b",
  label: "#5c5c5c",
  labelHalo: "#0b0b0b",
  place: "#7a7a7a",
};

export const FONT = ["Noto Sans Regular"];

export function basemap(): StyleSpecification {
  return {
    version: 8,
    glyphs: "https://tiles.openfreemap.org/fonts/{fontstack}/{range}.pbf",
    sources: {
      omt: { type: "vector", url: "https://tiles.openfreemap.org/planet", attribution: '<a href="https://openfreemap.org">OpenFreeMap</a> © <a href="https://www.openstreetmap.org/copyright">OpenStreetMap</a>' },
    },
    layers: [
      { id: "bg", type: "background", paint: { "background-color": C.bg } },
      { id: "park", type: "fill", source: "omt", "source-layer": "park", paint: { "fill-color": C.park } },
      { id: "wood", type: "fill", source: "omt", "source-layer": "landcover", filter: ["in", ["get", "class"], ["literal", ["wood", "grass"]]], paint: { "fill-color": C.park, "fill-opacity": 0.7 } },
      { id: "water", type: "fill", source: "omt", "source-layer": "water", paint: { "fill-color": C.water } },
      { id: "building", type: "fill", source: "omt", "source-layer": "building", minzoom: 14, paint: { "fill-color": C.building, "fill-opacity": ["interpolate", ["linear"], ["zoom"], 14, 0, 15.5, 1] } },
      {
        id: "road-minor",
        type: "line",
        source: "omt",
        "source-layer": "transportation",
        filter: ["in", ["get", "class"], ["literal", ["minor", "service", "track", "path"]]],
        layout: { "line-cap": "round", "line-join": "round" },
        paint: {
          "line-color": C.minor,
          "line-width": ["interpolate", ["exponential", 1.6], ["zoom"], 12, 0.5, 16, 6, 19, 22],
        },
      },
      {
        id: "road-major",
        type: "line",
        source: "omt",
        "source-layer": "transportation",
        filter: ["in", ["get", "class"], ["literal", ["primary", "secondary", "tertiary", "trunk", "motorway"]]],
        layout: { "line-cap": "round", "line-join": "round" },
        paint: {
          "line-color": C.major,
          "line-width": ["interpolate", ["exponential", 1.6], ["zoom"], 10, 0.6, 16, 10, 19, 32],
        },
      },
      {
        id: "rail",
        type: "line",
        source: "omt",
        "source-layer": "transportation",
        filter: ["==", ["get", "class"], "rail"],
        paint: { "line-color": "#191919", "line-width": 1, "line-dasharray": [3, 3] },
      },
      {
        id: "street-label",
        type: "symbol",
        source: "omt",
        "source-layer": "transportation_name",
        minzoom: 15,
        layout: {
          "symbol-placement": "line",
          "text-field": ["coalesce", ["get", "name:en"], ["get", "name"]],
          "text-font": FONT,
          "text-size": ["interpolate", ["linear"], ["zoom"], 15, 10, 18, 13],
          "text-letter-spacing": 0.04,
        },
        paint: { "text-color": C.label, "text-halo-color": C.labelHalo, "text-halo-width": 1.4 },
      },
      {
        id: "place-label",
        type: "symbol",
        source: "omt",
        "source-layer": "place",
        filter: ["in", ["get", "class"], ["literal", ["suburb", "neighbourhood", "quarter", "city", "town"]]],
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

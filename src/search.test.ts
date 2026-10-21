import { describe, expect, it } from "vitest";
import type { Data } from "./data";
import { buildIndex, norm, search } from "./search";

const line = (n: string, e: [string, string], coords: number[][]) => ({ type: "Feature", properties: { k: "f", n, w: [], e }, geometry: { type: "LineString", coordinates: coords } });
const data = {
  blocks: {
    features: [
      line("Forbes Ave", ["Morewood Ave", "S Craig St"], [[-79.944, 40.444], [-79.948, 40.4445]]),
      line("Forbes Ave", ["S Craig St", "S Bellefield Ave"], [[-79.948, 40.4445], [-79.951, 40.4442]]),
      line("Morewood Ave", ["Forbes Ave", "Fifth Ave"], [[-79.944, 40.444], [-79.943, 40.447]]),
    ],
  },
  lots: { features: [{ properties: { k: "cmu", n: "East Campus Garage" }, geometry: { type: "Point", coordinates: [-79.94, 40.4438] } }] },
} as unknown as Data;
const index = buildIndex(data, [["Carnegie Mellon University", "university", -79.943, 40.443]]);
const center: [number, number] = [-79.945, 40.444];

describe("search", () => {
  it("normalizes street words", () => {
    expect(norm("South Craig Street")).toBe("s craig st");
  });
  it("finds streets, places and CMU parking", () => {
    expect(search(index, "forbes", center)[0]).toMatchObject({ name: "Forbes Ave", sub: "Street" });
    expect(search(index, "carnegie mellon", center)[0].name).toBe("Carnegie Mellon University");
    expect(search(index, "east campus", center)[0].sub).toBe("CMU parking");
  });
  it("finds a corner from either order", () => {
    expect(search(index, "morewood & forbes", center)[0]).toMatchObject({ sub: "Intersection", at: [-79.944, 40.444] });
    expect(search(index, "forbes and craig", center)[0].name).toBe("Forbes Ave & S Craig St");
  });
  it("needs a couple of letters", () => {
    expect(search(index, "f", center)).toEqual([]);
  });
});

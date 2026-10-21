"""Copy a Pittsburgh basemap out of the Protomaps planet build, so the page serves its own map and no
tile server learns where anyone is looking. Also writes the label glyphs and a gazetteer of named
places for on-device search.

  public/tiles/{z}/{x}/{y}.mvt   zooms 0-15 over the city, uncompressed (the host compresses)
  public/glyphs/{font}/{range}.pbf
  public/data/places.json        [[name, kind, lon, lat], ...]

Run after build.py; re-run when the basemap should refresh (BUILD below)."""

import gzip
import json
import math
import sys
from pathlib import Path

import mapbox_vector_tile as mvt
import requests
from pmtiles.reader import Reader
from shapely.geometry import shape

from fetch import BBOX, UA

BUILD = "https://build.protomaps.com/20261020.pmtiles"
ROOT = Path(__file__).parent.parent / "public"
TILES = ROOT / "tiles"
MAXZOOM = 15
# Layers and kinds the style never draws; dropping them roughly halves the download.
DROP_LAYERS = {"pois"}
DROP_KINDS = {"buildings": {"address"}}

GLYPHS = "https://raw.githubusercontent.com/protomaps/basemaps-assets/main/fonts/{font}/{range}.pbf"
FONTS = ["Noto Sans Regular", "Noto Sans Medium"]
RANGES = ["0-255", "256-511", "8192-8447"]  # Latin, Latin Extended, punctuation like en dashes

# Named places worth searching for, by Protomaps kind.
SEARCHABLE = {
    "university", "college", "school", "hospital", "clinic", "library", "museum", "theatre", "cinema", "stadium",
    "park", "garden", "zoo", "attraction", "artwork", "place_of_worship", "townhall", "courthouse", "fire_station",
    "police", "post_office", "supermarket", "marketplace", "mall", "department_store", "hotel", "bus_station",
    "train_station", "station", "parking", "restaurant", "cafe", "bar", "pub", "fast_food", "pharmacy",
    "community_centre", "arts_centre", "sports_centre", "pitch", "playground", "swimming_pool", "dog_park",
    "nature_reserve", "viewpoint", "monument", "memorial", "building", "office", "bank", "grocery", "convenience",
    "bakery", "books", "music_venue", "events_venue", "conference_centre", "kindergarten", "dentist", "doctors",
}


def tile_range(z):
    s, w, n, e = BBOX
    f = lambda lat, lon: (int((lon + 180) / 360 * 2**z), int((1 - math.asinh(math.tan(math.radians(lat))) / math.pi) / 2 * 2**z))
    x0, y0 = f(n, w)
    x1, y1 = f(s, e)
    return [(x, y) for x in range(x0, x1 + 1) for y in range(y0, y1 + 1)]


def to_lonlat(z, x, y, px, py, extent):
    n = 2**z
    lon = (x + px / extent) / n * 360 - 180
    lat = math.degrees(math.atan(math.sinh(math.pi * (1 - 2 * (y + py / extent) / n))))
    return round(lon, 5), round(lat, 5)


def main():
    session = requests.Session()
    session.headers.update(UA)

    def get(offset, length):
        r = session.get(BUILD, headers={"Range": f"bytes={offset}-{offset + length - 1}"}, timeout=120)
        r.raise_for_status()
        return r.content

    reader = Reader(get)
    places = {}
    total = count = 0
    opts = {"y_coord_down": True}
    for z in range(0, MAXZOOM + 1):
        for x, y in tile_range(z):
            raw = reader.get(z, x, y)
            if not raw:
                continue
            tile = mvt.decode(gzip.decompress(raw), default_options=opts)
            layers = []
            for name, layer in tile.items():
                extent = layer.get("extent", 4096)
                if z == MAXZOOM and name in ("pois", "places"):
                    for f in layer["features"]:
                        p = f["properties"]
                        nm = p.get("name:en") or p.get("name")
                        if not nm or (name == "pois" and p.get("kind") not in SEARCHABLE):
                            continue
                        c = shape(f["geometry"]).representative_point()
                        lon, lat = to_lonlat(z, x, y, c.x, c.y, extent)
                        kind = p.get("kind") or "place"
                        # The same name across tile edges or a campus: keep one per ~300 m.
                        near = places.setdefault(nm, [])
                        if all(abs(lon - a) > 0.004 or abs(lat - b) > 0.003 for _, a, b in near):
                            near.append((kind, lon, lat))
                if name in DROP_LAYERS:
                    continue
                drop = DROP_KINDS.get(name, set())
                feats = [{"geometry": shape(f["geometry"]), "properties": f["properties"], **({"id": f["id"]} if "id" in f else {})}
                         for f in layer["features"] if f["properties"].get("kind") not in drop]
                if feats:
                    layers.append({"name": name, "features": feats, "extent": extent})
            data = mvt.encode(layers, default_options=opts)
            out = TILES / str(z) / str(x) / f"{y}.mvt"
            out.parent.mkdir(parents=True, exist_ok=True)
            out.write_bytes(data)
            total += len(data)
            count += 1
        print(f"  z{z}: {count} tiles, {total / 1e6:.1f} MB so far")

    rows = sorted([nm, k, lon, lat] for nm, items in places.items() for k, lon, lat in items)
    (ROOT / "data" / "places.json").write_text(json.dumps(rows, separators=(",", ":")))
    print(f"  places: {len(rows)}")

    for font in FONTS:
        d = ROOT / "glyphs" / font
        d.mkdir(parents=True, exist_ok=True)
        for rg in RANGES:
            r = session.get(GLYPHS.format(font=font.replace(" ", "%20"), range=rg), timeout=60)
            r.raise_for_status()
            (d / f"{rg}.pbf").write_bytes(r.content)
    print("  glyphs written")


if __name__ == "__main__":
    sys.exit(main())

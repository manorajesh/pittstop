"""Download every source the build needs into pipeline/cache. Re-running skips files already there;
pass --force to refetch."""

import io
import json
import math
import sys
import time
from pathlib import Path

import requests

CACHE = Path(__file__).parent / "cache"
FORCE = "--force" in sys.argv
UA = {"User-Agent": "pittstop/0.1 (https://mano.raje.sh/pittstop)"}

# Pittsburgh plus a margin, so walks can cross the city line.
BBOX = (40.355, -80.105, 40.505, -79.855)  # s, w, n, e

OVERPASS = "https://overpass-api.de/api/interpreter"
ARCGIS = "https://services1.arcgis.com/YZCmUqbcsUpOKfj7/arcgis/rest/services"
SOURCES = {
    "meters.geojson": f"{ARCGIS}/PGHWebPPATerminals/FeatureServer/0/query",
    "rpp.geojson": f"{ARCGIS}/PGHWebRPPP/FeatureServer/0/query",
    "rates.csv": "https://data.wprdc.org/datastore/dump/aefaf190-7f4c-4466-a28b-1b7ce039419d",
}


def save(name: str, fetch) -> None:
    path = CACHE / name
    if path.exists() and not FORCE:
        print(f"  {name} (cached)")
        return
    data = fetch()
    path.write_bytes(data)
    print(f"  {name} {len(data) / 1e6:.1f} MB")


def overpass(query: str) -> bytes:
    for attempt in range(4):
        r = requests.post(OVERPASS, data={"data": query}, headers=UA, timeout=600)
        if r.ok:
            return r.content
        print(f"  overpass {r.status_code}, retrying")
        time.sleep(30 * (attempt + 1))
    r.raise_for_status()
    return b""


def arcgis(url: str) -> bytes:
    # The service caps each page at 1000 features, so page until it runs dry.
    features, offset = [], 0
    while True:
        params = {"where": "1=1", "outFields": "*", "outSR": 4326, "f": "geojson", "resultOffset": offset}
        r = requests.get(url, params=params, headers=UA, timeout=120)
        r.raise_for_status()
        page = r.json()["features"]
        features += page
        if len(page) < 1000:
            return json.dumps({"type": "FeatureCollection", "features": features}).encode()
        offset += len(page)


def main() -> None:
    CACHE.mkdir(exist_ok=True)
    s, w, n, e = BBOX
    bbox = f"{s},{w},{n},{e}"

    # Every highway, with node coordinates, for both the street blocks and the walk graph.
    save("highways.json", lambda: overpass(f"[out:json][timeout:600];way[highway]({bbox});out body;>;out skel qt;"))
    save("lots.json", lambda: overpass(f'[out:json][timeout:300];nwr[amenity=parking]({bbox});out center tags;'))
    save("boundary.json", lambda: overpass('[out:json][timeout:120];rel[boundary=administrative][admin_level=8][name="Pittsburgh"];out geom;'))
    for name, url in SOURCES.items():
        save(name, lambda url=url: arcgis(url) if "arcgis" in url else requests.get(url, headers=UA, timeout=120).content)

    # Elevation from Mapzen/AWS terrarium tiles, decoded in build.py.
    z = 13
    def tile(lat, lon):
        x = int((lon + 180) / 360 * 2**z)
        y = int((1 - math.asinh(math.tan(math.radians(lat))) / math.pi) / 2 * 2**z)
        return x, y
    x0, y0 = tile(n, w)
    x1, y1 = tile(s, e)
    (CACHE / "terrain").mkdir(exist_ok=True)
    for x in range(x0, x1 + 1):
        for y in range(y0, y1 + 1):
            url = f"https://s3.amazonaws.com/elevation-tiles-prod/terrarium/{z}/{x}/{y}.png"
            save(f"terrain/{z}_{x}_{y}.png", lambda url=url: requests.get(url, headers=UA, timeout=60).content)


if __name__ == "__main__":
    main()

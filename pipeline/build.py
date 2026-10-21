"""Build the static data the page loads, from the sources fetch.py cached.

  public/data/parking.json  street blocks, each with its parking class and the rules that apply
  public/data/lots.json     lots and garages
  public/data/zones.json    residential permit zones, for the faint overlay
  public/data/walk.bin.gz   the walking network, with elevation, for walk times from a pin (gzipped,
                            since hosts rarely compress binaries; the page inflates it in a worker)

Nothing here erases a street: a metered block is free at 7 pm and a permit block is fine for an hour,
so every block keeps its rules and the page decides what's free for the hours someone asks about."""

import csv
import gzip
import json
import math
import re
import struct
import sys
from collections import Counter, defaultdict
from datetime import date, datetime, timezone
from pathlib import Path

import numpy as np
from PIL import Image
from shapely import STRtree
from shapely.geometry import LineString, Point, shape
from shapely.ops import polygonize, unary_union

import cmu
import schedules as S

ROOT = Path(__file__).parent
CACHE = ROOT / "cache"
OUT = ROOT.parent / "public" / "data"

# A local plane in meters around Oakland; plenty accurate across one city.
LAT0, LON0 = 40.44, -79.95
KX, KY = 111320 * math.cos(math.radians(LAT0)), 110540


def xy(lon, lat):
    return ((lon - LON0) * KX, (lat - LAT0) * KY)


def lonlat(x, y):
    return (x / KX + LON0, y / KY + LAT0)


DRIVE = {"trunk", "primary", "secondary", "tertiary", "residential", "unclassified", "living_street"}
# Arterials often allow parking, but with no meter or OSM tag there's no way to say so honestly.
ARTERIAL = {"trunk", "primary", "secondary"}
WALK = DRIVE | {"footway", "path", "pedestrian", "steps", "service", "track", "cycleway", "corridor", "living_street", "bridleway"}
NO_PARK = {"no", "no_parking", "no_stopping", "separate", "fire_lane"}


def load_osm():
    data = json.loads((CACHE / "highways.json").read_text())
    nodes, ways = {}, []
    for el in data["elements"]:
        if el["type"] == "node":
            nodes[el["id"]] = (el["lon"], el["lat"])
        elif el["type"] == "way":
            ways.append(el)
    return nodes, ways


def city_boundary():
    rel = json.loads((CACHE / "boundary.json").read_text())["elements"][0]
    lines = [LineString([xy(p["lon"], p["lat"]) for p in m["geometry"]]) for m in rel["members"] if m["type"] == "way" and m.get("role") == "outer"]
    return unary_union(list(polygonize(unary_union(lines))))


ABBR = {
    "AVENUE": "AVE", "STREET": "ST", "BOULEVARD": "BLVD", "DRIVE": "DR", "ROAD": "RD", "PLACE": "PL", "LANE": "LN",
    "TERRACE": "TER", "SQUARE": "SQ", "COURT": "CT", "PARKWAY": "PKWY", "HIGHWAY": "HWY", "WAY": "WAY", "ALLEY": "AL",
    "NORTH": "N", "SOUTH": "S", "EAST": "E", "WEST": "W", "SAINT": "ST", "MOUNT": "MT",
}


def norm(name: str | None) -> str:
    """'South Craig Street' and 'S CRAIG ST' -> 'S CRAIG ST'. Drops house numbers and '(Odd)'."""
    if not name:
        return ""
    name = re.sub(r"\(.*?\)", " ", name.upper())
    name = re.sub(r"[^A-Z0-9 ]", " ", name)
    words = [ABBR.get(w, w) for w in name.split()]
    while words and words[0].isdigit():
        words.pop(0)
    return " ".join(words)


def short(name: str) -> str:
    """'Forbes Avenue' -> 'Forbes Ave' for list rows."""
    parts = name.split()
    tail = {"Avenue": "Ave", "Street": "St", "Boulevard": "Blvd", "Drive": "Dr", "Road": "Rd", "Place": "Pl", "Lane": "Ln", "Terrace": "Ter", "Way": "Way", "Square": "Sq", "Court": "Ct"}
    if parts and parts[-1] in tail:
        parts[-1] = tail[parts[-1]]
    return " ".join(parts)


class Schedules:
    """Deduplicates rule sets so thousands of blocks share a few dozen."""

    def __init__(self):
        self.items, self.index = [], {}

    def add(self, rule: dict) -> int:
        key = json.dumps(rule, sort_keys=True)
        if key not in self.index:
            self.index[key] = len(self.items)
            self.items.append(rule)
        return self.index[key]


# --- elevation ---------------------------------------------------------------------------------

class Terrain:
    """Terrarium tiles (meters = R*256 + G + B/256 - 32768), sampled bilinearly."""

    def __init__(self, z=13):
        self.z, self.tiles = z, {}
        for p in (CACHE / "terrain").glob(f"{z}_*.png"):
            _, x, y = p.stem.split("_")
            a = np.asarray(Image.open(p).convert("RGB"), dtype=np.float64)
            self.tiles[(int(x), int(y))] = a[..., 0] * 256 + a[..., 1] + a[..., 2] / 256 - 32768

    def __call__(self, lon, lat):
        n = 2**self.z * 256
        px = (lon + 180) / 360 * n
        py = (1 - math.asinh(math.tan(math.radians(lat))) / math.pi) / 2 * n
        x0, y0 = math.floor(px - 0.5), math.floor(py - 0.5)
        fx, fy = px - 0.5 - x0, py - 0.5 - y0

        def at(x, y):
            t = self.tiles.get((x // 256, y // 256))
            return t[y % 256, x % 256] if t is not None else math.nan

        return (at(x0, y0) * (1 - fx) * (1 - fy) + at(x0 + 1, y0) * fx * (1 - fy)
                + at(x0, y0 + 1) * (1 - fx) * fy + at(x0 + 1, y0 + 1) * fx * fy)


# --- street blocks -----------------------------------------------------------------------------

def parking_tags(tags: dict) -> str | None:
    """'x' when OSM says neither side allows parking, 'ok' when a side does, None when it doesn't say."""
    sides = {}
    for side in ("left", "right"):
        v = tags.get(f"parking:{side}") or tags.get("parking:both") or tags.get(f"parking:lane:{side}") or tags.get("parking:lane:both")
        r = tags.get(f"parking:{side}:restriction") or tags.get("parking:both:restriction")
        if v is None and r is None:
            continue
        sides[side] = "x" if (v in NO_PARK or r in NO_PARK) else "ok"
    if not sides:
        return None
    return "x" if all(s == "x" for s in sides.values()) and len(sides) == 2 else "ok"


def blocks(nodes, ways, boundary):
    drive = [w for w in ways if w["tags"].get("highway") in DRIVE and w["tags"].get("access") not in ("private", "no")
             and w["tags"].get("area") != "yes"]
    uses = Counter(n for w in drive for n in set(w["nodes"]))
    names_at = defaultdict(set)
    for w in drive:
        nm = w["tags"].get("name")
        if nm:
            for n in (w["nodes"][0], w["nodes"][-1], *w["nodes"]):
                if uses[n] > 1:
                    names_at[n].add(short(nm))
    prepared = boundary.buffer(0)
    out = []
    for w in drive:
        ids = w["nodes"]
        cut = [0] + [i for i in range(1, len(ids) - 1) if uses[ids[i]] > 1] + [len(ids) - 1]
        for a, b in zip(cut, cut[1:]):
            seg = ids[a : b + 1]
            pts = [xy(*nodes[n]) for n in seg if n in nodes]
            if len(pts) < 2:
                continue
            line = LineString(pts)
            if line.length < 10 or not prepared.contains(line.interpolate(0.5, normalized=True)):
                continue
            name = w["tags"].get("name") or ""
            ends = [sorted(names_at[n] - {short(name)}) for n in (seg[0], seg[-1])]
            out.append({"way": w, "nodes": seg, "line": line, "name": name, "ends": ends})
    return out


def assign_meters(bl, sched):
    meters = json.loads((CACHE / "meters.geojson").read_text())["features"]
    csv_rows = {r["id"]: r for r in csv.DictReader(open(CACHE / "rates.csv")) if r["status"] == "Active"}
    tree = STRtree([b["line"] for b in bl])
    hits = defaultdict(list)
    lots, unmatched = [], 0
    for f in meters:
        p = f["properties"]
        if p.get("terminal_s") != "Active":
            continue
        rule = S.meter(p)
        assumed = False
        if not rule["pay"] and p["terminal_i"] in csv_rows:
            rule = S.meter_csv(csv_rows[p["terminal_i"]])
        if not rule["pay"]:
            # Nearly every meter in the city runs Mon-Sat 8a-6p; say so rather than call it free.
            rule = {"pay": [[s, e, None] for s, e in S.weekly("Mon - Sat", "8AM - 6PM")], "max": None, "no": [], "dynamic": False}
            assumed = True
        rule = {"kind": "meter", **rule, "assumed": assumed}
        pt = Point(xy(p["longitude"], p["latitude"]))
        if "virtual" in (p.get("location") or "").lower():
            continue  # ParkMobile zones with no place on the street
        if (p.get("lot") or "").strip():
            lots.append({"name": p["location"].title(), "pt": pt, "s": sched.add(rule), "ppa": True})
            continue
        want = norm(p["location"])
        near = [i for i in tree.query(pt.buffer(40)) if bl[i]["line"].distance(pt) <= 40]
        named = [i for i in near if norm(bl[i]["name"]) == want]
        pick = named or [i for i in near if bl[i]["line"].distance(pt) <= 12]
        if not pick:
            unmatched += 1
            continue
        best = min(pick, key=lambda i: bl[i]["line"].distance(pt))
        hits[best].append(sched.add(rule))
    for i, ss in hits.items():
        bl[i]["meter"] = Counter(ss).most_common(1)[0][0]
    print(f"  meters: {sum(len(v) for v in hits.values())} on {len(hits)} blocks, {len(lots)} in lots, {unmatched} unmatched")
    return lots


def assign_zones(bl, sched):
    zones = []
    for f in json.loads((CACHE / "rpp.geojson").read_text())["features"]:
        if not f["geometry"]:
            continue
        p = f["properties"]
        poly = shape(f["geometry"])
        poly = shape({"type": poly.geom_type, "coordinates": _project(f["geometry"]["coordinates"])}).buffer(0)
        rule = {"kind": "permit", **S.permit(p)}
        code = p.get("code_rpp") or p.get("code") or ""
        zones.append({"poly": poly, "s": sched.add(rule), "code": code, "area": (p.get("code_district") or code).split(" - ", 1)[-1].title()})
    tree = STRtree([z["poly"] for z in zones])
    for b in bl:
        mid = b["line"].interpolate(0.5, normalized=True)
        for i in tree.query(mid, predicate="within"):
            b["zone"] = zones[i]
            break
    print(f"  zones: {len(zones)}, {sum('zone' in b for b in bl)} blocks inside")
    return zones


def _project(coords):
    if isinstance(coords[0], (int, float)):
        return list(xy(*coords))
    return [_project(c) for c in coords]


# --- walking network ---------------------------------------------------------------------------

def walk_graph(nodes, ways, boundary, terrain):
    area = boundary.buffer(600)
    walk = []
    for w in ways:
        t = w["tags"]
        hw = t.get("highway")
        if not (hw in WALK or t.get("foot") in ("yes", "designated")):
            continue
        if t.get("foot") == "no" or (t.get("access") in ("private", "no") and t.get("foot") not in ("yes", "designated", "permissive")):
            continue
        if t.get("area") == "yes":
            continue
        walk.append(w)
    uses = Counter(n for w in walk for n in w["nodes"])
    # Keep intersections, ends, and the interior points a 2 m simplification keeps, so routes still bend
    # with the path; everything else folds into edge lengths.
    index, coords, raw_ids = {}, [], []

    def node(nid, p):
        if nid not in index:
            index[nid] = len(coords)
            coords.append(p)
            raw_ids.append(nid)
        return index[nid]

    edges = []  # (a, b, flags)
    bridge_nodes = set()
    for w in walk:
        ids = [n for n in w["nodes"] if n in nodes]
        if len(ids) < 2:
            continue
        pts = [xy(*nodes[n]) for n in ids]
        if not area.intersects(LineString(pts)):
            continue
        steps = w["tags"].get("highway") == "steps"
        elevated = w["tags"].get("bridge") not in (None, "no") or w["tags"].get("tunnel") not in (None, "no") or w["tags"].get("layer", "0") not in ("0",)
        cut = [0] + [i for i in range(1, len(ids) - 1) if uses[ids[i]] > 1] + [len(ids) - 1]
        for a, b in zip(cut, cut[1:]):
            seg = LineString(pts[a : b + 1])
            keep = {tuple(map(lambda v: round(v, 3), c)) for c in seg.simplify(2).coords}
            chain = [i for i in range(a, b + 1) if i in (a, b) or tuple(map(lambda v: round(v, 3), pts[i])) in keep]
            for i, j in zip(chain, chain[1:]):
                u, v = node(ids[i], pts[i]), node(ids[j], pts[j])
                if u != v:
                    edges.append((u, v, 1 if steps else 0))
                    if elevated:
                        bridge_nodes.update((u, v))
    n = len(coords)
    print(f"  walk graph: {n} nodes, {len(edges)} edges")
    ll = np.array([lonlat(*c) for c in coords])
    elev = np.array([terrain(lon, lat) for lon, lat in ll])
    elev = np.where(np.isnan(elev), np.nanmedian(elev), elev)
    elev = flatten_bridges(n, edges, bridge_nodes, elev, coords)
    return index, coords, ll, elev, edges, raw_ids


def flatten_bridges(n, edges, bridge_nodes, elev, coords):
    """The terrain under a bridge is the valley floor. Walk each run of bridge edges and interpolate
    its height between the two ends where it meets the ground."""
    adj = defaultdict(list)
    for a, b, _ in edges:
        if a in bridge_nodes and b in bridge_nodes:
            adj[a].append(b)
            adj[b].append(a)
    elev = elev.copy()
    seen = set()
    for start in list(adj):
        if start in seen:
            continue
        comp, stack = [], [start]
        seen.add(start)
        while stack:
            u = stack.pop()
            comp.append(u)
            for v in adj[u]:
                if v not in seen:
                    seen.add(v)
                    stack.append(v)
        ends = [u for u in comp if len(adj[u]) == 1] or comp
        if len(ends) < 2:
            continue
        # Interpolate by distance to the two farthest-apart ends.
        a = max(ends, key=lambda u: math.dist(coords[u], coords[ends[0]]))
        b = max(ends, key=lambda u: math.dist(coords[u], coords[a]))
        ea, eb = elev[a], elev[b]
        for u in comp:
            da, db = math.dist(coords[u], coords[a]), math.dist(coords[u], coords[b])
            elev[u] = ea + (eb - ea) * da / max(da + db, 1e-6)
    return elev


def write_walk(path, ll, elev, edges):
    """Little-endian: 'PSW1', node count, half-edge count; then lon, lat as int32 microdegrees
    (delta from the previous node, so it compresses), elevation as int16 decimeters, CSR offsets
    (uint32, n+1), targets (uint32), and a steps bitset over half-edges."""
    n = len(ll)
    adj = [[] for _ in range(n)]
    for a, b, f in edges:
        adj[a].append((b, f))
        adj[b].append((a, f))
    offsets = np.zeros(n + 1, dtype="<u4")
    targets, flags = [], []
    for i, nb in enumerate(adj):
        nb = sorted(set(nb))
        targets += [t for t, _ in nb]
        flags += [f for _, f in nb]
        offsets[i + 1] = len(targets)
    m = len(targets)
    micro = np.round(ll * 1e6).astype(np.int64)
    delta = np.diff(micro, axis=0, prepend=np.zeros((1, 2), dtype=np.int64)).astype("<i4")
    bits = np.packbits(np.array(flags, dtype=np.uint8), bitorder="little")
    with gzip.GzipFile(path, "wb", compresslevel=9, mtime=0) as f:
        f.write(b"PSW1" + struct.pack("<II", n, m))
        f.write(delta[:, 0].tobytes() + delta[:, 1].tobytes())
        f.write(np.round(elev * 10).astype("<i2").tobytes())
        pad = (12 + 8 * n + 2 * n) % 4 and 4 - (12 + 8 * n + 2 * n) % 4
        f.write(b"\0" * pad)
        f.write(offsets.tobytes() + np.array(targets, dtype="<u4").tobytes() + bits.tobytes())


# --- lots --------------------------------------------------------------------------------------

def osm_lots():
    out = []
    for el in json.loads((CACHE / "lots.json").read_text())["elements"]:
        t = el.get("tags", {})
        c = el.get("center") or ({"lon": el["lon"], "lat": el["lat"]} if "lon" in el else None)
        if not c or t.get("access") in ("private", "no", "permit", "employees", "residents", "delivery"):
            continue
        if t.get("parking") in ("street_side", "lane", "carports"):
            continue
        public = t.get("access") in ("yes", "permissive", "destination") or t.get("fee") or t.get("operator") or t.get("parking") in ("multi-storey", "underground")
        if not public and t.get("access") != "customers":
            continue
        out.append({
            "name": t.get("name") or ("Garage" if t.get("parking") in ("multi-storey", "underground") else "Lot"),
            "pt": Point(xy(c["lon"], c["lat"])),
            "fee": t.get("fee"), "customers": t.get("access") == "customers",
            "garage": t.get("parking") in ("multi-storey", "underground"),
            "hours": t.get("opening_hours"), "operator": t.get("operator"),
            "charge": t.get("charge"),
        })
    return out


# --- output ------------------------------------------------------------------------------------

def r5(v):
    return round(v, 5)


def main():
    OUT.mkdir(parents=True, exist_ok=True)
    print("loading")
    nodes, ways = load_osm()
    boundary = city_boundary()
    terrain = Terrain()
    sched = Schedules()

    print("blocks")
    bl = blocks(nodes, ways, boundary)
    print(f"  {len(bl)} blocks")
    ppa_lots = assign_meters(bl, sched)
    zones = assign_zones(bl, sched)

    print("walking")
    index, coords, ll, elev, edges, _ = walk_graph(nodes, ways, boundary, terrain)
    (OUT / "walk.bin").unlink(missing_ok=True)
    write_walk(OUT / "walk.bin.gz", ll, elev, edges)
    pts = np.array(coords)
    grid = defaultdict(list)
    for i, (x, y) in enumerate(pts):
        grid[(int(x // 50), int(y // 50))].append(i)

    def nearest(x, y):
        best, bd = -1, 1e18
        gx, gy = int(x // 50), int(y // 50)
        for r in range(0, 6):
            for dx in range(-r, r + 1):
                for dy in range(-r, r + 1):
                    if max(abs(dx), abs(dy)) != r:
                        continue
                    for i in grid.get((gx + dx, gy + dy), ()):
                        d = (pts[i][0] - x) ** 2 + (pts[i][1] - y) ** 2
                        if d < bd:
                            best, bd = i, d
            if best >= 0 and math.sqrt(bd) < r * 50:
                break
        return best

    print("classifying")
    campus_meter = cmu.street_rule(sched)
    feats, counts = [], Counter()
    for b in bl:
        t = b["way"]["tags"]
        hw = t["highway"]
        tag = parking_tags(t)
        if tag == "x":
            k, s = "x", None
        elif cmu.on_campus_street(short(b["name"]), *lonlat(*b["line"].interpolate(0.5, normalized=True).coords[0])):
            k, s = "m", campus_meter
            b["campus"] = True
        elif "meter" in b:
            k, s = "m", b["meter"]
        elif "zone" in b:
            k, s = "p", b["zone"]["s"]
        elif hw in ARTERIAL and tag != "ok":
            k, s = "u", None
        else:
            k, s = "f", None
        counts[k] += 1
        line = b["line"]
        w = sorted({index[n] for n in (b["nodes"][0], b["nodes"][-1]) if n in index} | {nearest(*line.interpolate(0.5, normalized=True).coords[0])})
        props = {"k": k, "n": short(b["name"]) if b["name"] else "", "w": w}
        if s is not None:
            props["s"] = s
        if "zone" in b:
            props["z"] = b["zone"]["code"]
        if b.get("campus"):
            props["c"] = 1
        if b["ends"][0] or b["ends"][1]:
            props["e"] = [e[0] if e else "" for e in b["ends"]]
        feats.append({"type": "Feature", "properties": props,
                      "geometry": {"type": "LineString", "coordinates": [[r5(a) for a in lonlat(*c)] for c in line.simplify(1.5).coords]}})
    print("  " + ", ".join(f"{k}={v}" for k, v in sorted(counts.items())))

    lots = []
    campus = cmu.facilities(sched)
    campus_pts = [Point(xy(f["lon"], f["lat"])) for f in campus]
    for f, pt in zip(campus, campus_pts):
        lots.append({"type": "Feature", "properties": {**f["props"], "w": [nearest(pt.x, pt.y)]},
                     "geometry": {"type": "Point", "coordinates": [f["lon"], f["lat"]]}})
    # CMU's own records win over OSM's for the same lot.
    near_campus = lambda p: any(p.distance(c) < 70 for c in campus_pts)
    for l in ppa_lots + [l for l in osm_lots() if not near_campus(l["pt"])]:
        x, y = l["pt"].x, l["pt"].y
        p = {"n": l["name"], "w": [nearest(x, y)]}
        if l.get("ppa"):
            p.update(k="ppa", s=l["s"])
        else:
            p["k"] = "garage" if l["garage"] else "lot"
            for key in ("fee", "hours", "operator", "charge"):
                if l.get(key):
                    p[key[0] if key != "charge" else "c"] = l[key]
            if l["customers"]:
                p["cu"] = 1
        lon, lat = lonlat(x, y)
        lots.append({"type": "Feature", "properties": p, "geometry": {"type": "Point", "coordinates": [r5(lon), r5(lat)]}})
    print(f"  lots: {len(lots)}")

    zone_feats = []
    for z in zones:
        g = z["poly"].simplify(4)
        def ring(r):
            return [[r5(a) for a in lonlat(*c)] for c in r.coords]
        polys = [g] if g.geom_type == "Polygon" else list(g.geoms)
        zone_feats.append({"type": "Feature", "properties": {"z": z["code"], "a": z["area"], "s": z["s"]},
                           "geometry": {"type": "MultiPolygon", "coordinates": [[ring(p.exterior)] + [ring(i) for i in p.interiors] for p in polys]}})

    meta = {
        "built": datetime.now(timezone.utc).strftime("%Y-%m-%d"),
        "sources": [
            {"name": "OpenStreetMap", "url": "https://www.openstreetmap.org/copyright", "asOf": date.today().isoformat()},
            {"name": "City of Pittsburgh: Parking Authority meters", "url": "https://pghgishub-pittsburghpa.opendata.arcgis.com/datasets/pittsburghpa::pittsburgh-parking-authority-terminals", "asOf": "2018-04"},
            {"name": "City of Pittsburgh: Residential Permit Parking areas", "url": "https://data.wprdc.org/dataset/residential-permit-parking-program-areas", "asOf": "2025-11"},
            {"name": "WPRDC: payment points and rates", "url": "https://data.wprdc.org/dataset/pittsburgh-parking-meters-and-payment-points", "asOf": "2019-01"},
            {"name": "Pittsburgh Parking Authority: meter policies and holidays", "url": "https://www.pittsburghparking.com/Enforcement-and-Metered-Parking/Meter-Policies", "asOf": "2026"},
        ],
        "campus": cmu.meta(),
    }

    dump(OUT / "parking.json", {"type": "FeatureCollection", "schedules": sched.items, "features": feats})
    dump(OUT / "lots.json", {"type": "FeatureCollection", "features": lots})
    dump(OUT / "zones.json", {"type": "FeatureCollection", "features": zone_feats})
    dump(OUT / "meta.json", meta)
    for p in sorted(OUT.iterdir()):
        print(f"  {p.name} {p.stat().st_size / 1e6:.2f} MB")


def dump(path, obj):
    path.write_text(json.dumps(obj, separators=(",", ":")))


if __name__ == "__main__":
    sys.exit(main())

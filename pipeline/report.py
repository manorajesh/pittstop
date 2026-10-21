"""Sanity checks on the built data: class counts, and blocks around Oakland that should come out a known way."""

import json
import math
import sys
from collections import Counter
from pathlib import Path

DATA = Path(__file__).parent.parent / "public" / "data"
NAMES = {"f": "free", "m": "metered", "p": "permit zone", "u": "unverified", "x": "no parking"}

# (label, lon, lat, street, expected class)
CHECKS = [
    ("Tech St at CMU (dynamic rate)", -79.9440, 40.4425, "Tech St", "m"),
    ("Forbes by Cathedral of Learning", -79.9535, 40.4424, "Forbes Ave", "m"),
    ("S Craig by Forbes", -79.9483, 40.4445, "South Craig St", "m"),
    ("Frew by CMU", -79.9445, 40.4419, "Frew St", "m"),
    ("Forbes by CMU has no meters", -79.9431, 40.4440, "Forbes Ave", "u"),
]


def mid(coords):
    return coords[len(coords) // 2]


def dist(a, b):
    kx = 111320 * math.cos(math.radians(40.44))
    return math.hypot((a[0] - b[0]) * kx, (a[1] - b[1]) * 110540)


def main():
    parking = json.loads((DATA / "parking.json").read_text())
    feats = parking["features"]
    print("blocks:", ", ".join(f"{NAMES[k]} {v}" for k, v in Counter(f["properties"]["k"] for f in feats).most_common()))
    print("schedules:", len(parking["schedules"]))
    failed = 0
    for label, lon, lat, street, want in CHECKS:
        near = [f for f in feats if f["properties"]["n"] == street and dist(mid(f["geometry"]["coordinates"]), (lon, lat)) < 250]
        kinds = Counter(f["properties"]["k"] for f in near)
        ok = kinds.get(want, 0) > 0
        failed += not ok
        print(f"  {'ok ' if ok else 'BAD'} {label}: {dict(kinds) or 'no blocks within 250 m'}")
    zones = Counter(f["properties"].get("z") for f in feats if f["properties"]["k"] == "p")
    print("permit blocks by zone:", ", ".join(f"{z} {n}" for z, n in zones.most_common(12)))
    return 1 if failed else 0


if __name__ == "__main__":
    sys.exit(main())

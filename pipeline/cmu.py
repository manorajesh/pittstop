"""Carnegie Mellon's campus, from the hand-checked cmu.json: garages with CMU's posted tariffs, the
Morewood visitor lot, permit-only lots, and the city meters on Frew, Tech and Margaret Morrison.
These replace whatever OpenStreetMap and the old city meter records say about the same places."""

import json
from pathlib import Path

import schedules as S

CMU = json.loads((Path(__file__).parent / "cmu.json").read_text())
MAP = "https://map.concept3d.com/?id=192#!m/{}"


def _windows(spec):
    return [w for item in spec for w in S.weekly(item["days"], item["hours"])]


def tiers(t):
    return [[m if m is not None else 10**6, c] for m, c in t]


def facilities(sched):
    """Every CMU facility as {name, lon, lat, props}; props go straight onto the lot feature."""
    overnight = S.weekly("Mon - Sun", CMU["overnight"]["hours"])
    out = []
    for g in CMU["garages"]:
        rule = {
            "kind": "garage", "owner": "cmu",
            "tiers": tiers(g["tiers"]),
            "closed": overnight,
            "flat": _windows(g.get("flat", [])),
            "flatCents": g.get("flatCents"),
        }
        if "affiliateTiers" in g:
            rule["aff"] = tiers(g["affiliateTiers"])
            rule["affFlatCents"] = g.get("affiliateFlatCents")
        out.append(_item(g, "garage", sched.add(rule), visitor=True))
    for l in CMU["lots"]:
        rule = {"kind": "meter", "owner": "cmu", "pay": [[s, e, None] for s, e in _windows(l["pay"])], "max": None, "no": [], "dynamic": False, "assumed": False}
        out.append(_item(l, "lot", sched.add(rule), visitor=True))
    private = sched.add({"kind": "private", "owner": "cmu"})
    for l in CMU["permitOnly"]:
        out.append(_item({**l, "note": "CMU permit holders only.", "sources": ["map", "policies"]}, "lot", private, visitor=False))
    return out


def _item(f, kind, s, visitor):
    props = {"k": "cmu", "n": f["name"], "s": s, "g": kind == "garage", "src": f["sources"], "m": f["map"]}
    for key, short in (("spaces", "sp"), ("address", "a"), ("note", "nt")):
        if f.get(key):
            props[short] = f[key]
    if not visitor:
        props["po"] = 1
    return {"name": f["name"], "lon": f["lon"], "lat": f["lat"], "props": props}


def street_rule(sched):
    st = CMU["streets"]
    rule = {"kind": "meter", "pay": [[s, e, None] for s, e in _windows(st["pay"])], "max": st["maxHours"] * 60, "no": [], "dynamic": True, "assumed": False}
    return sched.add(rule)


def on_campus_street(name, lon, lat):
    st = CMU["streets"]
    w, s, e, n = st["bbox"]
    return name in st["names"] and w <= lon <= e and s <= lat <= n


def meta():
    sources = {k: {**v, "checked": CMU["checked"]} for k, v in CMU["sources"].items()}
    return {"checked": CMU["checked"], "sources": sources, "mapLink": MAP, "streetNote": CMU["streets"]["note"], "streetSources": CMU["streets"]["sources"], "overnight": CMU["overnight"]["note"]}

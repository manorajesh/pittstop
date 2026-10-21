"""Turn the free-text hours, rates and limits in the city's parking data into week-minute intervals.

A week minute counts from Monday 00:00 (0) to the next Monday (10080). Intervals are [start, end),
and one that runs past midnight is kept whole: Fri 8a-12a is [6720, 7200]."""

import re

WEEK = 7 * 24 * 60
DAYS = {"mon": 0, "tue": 1, "wed": 2, "thu": 3, "fri": 4, "sat": 5, "sun": 6, "m": 0, "f": 4}


def day(token: str) -> int:
    token = token.strip().lower()
    for prefix in (token[:3], token[:1]):
        if prefix in DAYS:
            return DAYS[prefix]
    raise ValueError(f"not a day: {token!r}")


def days(text: str) -> list[int]:
    """'Mon - Sat' -> [0..5], 'M-F' -> [0..4], 'Fri - Sat' -> [4, 5]."""
    text = text.strip()
    if "-" in text:
        a, b = (day(t) for t in text.split("-", 1))
        return list(range(a, b + 1)) if a <= b else list(range(a, 7)) + list(range(0, b + 1))
    return [day(text)]


def clock(text: str) -> int:
    """'8AM', '8a', '7:00 AM', '12:00 AM', '10' (with an am/pm carried in) -> minutes after midnight."""
    m = re.fullmatch(r"\s*(\d{1,2})(?::(\d{2}))?\s*([ap])?\.?m?\.?\s*", text.lower())
    if not m:
        raise ValueError(f"not a time: {text!r}")
    h, mins, half = int(m[1]), int(m[2] or 0), m[3]
    if half == "p" and h != 12:
        h += 12
    if half == "a" and h == 12:
        h = 0
    return h * 60 + mins


def span(text: str) -> tuple[int, int]:
    """'~ 8AM - 6PM' -> (480, 1080). An end at or before the start runs past midnight: '8AM - 12AM' -> (480, 1440)."""
    text = text.replace("~", "").strip()
    a, b = (t.strip() for t in re.split(r"\s*-\s*", text, maxsplit=1))
    # '7-10AM': the start borrows the end's half of the day.
    if not re.search(r"[ap]", a, re.I):
        a += re.search(r"[ap]", b, re.I)[0]
    start, end = clock(a), clock(b)
    if end <= start:
        end += 24 * 60
    return start, end


def weekly(day_text: str, time_text: str) -> list[list[int]]:
    """One interval per day the hours apply."""
    start, end = span(time_text)
    return [[d * 1440 + start, d * 1440 + end] for d in days(day_text)]


def money(text: str) -> int | None:
    """'$1.50 Per Hour', '$3/hr' -> cents per hour. 'Dynamic' and blanks -> None."""
    m = re.search(r"\$\s*(\d+(?:\.\d+)?)", text or "")
    return round(float(m[1]) * 100) if m else None


def hours_limit(text: str) -> int | None:
    """'2 Hours', '4 HRS' -> minutes. 'No Max' and blanks -> None."""
    m = re.search(r"(\d+(?:\.\d+)?)\s*h", (text or "").lower())
    return round(float(m[1]) * 60) if m else None


def blank(v) -> bool:
    return v is None or not str(v).strip()


def meter(p: dict) -> dict:
    """A city GIS terminal (PGHWebPPATerminals) -> {pay: [[s, e, cents|None]], max, no: [[s, e]], dynamic}."""
    rate = money(p.get("rate"))
    dynamic = (p.get("rate") or "").strip().lower() == "dynamic"
    pay = []
    for dt, tt in ((p.get("date1"), p.get("time1")), (p.get("date2"), p.get("time2"))):
        if blank(dt) or blank(tt):
            continue
        for s, e in weekly(dt, tt):
            pay.append([s, e, rate])
    # A second rate for part of the day: rate applies over ratetimea, rate2 over ratetimeb.
    rate2 = money(p.get("rate2"))
    if rate2 is not None and not blank(p.get("ratetimea")) and not blank(p.get("ratetimeb")):
        a, b = span(p["ratetimea"]), span(p["ratetimeb"])
        split = []
        for s, e, r in pay:
            base = s - s % 1440
            for (ws, we), wr in ((a, rate), (b, rate2)):
                lo, hi = max(s, base + ws), min(e, base + we)
                if lo < hi:
                    split.append([lo, hi, wr])
        pay = split or pay
    no = []
    if not blank(p.get("restdates")):
        for t in (p.get("resttime1"), p.get("resttime2")):
            if not blank(t):
                no += weekly(p["restdates"], t)
    elif not blank(p.get("restrictio")):
        no = restrictions(p["restrictio"])
    return {"pay": sorted(pay), "max": hours_limit(p.get("maxhours")), "no": sorted(no), "dynamic": dynamic}


def restrictions(text: str) -> list[list[int]]:
    """'M-F, 7AM-9AM, 4PM-6PM' -> no-parking intervals."""
    parts = [t.strip() for t in text.split(",")]
    out = []
    for t in parts[1:]:
        out += weekly(parts[0], t)
    return out


def meter_csv(row: dict) -> dict:
    """A WPRDC rates row, used when the GIS terminal has no hours: hours like 'M-Thur, 8a-6p F-Sat 8a-12a'."""
    rate = money(row.get("rate"))
    pay = []
    for dt, tt in re.findall(r"([A-Za-z]+\s*-\s*[A-Za-z]+),?\s*(\d{1,2}[ap]?\s*-\s*\d{1,2}[ap])", row.get("hours") or ""):
        for s, e in weekly(dt, tt):
            pay.append([s, e, rate])
    no = restrictions(row["restrictions"]) if not blank(row.get("restrictions")) else []
    return {"pay": sorted(pay), "max": hours_limit(row.get("max_hours")), "no": sorted(no), "dynamic": (row.get("rate") or "").lower() == "dynamic"}


RPP_DAYS = ["monday", "tuesday", "wednesday", "thursday", "friday", "saturday", "sunday"]


def permit(p: dict) -> dict:
    """An RPP zone -> {lim: [[s, e]], grace: minutes, assumed: bool}. Missing hours fall back to the common
    Mon-Sat 7a-7p, flagged so the page can say so."""
    lim = []
    for d, name in enumerate(RPP_DAYS):
        v = p.get(name)
        if blank(v) or str(v).strip().lower() == "none":
            continue
        s, e = span(v)
        lim.append([d * 1440 + s, d * 1440 + e])
    assumed = not lim
    if assumed:
        lim = weekly("Mon - Sat", "7AM - 7PM")
    # '1 & 2 Hours' varies by block; take the shorter so we never promise too much.
    g = re.findall(r"\d+", p.get("grace_period") or "")
    grace = min(int(x) for x in g) * 60 if g else 60
    return {"lim": lim, "grace": grace, "assumed": assumed or not g}

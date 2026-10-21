import { useCallback, useEffect, useMemo, useRef, useState } from "preact/hooks";
import { Data, load, Option, rank, Results, verdictsFor } from "./data";
import { COLORS, ParkingMap } from "./map";
import { clock, describe, fromLocal, MAX_WINDOW_MIN, money, toLocal, Verdict, Window } from "./rules";
import type { Route } from "./walk";

// Pitt stop: drop a pin, say when, and see where to leave the car. Chrome follows the site's ph-*
// boxes and pills in city-steps' dark palette, with Pittsburgh gold for what's free.

const PLACES: { name: string; at: [number, number] }[] = [
  { name: "CMU", at: [-79.9437, 40.4432] },
  { name: "Cathedral of Learning", at: [-79.9532, 40.4443] },
  { name: "Phipps", at: [-79.9475, 40.4389] },
  { name: "UPMC Presby", at: [-79.9608, 40.4419] },
];
const DURATIONS = [1, 2, 4, 8];
const LEGEND: [keyof typeof COLORS, string][] = [
  ["free", "Free"],
  ["paid", "Paid"],
  ["limit", "Time limit too short"],
  ["no", "No parking"],
  ["unknown", "No data"],
];

// --- hash state: #at=40.44,-79.95&from=2026-10-21T14:00&to=2026-10-21T16:00 ---------------------

function readHash() {
  const h = new URLSearchParams(location.hash.slice(1));
  const at = h.get("at")?.split(",").map(Number);
  const from = h.get("from");
  const to = h.get("to");
  return {
    pin: at && at.length === 2 && at.every(isFinite) ? ([at[1], at[0]] as [number, number]) : null,
    win: from && to ? { from: fromLocal(from), to: fromLocal(to) } : null,
  };
}

function writeHash(pin: [number, number] | null, win: Window, custom: boolean) {
  const h = new URLSearchParams();
  if (pin) h.set("at", `${pin[1].toFixed(5)},${pin[0].toFixed(5)}`);
  if (custom) {
    h.set("from", toLocal(win.from));
    h.set("to", toLocal(win.to));
  }
  const s = h.toString().replace(/%2C/g, ",").replace(/%3A/g, ":");
  history.replaceState(null, "", s ? `#${s}` : location.pathname + location.search);
}

function soon(): Window {
  const q = 15 * 60000;
  const from = Math.ceil(Date.now() / q) * q;
  return { from, to: from + 2 * 3600000 };
}

// --- walking worker ----------------------------------------------------------------------------

class Walker {
  private worker = new Worker(new URL("./walk.worker.ts", import.meta.url), { type: "module" });
  private waiting = new Map<number, (v: any) => void>();
  private seq = 0;
  loaded: Promise<unknown> | null = null;
  constructor() {
    this.worker.onmessage = (e) => {
      const done = this.waiting.get(e.data.id);
      this.waiting.delete(e.data.id);
      done?.(e.data);
    };
  }
  private ask<T>(msg: object): Promise<T> {
    const id = ++this.seq;
    return new Promise((resolve, reject) => {
      this.waiting.set(id, (d) => (d.error ? reject(new Error(d.error)) : resolve(d)));
      this.worker.postMessage({ ...msg, id });
    });
  }
  load(url: string) {
    return (this.loaded ??= this.ask({ type: "load", url }));
  }
  async walk(lon: number, lat: number) {
    await this.loaded;
    return this.ask<{ time: Float32Array; snapMeters: number }>({ type: "walk", lon, lat });
  }
  async route(node: number) {
    return (await this.ask<{ route: Route | null }>({ type: "route", node })).route;
  }
}

// --- page ----------------------------------------------------------------------------------------

export function App() {
  const mapEl = useRef<HTMLDivElement>(null);
  const mapRef = useRef<ParkingMap | null>(null);
  const walker = useMemo(() => new Walker(), []);
  const initial = useMemo(readHash, []);

  const [data, setData] = useState<Data | null>(null);
  const [error, setError] = useState("");
  const [mapReady, setMapReady] = useState(false);
  const [win, setWin] = useState<Window>(initial.win ?? soon());
  const [customWin, setCustomWin] = useState(!!initial.win);
  const [pin, setPin] = useState<[number, number] | null>(initial.pin);
  const [times, setTimes] = useState<{ time: Float32Array; snapMeters: number } | null>(null);
  const [walking, setWalking] = useState(false);
  const [selected, setSelected] = useState<Option | null>(null);
  const [route, setRoute] = useState<Route | null>(null);
  const [whenOpen, setWhenOpen] = useState(false);
  const [sheetOpen, setSheetOpen] = useState(false);
  const [showMisfit, setShowMisfit] = useState(false);
  const [hover, setHover] = useState<{ name: string; verdict: Verdict; x: number; y: number } | null>(null);

  useEffect(() => {
    const title = document.title;
    document.title = "pitt stop — mano";
    return () => {
      document.title = title;
    };
  }, []);

  // The map lives as long as the page; the data loads alongside the style.
  useEffect(() => {
    const m = new ParkingMap(mapEl.current!, {
      pin: (lon, lat) => setPin([lon, lat]),
      hover: setHover,
      ready: () => setMapReady(true),
    });
    mapRef.current = m;
    load().then(setData).catch((e: Error) => setError(e.message));
    return () => m.dispose();
  }, []);

  useEffect(() => {
    if (!mapReady || !data) return;
    mapRef.current!.setData(data);
    // The walking network waits for the first paint, then loads in the background.
    const idle = (window as any).requestIdleCallback ?? ((f: () => void) => setTimeout(f, 300));
    idle(() => walker.load(import.meta.env.BASE_URL + "data/walk.bin").catch((e: Error) => setError(e.message)));
  }, [mapReady, data, walker]);

  const verdicts = useMemo(() => (data ? verdictsFor(data, win) : []), [data, win]);
  useEffect(() => {
    if (mapReady && data) mapRef.current!.setVerdicts(verdicts);
  }, [verdicts, mapReady, data]);

  useEffect(() => writeHash(pin, win, customWin), [pin, win, customWin]);

  // A new pin: walk times from it to everywhere within reach.
  useEffect(() => {
    mapRef.current?.setPin(pin);
    setSelected(null);
    setTimes(null);
    if (!pin) return;
    setSheetOpen(true);
    let live = true;
    setWalking(true);
    walker.load(import.meta.env.BASE_URL + "data/walk.bin");
    walker
      .walk(pin[0], pin[1])
      .then((t) => live && setTimes(t))
      .catch((e: Error) => live && setError(e.message))
      .finally(() => live && setWalking(false));
    return () => {
      live = false;
    };
  }, [pin, walker]);

  const results: Results | null = useMemo(() => (data && times ? rank(data, verdicts, times.time) : null), [data, verdicts, times]);

  // Keep the selection in step with a changed window.
  useEffect(() => {
    if (!selected || !results) return;
    const all = [...results.free, ...results.paid, ...results.misfit];
    const same = all.find((o) => o.kind === selected.kind && o.id === selected.id);
    if (same && same !== selected) setSelected(same);
  }, [results]);

  useEffect(() => {
    const m = mapRef.current;
    if (!m || !mapReady || !data) return;
    m.focus(selected);
    if (!selected) {
      m.setRoute(null);
      setRoute(null);
      return;
    }
    let live = true;
    walker.route(selected.node).then((r) => {
      if (!live) return;
      setRoute(r);
      m.setRoute(r ? [pin!, ...r.coords] : null);
      if (r) m.frame([pin!, ...r.coords], framePadding());
    });
    return () => {
      live = false;
    };
  }, [selected?.kind, selected?.id, mapReady, data]);

  const changeWin = useCallback((w: Window) => {
    setCustomWin(true);
    setWin(w);
  }, []);

  const locate = useCallback(() => {
    navigator.geolocation?.getCurrentPosition(
      (p) => {
        const at: [number, number] = [p.coords.longitude, p.coords.latitude];
        setPin(at);
        mapRef.current?.setPin(at, true);
      },
      () => setError("Couldn't get your location"),
      { enableHighAccuracy: true, timeout: 8000 }
    );
  }, []);

  const goTo = useCallback((at: [number, number]) => {
    setPin(at);
    mapRef.current?.setPin(at, true);
  }, []);

  const loading = !data || !mapReady;

  return (
    <div class={`ps-root${loading ? " ps-busy" : ""}`}>
      <div ref={mapEl} class="ps-map" />

      <nav class="ph-top ps-top">
        <a class="ph-box ph-brand" href={import.meta.env.BASE_URL} onClick={(e) => { e.preventDefault(); setPin(null); }}>
          <span class="ps-gold">pitt</span>stop
        </a>
        <button class={`ph-box${whenOpen ? " ph-box-active" : ""}`} aria-expanded={whenOpen} onClick={() => setWhenOpen((o) => !o)}>
          <span class="ps-when-label">When</span>
          <b>{windowText(win)}</b>
        </button>
      </nav>

      {whenOpen && <When win={win} onChange={changeWin} onClose={() => setWhenOpen(false)} />}

      <aside class={`ps-sheet${sheetOpen ? " ps-sheet-open" : ""}`} aria-label="Parking near the pin">
        <button class="ps-handle" aria-label={sheetOpen ? "Collapse" : "Expand"} onClick={() => setSheetOpen((o) => !o)}>
          <i />
        </button>
        <Search onPick={goTo} onLocate={locate} />
        {!pin ? (
          <div class="ps-empty">
            <h1>Where are you headed?</h1>
            <p>Tap the map where you're going. You'll get the closest free parking by walking time, hills included, plus what the meters and garages nearby would cost for your hours.</p>
            <div class="ps-chips">
              {PLACES.map((p) => (
                <button key={p.name} class="ph-pill" onClick={() => goTo(p.at)}>
                  {p.name}
                </button>
              ))}
            </div>
          </div>
        ) : !results ? (
          <div class="ps-empty">
            <p class="ps-quiet">{walking || !data ? "Walking the neighborhood…" : "Couldn't reach the walking network from here."}</p>
          </div>
        ) : (
          <div class="ps-results">
            {times && times.snapMeters > 150 && <p class="ps-warn">That pin is {Math.round(times.snapMeters)} m from the nearest sidewalk, so walk times are rough.</p>}
            <Group title="Free" options={results.free} selected={selected} onSelect={setSelected} empty="Nothing free within a 25-minute walk for these hours." route={route} />
            <Group title="Paid" options={results.paid} selected={selected} onSelect={setSelected} empty="No meters or paid lots nearby." route={route} />
            {results.misfit.length > 0 && (
              <button class="ps-more" onClick={() => setShowMisfit((s) => !s)}>
                {showMisfit ? "Hide" : "Show"} {results.misfit.length} nearby that won't work for these hours
              </button>
            )}
            {showMisfit && <Group title="Won't work" options={results.misfit} selected={selected} onSelect={setSelected} route={route} />}
            {results.unknown > 0 && <p class="ps-quiet ps-foot">{results.unknown} nearby blocks are main roads with no parking data. They're drawn in gray.</p>}
          </div>
        )}
        {data && <Sources data={data} />}
      </aside>

      <div class="ps-legend" aria-label="Legend">
        {LEGEND.map(([k, label]) => (
          <span key={k}>
            <i style={{ background: COLORS[k] }} />
            {label}
          </span>
        ))}
        <span>
          <i class="ps-dash" />
          Permit zone
        </span>
      </div>

      {hover && (
        <div class="ps-tip" style={{ left: hover.x + 14, top: hover.y + 14 }}>
          <b>{hover.name}</b>
          <span style={{ color: COLORS[hover.verdict.status] }}>{statusText(hover.verdict)}</span>
          <em>{hover.verdict.note}</em>
        </div>
      )}

      {(loading || error) && (
        <div class={`ps-loading${error ? " ps-loading-error" : ""}`}>
          <p>{error ? `${error}. Reload to try again.` : "Loading the streets"}</p>
        </div>
      )}
    </div>
  );
}

function framePadding() {
  const narrow = innerWidth < 720;
  return narrow ? { top: 80, right: 40, bottom: innerHeight * 0.55, left: 40 } : { top: 90, right: 420, bottom: 60, left: 60 };
}

// --- pieces --------------------------------------------------------------------------------------

function When({ win, onChange, onClose }: { win: Window; onChange: (w: Window) => void; onClose: () => void }) {
  const hours = (win.to - win.from) / 3600000;
  const tooLong = win.to - win.from > MAX_WINDOW_MIN * 60000;
  const set = (from: number, to: number) => onChange({ from, to: Math.max(to, from + 15 * 60000) });
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => e.key === "Escape" && onClose();
    addEventListener("keydown", onKey);
    return () => removeEventListener("keydown", onKey);
  }, [onClose]);
  return (
    <div class="ps-when" role="dialog" aria-label="When you need parking">
      <label>
        <span class="ps-label">From</span>
        <input type="datetime-local" step={900} value={toLocal(win.from)} onInput={(e) => {
          const from = fromLocal((e.target as HTMLInputElement).value);
          if (isFinite(from)) set(from, from + (win.to - win.from));
        }} />
      </label>
      <label>
        <span class="ps-label">To</span>
        <input type="datetime-local" step={900} value={toLocal(win.to)} onInput={(e) => {
          const to = fromLocal((e.target as HTMLInputElement).value);
          if (isFinite(to)) set(win.from, to);
        }} />
      </label>
      <div class="ps-chips">
        <button class="ph-pill" onClick={() => { const s = soon(); set(s.from, s.from + (win.to - win.from)); }}>
          Now
        </button>
        {DURATIONS.map((h) => (
          <button key={h} class={`ph-pill${Math.abs(hours - h) < 0.01 ? " ph-pill-active" : ""}`} onClick={() => set(win.from, win.from + h * 3600000)}>
            {h} hr
          </button>
        ))}
        <button class="ph-pill" onClick={() => {
          // Until 8 AM the next morning.
          const next = fromLocal(toLocal(win.from + 86400000).slice(0, 10) + "T08:00");
          set(win.from, next);
        }}>
          Overnight
        </button>
      </div>
      {tooLong && <p class="ps-warn">Windows longer than a week are checked for their first seven days.</p>}
      <button class="ps-done" onClick={onClose}>Done</button>
    </div>
  );
}

function Group({ title, options, selected, onSelect, empty, route }: {
  title: string;
  options: Option[];
  selected: Option | null;
  onSelect: (o: Option | null) => void;
  empty?: string;
  route: Route | null;
}) {
  return (
    <section class="ps-group">
      <h2 class="ps-label">{title}</h2>
      {!options.length && empty && <p class="ps-quiet">{empty}</p>}
      <ul>
        {options.map((o) => {
          const on = selected?.kind === o.kind && selected.id === o.id;
          return (
            <li key={`${o.kind}${o.id}`}>
              <button class={`ps-row${on ? " ps-row-on" : ""}`} aria-expanded={on} onClick={() => onSelect(on ? null : o)}>
                <span class="ps-min">
                  {Math.max(1, Math.round(o.seconds / 60))}
                  <small>min</small>
                </span>
                <span class="ps-what">
                  <b>
                    <i class="ps-dot" style={{ background: COLORS[o.verdict.status] }} />
                    {o.name}
                    {o.zone && <sup>Zone {o.zone}</sup>}
                  </b>
                  {o.between && <span>{o.between}</span>}
                  <em>{o.verdict.note}</em>
                  {on && (
                    <span class="ps-detail">
                      {o.schedule && <span>{describe(o.schedule)}</span>}
                      {o.lot?.h && <span>Hours {o.lot.h}</span>}
                      {route && <span>{routeText(route)}</span>}
                    </span>
                  )}
                </span>
                <span class="ps-price">{priceText(o.verdict)}</span>
              </button>
            </li>
          );
        })}
      </ul>
    </section>
  );
}

function Search({ onPick, onLocate }: { onPick: (at: [number, number]) => void; onLocate: () => void }) {
  const [q, setQ] = useState("");
  const [hits, setHits] = useState<{ name: string; sub: string; at: [number, number] }[]>([]);
  useEffect(() => {
    if (q.trim().length < 3) return setHits([]);
    const ctl = new AbortController();
    const t = setTimeout(() => {
      const url = `https://photon.komoot.io/api/?q=${encodeURIComponent(q)}&bbox=-80.1,40.36,-79.86,40.5&lat=40.444&lon=-79.95&limit=5&lang=en`;
      fetch(url, { signal: ctl.signal })
        .then((r) => r.json())
        .then((d) =>
          setHits(
            d.features.map((f: any) => ({
              name: f.properties.name || [f.properties.housenumber, f.properties.street].filter(Boolean).join(" "),
              sub: [f.properties.street && f.properties.name ? f.properties.street : "", f.properties.district || f.properties.city].filter(Boolean).join(", "),
              at: f.geometry.coordinates,
            }))
          )
        )
        .catch(() => {});
    }, 250);
    return () => {
      clearTimeout(t);
      ctl.abort();
    };
  }, [q]);
  return (
    <div class="ps-search">
      <input type="search" placeholder="Search a place in Pittsburgh" value={q} onInput={(e) => setQ((e.target as HTMLInputElement).value)} aria-label="Search a place" />
      <button class="ps-locate" onClick={onLocate} aria-label="Use my location" title="Use my location">
        <svg viewBox="0 0 16 16" aria-hidden="true">
          <circle cx="8" cy="8" r="4.5" />
          <path d="M8 0.5v3M8 12.5v3M0.5 8h3M12.5 8h3" />
        </svg>
      </button>
      {hits.length > 0 && (
        <ul class="ps-hits">
          {hits.map((h, i) => (
            <li key={i}>
              <button onClick={() => { onPick(h.at); setQ(""); setHits([]); }}>
                {h.name}
                <span>{h.sub}</span>
              </button>
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}

function Sources({ data }: { data: Data }) {
  return (
    <footer class="ps-sources">
      <p>Signs on the street win. This map reads city and OpenStreetMap records, which miss street cleaning, loading zones, and new signs.</p>
      <p>
        {data.meta.sources.map((s, i) => (
          <span key={s.url}>
            {i > 0 && " · "}
            <a href={s.url} target="_blank" rel="noreferrer">{s.name}</a> ({s.asOf})
          </span>
        ))}
        {" · "}
        <a href="https://openfreemap.org" target="_blank" rel="noreferrer">OpenFreeMap</a>
      </p>
    </footer>
  );
}

// --- text ----------------------------------------------------------------------------------------

function windowText(w: Window) {
  const a = clock(w.from);
  const b = clock(w.to, w.from);
  return `${a} – ${b}`;
}

function statusText(v: Verdict) {
  if (v.status === "paid") return v.cents != null ? `Paid · ${money(v.cents)}` : "Paid";
  return { free: "Free", limit: "Time limit too short", no: "No parking", unknown: "No data" }[v.status];
}

function priceText(v: Verdict) {
  if (v.status === "free") return "Free";
  if (v.status === "paid") return v.cents != null ? money(v.cents) : "$?";
  if (v.status === "limit") return "Limit";
  if (v.status === "no") return "No";
  return "?";
}

function routeText(r: Route) {
  const bits = [`${Math.round(r.meters / 10) * 10} m walk`];
  if (r.climb >= 8) bits.push(`${Math.round(r.climb)} m uphill`);
  if (r.flights) bits.push(`via ${r.flights} ${r.flights === 1 ? "flight" : "flights"} of city steps`);
  return bits.join(" · ");
}

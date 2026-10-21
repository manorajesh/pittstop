import { useCallback, useEffect, useMemo, useRef, useState } from "preact/hooks";
import { Data, load, Option, rank, Results, sourcesFor, verdictsFor } from "./data";
import { COLORS, ParkingMap } from "./map";
import { clock, describe, fromLocal, MAX_WINDOW_MIN, money, Status, toLocal, Verdict, Who, Window } from "./rules";
import { buildIndex, Hit, search } from "./search";
import { Tour } from "./tour";
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
const LEGEND: [Status, string][] = [
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

// Per-viewer conveniences; the page works the same without storage.
const SHOW_KEY = "pittstop:show";
const CMU_KEY = "pittstop:cmu";
const ALL: Status[] = ["free", "paid", "limit", "no", "unknown"];
function stored<T>(key: string, fallback: T): T {
  try {
    const v = localStorage.getItem(key);
    return v == null ? fallback : JSON.parse(v);
  } catch {
    return fallback;
  }
}
function store(key: string, value: unknown) {
  try {
    localStorage.setItem(key, JSON.stringify(value));
  } catch {}
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
  // Phones only: how far the bottom sheet is pulled up.
  const [sheet, setSheet] = useState<Sheet>("half");
  const [locating, setLocating] = useState(false);
  const [notice, setNotice] = useState("");
  const [privacyOpen, setPrivacyOpen] = useState(false);
  const [showMisfit, setShowMisfit] = useState(false);
  const [hover, setHover] = useState<{ name: string; verdict: Verdict; x: number; y: number } | null>(null);
  const [show, setShow] = useState<Set<Status>>(() => new Set(stored<Status[]>(SHOW_KEY, ALL).filter((s) => ALL.includes(s))));
  const [who, setWho] = useState<Who>(() => ({ cmu: stored(CMU_KEY, false) }));
  const [touring, setTouring] = useState(false);

  // A legend key toggles its status; with everything off, clicking one shows just that one again.
  const toggle = useCallback((k: Status) => {
    setShow((cur) => {
      const next = new Set(cur);
      if (next.has(k)) next.delete(k);
      else next.add(k);
      store(SHOW_KEY, [...next]);
      return next;
    });
  }, []);
  const only = useCallback((k: Status) => {
    setShow((cur) => {
      const next = cur.size === 1 && cur.has(k) ? new Set(ALL) : new Set([k]);
      store(SHOW_KEY, [...next]);
      return next;
    });
  }, []);
  const changeWho = useCallback((w: Who) => {
    setWho(w);
    store(CMU_KEY, w.cmu);
  }, []);

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
      pin: (lon, lat) => {
        setNotice("");
        setPin([lon, lat]);
      },
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
    idle(() => walker.load(import.meta.env.BASE_URL + "data/walk.bin.gz").catch((e: Error) => setError(e.message)));
  }, [mapReady, data, walker]);

  const verdicts = useMemo(() => (data ? verdictsFor(data, win, who) : []), [data, win, who]);
  useEffect(() => {
    if (mapReady && data) mapRef.current!.setVerdicts(verdicts, show);
  }, [verdicts, show, mapReady, data]);

  useEffect(() => writeHash(pin, win, customWin), [pin, win, customWin]);

  // A new pin: walk times from it to everywhere within reach.
  useEffect(() => {
    mapRef.current?.setPin(pin);
    setSelected(null);
    setTimes(null);
    if (!pin) return;
    setSheet((s) => (s === "full" ? s : "half"));
    let live = true;
    setWalking(true);
    walker.load(import.meta.env.BASE_URL + "data/walk.bin.gz");
    walker
      .walk(pin[0], pin[1])
      .then((t) => live && setTimes(t))
      .catch((e: Error) => live && setError(e.message))
      .finally(() => live && setWalking(false));
    return () => {
      live = false;
    };
  }, [pin, walker]);

  const results: Results | null = useMemo(() => (data && times ? rank(data, verdicts, times.time, show) : null), [data, verdicts, times, show]);

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

  // Your position stays on this device: it moves the pin and the "you" dot, and nothing else.
  const locate = useCallback(() => {
    if (!("geolocation" in navigator) || !isSecureContext) {
      setNotice("This browser can't share its location here. Search or tap the map instead.");
      return;
    }
    setLocating(true);
    setNotice("");
    const found = (p: GeolocationPosition) => {
      setLocating(false);
      const at: [number, number] = [p.coords.longitude, p.coords.latitude];
      if (!inPittsburgh(at)) {
        setNotice("You're outside Pittsburgh, and pitt stop only covers the city. Search or tap the map instead.");
        return;
      }
      mapRef.current?.setYou(at, p.coords.accuracy);
      setPin(at);
      mapRef.current?.setPin(at, true);
      if (p.coords.accuracy > 150) setNotice(`Your location is only accurate to about ${Math.round(p.coords.accuracy / 10) * 10} m. Tap the map to move the pin.`);
    };
    const failed = (e: GeolocationPositionError, retried: boolean) => {
      // GPS can be slow indoors; try once more with network location before giving up.
      if (e.code === e.TIMEOUT && !retried) {
        navigator.geolocation.getCurrentPosition(found, (e2) => failed(e2, true), { enableHighAccuracy: false, timeout: 15000, maximumAge: 120000 });
        return;
      }
      setLocating(false);
      setNotice(e.code === e.PERMISSION_DENIED ? deniedHelp() : "Couldn't find your location. Search or tap the map instead.");
    };
    navigator.geolocation.getCurrentPosition(found, (e) => failed(e, false), { enableHighAccuracy: true, timeout: 10000, maximumAge: 30000 });
  }, []);

  const center = useCallback((): [number, number] => {
    const c = mapRef.current?.map.getCenter();
    return c ? [c.lng, c.lat] : [-79.9495, 40.4435];
  }, []);

  const goTo = useCallback((at: [number, number]) => {
    setNotice("");
    setPin(at);
    mapRef.current?.setPin(at, true);
  }, []);

  // Choosing a result on a phone lowers the sheet so the route shows.
  const pick = useCallback((o: Option | null) => {
    setSelected(o);
    if (o && innerWidth < 720) setSheet("half");
  }, []);

  const loading = !data || !mapReady;

  return (
    <div class={`ps-root${loading ? " ps-busy" : ""}`}>
      <div ref={mapEl} class="ps-map" />

      <nav class="ph-top ps-top">
        <a class="ph-box ph-brand" href={import.meta.env.BASE_URL} onClick={(e) => { e.preventDefault(); setPin(null); }}>
          <span class="ps-gold">pitt</span>stop
        </a>
        <button class={`ph-box ps-when-box${whenOpen ? " ph-box-active" : ""}`} aria-expanded={whenOpen} onClick={() => setWhenOpen((o) => !o)}>
          <span class="ps-when-label">When</span>
          <b>{windowText(win)}</b>
        </button>
        <button class="ph-box ps-help" aria-label="How this works" title="How this works" onClick={() => { setWhenOpen(false); setTouring(true); }}>
          ?
        </button>
      </nav>

      {whenOpen && <When win={win} onChange={changeWin} onClose={() => setWhenOpen(false)} who={who} onWho={changeWho} />}

      <Sheet state={sheet} onState={setSheet}>
        <Search data={data} center={center} onPick={goTo} onLocate={locate} locating={locating} onFocus={() => setSheet("full")} />
        <button class="ps-private" onClick={() => setPrivacyOpen(true)}>
          <Lock />
          Private: your location and searches stay on this device
        </button>
        {notice && (
          <p class="ps-notice" role="status">
            {notice}
            <button aria-label="Dismiss" onClick={() => setNotice("")}>×</button>
          </p>
        )}
        {!pin ? (
          <div class="ps-empty">
            <h1>Where are you headed?</h1>
            <p>Tap the map where you're going. You'll get the closest free parking by walking time, hills included, plus what the meters and garages nearby would cost for your hours.</p>
            <button class="ps-near" onClick={locate} disabled={locating}>
              <Crosshair />
              {locating ? "Finding you…" : "Find parking near me"}
            </button>
            <p class="ps-quiet ps-optional">Location is optional and only used when you tap that. It stays on this device.</p>
            <div class="ps-chips">
              {PLACES.map((p) => (
                <button key={p.name} class="ph-pill" onClick={() => goTo(p.at)}>
                  {p.name}
                </button>
              ))}
            </div>
            <button class="ps-more ps-tour-link" onClick={() => setTouring(true)}>New here? Take the two-minute tour</button>
          </div>
        ) : !results ? (
          <div class="ps-empty">
            <p class="ps-quiet">{walking || !data ? "Walking the neighborhood…" : "Couldn't reach the walking network from here."}</p>
          </div>
        ) : (
          <div class="ps-results">
            {times && times.snapMeters > 150 && <p class="ps-warn">That pin is {Math.round(times.snapMeters)} m from the nearest sidewalk, so walk times are rough.</p>}
            {show.has("free") && <Group title="Free" options={results.free} selected={selected} onSelect={pick} empty="Nothing free within a 25-minute walk for these hours." route={route} data={data!} />}
            {show.has("paid") && <Group title="Paid" options={results.paid} selected={selected} onSelect={pick} empty="No meters or paid lots nearby." route={route} data={data!} />}
            {!show.has("free") && !show.has("paid") && !results.misfit.length && <p class="ps-quiet ps-foot">Free and paid are filtered out. Click them in the key to bring them back.</p>}
            {results.misfit.length > 0 && (
              <button class="ps-more" onClick={() => setShowMisfit((s) => !s)}>
                {showMisfit ? "Hide" : "Show"} {results.misfit.length} nearby that won't work for these hours
              </button>
            )}
            {showMisfit && <Group title="Won't work" options={results.misfit} selected={selected} onSelect={pick} route={route} data={data!} />}
            {results.unknown > 0 && <p class="ps-quiet ps-foot">{results.unknown} nearby blocks are main roads with no parking data. They're drawn in gray.</p>}
          </div>
        )}
        {data && <Sources data={data} onPrivacy={() => setPrivacyOpen(true)} />}
      </Sheet>

      <div class="ps-legend" role="group" aria-label="Key. Click to show or hide; double-click to show only one.">
        {LEGEND.map(([k, label]) => (
          <button
            key={k}
            class={show.has(k) ? "" : "ps-off"}
            aria-pressed={show.has(k)}
            title={`${show.has(k) ? "Hide" : "Show"} ${label.toLowerCase()} · double-click for only this`}
            onClick={() => toggle(k)}
            onDblClick={() => only(k)}
          >
            <i style={{ background: COLORS[k] }} />
            {label}
          </button>
        ))}
        <span class="ps-key-note">
          <i class="ps-dash" />
          Permit zone
        </span>
      </div>

      {touring && <Tour onClose={() => setTouring(false)} />}
      {privacyOpen && <Privacy onClose={() => setPrivacyOpen(false)} />}

      {hover && (
        <div class="ps-tip" style={{ left: `${hover.x + 14}px`, top: `${hover.y + 14}px` }}>
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
  return narrow ? { top: 110, right: 40, bottom: innerHeight * 0.56, left: 40 } : { top: 90, right: 420, bottom: 60, left: 60 };
}

const inPittsburgh = ([lon, lat]: [number, number]) => lon > -80.105 && lon < -79.855 && lat > 40.355 && lat < 40.505;

/** How to turn location back on, for the browser in hand. */
function deniedHelp() {
  const ua = navigator.userAgent;
  if (/iPhone|iPad|iPod/.test(ua)) return "Location is off for this site. On iPhone: Settings › Privacy & Security › Location Services › Safari Websites › While Using the App, then try again.";
  if (/Android/.test(ua)) return "Location is off for this site. Tap the icon left of the address bar › Permissions › Location › Allow, then try again.";
  return "Location is off for this site. Allow it from the icon left of the address bar, then try again.";
}

// --- the sheet: a side panel on wide screens, a bottom sheet you can drag on phones ---------------

type Sheet = "peek" | "half" | "full";
const SNAPS: Sheet[] = ["peek", "half", "full"];

function Sheet({ state, onState, children }: { state: Sheet; onState: (s: Sheet) => void; children: preact.ComponentChildren }) {
  const ref = useRef<HTMLElement>(null);
  const drag = useRef<{ y: number; base: number; t: number } | null>(null);
  const [dy, setDy] = useState<number | null>(null);

  // Where each snap leaves the sheet's top edge, as an offset from fully open.
  const offsets = () => {
    const h = ref.current?.offsetHeight ?? innerHeight;
    return { full: 0, half: Math.max(0, h - innerHeight * 0.5), peek: Math.max(0, h - 176) } as Record<Sheet, number>;
  };
  const start = (e: PointerEvent) => {
    if (innerWidth >= 720) return;
    drag.current = { y: e.clientY, base: offsets()[state], t: performance.now() };
    (e.currentTarget as HTMLElement).setPointerCapture(e.pointerId);
  };
  const move = (e: PointerEvent) => {
    const d = drag.current;
    if (d) setDy(Math.max(0, d.base + e.clientY - d.y));
  };
  const end = (e: PointerEvent) => {
    const d = drag.current;
    drag.current = null;
    if (!d) return;
    const moved = e.clientY - d.y;
    setDy(null);
    if (Math.abs(moved) < 6) {
      // A tap on the handle steps up, or drops back from the top.
      onState(state === "full" ? "half" : state === "half" ? "full" : "half");
      return;
    }
    const at = d.base + moved;
    const fling = moved / Math.max(1, performance.now() - d.t); // px per ms
    const o = offsets();
    let next = SNAPS.reduce((a, b) => (Math.abs(o[b] - at) < Math.abs(o[a] - at) ? b : a));
    if (fling > 0.6) next = SNAPS[Math.max(0, SNAPS.indexOf(state) - 1)];
    if (fling < -0.6) next = SNAPS[Math.min(2, SNAPS.indexOf(state) + 1)];
    onState(next);
  };
  return (
    <aside
      ref={ref}
      class={`ps-sheet ps-sheet-${state}${dy != null ? " ps-dragging" : ""}`}
      style={dy != null ? { transform: `translateY(${dy}px)` } : undefined}
      aria-label="Parking near the pin"
    >
      <div class="ps-grab" onPointerDown={start} onPointerMove={move} onPointerUp={end} onPointerCancel={end}>
        <button class="ps-handle" aria-label={state === "full" ? "Lower the panel" : "Raise the panel"} onClick={(e) => e.preventDefault()}>
          <i />
        </button>
      </div>
      {children}
    </aside>
  );
}

function Lock() {
  return (
    <svg viewBox="0 0 12 14" aria-hidden="true" class="ps-lock">
      <rect x="1.5" y="6" width="9" height="7" rx="1.5" />
      <path d="M3.5 6V4.5a2.5 2.5 0 0 1 5 0V6" />
    </svg>
  );
}

function Crosshair() {
  return (
    <svg viewBox="0 0 16 16" aria-hidden="true">
      <circle cx="8" cy="8" r="4.5" />
      <path d="M8 0.5v3M8 12.5v3M0.5 8h3M12.5 8h3" />
    </svg>
  );
}

function Privacy({ onClose }: { onClose: () => void }) {
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => e.key === "Escape" && onClose();
    addEventListener("keydown", onKey);
    return () => removeEventListener("keydown", onKey);
  }, [onClose]);
  return (
    <div class="ps-modal" role="dialog" aria-modal="true" aria-labelledby="ps-privacy-title" onClick={(e) => e.target === e.currentTarget && onClose()}>
      <div class="ps-modal-card">
        <h2 id="ps-privacy-title">
          <Lock /> Private by design
        </h2>
        <ul>
          <li><b>Your location stays on your device.</b> Walk times are worked out right here, and the page has nowhere to send your position.</li>
          <li><b>Search happens on your device too.</b> It looks through streets and places the page already has; what you type never goes anywhere.</li>
          <li><b>No accounts, no cookies, no analytics, no ads.</b></li>
          <li><b>No other companies.</b> The map, fonts and data all come from this site, and the page's security policy stops the browser from contacting anyone else. Links to sources open the source's own site only when you tap them.</li>
          <li><b>What's kept:</b> your key filters and the CMU ID switch, saved in this browser only. Your pin and hours sit in the page's address after the #, which browsers never send to the server. Share the link only if you want to share the spot.</li>
          <li><b>What this site's host sees:</b> like any website, the files you load. Map pieces load for the area on screen, so the host could tell roughly which part of Pittsburgh is being viewed, but not who you are or where you are.</li>
        </ul>
        <p class="ps-quiet">The code is open: <a href="https://github.com/manorajesh/pittstop" target="_blank" rel="noreferrer">github.com/manorajesh/pittstop</a></p>
        <button class="ph-pill ph-pill-active" onClick={onClose} autoFocus>Got it</button>
      </div>
    </div>
  );
}

// --- pieces --------------------------------------------------------------------------------------

function When({ win, onChange, onClose, who, onWho }: { win: Window; onChange: (w: Window) => void; onClose: () => void; who: Who; onWho: (w: Who) => void }) {
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
      <label class="ps-switch">
        <input type="checkbox" checked={who.cmu} onChange={(e) => onWho({ cmu: (e.target as HTMLInputElement).checked })} />
        <span>
          I have a CMU ID
          <small>Uses CMU's affiliate rates at the East Campus Garage, free nights and weekends</small>
        </span>
      </label>
      <button class="ps-done" onClick={onClose}>Done</button>
    </div>
  );
}

function Group({ title, options, selected, onSelect, empty, route, data }: {
  title: string;
  options: Option[];
  selected: Option | null;
  onSelect: (o: Option | null) => void;
  empty?: string;
  route: Route | null;
  data: Data;
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
                </span>
                <span class="ps-price">{priceText(o.verdict)}</span>
              </button>
              {on && (
                <div class="ps-detail">
                  {o.schedule && <span>{describe(o.schedule)}</span>}
                  {o.note && <span>{o.note}</span>}
                  {o.lot?.a && <span>{o.lot.a}</span>}
                  {o.lot?.h && <span>Hours {o.lot.h}</span>}
                  {route && <span>{routeText(route)}</span>}
                  <Cite list={sourcesFor(data, o)} />
                </div>
              )}
            </li>
          );
        })}
      </ul>
    </section>
  );
}

function Search({ data, center, onPick, onLocate, locating, onFocus }: {
  data: Data | null;
  center: () => [number, number];
  onPick: (at: [number, number]) => void;
  onLocate: () => void;
  locating: boolean;
  onFocus: () => void;
}) {
  const [q, setQ] = useState("");
  const [places, setPlaces] = useState<[string, string, number, number][] | null>(null);
  // Places are fetched once, from this site, the first time the field is used.
  const wake = () => {
    onFocus();
    if (places) return;
    setPlaces([]);
    fetch(import.meta.env.BASE_URL + "data/places.json").then((r) => r.json()).then(setPlaces).catch(() => {});
  };
  const index = useMemo(() => (data ? buildIndex(data, places ?? []) : []), [data, places]);
  const hits: Hit[] = useMemo(() => (q.trim().length >= 2 ? search(index, q, center()) : []), [index, q]);
  const choose = (h: Hit) => {
    onPick(h.at);
    setQ("");
    (document.activeElement as HTMLElement | null)?.blur();
  };
  return (
    <div class="ps-search">
      <input
        type="search"
        enterKeyHint="search"
        autoComplete="off"
        placeholder="Street, corner or place"
        value={q}
        onFocus={wake}
        onInput={(e) => setQ((e.target as HTMLInputElement).value)}
        onKeyDown={(e) => e.key === "Enter" && hits[0] && choose(hits[0])}
        aria-label="Search Pittsburgh streets, corners and places"
      />
      <button class={`ps-locate${locating ? " ps-locating" : ""}`} onClick={onLocate} aria-label="Use my location" title="Use my location" disabled={locating}>
        <Crosshair />
      </button>
      {q.trim().length >= 2 && (
        <ul class="ps-hits">
          {hits.map((h) => (
            <li key={h.name + h.sub}>
              <button onClick={() => choose(h)}>
                {h.name}
                <span>{h.sub}</span>
              </button>
            </li>
          ))}
          {!hits.length && <li class="ps-nohit">No match. Try a street, a corner like “Forbes & Craig”, or a place.</li>}
        </ul>
      )}
    </div>
  );
}

/** "Check it yourself" links for one place. */
function Cite({ list }: { list: { name: string; url: string; checked?: string }[] }) {
  if (!list.length) return null;
  return (
    <span class="ps-cite">
      <span class="ps-label">Check it yourself{list[0].checked ? ` · checked ${list[0].checked}` : ""}</span>
      {list.map((s) => (
        <a key={s.url} href={s.url} target="_blank" rel="noreferrer">
          {s.name} ↗
        </a>
      ))}
    </span>
  );
}

function Sources({ data, onPrivacy }: { data: Data; onPrivacy: () => void }) {
  return (
    <footer class="ps-sources">
      <p>Signs on the street win. This map reads city and OpenStreetMap records, which miss street cleaning, loading zones, and new signs.</p>
      <p>
        CMU campus: <a href={data.meta.campus.sources.visitor.url} target="_blank" rel="noreferrer">CMU Transportation Services</a> and its campus map, checked {data.meta.campus.checked}.
      </p>
      <p>
        {data.meta.sources.map((s, i) => (
          <span key={s.url}>
            {i > 0 && " · "}
            <a href={s.url} target="_blank" rel="noreferrer">{s.name}</a> ({s.asOf})
          </span>
        ))}
        {" · "}
        <a href="https://protomaps.com" target="_blank" rel="noreferrer">Protomaps</a> basemap
      </p>
      <p>
        <button class="ps-linkish" onClick={onPrivacy}>Privacy</button> · <a href="https://github.com/manorajesh/pittstop" target="_blank" rel="noreferrer">Source code</a>
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
  if (v.status === "paid") return v.cents != null ? money(v.cents) : "Paid";
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

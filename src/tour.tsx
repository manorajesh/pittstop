import { useEffect, useLayoutEffect, useState } from "preact/hooks";

// A short walk through the page: each step lights up one part of it and says what it does.

type Step = { sel?: string; title: string; body: string };

const STEPS: Step[] = [
  {
    title: "Pitt stop, in a minute",
    body: "This finds parking near where you're going, for the hours you'll be there: free first, then what paid parking would cost. Seven quick stops.",
  },
  {
    sel: ".ps-search",
    title: "Say where",
    body: "Tap anywhere on the map to drop a pin, search a street, corner (“Forbes & Craig”) or place, or use the target button to start from where you are. Around Oakland there are shortcuts for CMU, the Cathedral, Phipps and Presby.",
  },
  {
    sel: ".ps-when-box",
    title: "Say when",
    body: "Set From and To, or tap a length (1–8 hr, Overnight). Every street is recolored for exactly those hours, so meters are free after 6 p.m., on Sundays and on Parking Authority holidays. Turn on “I have a CMU ID” for CMU's affiliate garage rates.",
  },
  {
    sel: ".ps-legend",
    title: "Read the colors, filter them",
    body: "Gold is free, white is paid, amber means a time limit shorter than your stay, red is no parking, gray means no data. Dashed streets are residential permit zones, where visitors get one or two hours. Click a key to hide or show it; double-click to see only that one.",
  },
  {
    sel: ".ps-sheet",
    title: "Pick from the list",
    body: "Options are sorted by walking time from the pin, counting hills and city steps. Tap a row to see the route, the posted rules, and links to the source. Places that don't fit your hours are tucked under “won't work”.",
  },
  {
    sel: ".ps-sources",
    title: "Check the source",
    body: "Around CMU, every garage, lot and meter street was checked by hand against CMU Transportation Services and the Parking Authority, and each one links to its source. Elsewhere it's city and OpenStreetMap data, some of it years old. Posted signs always win.",
  },
  {
    sel: ".ps-private",
    title: "It's private",
    body: "Your location and searches never leave your device. The map, fonts and data all come from this site, with no accounts, cookies, analytics or other companies involved. Tap the lock line for details.",
  },
  {
    sel: ".ps-help",
    title: "That's it",
    body: "Open this again any time with the ? button. The pin and hours are saved in the page's link, so you can send someone exactly what you're looking at.",
  },
];

type Box = { x: number; y: number; w: number; h: number } | null;

// Preact 11 leaves numbers in styles unitless.
const px = (n: number) => `${Math.round(n)}px`;

export function Tour({ onClose }: { onClose: () => void }) {
  const [i, setI] = useState(0);
  const [box, setBox] = useState<Box>(null);
  const step = STEPS[i];
  const last = i === STEPS.length - 1;

  useLayoutEffect(() => {
    const measure = () => {
      const el = step.sel ? document.querySelector(step.sel) : null;
      if (!el) return setBox(null);
      const r = el.getBoundingClientRect();
      setBox({ x: r.left - 6, y: r.top - 6, w: r.width + 12, h: r.height + 12 });
    };
    measure();
    addEventListener("resize", measure);
    return () => removeEventListener("resize", measure);
  }, [i]);

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") onClose();
      else if (e.key === "ArrowRight" || e.key === "Enter") last ? onClose() : setI((n) => n + 1);
      else if (e.key === "ArrowLeft") setI((n) => Math.max(0, n - 1));
    };
    addEventListener("keydown", onKey);
    return () => removeEventListener("keydown", onKey);
  }, [last, onClose]);

  // The card sits beside what's lit: below it when there's room, otherwise above, else centered.
  const card: Record<string, string | number> = {};
  const W = Math.min(340, innerWidth - 24);
  if (box) {
    const below = box.y + box.h + 12;
    const roomBelow = innerHeight - below > 220;
    const roomAbove = box.y > 232;
    const left = Math.min(Math.max(12, box.x), innerWidth - W - 12);
    if (box.h > innerHeight * 0.6) {
      // A tall target (the side sheet): put the card beside it.
      card.top = Math.max(12, box.y + 40);
      card.left = box.x > W + 24 ? box.x - W - 12 : 12;
    } else if (roomBelow) {
      card.top = below;
      card.left = left;
    } else if (roomAbove) {
      card.bottom = innerHeight - box.y + 12;
      card.left = left;
    } else {
      card.top = 12;
      card.left = (innerWidth - W) / 2;
    }
  } else {
    card.top = Math.max(12, innerHeight / 2 - 110);
    card.left = (innerWidth - W) / 2;
  }

  return (
    <div class="ps-tour" role="dialog" aria-modal="true" aria-labelledby="ps-tour-title">
      <div
        class={`ps-tour-light${box ? "" : " ps-tour-none"}`}
        style={box ? { left: px(box.x), top: px(box.y), width: px(box.w), height: px(box.h) } : undefined}
        onClick={onClose}
      />
      <div class="ps-tour-card" style={{ ...Object.fromEntries(Object.entries(card).map(([k, v]) => [k, px(v as number)])), width: px(W) }} key={i}>
        <span class="ps-label">
          {i + 1} / {STEPS.length}
        </span>
        <h2 id="ps-tour-title">{step.title}</h2>
        <p>{step.body}</p>
        <div class="ps-tour-nav">
          <button class="ps-done" onClick={onClose}>
            Skip
          </button>
          <span>
            {i > 0 && (
              <button class="ph-pill" onClick={() => setI(i - 1)}>
                Back
              </button>
            )}
            <button class="ph-pill ph-pill-active" onClick={() => (last ? onClose() : setI(i + 1))} autoFocus>
              {last ? "Done" : "Next"}
            </button>
          </span>
        </div>
      </div>
    </div>
  );
}

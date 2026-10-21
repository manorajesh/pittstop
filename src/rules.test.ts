import { describe as group, expect, it } from "vitest";
import { describe, evaluate, fromLocal, Garage, hoursText, Meter, Permit, toLocal, weekMinute } from "./rules";

const day = (d: number, h: number, m = 0) => d * 1440 + h * 60 + m;
const monSat = (s: number, e: number, r: number | null): [number, number, number | null][] =>
  [0, 1, 2, 3, 4, 5].map((d) => [day(d, s), day(d, e), r]);

const oakland: Meter = { kind: "meter", pay: monSat(8, 18, 300), max: null, no: [], dynamic: false, assumed: false };
const twoHour: Meter = { ...oakland, pay: monSat(8, 18, 150), max: 120 };
const rushHour: Meter = { ...oakland, no: [0, 1, 2, 3, 4].map((d) => [day(d, 16), day(d, 18)] as [number, number]) };
const zoneQ: Permit = { kind: "permit", lim: monSat(7, 19, 0).map(([a, b]) => [a, b]), grace: 60, assumed: false };

// 2026-10-21 is a Wednesday.
const win = (a: string, b: string) => ({ from: fromLocal(a), to: fromLocal(b) });

group("time", () => {
  it("reads datetime-local values as Pittsburgh time", () => {
    expect(new Date(fromLocal("2026-10-21T14:00")).toISOString()).toBe("2026-10-21T18:00:00.000Z");
    expect(new Date(fromLocal("2026-12-21T14:00")).toISOString()).toBe("2026-12-21T19:00:00.000Z");
    expect(toLocal(fromLocal("2026-03-08T03:30"))).toBe("2026-03-08T03:30");
  });
  it("counts week minutes from Monday", () => {
    expect(weekMinute(fromLocal("2026-10-19T00:00"))).toBe(0);
    expect(weekMinute(fromLocal("2026-10-21T14:30"))).toBe(day(2, 14, 30));
  });
});

group("meters", () => {
  it("charges for the paid hours only", () => {
    const v = evaluate(oakland, win("2026-10-21T16:00", "2026-10-21T20:00"));
    expect(v.status).toBe("paid");
    expect(v.cents).toBe(600);
  });
  it("is free once the meter's off, and on Sundays", () => {
    expect(evaluate(oakland, win("2026-10-21T18:00", "2026-10-21T23:00")).status).toBe("free");
    expect(evaluate(oakland, win("2026-10-25T09:00", "2026-10-25T17:00")).status).toBe("free");
  });
  it("flags a window longer than the max", () => {
    const v = evaluate(twoHour, win("2026-10-21T10:00", "2026-10-21T13:00"));
    expect(v.status).toBe("limit");
    expect(new Date(v.until!).toISOString()).toBe("2026-10-21T16:00:00.000Z");
    expect(evaluate(twoHour, win("2026-10-21T17:00", "2026-10-21T21:00")).status).toBe("paid");
  });
  it("catches rush-hour no parking", () => {
    expect(evaluate(rushHour, win("2026-10-21T15:00", "2026-10-21T17:00")).status).toBe("no");
    expect(evaluate(rushHour, win("2026-10-24T15:00", "2026-10-24T17:00")).status).toBe("paid");
  });
  it("prices an overnight window across the fall DST change", () => {
    // 2026-11-01 01:00-02:00 happens twice. Sat 4p -> Mon 9a pays Sat 4p-6p and Mon 8a-9a.
    const v = evaluate(oakland, win("2026-10-31T16:00", "2026-11-02T09:00"));
    expect(v.cents).toBe(900);
  });
  it("doesn't invent a price for demand-priced meters", () => {
    const v = evaluate({ ...oakland, dynamic: true }, win("2026-10-21T10:00", "2026-10-21T11:00"));
    expect(v.status).toBe("paid");
    expect(v.cents).toBeNull();
  });
});

group("permit zones", () => {
  it("allows the visitor grace period", () => {
    expect(evaluate(zoneQ, win("2026-10-21T10:00", "2026-10-21T11:00")).status).toBe("free");
    expect(evaluate(zoneQ, win("2026-10-21T18:00", "2026-10-21T23:00")).status).toBe("free");
  });
  it("flags a stay past the grace period", () => {
    const v = evaluate(zoneQ, win("2026-10-21T10:00", "2026-10-21T13:00"));
    expect(v.status).toBe("limit");
    expect(new Date(v.until!).toISOString()).toBe("2026-10-21T15:00:00.000Z");
  });
});

group("text", () => {
  it("groups days that share hours", () => {
    expect(hoursText(oakland.pay)).toBe("Mon–Sat 8a–6p");
    expect(describe(twoHour)).toBe("Mon–Sat 8a–6p · $1.50/hr · 2 hr max");
    expect(describe(zoneQ)).toBe("Permit Mon–Sat 7a–7p · 1 hr without a permit");
  });
});

// East Campus Garage as pipeline/cmu.py builds it.
const weekly = (days: number[], s: number, e: number) => days.map((d) => [day(d, s), day(d, e)] as [number, number]);
const ecg: Garage = {
  kind: "garage",
  owner: "cmu",
  tiers: [[30, 0], [60, 1500], [180, 1700], [300, 1900], [1e6, 2200]],
  aff: [[30, 0], [60, 800], [180, 1000], [300, 1200], [1e6, 1500]],
  flat: [...weekly([0, 1, 2, 3, 4], 18, 23), ...weekly([5, 6], 8, 23)],
  flatCents: 1100,
  affFlatCents: 0,
  closed: weekly([0, 1, 2, 3, 4, 5, 6], 23, 30),
};

group("garages", () => {
  it("charges by length of stay", () => {
    expect(evaluate(ecg, win("2026-10-21T10:00", "2026-10-21T10:20")).cents).toBe(0);
    expect(evaluate(ecg, win("2026-10-21T10:00", "2026-10-21T12:30")).cents).toBe(1700);
    expect(evaluate(ecg, win("2026-10-21T09:00", "2026-10-21T17:00")).cents).toBe(2200);
  });
  it("uses CMU rates for CMU ID holders", () => {
    expect(evaluate(ecg, win("2026-10-21T10:00", "2026-10-21T12:30"), undefined, { cmu: true }).cents).toBe(1000);
  });
  it("is a flat rate in the evening, free with a CMU ID", () => {
    expect(evaluate(ecg, win("2026-10-21T18:30", "2026-10-21T22:00")).cents).toBe(1100);
    const v = evaluate(ecg, win("2026-10-24T10:00", "2026-10-24T20:00"), undefined, { cmu: true });
    expect(v.status).toBe("free");
  });
  it("turns visitors away overnight", () => {
    expect(evaluate(ecg, win("2026-10-21T20:00", "2026-10-22T08:00")).status).toBe("no");
  });
  it("keeps permit-only lots off limits", () => {
    expect(evaluate({ kind: "private" }, win("2026-10-21T10:00", "2026-10-21T11:00")).status).toBe("no");
  });
});

group("holidays", () => {
  it("doesn't charge city meters on Parking Authority holidays", () => {
    // Veterans Day, a Wednesday.
    const v = evaluate(oakland, win("2026-11-11T10:00", "2026-11-11T12:00"));
    expect(v.status).toBe("free");
    expect(v.note).toMatch(/holiday/);
  });
  it("still charges CMU's own lots", () => {
    const morewood: Meter = { ...oakland, owner: "cmu", pay: [0, 1, 2, 3, 4].map((d) => [day(d, 7), day(d, 17), null]) };
    expect(evaluate(morewood, win("2026-11-11T10:00", "2026-11-11T12:00")).status).toBe("paid");
  });
});

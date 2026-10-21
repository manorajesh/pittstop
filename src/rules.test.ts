import { describe as group, expect, it } from "vitest";
import { describe, evaluate, fromLocal, hoursText, Meter, Permit, toLocal, weekMinute } from "./rules";

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

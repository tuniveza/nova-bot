// Portal's calendar shows Acuity's feed from a copy read in the last 10 minutes, at once, and reads a
// fresh one behind it (src/booking-calendar.js recentCalendar); everything else reads it fresh.
import { afterEach, describe, expect, it, vi } from "vitest";
import { forgetRecentCalendar, listBookings, recentCalendar } from "../src/booking-calendar.js";

const ics = (id, summary) => `BEGIN:VCALENDAR\nBEGIN:VEVENT\nUID:${id}@scheduling\nSUMMARY:${summary}\nDTSTART:20261020T100000Z\nDTEND:20261020T110000Z\nEND:VEVENT\nEND:VCALENDAR\n`;
const env = { ACUITY_CALENDAR_URL: "https://acuity.example/feed.ics" };

afterEach(() => {
  forgetRecentCalendar();
  vi.restoreAllMocks();
});

describe("Portal's calendar: a recent copy of Acuity's feed", () => {
  it("reads the feed the first time, then shows that copy without reading again for a little while", async () => {
    const fetch = vi.spyOn(globalThis, "fetch").mockImplementation(async () => new Response(ics(1234567, "Mix")));
    const t = Date.now();
    expect(Object.keys(await recentCalendar(env, null, t))).toEqual(["1234567"]);
    expect(Object.keys(await recentCalendar(env, null, t + 5_000))).toEqual(["1234567"]);
    expect(fetch).toHaveBeenCalledTimes(1);
  });

  it("an older copy is shown at once and a fresh one read behind it, for the next look", async () => {
    let n = 0;
    vi.spyOn(globalThis, "fetch").mockImplementation(async () => new Response(ics(1234560 + ++n, "Session " + n)));
    const t = Date.now();
    await recentCalendar(env, null, t);
    const waits = [];
    const shown = await recentCalendar(env, { waitUntil: (p) => waits.push(p) }, t + 60_000);
    expect(Object.keys(shown)).toEqual(["1234561"]); // the copy already there
    expect(waits).toHaveLength(1); // the fresh read, behind it
    await waits[0];
    expect(Object.keys(await recentCalendar(env, null, Date.now()))).toEqual(["1234562"]);
  });

  it("a copy over 10 minutes old, or of another feed, isn't used", async () => {
    let n = 0;
    vi.spyOn(globalThis, "fetch").mockImplementation(async () => new Response(ics(1234560 + ++n, "S")));
    const t = Date.now();
    await recentCalendar(env, null, t);
    expect(Object.keys(await recentCalendar(env, null, t + 11 * 60_000))).toEqual(["1234562"]);
    expect(Object.keys(await recentCalendar({ ACUITY_CALENDAR_URL: "https://acuity.example/other.ics" }, null))).toEqual(["1234563"]);
  });

  it("everything else still reads the feed fresh every time", async () => {
    const fetch = vi.spyOn(globalThis, "fetch").mockImplementation(async () => new Response(ics(1234567, "Mix")));
    await listBookings(env);
    await listBookings(env);
    expect(fetch).toHaveBeenCalledTimes(2);
    await listBookings(env, { recent: true });
    await listBookings(env, { recent: true });
    expect(fetch).toHaveBeenCalledTimes(3);
  });
});

// Portal's calendar shows Acuity's feed from a copy read in the last 10 minutes, at once, and reads a
// fresh one behind it (src/booking-calendar.js recentCalendar); everything else reads it fresh.
import { afterEach, describe, expect, it, vi } from "vitest";
import { forgetRecentCalendar, listBookings, recentCalendar } from "../src/booking-calendar.js";
import { withBuild } from "../src/index.js";

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

// Nova's pages say which deploy's files they go with (X-Nova-Build), for Nova Agent's service worker
describe("Nova's pages say their deploy", () => {
  const env = { ASSETS: { fetch: async () => new Response(JSON.stringify({ build: "abc123", files: {} })) } };
  const req = new Request("https://nova.test/agent/");
  it("a page gets X-Nova-Build from public/nova-build.json", async () => {
    const res = await withBuild(new Response("<!doctype html>", { headers: { "Content-Type": "text/html; charset=utf-8" } }), req, env);
    expect(res.headers.get("X-Nova-Build")).toBe("abc123");
    expect(await res.text()).toBe("<!doctype html>");
  });
  it("a page the browser already has (304) says it too, so a newer deploy is noticed even when the page didn't change", async () => {
    const res = await withBuild(new Response(null, { status: 304 }), req, env);
    expect(res.status).toBe(304);
    expect(res.headers.get("X-Nova-Build")).toBe("abc123");
  });
  it("anything that isn't a page (a redirect, a file) is left as it is", async () => {
    const moved = Response.redirect("https://nova.test/agent/?open=%2Fcalendar%2F", 302);
    expect(await withBuild(moved, req, env)).toBe(moved);
  });
});

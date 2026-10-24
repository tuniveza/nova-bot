// Bringing Acuity's future bookings over to Nova's own booking system (src/acuity-import.js):
// a dry run first, then the real thing, with no emails and no charges, and safe to run twice.

import { createExecutionContext, env, waitOnExecutionContext } from "cloudflare:test";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import worker from "../src";
import { STAFF_AUTH } from "./sign-in.js";
import { matchSessionType, planAcuityImport, runAcuityImport } from "../src/acuity-import.js";
import { sendReminders } from "../src/nova/bookings.js";
import { BASE, clearTables, connectGoogle, installFakes } from "./fakes.js";

const FEED_URL = "https://calendar.test/acuity-feed";
const feedEnv = () => ({ ...env, ACUITY_CALENDAR_URL: FEED_URL });

// "20261022T131500Z" for a time this many days from now (on the hour)
const isoAt = (days, hours = 0) => {
  const d = new Date(Date.now() + days * 86_400_000);
  d.setUTCHours(13 + hours, 0, 0, 0);
  return d.toISOString();
};
const feedTime = (days, hours = 0) => isoAt(days, hours).replace(/[-:]/g, "").replace(/\.\d{3}/, "");
const event = ({ id, name, email, phone = "07700 900123", price = "£200.00", session, start, end, extra = "" }) =>
  [
    "BEGIN:VEVENT",
    `UID:${id}@scheduling`,
    `DESCRIPTION:Client time zone: Europe/London\\nName: ${name}\\nPhone: ${phone}\\nEmail: ${email}\\nPrice: ${price}\\n${extra}`,
    `DTSTART:${start}`,
    `DTEND:${end}`,
    `SUMMARY:${name}: ${session} (Novacane Studios)`,
    "END:VEVENT",
  ].join("\r\n");

let feedEvents;
const feed = () => ["BEGIN:VCALENDAR", ...feedEvents, "END:VCALENDAR"].join("\r\n");
const acuityFeed = { handle: async (url) => (url.startsWith(FEED_URL) ? new Response(feed(), { headers: { "Content-Type": "text/calendar" } }) : null) };

let fakes;
beforeEach(async () => {
  await clearTables();
  fakes = installFakes({ extra: [acuityFeed] });
  await connectGoogle();
  feedEvents = [
    event({ id: 1782089433, name: "Dana Hollis", email: "Dana@Example.com", session: "Rap Package - 2 songs (2 hours recording with engineer + 2 hours mixing)", start: feedTime(10), end: feedTime(10, 4), extra: "How did you hear about us?: A friend\\, Jo\\n" }),
    // Overlaps Dana's: both are real in Acuity, so both come over
    event({ id: 1782089434, name: "Kai Moss", email: "kai@example.com", price: "£75.00", session: "Mixing consultation", start: feedTime(10, 1), end: feedTime(10, 2) }),
    // Already happened: not brought over
    event({ id: 1782089435, name: "Old Booking", email: "old@example.com", session: "Studio Rental without Engineer - 2 hours", start: feedTime(-3), end: feedTime(-3, 2) }),
    // One of Acuity's own test bookings: left out
    event({ id: 1782089436, name: "Nova TEST booking", email: "test@example.com", session: "Studio Rental without Engineer - 2 hours", start: feedTime(12), end: feedTime(12, 2) }),
  ];
});
afterEach(() => vi.restoreAllMocks());

async function call(path, { method = "GET", origin = BASE, as = "admin" } = {}) {
  const headers = as === "admin" ? { ...STAFF_AUTH } : {};
  if (method === "POST") {
    headers["Content-Type"] = "application/x-www-form-urlencoded";
    if (origin) headers.Origin = origin;
  }
  const ctx = createExecutionContext();
  const res = await worker.fetch(new Request(BASE + path, { method, headers, body: method === "POST" ? "" : undefined, redirect: "manual" }), feedEnv(), ctx);
  await waitOnExecutionContext(ctx);
  return res;
}
const bookings = async () => (await env.DB.prepare("SELECT * FROM bookings ORDER BY starts_at").all()).results;
const novaEvents = () => [...fakes.google.events.values()].filter((e) => e.extendedProperties?.private?.novaBooking);

describe("matching Acuity's sessions to Nova's", () => {
  it("finds the same session by name, and nothing for one Nova doesn't have", () => {
    expect(matchSessionType("Rap Package - 2 songs (2 hours recording with engineer + 2 hours mixing)")?.id).toBe(64806309);
    expect(matchSessionType("rap package - 2 songs")?.id).toBe(64806309);
    expect(matchSessionType("Mixing consultation")).toBeNull();
  });
});

describe("the dry run", () => {
  it("lists what would happen and changes nothing", async () => {
    const plan = await planAcuityImport(feedEnv());
    expect(plan.problem).toBe("");
    expect(plan.counts).toEqual({ import: 2, already: 0, skip: 1 });
    expect(plan.items.map((i) => [i.acuityId, i.action])).toEqual([
      [1782089433, "import"],
      [1782089434, "import"],
      [1782089436, "skip"],
    ]);
    expect(await bookings()).toHaveLength(0);
    expect(novaEvents()).toHaveLength(0);
  });

  it("is a page for admins (and data with ?format=json)", async () => {
    const page = await call("/admin/import-acuity");
    expect(page.status).toBe(200);
    const html = await page.text();
    expect(html).toContain("Bring Acuity's bookings over");
    expect(html).toContain("Dana Hollis");
    expect(html).toContain("Bring them over");
    const data = await (await call("/admin/import-acuity?format=json")).json();
    expect(data.counts.import).toBe(2);
    expect(await bookings()).toHaveLength(0);
  });

  it("isn't for anyone signed out", async () => {
    expect((await call("/admin/import-acuity", { as: "nobody" })).status).toBe(302);
    expect((await call("/admin/import-acuity", { as: "nobody", method: "POST" })).status).toBe(401);
    expect(await bookings()).toHaveLength(0);
  });

  it("says plainly when there's no feed to read", async () => {
    const plan = await planAcuityImport(env);
    expect(plan.problem).toMatch(/isn't set up/);
  });
});

describe("bringing them over", () => {
  it("makes Nova bookings and calendar events, with no emails and no charges", async () => {
    const res = await call("/admin/import-acuity", { method: "POST" });
    expect(res.status).toBe(303);
    expect(decodeURIComponent(res.headers.get("Location"))).toContain("Brought over 2 bookings");
    const rows = await bookings();
    expect(rows).toHaveLength(2);
    const [dana, kai] = rows;
    expect(dana).toMatchObject({
      status: "booked",
      source: "acuity",
      sender: "acuity:1782089433",
      type_id: 64806309,
      first_name: "Dana",
      last_name: "Hollis",
      email: "dana@example.com",
      phone: "07700 900123",
      price_pence: 20000,
      paid_pence: 0,
      duration: 240,
    });
    expect(dana.notes).toContain("Acuity booking #1782089433");
    expect(dana.notes).toContain("How did you hear about us?: A friend, Jo");
    // Not a Nova session: Acuity's name, price and length are kept
    expect(kai).toMatchObject({ type_id: null, session: "Mixing consultation", price_pence: 7500, duration: 60, sender: "acuity:1782089434" });
    // Both in the studio's Google Calendar, even though they overlap
    expect(novaEvents()).toHaveLength(2);
    // At Acuity's time exactly
    expect(dana.starts_at).toBe(isoAt(10));
    expect(dana.ends_at).toBe(isoAt(10, 4));
    // Nobody emailed, nothing charged, no staff phones
    expect(fakes.google.emails).toHaveLength(0);
    expect(fetch.mock.calls.filter(([url]) => String(url).startsWith("https://api.stripe.com"))).toHaveLength(0);
    expect(fakes.push).toHaveLength(0);
    // And no day-before reminder from Nova later
    await sendReminders(env, Date.parse(dana.starts_at) - 3600_000);
    expect(fakes.google.emails).toHaveLength(0);
  });

  it("is safe to run again: nothing is brought over twice", async () => {
    await runAcuityImport(feedEnv());
    const again = await runAcuityImport(feedEnv());
    expect(again.imported).toHaveLength(0);
    expect(again.message).toContain("Nothing new");
    expect(await bookings()).toHaveLength(2);
    expect(novaEvents()).toHaveLength(2);
    const plan = await planAcuityImport(feedEnv());
    expect(plan.counts).toEqual({ import: 0, already: 2, skip: 1 });
  });

  it("does a few at a time and carries on with the rest next time", async () => {
    const first = await runAcuityImport(feedEnv(), Date.now(), { limit: 1 });
    expect(first.imported).toHaveLength(1);
    expect(first.left).toBe(1);
    const second = await runAcuityImport(feedEnv());
    expect(second.imported).toHaveLength(1);
    expect(second.left).toBe(0);
    expect(await bookings()).toHaveLength(2);
  });

  it("only from Portal's own admin page (the Origin check)", async () => {
    expect((await call("/admin/import-acuity", { method: "POST", origin: "https://elsewhere.test" })).status).toBe(403);
    expect(await bookings()).toHaveLength(0);
  });

  it("waits for Google Calendar to be connected", async () => {
    await env.DB.prepare("DELETE FROM settings WHERE key = 'google_refresh_token'").run();
    const out = await runAcuityImport(feedEnv());
    expect(out.ok).toBe(false);
    expect(out.message).toMatch(/Google Calendar isn't connected/);
    expect(await bookings()).toHaveLength(0);
  });
});

describe("Acuity's old addresses", () => {
  it("the webhook, the confirmation page's beacon and the email forwarder are told Nova doesn't use Acuity any more", async () => {
    for (const [path, method] of [["/acuity/webhook?key=x", "POST"], ["/acuity/email", "POST"], ["/acuity/booked?id=1", "GET"]]) {
      const ctx = createExecutionContext();
      const res = await worker.fetch(new Request(BASE + path, { method, body: method === "POST" ? "action=scheduled&id=1" : undefined }), env, ctx);
      await waitOnExecutionContext(ctx);
      expect(res.status).toBe(410);
      expect(await res.text()).toBe("Nova doesn't use Acuity any more.");
    }
    expect(await bookings()).toHaveLength(0);
  });
});

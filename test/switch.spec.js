// The behind-the-scenes switch between Acuity (the default) and Nova Bot's own
// booking system (mode.js). Acuity stays in charge unless the switch is flipped.

import { createExecutionContext, env, waitOnExecutionContext } from "cloudflare:test";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import worker from "../src";
import { bookingSystem, setBookingSystem } from "../src/mode.js";
import { forgetSessionTypes } from "../src/booking.js";
import { bookSession } from "../src/nova/book-session.js";
import { getBooking } from "../src/nova/bookings.js";
import { BOOKING_PAGE_HTML } from "./acuity-page.js";
import { BASE, clearTables, connectGoogle, makeClaude, makeGoogle, makeStripe, says } from "./fakes.js";

const ACUITY_FEED = "https://acuity.test/feed.ics";
let google, stripe, claude, acuityReads;

beforeEach(async () => {
  await clearTables();
  forgetSessionTypes();
  google = makeGoogle();
  stripe = makeStripe();
  claude = makeClaude();
  acuityReads = 0;
  vi.spyOn(globalThis, "fetch").mockImplementation(async (url, init) => {
    const u = String(url);
    if (u.startsWith("https://app.acuityscheduling.com/schedule.php")) return new Response(BOOKING_PAGE_HTML);
    if (u === ACUITY_FEED) {
      acuityReads++;
      return new Response("BEGIN:VCALENDAR\r\nEND:VCALENDAR\r\n");
    }
    for (const fake of [google, stripe, claude]) {
      const res = await fake.handle(u, init || {});
      if (res) return res;
    }
    throw new Error("Unexpected fetch in test: " + u);
  });
});
afterEach(() => vi.restoreAllMocks());

async function call(path, { method = "GET", body, headers = {}, extraEnv = {} } = {}) {
  const ctx = createExecutionContext();
  const init = { method, headers: { "CF-Connecting-IP": `203.0.113.${Math.floor(Math.random() * 250)}`, ...headers }, redirect: "manual" };
  if (body !== undefined) {
    init.body = typeof body === "string" ? body : JSON.stringify(body);
    init.headers = { "Content-Type": "application/json", Origin: BASE, ...init.headers };
  }
  const res = await worker.fetch(new Request(BASE + path, init), { ...env, ...extraEnv }, ctx);
  await waitOnExecutionContext(ctx);
  return res;
}

const admin = (path, init = {}) =>
  worker.fetch(new Request(BASE + path, { ...init, headers: { Authorization: "Basic " + btoa("studio:test-admin-password"), ...(init.headers || {}) } }), env);
const flip = (system) =>
  admin("/admin/booking-system", { method: "POST", headers: { Origin: BASE, "Content-Type": "application/x-www-form-urlencoded" }, body: new URLSearchParams({ system }) });

describe("the switch", () => {
  it("is on Acuity unless it's been flipped", async () => {
    expect(await bookingSystem(env)).toBe("acuity");
    expect(await bookingSystem({ ...env, BOOKING_SYSTEM: "nova" })).toBe("nova");
    await setBookingSystem(env, "acuity");
    expect(await bookingSystem({ ...env, BOOKING_SYSTEM: "nova" })).toBe("acuity"); // the setting wins
    await expect(setBookingSystem(env, "calendly")).rejects.toThrow();
  });

  it("can only be flipped to Nova once Google and Stripe work, and back to Acuity any time", async () => {
    let res = await flip("nova");
    expect(decodeURIComponent(res.headers.get("Location"))).toContain("Not switched");
    expect(await bookingSystem(env)).toBe("acuity");

    await connectGoogle(env, { nova: false });
    res = await flip("nova");
    expect(decodeURIComponent(res.headers.get("Location"))).toContain("Switched: NovaBot now uses its own booking system");
    expect(await bookingSystem(env)).toBe("nova");

    res = await flip("acuity");
    expect(decodeURIComponent(res.headers.get("Location"))).toContain("Switched back");
    expect(await bookingSystem(env)).toBe("acuity");
  });

  it("only takes the flip from the admin page itself", async () => {
    await connectGoogle(env, { nova: false });
    const res = await admin("/admin/booking-system", { method: "POST", headers: { Origin: "https://evil.example", "Content-Type": "application/x-www-form-urlencoded" }, body: "system=nova" });
    expect(res.status).toBe(403);
    expect(await bookingSystem(env)).toBe("acuity");
  });

  it("shows which system is on, on the admin page", async () => {
    let html = await (await admin("/admin/connections")).text();
    expect(html).toContain("NovaBot is using <b>Acuity</b> (the default)");
    expect(html).toContain("can be switched on once Google and Stripe");
    await connectGoogle(env, { nova: false });
    html = await (await admin("/admin/connections")).text();
    expect(html).toContain("Switch to Nova Bot&#39;s booking system".replace("&#39;", "'"));
    await connectGoogle();
    html = await (await admin("/admin/connections")).text();
    expect(html).toContain("Switch back to Acuity");
  });
});

describe("with the switch on Acuity (the default)", () => {
  it("sends /book to the usual booking page", async () => {
    const res = await call("/book?session=64806309");
    expect(res.status).toBe(302);
    expect(res.headers.get("Location")).toBe("https://novacane.co.uk/bookings-contact");
    expect((await call("/book/api/times", { method: "POST", body: { session: 1, date: "2026-10-10" } })).status).toBe(302);
  });

  it("chats with Acuity's sessions and links", async () => {
    claude.replies.push(says("Hi"));
    await call("/", { method: "POST", body: { messages: [{ role: "user", content: "hi" }] }, headers: { Origin: "https://novacane.co.uk" }, extraEnv: { ANTHROPIC_API_KEY: "k" } });
    const system = claude.calls[0].system;
    expect(system[0].text).toContain("https://novacane.co.uk/bookings-contact");
    expect(system[0].text).not.toContain("/book\n");
    expect(system[1].text).toContain("BOOKABLE SESSIONS (live from the booking calendar");
  });

  it("gives Nova Club Acuity's calendar", async () => {
    const res = await call("/club/busy?from=2026-10-01&until=2026-11-01", { extraEnv: { ACUITY_CALENDAR_URL: ACUITY_FEED } });
    expect(res.status).toBe(200);
    expect(acuityReads).toBe(1);
    expect(google.calls).toEqual([]);
  });

  it("still listens to Acuity's webhook", async () => {
    const res = await call("/acuity/webhook", { method: "POST", body: "action=scheduled&id=5", headers: { "Content-Type": "application/x-www-form-urlencoded" } });
    expect(res.status).toBe(401); // no key in this test: refused like always, not "gone"
  });

  it("keeps Nova bookings made earlier working: their page, paying and Stripe", async () => {
    await connectGoogle();
    const day = new Intl.DateTimeFormat("en-CA", { timeZone: "Europe/London" }).format(new Date(Date.now() + 10 * 86_400_000));
    const out = await bookSession(env, { session_type_id: 12738216, date: day, time: "11:00", first_name: "Ola", last_name: "Ade", email: "ola@example.com", phone: "1" }, { ip: "x", staff: true });
    await setBookingSystem(env, "acuity");
    const b = await getBooking(env, out.booked.id);
    expect((await call(`/booking/${b.token}`)).status).toBe(200);
    expect((await call(`/pay/${b.token}?for=deposit`)).status).toBe(303);
  });
});

describe("with the switch on Nova", () => {
  beforeEach(() => connectGoogle());

  it("opens Nova Bot's booking page", async () => {
    const res = await call("/book?session=64806309");
    expect(res.status).toBe(200);
    expect(await res.text()).toContain("Book a session");
  });

  it("chats with Nova Bot's sessions and booking page", async () => {
    claude.replies.push(says("Hi"));
    await call("/", { method: "POST", body: { messages: [{ role: "user", content: "hi" }] }, headers: { Origin: "https://novacane.co.uk" }, extraEnv: { ANTHROPIC_API_KEY: "k" } });
    const system = claude.calls[0].system;
    expect(system[0].text).toContain("https://novacane-worker.novacane-studio.workers.dev/book");
    expect(system[0].text).not.toContain("https://novacane.co.uk/bookings-contact\n");
    expect(system[1].text).toContain("BOOKABLE SESSIONS (from the studio's booking system");
    expect(claude.calls[0].tools.map((t) => t.name)).toContain("open_booking_form");
  });

  it("gives Nova Club the studio's Google Calendar", async () => {
    const res = await call("/club/busy?from=2026-10-01&until=2026-11-01", { extraEnv: { ACUITY_CALENDAR_URL: ACUITY_FEED } });
    expect(res.status).toBe(200);
    expect(acuityReads).toBe(0);
    expect(google.calls.some((c) => c.includes("/events"))).toBe(true);
  });
});

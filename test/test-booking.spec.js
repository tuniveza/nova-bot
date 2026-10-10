// Portal → Admin → Test booking: an admin checks the booking flow works without real
// money, without emailing or alerting anyone else, and the test cleans up after itself.

import { createExecutionContext, env, waitOnExecutionContext } from "cloudflare:test";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import worker from "../src";
import { sha256 } from "../src/portal/auth.js";
import { STAFF_AUTH } from "./sign-in.js";
import { freeTimesOn } from "../src/nova/booking.js";
import { bookSession } from "../src/nova/book-session.js";
import { cancelBooking, getBooking, sendReminders, startCheckout } from "../src/nova/bookings.js";
import { listBookings } from "../src/nova/booking-calendar.js";
import { sendBookingEmail } from "../src/nova/emails.js";
import { runManageBookingTool } from "../src/nova/manage-bookings.js";
import { MAX_TEST_BOOKINGS, removeOldTestBookings } from "../src/nova/test-booking.js";
import { BASE, clearTables, connectGoogle, installFakes, ukDay } from "./fakes.js";

const RAP_2 = 64806309; // £200, deposit £100
const ADMIN_EMAIL = "test-admin@novacane.test";
const STAFF_TOKEN = "test-staff-portal-session";

let fakes;
beforeEach(async () => {
  await clearTables();
  fakes = installFakes();
  await connectGoogle();
  // A member of staff (not an admin), signed in
  const now = new Date().toISOString();
  const later = new Date(Date.now() + 86_400_000).toISOString();
  await env.DB.batch([
    env.DB.prepare("INSERT OR IGNORE INTO staff (id, email, password_hash, display_name, role, status, created_at, planet_seed, index_partition) VALUES ('test-staff', 'test-staff@novacane.test', NULL, 'Test Staff', 'staff', 'active', ?, 'test-staff', 'staff:test-staff')").bind(now),
    env.DB.prepare("INSERT OR REPLACE INTO sessions (id, staff_id, kind, created_at, expires_at, last_seen_at) VALUES (?, 'test-staff', 'cookie', ?, ?, ?)").bind(await sha256(STAFF_TOKEN), now, later, now),
  ]);
});
afterEach(() => vi.restoreAllMocks());

async function call(path, { method = "GET", body, as = "admin", origin = BASE, extraEnv = {} } = {}) {
  const headers = as === "admin" ? { ...STAFF_AUTH } : as === "staff" ? { Cookie: `nova_session=${STAFF_TOKEN}` } : {};
  if (body !== undefined) {
    headers["Content-Type"] = "application/json";
    if (origin) headers.Origin = origin;
  }
  const ctx = createExecutionContext();
  const res = await worker.fetch(new Request(BASE + path, { method, headers, body: body === undefined ? undefined : JSON.stringify(body), redirect: "manual" }), { ...env, ...extraEnv }, ctx);
  await waitOnExecutionContext(ctx);
  return res;
}

const run = async (options = {}, extra = {}) => {
  const res = await call("/admin/test-booking/run", { method: "POST", body: { session: RAP_2, date: ukDay(30), time: "14:00", payment: "skip", ...options }, ...extra });
  expect(res.status).toBe(200);
  const out = await res.json();
  return out;
};
const stripeCalls = () => fetch.mock.calls.filter(([url]) => String(url).startsWith("https://api.stripe.com"));
const testRows = async () => (await env.DB.prepare("SELECT * FROM bookings WHERE test = 1 ORDER BY id").all()).results;

describe("who can use it", () => {
  it("is for admins: the page, the state and running one", async () => {
    const page = await call("/admin/test-booking");
    expect(page.status).toBe(200);
    const html = await page.text();
    expect(html).toContain("Run test booking");
    expect(html).toContain("Remove all test bookings");
    expect((await call("/admin/test-booking/state")).status).toBe(200);
    const out = await run();
    expect(out.ok).toBe(true);
  });

  it("is not for staff", async () => {
    expect((await call("/admin/test-booking", { as: "staff" })).status).toBe(403);
    expect((await call("/admin/test-booking/state", { as: "staff" })).status).toBe(403);
    expect((await call("/admin/test-booking/run", { as: "staff", method: "POST", body: { session: RAP_2 } })).status).toBe(403);
    expect((await call("/admin/test-booking/remove", { as: "staff", method: "POST", body: {} })).status).toBe(403);
    expect(await testRows()).toHaveLength(0);
  });

  it("is not for anyone signed out", async () => {
    const page = await call("/admin/test-booking", { as: "nobody" });
    expect(page.status).toBe(302);
    expect(page.headers.get("Location")).toContain("/portal/?next=");
    expect((await call("/admin/test-booking/run", { as: "nobody", method: "POST", body: { session: RAP_2 } })).status).toBe(401);
    expect((await call("/admin/test-booking/remove", { as: "nobody", method: "POST", body: {} })).status).toBe(401);
    expect(await testRows()).toHaveLength(0);
  });

  it("refuses changes from another website (the Origin header)", async () => {
    expect((await call("/admin/test-booking/run", { method: "POST", body: { session: RAP_2 }, origin: "https://evil.example" })).status).toBe(403);
    expect((await call("/admin/test-booking/run", { method: "POST", body: { session: RAP_2 }, origin: "" })).status).toBe(403);
    expect((await call("/admin/test-booking/remove", { method: "POST", body: {}, origin: "https://evil.example" })).status).toBe(403);
    expect(await testRows()).toHaveLength(0);
  });
});

describe("running one", () => {
  it("ticks off every step and flags the booking TEST, with made-up details", async () => {
    const out = await run();
    expect(out.ok).toBe(true);
    expect(out.steps.map((s) => [s.key, s.status])).toEqual([
      ["slot", "pass"],
      ["booking", "pass"],
      ["payment", "pass"],
      ["email", "pass"],
      ["calendar", "pass"],
      ["alerts", "pass"],
    ]);
    const [b] = await testRows();
    expect(b).toMatchObject({ test: 1, test_by: "test-admin", test_blocks: 0, source: "test", status: "booked", first_name: "TEST", email: "test-booking@novacane.invalid", phone: null, referral_code: null });
    expect(out.booking.id).toBe(b.id);
    // In the calendar marked TEST and "free", so it doesn't block customers
    const event = fakes.google.events.get(b.event_id);
    expect(event.summary).toMatch(/^TEST · /);
    expect(event.transparency).toBe("transparent");
    expect(event.description).toContain("TEST BOOKING: not a real client");
    // Not in the referral report
    expect((await env.DB.prepare("SELECT COUNT(*) AS n FROM appointments").first("n"))).toBe(0);
  });

  it("says why when a step fails, and stops there", async () => {
    fakes.google.failCalendar = true;
    const out = await run();
    expect(out.ok).toBe(false);
    expect(out.steps[0]).toMatchObject({ key: "slot", status: "fail" });
    expect(out.steps[0].detail).toContain("couldn't be read");
    expect(out.steps.slice(1).every((s) => s.status === "skip")).toBe(true);
    expect(await testRows()).toHaveLength(0);
  });

  it("won't use a time that's already taken", async () => {
    const real = await bookSession(env, { session_type_id: RAP_2, date: ukDay(30), time: "13:00", first_name: "Dana", last_name: "Hollis", email: "dana@example.com", phone: "07700 900111" }, { ip: "staff", staff: true });
    expect(real.ok).toBe(true);
    const out = await run();
    expect(out.steps[0]).toMatchObject({ key: "slot", status: "fail" });
    expect(out.steps[0].detail).toContain("isn't showing as free");
  });

  it("picks a quiet slot when no time is given", async () => {
    const out = await run({ date: "", time: "" });
    expect(out.ok).toBe(true);
    const [b] = await testRows();
    expect(Date.parse(b.starts_at) - Date.now()).toBeGreaterThan(27 * 86_400_000);
  });

  it(`keeps to ${MAX_TEST_BOOKINGS} test bookings at once`, async () => {
    for (let i = 0; i < MAX_TEST_BOOKINGS; i++) {
      await env.DB.prepare(
        "INSERT INTO bookings (token, status, source, session, duration, starts_at, ends_at, first_name, last_name, email, created_at, updated_at, test) VALUES (?, 'booked', 'test', 'x', 60, ?, ?, 'TEST', 'Booking', 'a@b.invalid', ?, ?, 1)"
      ).bind(`tok${i}`.padEnd(24, "x"), "2026-01-01T10:00:00Z", "2026-01-01T11:00:00Z", new Date().toISOString(), new Date().toISOString()).run();
    }
    const out = await run();
    expect(out.ok).toBe(false);
    expect(out.steps[0].detail).toContain("Remove them first");
  });
});

describe("payment: never real money", () => {
  it("skip: a 'payment bypassed: test' record, and Stripe is never contacted", async () => {
    const out = await run({ payment: "skip" });
    expect(out.steps.find((s) => s.key === "payment").detail).toContain("Skipped");
    const [b] = await testRows();
    const payments = (await env.DB.prepare("SELECT * FROM payments WHERE booking_id = ?").bind(b.id).all()).results;
    expect(payments).toEqual([expect.objectContaining({ kind: "test", amount_pence: 0, note: "Payment bypassed: test", stripe_id: null })]);
    expect(stripeCalls()).toHaveLength(0);
  });

  it("fake, with a test key: Stripe's TEST mode and test card, recorded like a real payment", async () => {
    const out = await run({ payment: "fake" });
    expect(out.ok).toBe(true);
    expect(fakes.stripe.intents).toHaveLength(1);
    expect(fakes.stripe.intents[0].form).toMatchObject({ amount: "10000", currency: "gbp", payment_method: "pm_card_visa", confirm: "true", "metadata[test]": "1" });
    expect(fakes.stripe.keys.every((k) => k.startsWith("sk_test_"))).toBe(true);
    expect(fakes.stripe.sessions).toHaveLength(0); // no checkout page
    const [b] = await testRows();
    expect(b.paid_pence).toBe(10000);
    expect((await env.DB.prepare("SELECT stripe_id FROM payments WHERE booking_id = ? AND kind = 'payment'").bind(b.id).first("stripe_id"))).toBe("pi_test_1");
  });

  it("fake, with only a live key: Stripe isn't contacted at all; the payment is simulated", async () => {
    const out = await run({ payment: "fake" }, { extraEnv: { STRIPE_SECRET_KEY: "sk_live_realmoney" } });
    expect(out.ok).toBe(true);
    const step = out.steps.find((s) => s.key === "payment");
    expect(step.detail).toContain("Simulated");
    expect(step.detail).toContain("only a live key is set");
    expect(stripeCalls()).toHaveLength(0);
    const [b] = await testRows();
    expect(b.paid_pence).toBe(10000);
  });

  it("fake, with a live main key and a separate test key: only the test key is used", async () => {
    await run({ payment: "fake" }, { extraEnv: { STRIPE_SECRET_KEY: "sk_live_realmoney", STRIPE_TEST_SECRET_KEY: "sk_test_separate" } });
    expect(fakes.stripe.intents).toHaveLength(1);
    expect(fakes.stripe.keys).toEqual(["sk_test_separate"]);
  });

  it("a test booking can never be paid, refunded or charged for real afterwards", async () => {
    await run({ payment: "fake" }, { extraEnv: { STRIPE_SECRET_KEY: "sk_live_realmoney" } });
    const [b] = await testRows();
    const live = { ...env, STRIPE_SECRET_KEY: "sk_live_realmoney" };
    expect((await startCheckout(live, b, "balance")).problem).toContain("TEST booking");
    await cancelBooking(live, b, { by: "staff", refundPence: 10000, refundNow: true });
    expect(stripeCalls()).toHaveLength(0);
    expect((await getBooking(env, b.id)).refunded_pence).toBe(10000); // recorded, never sent to Stripe
  });
});

describe("emails: only ever to the admin", () => {
  it("by default nothing is sent; the confirmation is a preview", async () => {
    const out = await run({ payment: "fake" });
    expect(out.email.subject).toMatch(/^\[TEST\] You're booked in/);
    expect(out.email.html).toContain("<html");
    expect(out.email.text).toContain("TEST: this is a test booking");
    expect(out.email.to).toBe("");
    expect(fakes.google.emails).toHaveLength(0);
    // The receipt the payment would send was held back too
    const outbox = (await env.DB.prepare("SELECT * FROM outbox").all()).results;
    expect(outbox.every((m) => m.sent === 0)).toBe(true);
  });

  it("with 'email me', it goes to the admin who ran it and no one else", async () => {
    const out = await run({ emailMe: true, payment: "fake" });
    expect(out.ok).toBe(true);
    expect(fakes.google.emails).toHaveLength(1);
    expect(fakes.google.emails[0].to).toBe(ADMIN_EMAIL);
    expect(fakes.google.emails[0].subject).toMatch(/^\[TEST\] /);
  });

  it("nothing else about a test booking is ever emailed (moves, cancellations, reminders, a made-up address)", async () => {
    await run({ date: ukDay(1), time: "14:00" });
    const [b] = await testRows();
    expect(await sendBookingEmail(env, "receipt", b, { amount: 100 })).toBe(false);
    expect(await sendBookingEmail(env, "confirmation", b, { testSendTo: "someone-else@example.com" })).toBe(false);
    await cancelBooking(env, b, { by: "customer" });
    await sendReminders(env, Date.now());
    expect(fakes.google.emails).toHaveLength(0);
  });
});

describe("alerts: never to other staff", () => {
  const vapid = async () => {
    const pair = await crypto.subtle.generateKey({ name: "ECDSA", namedCurve: "P-256" }, true, ["sign", "verify"]);
    const jwk = await crypto.subtle.exportKey("jwk", pair.privateKey);
    const raw = await crypto.subtle.exportKey("raw", pair.publicKey);
    const b64url = (bytes) => btoa(String.fromCharCode(...new Uint8Array(bytes))).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
    return { VAPID_PUBLIC_KEY: b64url(raw), VAPID_PRIVATE_KEY: jwk.d, b64url };
  };
  const addPhone = async (endpoint, staffId, b64url) => {
    const pair = await crypto.subtle.generateKey({ name: "ECDH", namedCurve: "P-256" }, true, ["deriveBits"]);
    await env.DB.prepare("INSERT INTO push_subscriptions (endpoint, p256dh, auth, created_at, staff_id) VALUES (?, ?, ?, ?, ?)")
      .bind(endpoint, b64url(await crypto.subtle.exportKey("raw", pair.publicKey)), b64url(crypto.getRandomValues(new Uint8Array(16))), new Date().toISOString(), staffId)
      .run();
  };

  it("with 'alert me', only the admin's own phone; without it, no phone; never the Alerts list", async () => {
    const { b64url, ...keys } = await vapid();
    await addPhone("https://web.push.apple.com/admin-phone", "test-admin", b64url);
    await addPhone("https://web.push.apple.com/staff-phone", "test-staff", b64url);

    await run({}, { extraEnv: keys });
    expect(fakes.push).toHaveLength(0);

    const out = await run({ alertMe: true, payment: "fake", time: "18:30" }, { extraEnv: keys });
    expect(out.steps.find((s) => s.key === "alerts").status).toBe("pass");
    expect(fakes.push.map((p) => p.url)).toEqual(["https://web.push.apple.com/admin-phone"]);
    expect(out.alert.title).toMatch(/^TEST · /);
    expect((await env.DB.prepare("SELECT COUNT(*) AS n FROM notifications").first("n"))).toBe(0);
  });
});

describe("kept out of real counts and availability", () => {
  it("customers can still book its time, Nova Club doesn't see it, and staff counts leave it out", async () => {
    await run({ date: ukDay(30), time: "14:00" });
    const [b] = await testRows();
    // Free times for customers still include it
    expect((await freeTimesOn(env, RAP_2, ukDay(30))).times).toContain("14:00");
    // Nova Club's busy times don't include it
    const from = ukDay(29), until = ukDay(32);
    const club = await (await worker.fetch(new Request(`${BASE}/club/busy?from=${from}&until=${until}`), env)).json();
    expect(club.busy.some(([s, e]) => s < Date.parse(b.ends_at) && e > Date.parse(b.starts_at))).toBe(false);
    // NovaBot's booking tools don't list it or touch it
    expect((await runManageBookingTool(env, "find_bookings", { from: ukDay(29), to: ukDay(31) })).message).not.toContain(`#${b.id}:`);
    const cancel = await runManageBookingTool(env, "cancel_booking", { booking_id: b.id, notify_client: true, confirmed: true });
    expect(cancel.ok).toBe(false);
    expect(cancel.message).toContain("TEST booking");
    expect((await getBooking(env, b.id)).status).toBe("booked");
    // Staff questions (counts) leave it out; the Calendar tab shows it, marked TEST
    expect((await listBookings(env, Date.now(), { tests: false })).some((i) => i.id === b.id)).toBe(false);
    const shown = (await listBookings(env)).find((i) => i.id === b.id);
    expect(shown.name).toMatch(/^TEST · /);
    expect(shown.test).toBe(true);
  });

  it("blocks the time only when the admin chooses to", async () => {
    await run({ date: ukDay(30), time: "14:00", blockSlot: true });
    const [b] = await testRows();
    expect(b.test_blocks).toBe(1);
    expect(fakes.google.events.get(b.event_id).transparency).toBe("opaque");
    expect((await freeTimesOn(env, RAP_2, ukDay(30))).times).not.toContain("14:00");
  });
});

describe("clean-up", () => {
  it("'Remove all test bookings' removes each one, its calendar event, payments and emails, and nothing real", async () => {
    const real = await bookSession(env, { session_type_id: RAP_2, date: ukDay(20), time: "12:00", first_name: "Dana", last_name: "Hollis", email: "dana@example.com", phone: "07700 900111" }, { ip: "staff", staff: true });
    expect(real.ok).toBe(true);
    await run({ payment: "fake" });
    await run({ time: "18:30", emailMe: true });
    const tests = await testRows();
    expect(tests).toHaveLength(2);
    const events = tests.map((t) => t.event_id);

    const res = await call("/admin/test-booking/remove", { method: "POST", body: {} });
    const out = await res.json();
    expect(out).toMatchObject({ ok: true, removed: 2, kept: [], bookings: [] });
    expect(await testRows()).toHaveLength(0);
    for (const id of events) expect(fakes.google.events.has(id)).toBe(false);
    const ids = tests.map((t) => t.id);
    for (const table of ["payments", "outbox"]) {
      const n = await env.DB.prepare(`SELECT COUNT(*) AS n FROM ${table} WHERE booking_id IN (${ids.join(",")})`).first("n");
      expect(n).toBe(0);
    }
    // The real booking is untouched
    const kept = await getBooking(env, real.booked.id);
    expect(kept.status).toBe("booked");
    expect(fakes.google.events.has(kept.event_id)).toBe(true);
  });

  it("keeps a test booking whose calendar event couldn't be removed, and says so", async () => {
    await run();
    fakes.google.failCalendar = true;
    const out = await (await call("/admin/test-booking/remove", { method: "POST", body: {} })).json();
    expect(out.ok).toBe(false);
    expect(out.kept).toHaveLength(1);
    expect(await testRows()).toHaveLength(1);
  });

  it("removes itself after 24 hours (the every-minute timer)", async () => {
    await run({ time: "10:00" });
    await run({ time: "18:30" });
    const [old, fresh] = await testRows();
    await env.DB.prepare("UPDATE bookings SET created_at = ? WHERE id = ?").bind(new Date(Date.now() - 25 * 3_600_000).toISOString(), old.id).run();

    // Through the cron itself
    const ctx = createExecutionContext();
    await worker.scheduled({ scheduledTime: Date.now(), cron: "* * * * *" }, env, ctx);
    await waitOnExecutionContext(ctx);

    expect((await testRows()).map((b) => b.id)).toEqual([fresh.id]);
    expect(fakes.google.events.has(old.event_id)).toBe(false);
    expect(fakes.google.events.has(fresh.event_id)).toBe(true);
    // And once it's a day old, the fresh one goes too
    await removeOldTestBookings(env, Date.now() + 25 * 3_600_000);
    expect(await testRows()).toHaveLength(0);
  });
});

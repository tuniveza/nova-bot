// The website booking flow: booking page -> held time -> Stripe checkout ->
// webhook -> booked in Google Calendar -> emails from Gmail; and the customer's
// own booking page (pay, move, cancel).

import { createExecutionContext, env, waitOnExecutionContext } from "cloudflare:test";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import worker from "../src";
import { expireHolds, getBooking, sendReminders } from "../src/nova/bookings.js";
import { BASE, clearTables, connectGoogle, installFakes, paidEvent, stripeWebhook, ukDay, ukEvent, ukIso } from "./fakes.js";

const RAP_2 = 64806309; // £200, 4 hours + 30 minutes changeover
const VOICE_1H = 12738216; // £80

let fakes;
let ip; // each test is its own visitor, so rate limits don't carry over
beforeEach(async () => {
  await clearTables();
  fakes = installFakes();
  await connectGoogle();
  ip = `198.51.${Math.floor(Math.random() * 250)}.${Math.floor(Math.random() * 250)}`;
});
afterEach(() => vi.restoreAllMocks());

async function call(path, { method = "GET", body, headers = {} } = {}) {
  const ctx = createExecutionContext();
  const init = { method, headers: { "CF-Connecting-IP": ip, ...headers } };
  if (body !== undefined) {
    init.body = typeof body === "string" ? body : JSON.stringify(body);
    init.headers = { "Content-Type": "application/json", Origin: BASE, ...init.headers };
  }
  const res = await worker.fetch(new Request(BASE + path, init), env, ctx);
  await waitOnExecutionContext(ctx);
  return res;
}

const details = (date, time = "14:00", extra = {}) => ({
  session: RAP_2, date, time, first: "Kai", last: "Lee", email: "Kai@Example.com", phone: "07700 900123", notes: "Two vocalists", ...extra,
});

async function startBooking(date = ukDay(10), time = "14:00", extra = {}) {
  const res = await call("/book/api/checkout", { method: "POST", body: details(date, time, extra) });
  return res.json();
}

async function pay(bookingId, amount, opts) {
  const res = await worker.fetch(await stripeWebhook(paidEvent(bookingId, amount, opts)), env, createExecutionContext());
  return res;
}

describe("the booking page", () => {
  it("shows the sessions, filled in from the link", async () => {
    const res = await call(`/book?session=${RAP_2}&first=Kai&email=kai%40x.co`);
    expect(res.status).toBe(200);
    const html = await res.text();
    expect(html).toContain("Book a session");
    expect(html).toContain(`"session":${RAP_2}`);
    expect(html).toContain('"first":"Kai"');
    expect(html).toContain("Rap Package - 2 songs");
    expect(html).toContain("deposit");
  });

  it("says online booking isn't available until Google is connected", async () => {
    await env.DB.prepare("DELETE FROM settings WHERE key LIKE 'google_%'").run();
    const html = await (await call("/book")).text();
    expect(html).toContain("Online booking isn't available right now");
  });

  it("lists free times for a day", async () => {
    const day = ukDay(10);
    fakes.google.add(ukEvent(day, "10:00", "16:00"));
    const { times } = await (await call("/book/api/times", { method: "POST", body: { session: VOICE_1H, date: day } })).json();
    expect(times[0]).toBe("16:00");
    expect(times.at(-1)).toBe("21:30");
  });

  it("only takes changes from its own pages", async () => {
    const res = await call("/book/api/checkout", { method: "POST", body: details(ukDay(10)), headers: { Origin: "https://evil.example" } });
    expect(res.status).toBe(403);
  });

  it("checks the details first, in words for the customer", async () => {
    expect(await startBooking(ukDay(10), "14:00", { email: "nope" })).toMatchObject({ ok: false, field: "email" });
    expect(await startBooking(ukDay(10), "14:00", { last: "" })).toMatchObject({ ok: false, field: "name" });
    expect(await startBooking(ukDay(10), "14:00", { phone: "" })).toMatchObject({ ok: false, field: "phone" });
  });
});

describe("paying the deposit", () => {
  it("holds the time in the calendar and sends them to Stripe for the 50% deposit", async () => {
    const day = ukDay(10);
    const out = await startBooking(day);
    expect(out.ok).toBe(true);
    expect(out.url).toMatch(/^https:\/\/checkout\.stripe\.com\//);

    const b = await env.DB.prepare("SELECT * FROM bookings").first();
    expect(b).toMatchObject({ status: "hold", source: "website", price_pence: 20000, deposit_pence: 10000, email: "kai@example.com", starts_at: ukIso(day, "14:00") });
    const event = fakes.google.events.get(b.event_id);
    expect(event.summary).toContain("HOLD");
    expect(event.status).toBe("tentative");
    expect(event.extendedProperties.private.novaBooking).toBe(String(b.id));

    const checkout = fakes.stripe.sessions[0].form;
    expect(checkout["line_items[0][price_data][unit_amount]"]).toBe("10000");
    expect(checkout["line_items[0][price_data][currency]"]).toBe("gbp");
    expect(checkout["metadata[booking_id]"]).toBe(String(b.id));
    expect(checkout.customer_email).toBe("kai@example.com");
    expect(checkout.success_url).toBe(`${BASE}/booking/${b.token}?paid=1`);

    // While it's held, nobody else can take that time
    const { times } = await (await call("/book/api/times", { method: "POST", body: { session: VOICE_1H, date: day } })).json();
    expect(times).not.toContain("14:00");
  });

  it("is booked once Stripe says it's paid: calendar confirmed, confirmation emailed with a calendar file", async () => {
    await startBooking();
    let b = await env.DB.prepare("SELECT * FROM bookings").first();
    expect((await pay(b.id, 10000)).status).toBe(200);

    b = await getBooking(env, b.id);
    expect(b).toMatchObject({ status: "booked", paid_pence: 10000, hold_until: null });
    const event = fakes.google.events.get(b.event_id);
    expect(event.status).toBe("confirmed");
    expect(event.summary).toBe("Kai Lee · " + b.session);
    expect(event.description).toContain("£100 paid, £100 due");

    expect(fakes.google.emails).toHaveLength(1);
    const email = fakes.google.emails[0];
    expect(email.to).toBe("kai@example.com");
    expect(email.from).toBe("Novacane Studios <studio@novacane.test>");
    expect(email.subject).toMatch(/^You're booked in/);
    expect(email.text).toContain("The remaining £100 is due on arrival");
    expect(email.text).toContain(`${BASE}/booking/${b.token}`);
    expect(email.attachments[0].content).toContain("STATUS:CONFIRMED");
    expect(email.attachments[0].content).toContain(`UID:nova-booking-${b.id}@novacane.co.uk`);

    const sent = await env.DB.prepare("SELECT kind, sent FROM outbox").all();
    expect(sent.results).toEqual([{ kind: "confirmation", sent: 1 }]);
  });

  it("counts each Stripe payment once, however many times Stripe repeats it", async () => {
    await startBooking();
    const b = await env.DB.prepare("SELECT id FROM bookings").first();
    await pay(b.id, 10000);
    await pay(b.id, 10000);
    expect((await getBooking(env, b.id)).paid_pence).toBe(10000);
    expect(fakes.google.emails).toHaveLength(1);
  });

  it("turns away webhooks that Stripe didn't sign, or old ones", async () => {
    await startBooking();
    const b = await env.DB.prepare("SELECT id FROM bookings").first();
    const forged = await stripeWebhook(paidEvent(b.id, 10000), { secret: "whsec_wrong" });
    expect((await worker.fetch(forged, env, createExecutionContext())).status).toBe(400);
    const stale = await stripeWebhook(paidEvent(b.id, 10000), { t: Math.floor(Date.now() / 1000) - 3600 });
    expect((await worker.fetch(stale, env, createExecutionContext())).status).toBe(400);
    expect((await getBooking(env, b.id)).status).toBe("hold");
  });

  it("lets the time go if they leave checkout, or it runs out", async () => {
    await startBooking();
    let b = await env.DB.prepare("SELECT * FROM bookings").first();
    const back = await call(`/book/cancelled?token=${b.token}`);
    expect(await back.text()).toContain("No payment was taken");
    b = await getBooking(env, b.id);
    expect(b.status).toBe("expired");
    expect(fakes.google.events.has(b.event_id)).toBe(false);

    // And by the clock
    await startBooking(ukDay(11));
    const held = await env.DB.prepare("SELECT * FROM bookings WHERE status = 'hold'").first();
    await expireHolds(env, Date.parse(held.hold_until) + 1000);
    expect((await getBooking(env, held.id)).status).toBe("expired");
    expect(fakes.stripe.expired).toContain(held.checkout_id);
  });

  it("refunds a payment that arrives for a booking that was let go", async () => {
    await startBooking();
    const b = await env.DB.prepare("SELECT * FROM bookings").first();
    await call(`/book/cancelled?token=${b.token}`);
    await pay(b.id, 10000, { pi: "pi_late" });
    expect(fakes.stripe.refunds).toEqual([{ id: expect.any(String), paymentIntent: "pi_late", amount: 10000 }]);
  });

  it("won't hold a time someone else just took", async () => {
    const day = ukDay(10);
    expect((await startBooking(day)).ok).toBe(true);
    const second = await startBooking(day, "15:00", { email: "other@example.com" });
    expect(second).toMatchObject({ ok: false, field: "time" });
  });

  it("limits how many bookings one visitor can start in a day", async () => {
    for (let i = 0; i < 6; i++) expect((await startBooking(ukDay(20 + i))).ok).toBe(true);
    expect((await startBooking(ukDay(30))).message).toContain("a lot of bookings");
  });
});

describe("the customer's booking page", () => {
  async function bookedAndPaid(day = ukDay(10), time = "14:00") {
    await startBooking(day, time);
    const b = await env.DB.prepare("SELECT * FROM bookings ORDER BY id DESC").first();
    await pay(b.id, 10000);
    fakes.google.emails.length = 0;
    return getBooking(env, b.id);
  }

  it("shows the booking and what's left to pay, and the pay link makes a fresh checkout", async () => {
    const b = await bookedAndPaid();
    const html = await (await call(`/booking/${b.token}`)).text();
    expect(html).toContain("Booked");
    expect(html).toContain("£100");
    expect(html).toContain(`/pay/${b.token}?for=balance`);
    const res = await call(`/pay/${b.token}?for=balance`);
    expect(res.status).toBe(303);
    expect(res.headers.get("Location")).toMatch(/^https:\/\/checkout\.stripe\.com\//);
    expect(fakes.stripe.sessions.at(-1).form["line_items[0][price_data][unit_amount]"]).toBe("10000");
  });

  it("doesn't find a booking from a made-up link", async () => {
    expect((await call("/booking/xxxxxxxxxxxxxxxxxxxxxxxxxxxx")).status).toBe(404);
  });

  it("cancels with enough notice: out of the calendar, emailed, staff told to refund the deposit", async () => {
    const b = await bookedAndPaid();
    const out = await (await call(`/booking/${b.token}/cancel`, { method: "POST", body: {} })).json();
    expect(out.ok).toBe(true);
    const after = await getBooking(env, b.id);
    expect(after.status).toBe("cancelled");
    expect(fakes.google.events.has(b.event_id)).toBe(false);
    expect(fakes.google.emails[0].subject).toMatch(/^Cancelled/);
    expect(fakes.google.emails[0].text).toContain("Your refund of £100 will be processed by the team");
    expect(fakes.google.emails[0].attachments[0].content).toContain("METHOD:CANCEL");
    // CUSTOMER_CANCEL_REFUNDS is "staff": no automatic refund
    expect(fakes.stripe.refunds).toEqual([]);
  });

  it("keeps the deposit when it's cancelled with under 48 hours' notice", async () => {
    const b = await bookedAndPaid(ukDay(1), "10:00");
    await call(`/booking/${b.token}/cancel`, { method: "POST", body: {} });
    expect(fakes.google.emails[0].text).toContain("the deposit is non-refundable");
  });

  it("moves to another free time at least 48 hours away, and emails the new time", async () => {
    const b = await bookedAndPaid();
    const newDay = ukDay(12);
    const { times } = await (await call(`/booking/${b.token}/times`, { method: "POST", body: { date: newDay } })).json();
    expect(times).toContain("11:00");
    const out = await (await call(`/booking/${b.token}/move`, { method: "POST", body: { date: newDay, time: "11:00" } })).json();
    expect(out.ok).toBe(true);
    const moved = await getBooking(env, b.id);
    expect(moved.starts_at).toBe(ukIso(newDay, "11:00"));
    expect(fakes.google.events.get(b.event_id).start.dateTime).toBe(ukIso(newDay, "11:00"));
    expect(fakes.google.emails[0].subject).toMatch(/^Your session has moved/);
    expect(fakes.google.emails[0].text).toContain("It was:");
  });

  it("won't move it with under 48 hours to go", async () => {
    const b = await bookedAndPaid(ukDay(1), "10:00");
    const out = await (await call(`/booking/${b.token}/move`, { method: "POST", body: { date: ukDay(12), time: "11:00" } })).json();
    expect(out.ok).toBe(false);
  });
});

describe("reminders", () => {
  it("emails the day before, once", async () => {
    await startBooking(ukDay(10));
    const b = await env.DB.prepare("SELECT * FROM bookings").first();
    await pay(b.id, 10000);
    // Pretend it was booked weeks ago
    await env.DB.prepare("UPDATE bookings SET created_at = ? WHERE id = ?").bind(new Date(Date.now() - 30 * 86_400_000).toISOString(), b.id).run();
    fakes.google.emails.length = 0;
    const dayBefore = Date.parse(b.starts_at) - 20 * 3_600_000;
    await sendReminders(env, dayBefore);
    await sendReminders(env, dayBefore + 60_000);
    expect(fakes.google.emails.map((e) => e.subject)).toEqual([expect.stringMatching(/^See you tomorrow/)]);
  });
});

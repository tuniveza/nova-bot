// Staff managing bookings from Nova Hub's chat: find, cancel (with refunds),
// move, change details, change session/price/paid, payment links, refunds.

import { env } from "cloudflare:test";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { bookSession } from "../src/nova/book-session.js";
import { getBooking, paymentReceived } from "../src/nova/bookings.js";
import { runManageBookingTool } from "../src/nova/manage-bookings.js";
import { clearTables, connectGoogle, installFakes, ukDay, ukEvent, ukIso } from "./fakes.js";

const RAP_2 = 64806309; // £200, deposit £100
const VOICE_1H = 12738216; // £80

let fakes;
beforeEach(async () => {
  await clearTables();
  fakes = installFakes();
  await connectGoogle();
});
afterEach(() => vi.restoreAllMocks());

async function makeBooking({ day = ukDay(10), time = "14:00", type = RAP_2, first = "Dana", last = "Hollis", email = "dana@example.com", paid = 0 } = {}) {
  const out = await bookSession(env, { session_type_id: type, date: day, time, first_name: first, last_name: last, email, phone: "07700 900111" }, { ip: "staff", staff: true });
  expect(out.ok).toBe(true);
  if (paid) await paymentReceived(env, { bookingId: out.booked.id, amountPence: paid, stripeId: `pi_${out.booked.id}_${paid}`, purpose: "deposit" });
  fakes.google.emails.length = 0;
  return getBooking(env, out.booked.id);
}

const run = (name, input) => runManageBookingTool(env, name, input);

describe("find_bookings", () => {
  it("lists bookings with their numbers and what's paid, plus other calendar events", async () => {
    const b = await makeBooking({ paid: 10000 });
    fakes.google.add(ukEvent(ukDay(11), "10:00", "12:00", { summary: "Gear maintenance" }));
    const out = await run("find_bookings", { from: ukDay(9), to: ukDay(12) });
    expect(out.message).toContain(`#${b.id}:`);
    expect(out.message).toContain("Dana Hollis");
    expect(out.message).toContain("£100 of £200 paid");
    expect(out.message).toContain('Calendar event (not a booking)');
    expect(out.message).toContain('"Gear maintenance"');
  });

  it("finds by part of a name, email or phone", async () => {
    await makeBooking();
    await makeBooking({ day: ukDay(11), first: "Kai", last: "Lee", email: "kai@example.com" });
    expect((await run("find_bookings", { name: "kai" })).message).toMatch(/1 booking\(s\)[\s\S]*Kai Lee/);
    expect((await run("find_bookings", { phone: "+44 7700 900111" })).message).toContain("2 booking(s)");
    expect((await run("find_bookings", { email: "nobody" })).message).toContain("No bookings found");
  });
});

describe("cancel_booking", () => {
  it("asks first, then cancels, refunds the policy amount through Stripe and emails the client", async () => {
    const b = await makeBooking({ paid: 10000 });
    const ask = await run("cancel_booking", { booking_id: b.id, notify_client: true, confirmed: false });
    expect(ask.message).toContain("Not cancelled yet");
    expect(ask.message).toContain("Refund: £100 to their card (the studio's policy)");
    expect((await getBooking(env, b.id)).status).toBe("booked");

    const done = await run("cancel_booking", { booking_id: b.id, notify_client: true, confirmed: true });
    expect(done.ok).toBe(true);
    expect(done.message).toContain("£100 refunded");
    expect(fakes.stripe.refunds).toEqual([{ id: expect.any(String), paymentIntent: `pi_${b.id}_10000`, amount: 10000 }]);
    const after = await getBooking(env, b.id);
    expect(after).toMatchObject({ status: "cancelled", refunded_pence: 10000 });
    expect(fakes.google.events.has(b.event_id)).toBe(false);
    expect(fakes.google.emails[0].text).toContain("£100 is being refunded to your card");
  });

  it("keeps the deposit under 48 hours, unless staff say otherwise", async () => {
    const b = await makeBooking({ day: ukDay(1), time: "10:00", paid: 10000 });
    expect((await run("cancel_booking", { booking_id: b.id, notify_client: false, confirmed: false })).message).toContain("Refund: nothing");
    const done = await run("cancel_booking", { booking_id: b.id, notify_client: false, refund: "full", confirmed: true });
    expect(done.message).toContain("£100 refunded");
    expect(fakes.google.emails).toHaveLength(0);
  });

  it("won't refund more than was paid, or cancel twice, or a booking that doesn't exist", async () => {
    const b = await makeBooking({ paid: 10000 });
    expect((await run("cancel_booking", { booking_id: b.id, notify_client: true, refund: "150", confirmed: true })).ok).toBe(false);
    await run("cancel_booking", { booking_id: b.id, notify_client: false, refund: "none", confirmed: true });
    expect((await run("cancel_booking", { booking_id: b.id, notify_client: true, confirmed: true })).message).toContain("already cancelled");
    expect((await run("cancel_booking", { booking_id: 999, notify_client: true, confirmed: true })).message).toContain("no booking #999");
  });
});

describe("reschedule_booking", () => {
  it("moves it once confirmed, if the new time is free", async () => {
    const b = await makeBooking();
    const day = ukDay(15);
    expect((await run("reschedule_booking", { booking_id: b.id, date: day, time: "11:00", notify_client: true, confirmed: false })).message).toContain("Not moved yet");
    const done = await run("reschedule_booking", { booking_id: b.id, date: day, time: "11:00", notify_client: true, confirmed: true });
    expect(done.ok).toBe(true);
    expect((await getBooking(env, b.id)).starts_at).toBe(ukIso(day, "11:00"));
    expect(fakes.google.emails[0].subject).toMatch(/^Your session has moved/);
  });

  it("can move it a little within its own time (it doesn't clash with itself)", async () => {
    const b = await makeBooking({ time: "14:00" });
    const done = await run("reschedule_booking", { booking_id: b.id, date: ukDay(10), time: "15:00", notify_client: false, confirmed: true });
    expect(done.ok).toBe(true);
  });

  it("says when the time isn't free, and can override it if staff ask", async () => {
    const b = await makeBooking({ type: VOICE_1H });
    const day = ukDay(15);
    fakes.google.add(ukEvent(day, "11:00", "13:00"));
    expect((await run("reschedule_booking", { booking_id: b.id, date: day, time: "11:00", notify_client: false, confirmed: true })).message).toContain("isn't free");
    const forced = await run("reschedule_booking", { booking_id: b.id, date: day, time: "11:00", notify_client: false, ignore_availability: true, confirmed: true });
    expect(forced.ok).toBe(true);
  });
});

describe("changing details and money", () => {
  it("update_booking changes contact details in the calendar too", async () => {
    const b = await makeBooking();
    const done = await run("update_booking", { booking_id: b.id, phone: "07700 900999", notes: "Needs the vocal booth", confirmed: true });
    expect(done.message).toContain('phone: "07700 900111" → "07700 900999"');
    expect(fakes.google.events.get(b.event_id).description).toContain("Notes: Needs the vocal booth");
  });

  it("change_booking_extras changes the session and price, and marks it paid", async () => {
    const b = await makeBooking();
    const ask = await run("change_booking_extras", { booking_id: b.id, session_type: "Voiceover Recording with Engineer - 1 hour", confirmed: false });
    expect(ask.message).toContain('→ "Voiceover Recording with Engineer - 1 hour"');
    await run("change_booking_extras", { booking_id: b.id, session_type: String(VOICE_1H), confirmed: true });
    let after = await getBooking(env, b.id);
    expect(after).toMatchObject({ type_id: VOICE_1H, duration: 60, price_pence: 8000, deposit_pence: 4000 });
    expect(fakes.google.events.get(b.event_id).end.dateTime).toBe(new Date(Date.parse(b.starts_at) + 3_600_000).toISOString());

    await run("change_booking_extras", { booking_id: b.id, paid: true, confirmed: true });
    after = await getBooking(env, b.id);
    expect(after.paid_pence).toBe(8000);
    expect((await env.DB.prepare("SELECT kind, amount_pence FROM payments").first())).toEqual({ kind: "manual", amount_pence: 8000 });
  });

  it("send_payment_link emails the deposit or balance link", async () => {
    const b = await makeBooking({ paid: 10000 });
    expect((await run("send_payment_link", { booking_id: b.id, what: "deposit", confirmed: true })).message).toContain("Nothing to pay");
    const done = await run("send_payment_link", { booking_id: b.id, what: "balance", confirmed: true });
    expect(done.ok).toBe(true);
    expect(fakes.google.emails[0].subject).toBe(`Pay your balance: £100 for ${fakes.google.emails[0].subject.split("for ")[1]}`);
    expect(fakes.google.emails[0].text).toContain(`/pay/${b.token}?for=balance`);
  });

  it("refund_payment refunds online payments only", async () => {
    const b = await makeBooking({ paid: 10000 });
    expect((await run("refund_payment", { booking_id: b.id, amount: "120", confirmed: true })).ok).toBe(false);
    const done = await run("refund_payment", { booking_id: b.id, amount: "40", reason: "Started late", confirmed: true });
    expect(done.message).toContain("Refunded £40");
    expect((await getBooking(env, b.id)).refunded_pence).toBe(4000);
    expect(fakes.stripe.refunds[0].amount).toBe(4000);
  });

  it("tells staff when Gmail won't send", async () => {
    const b = await makeBooking();
    fakes.google.failGmail = true;
    const done = await run("send_payment_link", { booking_id: b.id, what: "deposit", confirmed: true });
    expect(done.ok).toBe(false);
    expect((await env.DB.prepare("SELECT sent, error FROM outbox ORDER BY id DESC").first()).sent).toBe(0);
  });
});

describe("without Google", () => {
  it("says the calendar isn't connected", async () => {
    await env.DB.prepare("DELETE FROM settings WHERE key LIKE 'google_%'").run();
    expect((await run("find_bookings", {})).message).toContain("isn't connected");
  });
});

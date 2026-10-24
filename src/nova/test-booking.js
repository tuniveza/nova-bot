// Test bookings: an admin checks the booking flow still works, without real money.
//
// Portal → Admin → Test booking (admin-test-booking.js) runs one pretend booking through
// Nova Bot's own booking engine (bookings.js), a step at a time:
//
//   slot found        the time is free in the studio calendar (freeSlot, as for customers)
//   booking created   createBooking(), with the test flag: a row, and an event in Google Calendar
//   payment           "skip": a "payment bypassed: test" record, no Stripe at all
//                     "fake": Stripe TEST mode with Stripe's test card, only with a test key
//                     (sk_test_…); with only a live key Stripe isn't touched and the payment is
//                     simulated. Either way it's recorded through paymentReceived(), like a real one.
//   confirmation      the email, shown as a preview; sent only to the admin, only if they ask
//   calendar event    the event is really there (read back from Google Calendar)
//   alerts            the staff alert, shown as a preview; sent only to the admin's own phones, if asked
//
// Safe edges (bookings.js and emails.js check the flag too, so nothing else leaks either):
// fake details (no client's data), "TEST" on everything, marked "free" in the calendar so
// customers can still book the time (unless the admin chooses to block it), no referral, no
// reminders, no staff alerts, kept out of NovaBot's booking tools and its counts.
// Clean-up: "Remove all test bookings", and the every-minute timer removes them after 24 hours.
// Nothing here is reachable by NovaBot (the AI): only an admin pressing the button.

import { addDays, calendarTouched, freeStarts, freeSlot, ukToday } from "./booking.js";
import { bookingLines, createBooking, getBooking, paymentReceived } from "./bookings.js";
import { buildEmail, moneyState, sendBookingEmail } from "./emails.js";
import { deleteEvent, googleReady, listEvents, offline } from "./google.js";
import { stripeTestKey, testModePayment } from "./stripe.js";
import { getType, money, msToUk, whenInWords } from "./studio.js";
import { notifyPhones } from "../push.js";

// Test bookings go after this long
export const TEST_KEEP_HOURS = 24;
// The most test bookings at once (so a stuck button can't fill the calendar)
export const MAX_TEST_BOOKINGS = 10;
// A quiet slot: this many days ahead, late in the day
const QUIET_DAYS_AHEAD = 28;
// The fake client: obviously not a person, at an address that can never receive email (.invalid)
export const TEST_PERSON = { firstName: "TEST", lastName: "Booking", email: "test-booking@novacane.invalid", phone: "" };

export const STEPS = [
  ["slot", "Slot found"],
  ["booking", "Booking created"],
  ["payment", "Payment"],
  ["email", "Confirmation email"],
  ["calendar", "Calendar event"],
  ["alerts", "Alerts"],
];

// ===== A QUIET SLOT =====

// The latest free start on the first day with one, about four weeks ahead: well away from
// today's real bookings. Returns { date, time } or null.
export async function quietSlot(env, typeId, today = ukToday()) {
  const type = getType(typeId);
  if (!type) return null;
  const from = addDays(today, QUIET_DAYS_AHEAD);
  const days = await freeStarts(env, type, from, addDays(from, 6), { fresh: true });
  const day = Object.keys(days).sort()[0];
  if (!day) return null;
  const times = Object.keys(days[day]).sort();
  return { date: day, time: times[times.length - 1] };
}

// ===== RUNNING ONE =====

// Run a test booking for `admin` (the signed-in admin's staff row). Options:
//   session (type id), date, time (UK; a quiet slot if left out),
//   payment: "skip" | "fake", blockSlot (let it block the time for customers),
//   emailMe (send the confirmation to the admin), alertMe (send the alert to the admin's phones).
// Returns { ok, booking, steps: [{ key, label, status: "pass"|"fail"|"skip", detail }], email, alert }.
export async function runTestBooking(env, admin, options = {}) {
  if (!admin || admin.role !== "admin") throw new Error("Admins only");
  const steps = STEPS.map(([key, label]) => ({ key, label, status: "waiting", detail: "" }));
  const step = (key) => steps.find((s) => s.key === key);
  const pass = (key, detail) => Object.assign(step(key), { status: "pass", detail });
  const skip = (key, detail) => Object.assign(step(key), { status: "skip", detail });
  const fail = (key, detail) => {
    Object.assign(step(key), { status: "fail", detail });
    for (const s of steps) if (s.status === "waiting") Object.assign(s, { status: "skip", detail: "Not run: an earlier step failed." });
  };
  const result = (extra = {}) => ({ ok: steps.every((s) => s.status !== "fail"), steps, ...extra });

  const payment = options.payment === "fake" ? "fake" : "skip";
  const blocks = options.blockSlot === true;
  const type = getType(options.session);

  // ---- Slot found ----
  if (!type) {
    fail("slot", "Pick a session.");
    return result();
  }
  const existing = await env.DB.prepare("SELECT COUNT(*) AS n FROM bookings WHERE test = 1").first("n");
  if (existing >= MAX_TEST_BOOKINGS) {
    fail("slot", `There are already ${existing} test bookings. Remove them first ("Remove all test bookings").`);
    return result();
  }
  if (!(await googleReady(env))) {
    fail("slot", "Google isn't connected, so the studio calendar can't be checked. Connect it in Admin → Google.");
    return result();
  }
  let date = String(options.date || "");
  let time = String(options.time || "");
  try {
    if (!date || !time) {
      const quiet = await quietSlot(env, type.id);
      if (!quiet) {
        fail("slot", "No free time about four weeks ahead to use. Pick a day and time.");
        return result();
      }
      ({ date, time } = quiet);
    }
    const slot = await freeSlot(env, { date, time }, ukToday(), { type });
    if (slot.problem) {
      fail("slot", slot.problem);
      return result();
    }
    time = slot.time;
    pass("slot", `${whenInWords(slot.startsAt, slot.endsAt)} (UK time) is free for ${type.name}.`);
  } catch (err) {
    fail("slot", `The studio calendar couldn't be read: ${short(err)}`);
    return result();
  }

  // ---- Booking created (and its calendar event) ----
  const made = await createBooking(env, {
    type,
    date,
    time,
    person: TEST_PERSON,
    source: "test",
    status: "booked",
    notes: `TEST booking made in Portal by ${admin.display_name || "an admin"}. Not a real client; it removes itself within ${TEST_KEEP_HOURS} hours.`,
    skipCheck: true, // just checked above
    test: { by: admin.id, blocks },
  });
  if (made.problem) {
    fail("booking", made.problem);
    return result();
  }
  let b = made.booking;
  pass("booking", `Booking #${b.id}, marked TEST. ${blocks ? "It blocks this time for customers (you chose that)." : "Customers can still book this time."}`);

  // ---- Payment ----
  const deposit = moneyState(b).depositDue;
  try {
    if (payment === "skip") {
      await env.DB.prepare("INSERT INTO payments (booking_id, kind, amount_pence, stripe_id, note, created_at) VALUES (?, 'test', 0, NULL, 'Payment bypassed: test', ?)")
        .bind(b.id, new Date().toISOString())
        .run();
      pass("payment", "Skipped: recorded as \"payment bypassed: test\". Stripe wasn't contacted.");
    } else if (stripeTestKey(env)) {
      const paid = await testModePayment(env, { booking: b, amountPence: deposit });
      await paymentReceived(env, { bookingId: b.id, amountPence: paid.amount, stripeId: paid.id, purpose: "deposit" });
      b = await getBooking(env, b.id);
      if (b.paid_pence !== paid.amount) throw new Error(`the booking shows ${money(b.paid_pence)} paid, not ${money(paid.amount)}`);
      pass("payment", `Faked in Stripe's TEST mode with Stripe's test card: ${money(paid.amount)} deposit (${paid.id}), recorded against the booking. No real money.`);
    } else {
      const id = `test_sim_${crypto.randomUUID()}`;
      await paymentReceived(env, { bookingId: b.id, amountPence: deposit, stripeId: id, purpose: "deposit" });
      b = await getBooking(env, b.id);
      if (b.paid_pence !== deposit) throw new Error(`the booking shows ${money(b.paid_pence)} paid, not ${money(deposit)}`);
      pass(
        "payment",
        `Simulated: ${money(deposit)} deposit recorded against the booking the way a Stripe payment is. Stripe wasn't contacted: ${env.STRIPE_SECRET_KEY ? "only a live key is set, and test bookings never use it" : "no Stripe key is set"}. Add STRIPE_TEST_SECRET_KEY (sk_test_…) to test Stripe itself.`
      );
    }
  } catch (err) {
    fail("payment", `The payment didn't go through: ${short(err)}`);
    return result({ booking: summary(b) });
  }

  // ---- Confirmation email (a preview; sent only to this admin, if asked) ----
  let email = null;
  try {
    const built = buildEmail(env, "confirmation", b);
    email = { subject: `[TEST] ${built.subject}`, text: built.text, html: built.html, to: options.emailMe ? admin.email : "" };
    if (options.emailMe) {
      const sent = await sendBookingEmail(env, "confirmation", b, { testSendTo: admin.email });
      if (!sent) {
        const why = await env.DB.prepare("SELECT error FROM outbox WHERE booking_id = ? ORDER BY id DESC LIMIT 1").bind(b.id).first("error");
        fail("email", `Couldn't send it to you: ${why || "unknown reason"}`);
        return result({ booking: summary(b), email });
      }
      pass("email", `Sent to you only (${admin.email})${offline(env) ? ", in the sandbox (kept in the outbox, not really sent)" : ""}. Preview below.`);
    } else {
      pass("email", "Built. Preview below; sent to no one.");
    }
  } catch (err) {
    fail("email", `The email couldn't be built: ${short(err)}`);
    return result({ booking: summary(b), email });
  }

  // ---- Calendar event (read back) ----
  try {
    if (!b.event_id) throw new Error("the booking has no calendar event");
    if (offline(env)) {
      pass("calendar", `Sandbox: the stand-in calendar event (${b.event_id}) is in place. Google isn't used here.`);
    } else {
      const events = await listEvents(env, Date.parse(b.starts_at) - 60_000, Date.parse(b.ends_at) + 60_000);
      const event = events.find((e) => e.id === b.event_id);
      if (!event) throw new Error("it isn't in Google Calendar");
      const marked = String(event.summary || "").startsWith("TEST");
      const free = event.transparency === "transparent";
      if (!marked) throw new Error("it isn't marked TEST");
      if (!blocks && !free) throw new Error("it isn't marked \"free\", so it would block customers");
      pass("calendar", `In Google Calendar as "${event.summary}"${free ? ', marked "free"' : ""}.`);
    }
  } catch (err) {
    fail("calendar", `The calendar event isn't right: ${short(err)}`);
    return result({ booking: summary(b), email });
  }

  // ---- Alerts (a preview; sent only to this admin's phones, if asked) ----
  const alert = { title: `TEST · New booking: ${b.first_name} ${b.last_name}`, body: ["Test booking from Portal (not real).", ...bookingLines(b)].join("\n") };
  try {
    if (options.alertMe) {
      const delivered = await notifyPhones(env, { ...alert, url: "/portal/?view=manage&page=%2Fadmin%2Ftest-booking", save: false, to: { staff: [admin.id] } });
      if (delivered > 0) pass("alerts", `Sent to your ${delivered === 1 ? "phone" : `${delivered} phones`} only. No other staff were told.`);
      else skip("alerts", "None of your phones have alerts turned on (or alerts aren't set up), so nothing was sent. Preview below. No other staff were told.");
    } else {
      pass("alerts", "Built. Preview below; sent to no one. Staff phones are never told about test bookings.");
    }
  } catch (err) {
    fail("alerts", `The alert couldn't be sent: ${short(err)}`);
  }

  return result({ booking: summary(await getBooking(env, b.id)), email, alert });
}

const short = (err) => String(err?.message || err).slice(0, 300);

// What the test page shows for a booking
function summary(b) {
  if (!b) return null;
  const { net } = moneyState(b);
  return {
    id: b.id,
    status: b.status,
    session: b.session,
    when: whenInWords(b.starts_at, b.ends_at),
    starts_at: b.starts_at,
    created_at: b.created_at,
    created_uk: (() => {
      const t = msToUk(Date.parse(b.created_at));
      return `${t.date} ${t.time}`;
    })(),
    paid: net > 0 ? money(net) : "nothing",
    blocks: Boolean(b.test_blocks),
    by: b.test_by,
    event: Boolean(b.event_id),
    event_link: b.event_link || null,
  };
}

// ===== LISTING AND REMOVING =====

export async function listTestBookings(env) {
  const { results } = await env.DB.prepare("SELECT * FROM bookings WHERE test = 1 ORDER BY id DESC LIMIT 100").all();
  return results.map(summary);
}

// Remove test bookings: their calendar events, payments, emails and alerts, then the rows.
// `olderThanMs`: only those made before then (the 24-hour timer). If a calendar event
// can't be removed (Google down), that booking stays, to try again later.
// Returns { removed, kept: [{ id, why }] }.
export async function removeTestBookings(env, { olderThanMs = null, limit = 100 } = {}) {
  const { results } = olderThanMs
    ? await env.DB.prepare("SELECT * FROM bookings WHERE test = 1 AND created_at < ? ORDER BY id LIMIT ?").bind(new Date(olderThanMs).toISOString(), limit).all()
    : await env.DB.prepare("SELECT * FROM bookings WHERE test = 1 ORDER BY id LIMIT ?").bind(limit).all();
  let removed = 0;
  const kept = [];
  for (const b of results) {
    if (!b.test) continue; // never a real booking
    try {
      if (b.event_id) await deleteEvent(env, b.event_id);
    } catch (err) {
      kept.push({ id: b.id, why: `its calendar event couldn't be removed (${short(err)})` });
      continue;
    }
    await env.DB.batch([
      env.DB.prepare("DELETE FROM payments WHERE booking_id = ?").bind(b.id),
      env.DB.prepare("DELETE FROM outbox WHERE booking_id = ?").bind(b.id),
      env.DB.prepare("DELETE FROM notifications WHERE appointment_id = ? AND title LIKE 'TEST%'").bind(b.id),
      env.DB.prepare("DELETE FROM bookings WHERE id = ? AND test = 1").bind(b.id),
    ]);
    removed++;
  }
  if (removed) calendarTouched();
  return { removed, kept };
}

// Every minute (index.js): test bookings older than 24 hours remove themselves
export async function removeOldTestBookings(env, now = Date.now()) {
  return removeTestBookings(env, { olderThanMs: now - TEST_KEEP_HOURS * 3_600_000, limit: 20 });
}

// What the test page needs to start: the live booking system, how payments would be faked
export async function testBookingFacts(env) {
  const live = /^(sk|rk)_live_/.test(String(env.STRIPE_SECRET_KEY || ""));
  return {
    system: "nova",
    google: await googleReady(env),
    sandbox: offline(env),
    stripe: stripeTestKey(env) ? "test" : live ? "live-only" : env.STRIPE_SECRET_KEY ? "other" : "none",
    keepHours: TEST_KEEP_HOURS,
    max: MAX_TEST_BOOKINGS,
  };
}

// The booking engine: making, paying for, moving and cancelling bookings.
//
// Every booking is a row in the bookings table and an event in the studio's
// Google Calendar (google.js), kept in step:
//
//   hold       the customer is paying the deposit at checkout; the time is held in
//              the calendar ("Hold" event) for CHECKOUT_HOLD_MINUTES, then let go
//   booked     in the calendar; deposit paid, or a link to pay it has been emailed
//   cancelled  removed from the calendar
//   expired    a hold that was never paid for
//
// Money goes through Stripe (stripe.js); every payment, refund and "marked paid"
// is in the payments table. Emails go through Gmail (emails.js). Staff phones hear
// about everything that matters (push.js).

import { calendarTouched, dayInWords, freeSlot, publicUrl, ukToday } from "./booking.js";
import { calendarChanged } from "./club-calendar.js";
import { deleteEvent, insertEvent, patchEvent } from "./google.js";
import { manageLink, moneyState, sendBookingEmail } from "./emails.js";
import { notifyPhones } from "../push.js";
import { createCheckout, expireCheckout, refund, stripeOffline, stripeReady } from "./stripe.js";
import {
  CANCEL_NOTICE_HOURS,
  CHECKOUT_HOLD_MINUTES,
  CUSTOMER_CANCEL_REFUNDS,
  CUSTOMER_MOVE_HOURS,
  REMINDER_HOURS,
  STUDIO,
  TIME_ZONE,
  depositFor,
  getType,
  money,
  pence,
  ukToMs,
  whenInWords,
} from "./studio.js";

const EMAIL_PATTERN = /^[^\s@<>"]+@[^\s@<>"]+\.[^\s@<>"]{2,}$/;
export const isEmail = (s) => EMAIL_PATTERN.test(String(s || ""));

// ===== READING =====

export async function getBooking(env, id) {
  if (!Number.isInteger(Number(id)) || Number(id) <= 0) return null;
  return env.DB.prepare("SELECT * FROM bookings WHERE id = ?").bind(Number(id)).first();
}

export async function getBookingByToken(env, token) {
  if (!/^[A-Za-z0-9_-]{20,64}$/.test(String(token || ""))) return null;
  return env.DB.prepare("SELECT * FROM bookings WHERE token = ?").bind(token).first();
}

export const fullName = (b) => `${b.first_name} ${b.last_name}`.trim();
export const when = (b) => whenInWords(b.starts_at, b.ends_at);

// "#12: Saturday 31 October 2026, 17:00–21:00, Dana Hollis, Rap Package…, email…, phone…, £100 of £200 paid"
export function describe(b) {
  const { net } = moneyState(b);
  const paid = net <= 0 ? "nothing paid" : net >= b.price_pence ? `paid in full (${money(net)})` : `${money(net)} of ${money(b.price_pence)} paid`;
  return [
    `#${b.id}: ${when(b)}`,
    fullName(b),
    b.session,
    b.email ? `email ${b.email}` : "",
    b.phone ? `phone ${b.phone}` : "",
    paid,
    b.status !== "booked" ? `status ${b.status}` : "",
    b.notes ? `notes: "${String(b.notes).slice(0, 100)}"` : "",
  ]
    .filter(Boolean)
    .join(", ");
}

// The lines for a staff notification or the Alerts tab
export function bookingLines(b) {
  const { net, balanceDue } = moneyState(b);
  return [
    b.session,
    `${when(b)} (#${b.id})`,
    `Name: ${fullName(b)}`,
    b.phone && `Phone: ${b.phone}`,
    `Email: ${b.email}`,
    `Price: ${money(b.price_pence)}`,
    net > 0 ? `Paid: ${money(net)}${balanceDue > 0 ? `, ${money(balanceDue)} to pay` : " (in full)"}` : "Paid: nothing yet",
    b.referral_code && `Referral code: ${b.referral_code}`,
    b.notes && `Notes: ${b.notes}`,
  ].filter(Boolean);
}

async function tellStaff(env, b, title, extraLines = []) {
  try {
    await notifyPhones(env, {
      title,
      body: [...extraLines, ...bookingLines(b)].join("\n"),
      url: b.event_link || "/app/",
      appointmentId: b.id,
    });
  } catch (err) {
    console.log("Couldn't tell staff:", err);
  }
}

// ===== THE CALENDAR EVENT =====

function eventFor(env, b) {
  const hold = b.status === "hold";
  const { net, balanceDue } = moneyState(b);
  const paid = net <= 0 ? "Not paid" : balanceDue > 0 ? `${money(net)} paid, ${money(balanceDue)} due` : "Paid in full";
  return {
    summary: `${hold ? "HOLD (paying deposit) · " : ""}${fullName(b)} · ${b.session}`,
    description: [
      `Booking #${b.id} (${b.source})`,
      `Phone: ${b.phone || "-"}`,
      `Email: ${b.email}`,
      `Price: ${money(b.price_pence)} · ${paid}`,
      b.referral_code ? `Referral code: ${b.referral_code}` : "",
      b.notes ? `Notes: ${b.notes}` : "",
      "",
      `Customer's page: ${manageLink(env, b)}`,
      "Manage it in Nova Hub (change it there, not here, so the customer is emailed).",
    ]
      .filter((l, i, all) => l !== "" || (i > 0 && all[i - 1] !== ""))
      .join("\n"),
    start: { dateTime: b.starts_at, timeZone: TIME_ZONE },
    end: { dateTime: b.ends_at, timeZone: TIME_ZONE },
    location: STUDIO.address,
    status: hold ? "tentative" : "confirmed",
    colorId: hold ? "8" : b.source === "website" ? "3" : "9",
    transparency: "opaque",
    extendedProperties: { private: { novaBooking: String(b.id) } },
    reminders: { useDefault: true },
  };
}

// The calendar changed: free times are looked up afresh, and Nova Club hears straight away
async function touched(env) {
  calendarTouched();
  await calendarChanged(env).catch((err) => console.log("Couldn't mark the Nova Club calendar as changed:", err));
}

async function syncEvent(env, b) {
  if (!b.event_id) return;
  await patchEvent(env, b.event_id, eventFor(env, b));
}

// ===== MAKING A BOOKING =====

// Make a booking. `status`: "hold" (website checkout) or "booked" (chat or staff).
// The time must already have been checked with freeSlot(); it's checked once more
// here, just before the calendar event goes in.
// Returns { booking } or { problem, taken? }.
export async function createBooking(env, { type, date, time, person, source, status = "booked", notes = "", referralCode = "", chatId = null, sender = null, pricePence = null, skipCheck = false }) {
  if (!skipCheck) {
    const slot = await freeSlot(env, { date, time }, ukToday(), { type });
    if (slot.problem) return { problem: slot.problem, taken: Boolean(slot.taken) };
  }
  const startsAt = new Date(ukToMs(date, time)).toISOString();
  const endsAt = new Date(Date.parse(startsAt) + type.duration * 60_000).toISOString();
  const price = pricePence ?? pence(type.price);
  const now = new Date().toISOString();
  const holdUntil = status === "hold" ? new Date(Date.now() + (CHECKOUT_HOLD_MINUTES + 10) * 60_000).toISOString() : null;
  const token = newToken();

  const { meta } = await env.DB.prepare(
    `INSERT INTO bookings (token, status, source, type_id, session, duration, changeover, starts_at, ends_at, first_name, last_name, email, phone, notes,
       price_pence, deposit_pence, hold_until, referral_code, chat_id, sender, created_at, updated_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
  )
    .bind(
      token, status, source, type.id, type.name, type.duration, type.changeover || 0, startsAt, endsAt,
      person.firstName, person.lastName, person.email.toLowerCase(), person.phone || null, notes || null,
      price, depositFor(price), holdUntil, referralCode || null, chatId, sender, now, now
    )
    .run();
  let b = await getBooking(env, meta.last_row_id);

  // Into the calendar. If that fails, the booking doesn't exist.
  try {
    const event = await insertEvent(env, eventFor(env, b));
    await env.DB.prepare("UPDATE bookings SET event_id = ?, event_link = ? WHERE id = ?").bind(event.id, event.htmlLink || null, b.id).run();
    b = { ...b, event_id: event.id, event_link: event.htmlLink || null };
  } catch (err) {
    console.log("Couldn't put the booking in Google Calendar:", err);
    await env.DB.prepare("DELETE FROM bookings WHERE id = ?").bind(b.id).run();
    return { problem: "The studio calendar couldn't be reached just now, so nothing was booked. Please try again in a minute." };
  }
  await touched(env);

  // Another booking may have landed in the same moment: keep the first, let this one go
  const mine = [Date.parse(startsAt), Date.parse(endsAt) + (type.changeover || 0) * 60_000];
  const { results: near } = await env.DB.prepare(
    "SELECT starts_at, ends_at, changeover FROM bookings WHERE id < ? AND status IN ('hold', 'booked') AND starts_at < ? AND ends_at > ?"
  )
    .bind(b.id, new Date(mine[1]).toISOString(), new Date(mine[0] - 86_400_000).toISOString())
    .all();
  const clash = near.some((o) => Date.parse(o.starts_at) < mine[1] && Date.parse(o.ends_at) + (o.changeover || 0) * 60_000 > mine[0]);
  if (clash) {
    await deleteEvent(env, b.event_id).catch(() => {});
    await env.DB.prepare("UPDATE bookings SET status = 'expired', updated_at = ? WHERE id = ?").bind(new Date().toISOString(), b.id).run();
    return { problem: `${dayInWords(date)} at ${time} has just been taken.`, taken: true };
  }

  await saveReferral(env, b);
  return { booking: b };
}

function newToken() {
  const bytes = crypto.getRandomValues(new Uint8Array(24));
  return btoa(String.fromCharCode(...bytes)).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

// A booking made in the chat or by staff: in the calendar now, deposit by email link
export async function bookAndAskForDeposit(env, args) {
  const made = await createBooking(env, { ...args, status: "booked" });
  if (made.problem) return made;
  const b = made.booking;
  await sendBookingEmail(env, "confirmation", b);
  await tellStaff(env, b, `New booking: ${fullName(b)}`, [`Booked ${args.source === "staff" ? "by staff" : "by NovaBot in the chat"}. Deposit link emailed.`]);
  return made;
}

// ===== CHECKOUT (website) =====

// Start paying: a Stripe checkout for a booking's deposit or balance (or what's left of it).
// Returns { url } or { problem }.
export async function startCheckout(env, b, purpose = "auto", { hold = false } = {}) {
  const { depositDue, balanceDue } = moneyState(b);
  if (purpose === "auto") purpose = depositDue > 0 ? "deposit" : "balance";
  const amount = purpose === "deposit" ? depositDue : balanceDue;
  if (amount <= 0) return { problem: "Nothing to pay: this booking is already paid." };
  if (!stripeReady(env)) return { problem: "Online payment isn't set up yet. Please contact the studio." };
  const back = manageLink(env, b);
  if (stripeOffline(env)) {
    // Sandbox: a local stand-in for Stripe's page (book-page.js)
    return { url: `${publicUrl(env)}/book/sandbox-pay?token=${encodeURIComponent(b.token)}&for=${purpose}&amount=${amount}` };
  }
  const session = await createCheckout(env, {
    booking: b,
    amountPence: amount,
    purpose,
    successUrl: `${back}?paid=1`,
    cancelUrl: hold ? `${publicUrl(env)}/book/cancelled?token=${encodeURIComponent(b.token)}` : back,
    expiresInMinutes: hold ? CHECKOUT_HOLD_MINUTES : 23 * 60,
  });
  await env.DB.prepare("UPDATE bookings SET checkout_id = ? WHERE id = ?").bind(session.id, b.id).run();
  return { url: session.url };
}

// Stripe (or the sandbox stand-in) says a payment went through
export async function paymentReceived(env, { bookingId, amountPence, stripeId, purpose }) {
  let b = await getBooking(env, bookingId);
  if (!b) {
    console.log(`Payment ${stripeId} for unknown booking ${bookingId}`);
    return;
  }
  // Each Stripe payment counts once, however many times Stripe tells us
  const inserted = await env.DB.prepare(
    "INSERT INTO payments (booking_id, kind, amount_pence, stripe_id, note, created_at) VALUES (?, 'payment', ?, ?, ?, ?) ON CONFLICT (stripe_id) DO NOTHING"
  )
    .bind(b.id, amountPence, stripeId, purpose || null, new Date().toISOString())
    .run();
  if (!inserted.meta.changes) return;
  const now = new Date().toISOString();
  await env.DB.prepare("UPDATE bookings SET paid_pence = paid_pence + ?, updated_at = ? WHERE id = ?").bind(amountPence, now, b.id).run();
  b = await getBooking(env, b.id);

  if (b.status === "hold") {
    // The deposit's in: it's booked
    await env.DB.prepare("UPDATE bookings SET status = 'booked', hold_until = NULL, updated_at = ? WHERE id = ?").bind(now, b.id).run();
    b = await getBooking(env, b.id);
    await syncEvent(env, b).catch((err) => console.log("Couldn't confirm the calendar event:", err));
    await touched(env);
    await sendBookingEmail(env, "confirmation", b);
    await tellStaff(env, b, `New booking: ${fullName(b)}`, [`Booked on the website, ${money(amountPence)} deposit paid.`]);
    return;
  }
  if (b.status === "cancelled" || b.status === "expired") {
    // Paid for a booking that no longer exists (e.g. the hold ran out): give it back
    try {
      await refundBooking(env, b, amountPence, "Paid after the booking was let go");
    } catch (err) {
      console.log("Couldn't refund a late payment:", err);
    }
    await tellStaff(env, b, `Payment for a ${b.status} booking: ${fullName(b)}`, [`${money(amountPence)} came in after it was ${b.status}; a refund has been asked for. Please check Stripe.`]);
    return;
  }
  await syncEvent(env, b).catch((err) => console.log("Couldn't update the calendar event:", err));
  await sendBookingEmail(env, "receipt", b, { amount: amountPence });
  await tellStaff(env, b, `Payment received: ${fullName(b)}`, [`${money(amountPence)} paid online.`]);
}

// A checkout page closed without paying: let a held time go
export async function checkoutExpired(env, { bookingId, checkoutId }) {
  const b = await getBooking(env, bookingId);
  if (b && b.status === "hold" && b.paid_pence === 0 && (!checkoutId || b.checkout_id === checkoutId)) await releaseHold(env, b);
}

export async function releaseHold(env, b) {
  await deleteEvent(env, b.event_id).catch((err) => console.log("Couldn't remove a hold from the calendar:", err));
  await env.DB.prepare("UPDATE bookings SET status = 'expired', updated_at = ? WHERE id = ? AND status = 'hold'").bind(new Date().toISOString(), b.id).run();
  await touched(env);
}

// Every minute: holds whose checkout has run out are let go
export async function expireHolds(env, now = Date.now()) {
  const { results } = await env.DB.prepare("SELECT * FROM bookings WHERE status = 'hold' AND hold_until < ? LIMIT 20")
    .bind(new Date(now).toISOString())
    .all();
  for (const b of results) {
    await expireCheckout(env, b.checkout_id);
    // Paid in the last moment? (The webhook may still be on its way.)
    const fresh = await getBooking(env, b.id);
    if (fresh.status === "hold" && fresh.paid_pence === 0) await releaseHold(env, fresh);
  }
}

// Every minute: the day-before reminders
export async function sendReminders(env, now = Date.now()) {
  const { results } = await env.DB.prepare(
    "SELECT * FROM bookings WHERE status = 'booked' AND reminded_at IS NULL AND starts_at > ? AND starts_at <= ? LIMIT 20"
  )
    .bind(new Date(now).toISOString(), new Date(now + REMINDER_HOURS * 3_600_000).toISOString())
    .all();
  for (const b of results) {
    // Booked less than a day ahead: the confirmation was the reminder
    const fresh = Date.parse(b.starts_at) - Date.parse(b.created_at) < REMINDER_HOURS * 3_600_000;
    await env.DB.prepare("UPDATE bookings SET reminded_at = ? WHERE id = ?").bind(new Date(now).toISOString(), b.id).run();
    if (!fresh) await sendBookingEmail(env, "reminder", b);
  }
}

// ===== CHANGING A BOOKING =====

const hoursUntil = (b, now = Date.now()) => (Date.parse(b.starts_at) - now) / 3_600_000;

// What a cancellation gives back under the studio's policy: everything paid with
// enough notice; without it, the deposit is kept and anything above it is returned.
export function policyRefund(b, now = Date.now()) {
  const { net } = moneyState(b);
  if (net <= 0) return 0;
  return hoursUntil(b, now) >= CANCEL_NOTICE_HOURS ? net : Math.max(0, net - b.deposit_pence);
}

// Cancel. `refundPence`: what to give back (null = the policy amount, refunded
// only when `refundNow`). Returns { ok, message } for staff or the customer.
export async function cancelBooking(env, b, { by, notify = true, note = "", refundPence = null, refundNow = by === "staff" }) {
  if (b.status === "cancelled") return { ok: false, message: "That booking is already cancelled." };
  const amount = refundPence ?? policyRefund(b);
  const now = new Date().toISOString();
  await env.DB.prepare("UPDATE bookings SET status = 'cancelled', cancelled_at = ?, cancel_reason = ?, updated_at = ?, hold_until = NULL WHERE id = ?")
    .bind(now, `${by}${note ? ": " + note : ""}`.slice(0, 500), now, b.id)
    .run();
  await deleteEvent(env, b.event_id).catch((err) => console.log("Couldn't remove the cancelled booking from the calendar:", err));
  await touched(env);
  await markReferralCancelled(env, b.id);
  let cancelled = await getBooking(env, b.id);

  // The money
  let moneyLine = "";
  let staffLine = "";
  if (amount > 0 && refundNow) {
    try {
      await refundBooking(env, cancelled, amount, `Cancelled by ${by}`);
      cancelled = await getBooking(env, b.id);
      moneyLine = `${money(amount)} is being refunded to your card. It usually shows within 5 to 10 working days.`;
      staffLine = `${money(amount)} refunded.`;
    } catch (err) {
      moneyLine = `Your refund of ${money(amount)} will be sorted by the team.`;
      staffLine = `Couldn't refund ${money(amount)} automatically (${err.message}). Please refund it in Stripe.`;
    }
  } else if (amount > 0) {
    moneyLine = `Your refund of ${money(amount)} will be processed by the team shortly.`;
    staffLine = `Refund due: ${money(amount)}. Ask NovaBot in Nova Hub to "refund booking ${b.id}".`;
  } else if (moneyState(b).net > 0) {
    moneyLine = `As it was cancelled with less than ${CANCEL_NOTICE_HOURS} hours' notice, the deposit is non-refundable.`;
    staffLine = `Within ${CANCEL_NOTICE_HOURS} hours: deposit kept.`;
  }

  if (notify) await sendBookingEmail(env, "cancelled", cancelled, { note, money: moneyLine });
  await tellStaff(env, cancelled, `Booking cancelled: ${fullName(b)}`, [`Cancelled by ${by === "customer" ? "the customer" : "staff"}.`, staffLine].filter(Boolean));
  return { ok: true, message: [`Cancelled: ${describe(b)}.`, staffLine, notify ? "The client has been emailed." : "The client wasn't emailed."].filter(Boolean).join(" ") };
}

// Move to a new day and time (UK). Returns { ok, message }.
export async function moveBooking(env, b, { date, time, by, notify = true, ignoreAvailability = false }) {
  if (b.status !== "booked") return { ok: false, message: `Booking #${b.id} is ${b.status}, so it can't be moved.` };
  const type = { id: b.type_id, name: b.session, duration: b.duration, changeover: b.changeover };
  const slot = await freeSlot(env, { date, time }, ukToday(), { type, ignoreBookingId: b.id });
  if (slot.problem && !(ignoreAvailability && slot.taken)) return { ok: false, taken: Boolean(slot.taken), message: slot.problem };
  const startsAt = slot.startsAt || new Date(ukToMs(date, time)).toISOString();
  const endsAt = new Date(Date.parse(startsAt) + b.duration * 60_000).toISOString();
  const was = when(b);
  await env.DB.prepare("UPDATE bookings SET starts_at = ?, ends_at = ?, reminded_at = NULL, updated_at = ? WHERE id = ?")
    .bind(startsAt, endsAt, new Date().toISOString(), b.id)
    .run();
  const moved = await getBooking(env, b.id);
  try {
    await syncEvent(env, moved);
  } catch (err) {
    // Put it back: the calendar must match
    await env.DB.prepare("UPDATE bookings SET starts_at = ?, ends_at = ?, updated_at = ? WHERE id = ?").bind(b.starts_at, b.ends_at, new Date().toISOString(), b.id).run();
    return { ok: false, message: "The studio calendar couldn't be updated just now, so it hasn't moved. Try again in a minute." };
  }
  await touched(env);
  await env.DB.prepare("UPDATE appointments SET starts_at = ?, updated_at = ? WHERE id = ?").bind(startsAt, new Date().toISOString(), b.id).run();
  if (notify) await sendBookingEmail(env, "moved", moved, { was });
  await tellStaff(env, moved, `Booking moved: ${fullName(b)}`, [`Moved by ${by === "customer" ? "the customer" : "staff"}. Was: ${was}`]);
  return { ok: true, message: `Moved: ${fullName(b)}'s ${b.session} is now ${when(moved)}.${notify ? " The client has been emailed." : ""}` };
}

// Change contact details or notes
export async function updateDetails(env, b, changes) {
  const columns = { firstName: "first_name", lastName: "last_name", email: "email", phone: "phone", notes: "notes" };
  const sets = Object.keys(changes).filter((k) => columns[k]);
  if (!sets.length) return b;
  await env.DB.prepare(`UPDATE bookings SET ${sets.map((k) => `${columns[k]} = ?`).join(", ")}, updated_at = ? WHERE id = ?`)
    .bind(...sets.map((k) => changes[k]), new Date().toISOString(), b.id)
    .run();
  const updated = await getBooking(env, b.id);
  await syncEvent(env, updated).catch((err) => console.log("Couldn't update the calendar event:", err));
  return updated;
}

// Change the session type and/or price, and/or mark paid (cash, bank transfer…) or unpaid
export async function changeExtras(env, b, { typeId = null, pricePence = null, paid = null }) {
  const lines = [];
  const now = new Date().toISOString();
  if (typeId) {
    const type = getType(typeId);
    if (!type) throw new Error("No such session type");
    const endsAt = new Date(Date.parse(b.starts_at) + type.duration * 60_000).toISOString();
    const newPrice = pricePence ?? pence(type.price);
    await env.DB.prepare("UPDATE bookings SET type_id = ?, session = ?, duration = ?, changeover = ?, ends_at = ?, price_pence = ?, deposit_pence = ?, updated_at = ? WHERE id = ?")
      .bind(type.id, type.name, type.duration, type.changeover || 0, endsAt, newPrice, depositFor(newPrice), now, b.id)
      .run();
    lines.push(`Session: ${type.name}`, `Price: ${money(newPrice)}`);
  } else if (pricePence !== null) {
    await env.DB.prepare("UPDATE bookings SET price_pence = ?, deposit_pence = ?, updated_at = ? WHERE id = ?").bind(pricePence, depositFor(pricePence), now, b.id).run();
    lines.push(`Price: ${money(pricePence)}`);
  }
  let updated = await getBooking(env, b.id);
  if (paid !== null) {
    const { net } = moneyState(updated);
    const difference = paid ? updated.price_pence - net : -net;
    if (difference !== 0) {
      await env.DB.prepare("INSERT INTO payments (booking_id, kind, amount_pence, note, created_at) VALUES (?, 'manual', ?, ?, ?)")
        .bind(b.id, difference, paid ? "Marked paid by staff" : "Marked unpaid by staff", now)
        .run();
      await env.DB.prepare("UPDATE bookings SET paid_pence = paid_pence + ?, updated_at = ? WHERE id = ?").bind(difference, now, b.id).run();
    }
    lines.push(paid ? "Marked paid in full" : "Marked not paid");
    updated = await getBooking(env, b.id);
  }
  await syncEvent(env, updated).catch((err) => console.log("Couldn't update the calendar event:", err));
  await touched(env);
  return { booking: updated, lines };
}

// Refund up to `amountPence` across the booking's Stripe payments, newest first
export async function refundBooking(env, b, amountPence, reason) {
  const { results } = await env.DB.prepare("SELECT stripe_id, amount_pence FROM payments WHERE booking_id = ? AND kind = 'payment' ORDER BY id DESC").bind(b.id).all();
  const refunded = await env.DB.prepare("SELECT COALESCE(SUM(amount_pence), 0) AS total FROM payments WHERE booking_id = ? AND kind = 'refund'").bind(b.id).first("total");
  let left = amountPence;
  let alreadyBack = refunded;
  const done = [];
  for (const p of results) {
    if (left <= 0) break;
    // Older refunds come off the newest payments first, as Stripe saw them
    const room = Math.max(0, p.amount_pence - alreadyBack);
    alreadyBack = Math.max(0, alreadyBack - p.amount_pence);
    const take = Math.min(room, left);
    if (take <= 0) continue;
    const id = stripeOffline(env) || String(p.stripe_id).startsWith("sandbox_") ? `sandbox_refund_${crypto.randomUUID()}` : await refund(env, { paymentIntent: p.stripe_id, amountPence: take, bookingId: b.id, reason });
    await env.DB.prepare("INSERT INTO payments (booking_id, kind, amount_pence, stripe_id, note, created_at) VALUES (?, 'refund', ?, ?, ?, ?)")
      .bind(b.id, take, id, String(reason || "").slice(0, 200), new Date().toISOString())
      .run();
    await env.DB.prepare("UPDATE bookings SET refunded_pence = refunded_pence + ?, updated_at = ? WHERE id = ?").bind(take, new Date().toISOString(), b.id).run();
    left -= take;
    done.push(id);
  }
  if (left > 0) throw new Error(`only ${money(amountPence - left)} could be refunded online (the rest wasn't paid through Stripe)`);
  return done;
}

// Email a payment link (deposit or balance)
export async function requestPayment(env, b, purpose) {
  return sendBookingEmail(env, "payment-request", b, { purpose });
}

// ===== CUSTOMERS CHANGING THEIR OWN BOOKING =====

export function customerCanMove(b, now = Date.now()) {
  return b.status === "booked" && hoursUntil(b, now) >= CUSTOMER_MOVE_HOURS;
}

export async function customerCancel(env, b) {
  if (b.status !== "booked") return { ok: false, message: "This booking can't be cancelled online." };
  if (hoursUntil(b) <= 0) return { ok: false, message: "This session has already started." };
  return cancelBooking(env, b, { by: "customer", refundNow: CUSTOMER_CANCEL_REFUNDS === "auto" });
}

// ===== REFERRALS (the referral report on /admin) =====

async function saveReferral(env, b) {
  try {
    const now = new Date().toISOString();
    await env.DB.prepare(
      `INSERT INTO appointments (id, first_name, last_name, email, phone, appointment_type, starts_at, status, booked_at, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, 'scheduled', ?, ?) ON CONFLICT (id) DO NOTHING`
    )
      .bind(b.id, b.first_name, b.last_name, b.email, b.phone, b.session, b.starts_at, now, now)
      .run();
    if (!b.referral_code) return;
    const code = String(b.referral_code).toUpperCase().replace(/\s+/g, "");
    const active = await env.DB.prepare("SELECT code, referrer FROM referral_codes WHERE code = ? AND active = 1").bind(code).first();
    await env.DB.prepare(
      "UPDATE appointments SET referral_answer = 'yes', referral_code = ?, referrer_name = ?, invalid_code = ?, referral_source = 'booking form', referral_at = ? WHERE id = ?"
    )
      .bind(active ? active.code : null, active ? active.referrer : null, active ? null : code.slice(0, 64), now, b.id)
      .run();
  } catch (err) {
    console.log("Couldn't save the referral:", err);
  }
}

async function markReferralCancelled(env, id) {
  await env.DB.prepare("UPDATE appointments SET status = 'canceled', updated_at = ? WHERE id = ?").bind(new Date().toISOString(), id).run().catch(() => {});
}

// ===== FOR NOVA HUB =====

// Bookings in a time range (the Calendar tab, staff questions), soonest first
export async function bookingsBetween(env, fromIso, untilIso, statuses = ["booked"]) {
  const { results } = await env.DB.prepare(
    `SELECT * FROM bookings WHERE status IN (${statuses.map(() => "?").join(", ")}) AND starts_at < ? AND ends_at > ? ORDER BY starts_at LIMIT 1000`
  )
    .bind(...statuses, untilIso, fromIso)
    .all();
  return results;
}

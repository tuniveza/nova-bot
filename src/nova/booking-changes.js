// The booking changes behind Portal → Approvals, for Nova's own booking system
// (src/booking-actions.js keeps the queue: who proposed what, who approved it, and that it runs once).
//
// Two halves, both only ever called from the queue:
//   checkBookingChange()   checks a proposal against the bookings table and the studio's Google
//                       Calendar and writes its plain-English summary (never the AI's words)
//   makeBookingChange() makes the change, after an admin pressed Approve
//
//   create        make a booking            { typeId, start, firstName, lastName, email, phone?, notes?, notifyClient }
//   reschedule    move a booking            { bookingId, start, notifyClient, ignoreAvailability? }
//   cancel        cancel a booking          { bookingId, notifyClient, note?, refund? }
//                 refund: "policy" (the default), "full", "none", or pence
//   update        change a booking's client details or notes { bookingId, firstName?, lastName?, email?, phone?, notes? }
//   extras        session type, price, paid, a payment link or a refund
//                 { bookingId, type?, price?, paid?, paymentLink?: "deposit"|"balance", refund?: pence|"all", reason? }
//   block_add     block off a time          { start, end, notes? }  (a busy event in the studio's Google Calendar)
//   block_remove  remove a blocked-off time { blockId }  (that event's id)
//
// (start and end: UTC ISO, or the UK clock "YYYY-MM-DDTHH:MM". `appointmentId` is still read as
// `bookingId`, for a Nova Agent from before.)
//
// Everything is done the way staff would do it by hand: the client is emailed unless the change
// says not to, the calendar event follows, and staff phones hear about it (nova/bookings.js).

import { dayInWords } from "./booking.js";
import {
  bookAndAskForDeposit,
  cancelBooking,
  changeExtras,
  createBooking,
  describe,
  fullName,
  getBooking,
  isEmail,
  moveBooking,
  policyRefund,
  refundBooking,
  requestPayment,
  updateDetails,
} from "./bookings.js";
import { moneyState } from "./emails.js";
import { deleteEvent, getEvent, insertEvent } from "./google.js";
import { SESSION_TYPES, TIME_ZONE, getType, money, msToUk, pence } from "./studio.js";
import { readTime, ukClock, ukShort } from "../uk-time.js";

// How far ahead a booking or blocked time can be
const MAX_AHEAD_MS = 2 * 365 * 86400000;
// The longest blocked-off time in one go
const MAX_BLOCK_MS = 31 * 86400000;

const fail = (status, error) => ({ status, error });

function text(value, max) {
  return typeof value === "string" ? value.replace(/\r\n?/g, "\n").trim().slice(0, max) : "";
}

function positiveId(value) {
  const n = typeof value === "string" && /^\d{1,15}$/.test(value.trim()) ? Number(value) : value;
  return Number.isInteger(n) && n > 0 ? n : null;
}

// A start or end time -> UTC ISO, or a problem
function readWhen(value, label, { future = true } = {}) {
  const date = readTime(value);
  if (!date) return { problem: `${label} must be a UK time "YYYY-MM-DDTHH:MM" or a UTC time (ISO 8601).` };
  if (future && date.getTime() < Date.now()) return { problem: `${label} (${ukShort(date)}) is in the past.` };
  if (date.getTime() > Date.now() + MAX_AHEAD_MS) return { problem: `${label} is more than two years ahead.` };
  return { iso: date.toISOString() };
}

const emailNote = (notify) => (notify ? "the client is emailed" : "no email to the client");
const span = (start, end) => {
  const a = ukShort(start);
  const b = ukShort(end);
  return a.slice(0, -5) === b.slice(0, -5) ? `${a}–${ukClock(end)}` : `${a} to ${b}`;
};

// "40", "£40.00" -> 4000 pence, or null
function poundsToPence(value) {
  const t = String(value ?? "").replace(/[£\s,]/g, "");
  return /^\d{1,5}(\.\d{1,2})?$/.test(t) ? pence(t) : null;
}

// A session type by its id or name, or null
function typeFrom(value) {
  if (value === undefined || value === null || value === "") return null;
  const byId = getType(value);
  if (byId) return byId;
  const wanted = String(value).trim().toLowerCase();
  return SESSION_TYPES.find((t) => t.name.toLowerCase() === wanted) || SESSION_TYPES.find((t) => t.name.toLowerCase().includes(wanted)) || null;
}

// The booking a change is about: there, real (not a test) and not cancelled. -> { b } or { problem }
async function liveBooking(env, raw) {
  const id = positiveId(raw?.bookingId ?? raw?.appointmentId);
  if (!id) return { problem: "bookingId: which booking (its number, e.g. 12)?" };
  const b = await getBooking(env, id);
  if (!b) return { problem: `There's no booking #${id}.` };
  if (b.test) return { problem: `Booking #${id} is a TEST booking: an admin removes it in Portal → Admin → Test booking.` };
  if (b.status === "cancelled") return { problem: `Booking #${id} is already cancelled.` };
  if (b.status !== "booked") return { problem: `Booking #${id} is ${b.status}, so it can't be changed.` };
  return { b };
}

// How much a cancellation refunds: { pence, words } or { problem }
function refundFor(b, choice) {
  const { net } = moneyState(b);
  const c = choice === undefined || choice === null || choice === "" ? "policy" : String(choice).trim().toLowerCase();
  let amount;
  if (c === "policy") amount = policyRefund(b);
  else if (c === "full" || c === "all") amount = net;
  else if (c === "none" || c === "0") amount = 0;
  else if (Number.isInteger(choice) && choice >= 0) amount = choice;
  else return { problem: 'refund: "policy", "full", "none" or an amount in pence.' };
  if (amount > net) return { problem: `Only ${money(net)} has been paid, so no more than that can be refunded.` };
  return { pence: amount, words: amount > 0 ? `${money(amount)} refunded to their card${c === "policy" ? " (the studio's policy)" : ""}` : "no refund" };
}

// Money paid online and not yet refunded (what Stripe can give back)
async function onlineLeft(env, b) {
  const paid = await env.DB.prepare("SELECT COALESCE(SUM(amount_pence), 0) AS total FROM payments WHERE booking_id = ? AND kind = 'payment'").bind(b.id).first("total");
  return Math.max(0, (paid || 0) - b.refunded_pence);
}

// Is this calendar event a blocked-off time staff may remove (not a booking)?
const isBooking = (event) => Boolean(event?.extendedProperties?.private?.novaBooking);

// ===== CHECKING =====

// Check and tidy a proposal's details, and write its summary. -> { payload, summary } or { status, error }
export async function checkBookingChange(env, kind, raw) {
  const input = raw && typeof raw === "object" && !Array.isArray(raw) ? raw : {};
  const notifyClient = input.notifyClient !== false;

  if (kind === "create") {
    const type = getType(positiveId(input.typeId));
    if (!positiveId(input.typeId)) return fail(400, "typeId: which session type (its id from the session list)?");
    if (!type) return fail(400, `There's no session type ${input.typeId}.`);
    const start = readWhen(input.start, "start");
    if (start.problem) return fail(400, start.problem);
    const firstName = text(input.firstName, 60);
    const lastName = text(input.lastName, 60);
    const email = text(input.email, 200).toLowerCase();
    if (!firstName || !lastName) return fail(400, "The client's first and last name are needed.");
    if (!isEmail(email)) return fail(400, "The client's email address is needed.");
    const payload = { typeId: type.id, start: start.iso, firstName, lastName, email, notifyClient };
    if (text(input.phone, 40)) payload.phone = text(input.phone, 40);
    if (text(input.notes, 2000)) payload.notes = text(input.notes, 2000);
    const end = new Date(Date.parse(start.iso) + type.duration * 60000);
    return { payload, summary: `Book ${firstName} ${lastName} (${email}) for ${type.name} on ${span(start.iso, end)} (${emailNote(notifyClient)}${notifyClient ? ", with a link to pay the deposit" : ""})` };
  }

  if (kind === "reschedule") {
    const found = await liveBooking(env, input);
    if (found.problem) return fail(400, found.problem);
    const start = readWhen(input.start, "start");
    if (start.problem) return fail(400, start.problem);
    if (Date.parse(found.b.starts_at) === Date.parse(start.iso)) return fail(400, `It's already at ${ukShort(start.iso)}.`);
    const payload = { bookingId: found.b.id, start: start.iso, notifyClient };
    if (input.ignoreAvailability === true) payload.ignoreAvailability = true;
    return {
      payload,
      summary: `Move ${fullName(found.b)}'s ${found.b.session} (#${found.b.id}) from ${ukShort(found.b.starts_at)} to ${ukShort(start.iso)} (${emailNote(notifyClient)}${payload.ignoreAvailability ? ", even if that time isn't free" : ""})`,
    };
  }

  if (kind === "cancel") {
    const found = await liveBooking(env, input);
    if (found.problem) return fail(400, found.problem);
    const refund = refundFor(found.b, input.refund);
    if (refund.problem) return fail(400, refund.problem);
    const note = text(input.note, 500);
    const payload = { bookingId: found.b.id, notifyClient, refund: refund.pence };
    if (note) payload.note = note;
    return {
      payload,
      summary: `Cancel ${fullName(found.b)}'s ${found.b.session} (#${found.b.id}) on ${ukShort(found.b.starts_at)}: ${refund.words} (${emailNote(notifyClient)}${note && notifyClient ? `, with the note "${note}"` : ""})`,
    };
  }

  if (kind === "update") {
    const found = await liveBooking(env, input);
    if (found.problem) return fail(400, found.problem);
    const b = found.b;
    const changes = {};
    for (const [key, max] of [["firstName", 60], ["lastName", 60], ["email", 200], ["phone", 40]]) {
      if (text(input[key], max)) changes[key] = key === "email" ? text(input[key], max).toLowerCase() : text(input[key], max);
    }
    if (typeof input.notes === "string") changes.notes = input.notes.slice(0, 2000);
    if (changes.email && !isEmail(changes.email)) return fail(400, "That email address doesn't look right.");
    const before = { firstName: b.first_name, lastName: b.last_name, email: b.email, phone: b.phone, notes: b.notes };
    for (const key of Object.keys(changes)) if (String(before[key] || "") === changes[key]) delete changes[key];
    if (Object.keys(changes).length === 0) return fail(400, "Nothing to change: give at least one of firstName, lastName, email, phone, notes that's different.");
    const NAMES = { firstName: "first name", lastName: "last name", email: "email", phone: "phone", notes: "notes" };
    const list = Object.entries(changes).map(([key, value]) => `${NAMES[key]} "${String(before[key] || "").slice(0, 100)}" → "${value.slice(0, 100)}"`);
    return { payload: { bookingId: b.id, ...changes }, summary: `Change ${fullName(b)}'s ${b.session} (#${b.id}) on ${ukShort(b.starts_at)}: ${list.join(", ")}` };
  }

  if (kind === "extras") {
    const found = await liveBooking(env, input);
    if (found.problem) return fail(400, found.problem);
    const b = found.b;
    const payload = { bookingId: b.id };
    const list = [];
    if (input.type !== undefined && input.type !== null && input.type !== "") {
      const type = typeFrom(input.type);
      if (!type) return fail(400, `There's no session type "${String(input.type).slice(0, 80)}".`);
      if (type.id !== b.type_id) {
        payload.type = type.id;
        list.push(`session "${b.session}" → "${type.name}"`);
      }
    }
    if (input.price !== undefined && input.price !== null && input.price !== "") {
      const p = poundsToPence(input.price);
      if (p === null) return fail(400, "price: the amount in pounds, e.g. 80.00.");
      payload.price = (p / 100).toFixed(2);
      list.push(`price ${money(b.price_pence)} → ${money(p)}`);
    }
    if (typeof input.paid === "boolean") {
      payload.paid = input.paid;
      list.push(input.paid ? "mark it paid in full (money taken outside Stripe)" : "mark it not paid");
    }
    if (input.paymentLink !== undefined && input.paymentLink !== null && input.paymentLink !== "") {
      const what = input.paymentLink === "deposit" ? "deposit" : input.paymentLink === "balance" ? "balance" : null;
      if (!what) return fail(400, 'paymentLink: "deposit" or "balance".');
      const { depositDue, balanceDue } = moneyState(b);
      const amount = what === "deposit" ? depositDue : balanceDue;
      if (amount <= 0) return fail(400, `Nothing to pay for the ${what}: ${describe(b)}.`);
      payload.paymentLink = what;
      list.push(`email ${b.email} a link to pay the ${what} (${money(amount)})`);
    }
    if (input.refund !== undefined && input.refund !== null && input.refund !== "") {
      const left = await onlineLeft(env, b);
      const amount = String(input.refund).trim().toLowerCase() === "all" ? left : Number.isInteger(input.refund) ? input.refund : poundsToPence(input.refund);
      if (amount === null || amount <= 0) return fail(400, 'refund: an amount in pence, or "all".');
      if (amount > left) return fail(400, `Only ${money(left)} was paid online and not yet refunded, so at most that can go back through Stripe.`);
      payload.refund = amount;
      const reason = text(input.reason, 200);
      if (reason) payload.reason = reason;
      list.push(`refund ${money(amount)} to their card${reason ? ` ("${reason}")` : ""}`);
    }
    if (!list.length) return fail(400, "Nothing to change: give type, price, paid, paymentLink or refund.");
    return { payload, summary: `Change ${fullName(b)}'s booking #${b.id} on ${ukShort(b.starts_at)}: ${list.join(", ")}` };
  }

  if (kind === "block_add") {
    const start = readWhen(input.start, "start");
    if (start.problem) return fail(400, start.problem);
    const end = readWhen(input.end, "end");
    if (end.problem) return fail(400, end.problem);
    const length = Date.parse(end.iso) - Date.parse(start.iso);
    if (length <= 0) return fail(400, "end must be after start.");
    if (length > MAX_BLOCK_MS) return fail(400, "That's more than a month: block it off in smaller pieces.");
    const payload = { start: start.iso, end: end.iso };
    const notes = text(input.notes, 500);
    if (notes) payload.notes = notes;
    return { payload, summary: `Block off ${span(start.iso, end.iso)} in the studio's calendar${notes ? ` ("${notes}")` : ""}` };
  }

  if (kind === "block_remove") {
    const blockId = typeof input.blockId === "string" || typeof input.blockId === "number" ? String(input.blockId).trim().slice(0, 1024) : "";
    if (!blockId) return fail(400, "blockId: which blocked time (its calendar event id)?");
    const event = await getEvent(env, blockId);
    if (!event) return fail(400, `There's no blocked time ${blockId} in the studio's calendar.`);
    if (isBooking(event)) return fail(400, "That's a booking, not a blocked time: cancel the booking instead.");
    const s = event.start?.dateTime || event.start?.date;
    const e = event.end?.dateTime || event.end?.date;
    const name = text(event.summary, 100);
    return { payload: { blockId }, summary: `Remove the blocked-off time ${s && e ? span(s, e) : blockId}${name ? ` ("${name}")` : ""}` };
  }

  return fail(400, `kind must be one of: create, reschedule, cancel, update, extras, block_add, block_remove.`);
}

// ===== CARRYING IT OUT (an admin approved it) =====

// -> { ok, result } or { ok: false, error }
export async function makeBookingChange(env, kind, p) {
  if (kind === "create") {
    const type = getType(p.typeId);
    if (!type) return { ok: false, error: `There's no session type ${p.typeId} any more.` };
    const { date, time } = msToUk(Date.parse(p.start));
    const args = { type, date, time, source: "staff", notes: p.notes || "", person: { firstName: p.firstName, lastName: p.lastName, email: p.email, phone: p.phone || null } };
    const made = p.notifyClient === false ? await createBooking(env, { ...args, status: "booked" }) : await bookAndAskForDeposit(env, args);
    if (made.problem) return { ok: false, error: made.problem };
    return { ok: true, result: { bookingId: made.booking.id } };
  }

  if (kind === "block_add") {
    const event = await insertEvent(env, {
      summary: p.notes ? `Blocked: ${p.notes}` : "Blocked",
      description: "Blocked off in Portal → Approvals: no bookings at this time.",
      start: { dateTime: p.start, timeZone: TIME_ZONE },
      end: { dateTime: p.end, timeZone: TIME_ZONE },
      transparency: "opaque",
      colorId: "8",
      extendedProperties: { private: { novaBlock: "1" } },
    });
    return { ok: true, result: { blockId: event.id || null } };
  }

  if (kind === "block_remove") {
    const event = await getEvent(env, p.blockId);
    if (event && isBooking(event)) return { ok: false, error: "That's a booking, not a blocked time." };
    await deleteEvent(env, p.blockId);
    return { ok: true, result: { blockId: p.blockId } };
  }

  // Everything else is about one booking, as it is now
  const found = await liveBooking(env, p);
  if (found.problem) return { ok: false, error: found.problem };
  const b = found.b;

  if (kind === "reschedule") {
    const { date, time } = msToUk(Date.parse(p.start));
    const moved = await moveBooking(env, b, { date, time, by: "staff", notify: p.notifyClient !== false, ignoreAvailability: p.ignoreAvailability === true });
    if (!moved.ok) return { ok: false, error: moved.taken ? `${dayInWords(date)} at ${time} isn't free in the calendar any more.` : moved.message };
    return { ok: true, result: { bookingId: b.id, start: p.start } };
  }
  if (kind === "cancel") {
    const out = await cancelBooking(env, b, { by: "staff", notify: p.notifyClient !== false, note: p.note || "", refundPence: Number.isInteger(p.refund) ? p.refund : null, refundNow: true });
    return out.ok ? { ok: true, result: { bookingId: b.id, note: out.message } } : { ok: false, error: out.message };
  }
  if (kind === "update") {
    const changes = {};
    for (const key of ["firstName", "lastName", "email", "phone", "notes"]) if (key in p) changes[key] = p[key];
    await updateDetails(env, b, changes);
    return { ok: true, result: { bookingId: b.id } };
  }
  if (kind === "extras") {
    const notes = [];
    let current = b;
    if ("type" in p || "price" in p || "paid" in p) {
      const { booking, lines } = await changeExtras(env, current, {
        typeId: "type" in p ? p.type : null,
        pricePence: "price" in p ? pence(p.price) : null,
        paid: "paid" in p ? p.paid : null,
      });
      current = booking;
      notes.push(...lines);
    }
    if (p.refund) {
      try {
        await refundBooking(env, current, p.refund, p.reason || "Refunded by staff");
        notes.push(`Refunded ${money(p.refund)}`);
        current = await getBooking(env, b.id);
      } catch (err) {
        return { ok: false, error: `Not refunded: ${err.message}. Check Stripe.` };
      }
    }
    if (p.paymentLink) {
      const sent = await requestPayment(env, current, p.paymentLink);
      if (!sent) return { ok: false, error: `${notes.length ? notes.join(", ") + ". But the" : "The"} payment link email couldn't be sent (Gmail didn't take it). Check Google in Portal → Admin.` };
      notes.push(`Payment link for the ${p.paymentLink} emailed`);
    }
    return { ok: true, result: { bookingId: b.id, note: notes.join(", ") } };
  }
  return { ok: false, error: `Unknown kind ${kind}.` };
}


// Staff managing bookings from Nova Hub's chat
//
// In Nova Hub, staff can ask NovaBot to find, cancel, move or change a booking
// ("cancel Dana's session on Saturday", "move Kai to 4pm", "send Ola the
// balance link", "refund booking 12"). These tools are only given to NovaBot in
// the staff chat, never on the website.
//
// Everything happens straight away, in the bookings table, the studio's Google
// Calendar, Gmail (the client's emails) and Stripe (refunds), see bookings.js.
//
// Safety:
// - Changes name the booking by its number (#12), which NovaBot gets from
//   find_bookings, so it can't mix up two people with similar names.
// - Every change takes two calls. The first (confirmed false) changes nothing and
//   gives NovaBot a summary to show staff. Only a second call with confirmed true
//   makes the change, after staff have clearly said yes.

import { dayInWords, eventSpan, normaliseTime, ukToday } from "./booking.js";
import {
  cancelBooking,
  changeExtras,
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
import { googleReady, listEvents } from "./google.js";
import { SESSION_TYPES, getType, money, msToUk, pence, ukToMs } from "./studio.js";

// The most bookings find_bookings lists in one go (keeps replies readable)
const MAX_LISTED = 15;

const ID = { type: "integer", description: "The booking's number (#12 → 12), from find_bookings" };
const CONFIRMED = {
  type: "boolean",
  description: "false: just check it and get a summary to show staff (nothing changes). true: do it, only after staff have seen that summary and clearly said yes.",
};

export const FIND_BOOKINGS_TOOL = {
  name: "find_bookings",
  description:
    "Find bookings in the studio's calendar, to answer staff questions or before changing one. Give a date range and/or part of the client's name, email or phone. Lists each booking with its number, plus anything else in the calendar that blocks time.",
  input_schema: {
    type: "object",
    properties: {
      from: { type: "string", description: "First day to look at, YYYY-MM-DD (UK date). Default: today" },
      to: { type: "string", description: "Last day to look at, YYYY-MM-DD. Default: 60 days after `from`" },
      name: { type: "string", description: "All or part of the client's name" },
      email: { type: "string", description: "All or part of the client's email" },
      phone: { type: "string", description: "The client's phone number (any format)" },
      include_cancelled: { type: "boolean", description: "Also list cancelled bookings" },
    },
  },
};

export const CANCEL_BOOKING_TOOL = {
  name: "cancel_booking",
  description:
    "Cancel a booking: it leaves the calendar, and the client is emailed. Money: by default the studio's policy is refunded through Stripe (everything paid with 48+ hours' notice; otherwise the deposit is kept). Find it with find_bookings first.",
  input_schema: {
    type: "object",
    properties: {
      booking_id: ID,
      notify_client: { type: "boolean", description: "Email the client the cancellation (usually yes)" },
      refund: { type: "string", description: '"policy" (default), "full" (everything paid), "none", or an amount in pounds such as "40"' },
      note: { type: "string", description: "Optional message included in the client's cancellation email" },
      confirmed: CONFIRMED,
    },
    required: ["booking_id", "notify_client", "confirmed"],
  },
};

export const RESCHEDULE_BOOKING_TOOL = {
  name: "reschedule_booking",
  description: "Move a booking to a new day and/or start time. The calendar is updated and the client is emailed. Find it with find_bookings first.",
  input_schema: {
    type: "object",
    properties: {
      booking_id: ID,
      date: { type: "string", description: "The new day, YYYY-MM-DD (UK date)" },
      time: { type: "string", description: "The new start time, 24-hour HH:MM (UK time)" },
      notify_client: { type: "boolean", description: "Email the client the new time (usually yes)" },
      ignore_availability: {
        type: "boolean",
        description: "Move it even if the calendar shows that time as not free. Only if staff explicitly ask to override.",
      },
      confirmed: CONFIRMED,
    },
    required: ["booking_id", "date", "time", "notify_client", "confirmed"],
  },
};

export const UPDATE_BOOKING_TOOL = {
  name: "update_booking",
  description:
    "Change a booking's client details or notes: first name, last name, email, phone, notes. Only give the fields that change. (Session type, price and paid status: change_booking_extras.) Find it with find_bookings first.",
  input_schema: {
    type: "object",
    properties: {
      booking_id: ID,
      first_name: { type: "string" },
      last_name: { type: "string" },
      email: { type: "string" },
      phone: { type: "string" },
      notes: { type: "string", description: "Replaces the booking's notes" },
      confirmed: CONFIRMED,
    },
    required: ["booking_id", "confirmed"],
  },
};

export const CHANGE_EXTRAS_TOOL = {
  name: "change_booking_extras",
  description:
    "Change a booking's session type, price, or paid status (e.g. they paid cash or by bank transfer: mark it paid). Only give what changes. Find the booking with find_bookings first.",
  input_schema: {
    type: "object",
    properties: {
      booking_id: ID,
      session_type: { type: "string", description: "The new session type: its ID or name from the BOOKABLE SESSIONS list" },
      price: { type: "string", description: "The new total price in pounds, e.g. \"80.00\"" },
      paid: { type: "boolean", description: "true: mark it paid in full (money taken outside Stripe). false: mark it not paid." },
      confirmed: CONFIRMED,
    },
    required: ["booking_id", "confirmed"],
  },
};

export const PAYMENT_LINK_TOOL = {
  name: "send_payment_link",
  description: "Email the client a secure Stripe link to pay their deposit or balance. Find the booking with find_bookings first.",
  input_schema: {
    type: "object",
    properties: {
      booking_id: ID,
      what: { type: "string", enum: ["deposit", "balance"], description: "The deposit (secures it) or the balance (everything left to pay)" },
      confirmed: CONFIRMED,
    },
    required: ["booking_id", "what", "confirmed"],
  },
};

export const REFUND_TOOL = {
  name: "refund_payment",
  description: "Refund money paid online for a booking, back to the client's card through Stripe. The booking itself stays as it is (to cancel it, use cancel_booking). Find it with find_bookings first.",
  input_schema: {
    type: "object",
    properties: {
      booking_id: ID,
      amount: { type: "string", description: 'An amount in pounds such as "40", or "all" for everything paid online' },
      reason: { type: "string", description: "Why (kept with the refund)" },
      confirmed: CONFIRMED,
    },
    required: ["booking_id", "amount", "confirmed"],
  },
};

export const MANAGE_BOOKING_TOOLS = [FIND_BOOKINGS_TOOL, CANCEL_BOOKING_TOOL, RESCHEDULE_BOOKING_TOOL, UPDATE_BOOKING_TOOL, CHANGE_EXTRAS_TOOL, PAYMENT_LINK_TOOL, REFUND_TOOL];

// The extra instructions NovaBot gets in the staff chat
export const MANAGE_BOOKINGS_RULES = `STAFF CHAT: MANAGING BOOKINGS
You're talking to Novacane staff in Nova Hub, not a customer. Besides everything
above, you can look up and change bookings. Everything happens straight away in the
studio's Google Calendar, the client's emails (Gmail) and payments (Stripe):
- find_bookings lists bookings with their numbers (#12). Use it to answer questions
  ("what's on Saturday?", "when is Kai in next?", "who hasn't paid?") and before any change.
- cancel_booking, reschedule_booking, update_booking, change_booking_extras,
  send_payment_link and refund_payment change a booking by its number.
- Every change takes two steps: first call the tool with confirmed false. That
  changes nothing and tells you exactly what will happen: show staff that summary
  and ask them to confirm. Only after they clearly say yes, call it again with
  confirmed true. If more than one booking could be the one they mean, ask which.
- Ask whether to email the client if staff haven't said (it's usually wanted).
- Cancelling refunds the studio's policy amount unless staff say otherwise: say how
  much will be refunded in the summary.
- Never say something is cancelled, moved, changed, sent or refunded unless the tool
  said it was done.`;

export function isManageBookingTool(name) {
  return MANAGE_BOOKING_TOOLS.some((tool) => tool.name === name);
}

// Run one of these tools. Returns { ok, message } for Claude.
export async function runManageBookingTool(env, name, input, today = ukToday()) {
  if (!(await googleReady(env))) {
    return { ok: false, message: "The studio's Google Calendar isn't connected yet (see /admin/google), so bookings can't be managed from here." };
  }
  if (name === FIND_BOOKINGS_TOOL.name) return findBookings(env, input, today);
  const b = await bookingFor(env, input?.booking_id ?? input?.appointment_id);
  if (b.problem) return { ok: false, message: b.problem };
  if (name === CANCEL_BOOKING_TOOL.name) return cancel(env, b, input);
  if (name === RESCHEDULE_BOOKING_TOOL.name) return reschedule(env, b, input, today);
  if (name === UPDATE_BOOKING_TOOL.name) return update(env, b, input);
  if (name === CHANGE_EXTRAS_TOOL.name) return extras(env, b, input);
  if (name === PAYMENT_LINK_TOOL.name) return paymentLink(env, b, input);
  if (name === REFUND_TOOL.name) return refundTool(env, b, input);
  return { ok: false, message: "Unknown tool." };
}

async function bookingFor(env, id) {
  if (!Number.isInteger(id) || id <= 0) return { problem: "That isn't a booking number. Use find_bookings to find the booking first." };
  const b = await getBooking(env, id);
  if (!b) return { problem: `There's no booking #${id}. Use find_bookings to find it again.` };
  return b;
}

const confirmFirst = (what, lines, tool) =>
  ({ ok: true, message: `Not ${what} yet. Show staff this and ask them to confirm:\n${lines.filter(Boolean).join("\n")}\nOnly after they clearly say yes, call ${tool} again with confirmed true.` });

// ===== FIND =====

async function findBookings(env, input, today) {
  const from = isDate(input?.from) ? input.from : today;
  const to = isDate(input?.to) ? input.to : addDays(from, 60);
  if (to < from) return { ok: false, message: "The end date is before the start date. Check the dates." };
  const fromIso = new Date(ukToMs(from)).toISOString();
  const untilIso = new Date(ukToMs(addDays(to, 1))).toISOString();

  const statuses = input?.include_cancelled ? ["booked", "hold", "cancelled"] : ["booked", "hold"];
  const { results } = await env.DB.prepare(
    `SELECT * FROM bookings WHERE status IN (${statuses.map(() => "?").join(", ")}) AND starts_at < ? AND ends_at > ? ORDER BY starts_at LIMIT 500`
  )
    .bind(...statuses, untilIso, fromIso)
    .all();

  const name = lower(input?.name);
  const email = lower(input?.email);
  const phone = digits(input?.phone);
  const filtered = Boolean(name || email || phone);
  const found = results.filter(
    (b) =>
      (!name || lower(fullName(b)).includes(name)) &&
      (!email || lower(b.email).includes(email)) &&
      (!phone || (digits(b.phone).length > 0 && digits(b.phone).endsWith(phone.slice(-9))))
  );

  // Anything else in the calendar (staff's own events, blocked time), when not searching for a person
  let others = [];
  if (!filtered) {
    try {
      const ours = new Set(results.map((b) => b.event_id).filter(Boolean));
      others = (await listEvents(env, Date.parse(fromIso), Date.parse(untilIso)))
        .filter((e) => !ours.has(e.id) && !e.extendedProperties?.private?.novaBooking)
        .map((e) => {
          const span = eventSpan(e);
          if (!span) return null;
          const start = msToUk(span[0]);
          return `- Calendar event (not a booking): ${dayInWords(start.date)} ${e.start?.date ? "all day" : `${start.time}–${msToUk(span[1]).time}`}, "${e.summary || "Busy"}"`;
        })
        .filter(Boolean);
    } catch (err) {
      console.log("Couldn't list other calendar events:", err);
    }
  }

  const range = from === to ? dayInWords(from) : `${dayInWords(from)} to ${dayInWords(to)}`;
  if (!found.length && !others.length) return { ok: true, message: `No bookings found (${range}${filtersInWords(input)}).` };
  const lines = found.slice(0, MAX_LISTED).map((b) => "- " + describe(b));
  const more = found.length > MAX_LISTED ? `\n…and ${found.length - MAX_LISTED} more. Narrow it down by date or name to see them.` : "";
  return {
    ok: true,
    message:
      `${found.length} booking(s) (${range}${filtersInWords(input)}):\n${lines.join("\n") || "none"}${more}` +
      (others.length ? `\nAlso in the calendar:\n${others.slice(0, MAX_LISTED).join("\n")}` : ""),
  };
}

// ===== CANCEL =====

async function cancel(env, b, input) {
  if (b.status === "cancelled") return { ok: false, message: `#${b.id} is already cancelled.` };
  const notify = input?.notify_client !== false;
  const note = field(input?.note, 500);
  const { net } = moneyState(b);
  const choice = String(input?.refund || "policy").trim().toLowerCase();
  let refundPence;
  if (choice === "policy") refundPence = policyRefund(b);
  else if (choice === "full" || choice === "all") refundPence = net;
  else if (choice === "none" || choice === "0") refundPence = 0;
  else {
    const amount = poundsToPence(choice);
    if (amount === null) return { ok: false, message: 'The refund should be "policy", "full", "none" or an amount like "40". Ask staff.' };
    refundPence = amount;
  }
  if (refundPence > net) return { ok: false, message: `Only ${money(net)} has been paid, so no more than that can be refunded.` };

  if (input?.confirmed !== true) {
    return confirmFirst("cancelled", [
      `- Cancel: ${describe(b)}`,
      `- Email the client: ${notify ? "yes" : "no"}`,
      `- Refund: ${refundPence > 0 ? money(refundPence) + " to their card" : "nothing"}${choice === "policy" ? " (the studio's policy)" : ""}`,
      note && `- Note to the client: "${note}"`,
    ], "cancel_booking");
  }
  return cancelBooking(env, b, { by: "staff", notify, note, refundPence, refundNow: true });
}

// ===== RESCHEDULE =====

async function reschedule(env, b, input, today) {
  const date = isDate(input?.date) ? input.date : "";
  const time = normaliseTime(input?.time);
  if (!date || !time) return { ok: false, message: "Not moved: I need the new day (YYYY-MM-DD) and start time (HH:MM). Ask staff." };
  if (date < today) return { ok: false, message: `Not moved: ${dayInWords(date)} is in the past. Check the date with staff.` };
  const notify = input?.notify_client !== false;
  const override = input?.ignore_availability === true;
  if (input?.confirmed !== true) {
    return confirmFirst("moved", [
      `- Move: ${describe(b)}`,
      `- To: ${dayInWords(date)} at ${time} (UK time)`,
      `- Email the client: ${notify ? "yes" : "no"}`,
      override && "- Even if the calendar shows that time as not free",
    ], "reschedule_booking");
  }
  const result = await moveBooking(env, b, { date, time, by: "staff", notify, ignoreAvailability: override });
  if (!result.ok && result.taken) {
    return { ok: false, message: `Not moved: ${dayInWords(date)} at ${time} isn't free in the calendar. Tell staff; they can pick another time, or ask you to override it.` };
  }
  return result;
}

// ===== DETAILS =====

async function update(env, b, input) {
  const changes = {};
  if (field(input?.first_name, 60)) changes.firstName = field(input.first_name, 60);
  if (field(input?.last_name, 60)) changes.lastName = field(input.last_name, 60);
  if (field(input?.email, 200)) {
    changes.email = field(input.email, 200).toLowerCase();
    if (!isEmail(changes.email)) return { ok: false, message: "That email address doesn't look right. Check it with staff." };
  }
  if (field(input?.phone, 40)) changes.phone = field(input.phone, 40);
  if (typeof input?.notes === "string") changes.notes = input.notes.slice(0, 2000);
  if (!Object.keys(changes).length) return { ok: false, message: "Nothing to change. Ask staff what should change." };
  const before = { firstName: b.first_name, lastName: b.last_name, email: b.email, phone: b.phone, notes: b.notes };
  const list = Object.entries(changes).map(([k, v]) => `- ${k}: "${before[k] || ""}" → "${v}"`);
  if (input?.confirmed !== true) return confirmFirst("changed", [`- Booking: ${describe(b)}`, ...list], "update_booking");
  await updateDetails(env, b, changes);
  return { ok: true, message: `Changed ${fullName(b)}'s booking #${b.id}:\n${list.join("\n")}` };
}

async function extras(env, b, input) {
  let type = null;
  if (field(input?.session_type, 150)) {
    const wanted = field(input.session_type, 150);
    type = getType(wanted) || SESSION_TYPES.find((t) => t.name.toLowerCase() === wanted.toLowerCase()) || SESSION_TYPES.find((t) => t.name.toLowerCase().includes(wanted.toLowerCase()));
    if (!type) return { ok: false, message: `There's no session type "${wanted}". Use an ID or name from the BOOKABLE SESSIONS list.` };
  }
  let pricePence = null;
  if (input?.price !== undefined && input?.price !== null && input?.price !== "") {
    pricePence = poundsToPence(input.price);
    if (pricePence === null) return { ok: false, message: "That price doesn't look right. Ask staff for the amount in pounds, e.g. 80.00." };
  }
  const paid = typeof input?.paid === "boolean" ? input.paid : null;
  if (!type && pricePence === null && paid === null) return { ok: false, message: "Nothing to change. Ask staff what should change." };

  if (input?.confirmed !== true) {
    return confirmFirst("changed", [
      `- Booking: ${describe(b)}`,
      type && `- Session: "${b.session}" → "${type.name}" (${type.duration / 60} hours${pricePence === null ? `, price ${money(pence(type.price))}` : ""})`,
      pricePence !== null && `- Price: ${money(b.price_pence)} → ${money(pricePence)}`,
      paid !== null && `- ${paid ? "Mark paid in full (money taken outside Stripe)" : "Mark not paid"}`,
      type && type.duration !== b.duration && "- The calendar event's length changes to match (check the new end time is free)",
    ], "change_booking_extras");
  }
  const { booking, lines } = await changeExtras(env, b, { typeId: type?.id ?? null, pricePence, paid });
  return { ok: true, message: `Changed #${booking.id} (${fullName(booking)}):\n- ${lines.join("\n- ")}\nNow: ${describe(booking)}` };
}

// ===== MONEY =====

async function paymentLink(env, b, input) {
  if (b.status !== "booked") return { ok: false, message: `#${b.id} is ${b.status}, so there's nothing to pay.` };
  const { depositDue, balanceDue } = moneyState(b);
  const what = input?.what === "deposit" ? "deposit" : "balance";
  const amount = what === "deposit" ? depositDue : balanceDue;
  if (amount <= 0) return { ok: false, message: `Nothing to pay for the ${what}: ${describe(b)}.` };
  if (input?.confirmed !== true) {
    return confirmFirst("sent", [`- Email ${b.email} a link to pay the ${what}: ${money(amount)}`, `- Booking: ${describe(b)}`], "send_payment_link");
  }
  const sent = await requestPayment(env, b, what);
  return sent
    ? { ok: true, message: `Sent: ${b.email} has a link to pay the ${money(amount)} ${what}.` }
    : { ok: false, message: "The email couldn't be sent (Gmail didn't accept it). Tell staff to check the Google connection at /admin/google." };
}

async function refundTool(env, b, input) {
  const { net } = moneyState(b);
  const { results } = await env.DB.prepare("SELECT COALESCE(SUM(amount_pence), 0) AS online FROM payments WHERE booking_id = ? AND kind = 'payment'").bind(b.id).all();
  const onlineLeft = Math.max(0, (results[0]?.online || 0) - b.refunded_pence);
  const amount = String(input?.amount || "").trim().toLowerCase() === "all" ? onlineLeft : poundsToPence(input?.amount);
  if (amount === null || amount <= 0) return { ok: false, message: 'Give the amount in pounds (e.g. "40") or "all". Ask staff.' };
  if (amount > onlineLeft) return { ok: false, message: `Only ${money(onlineLeft)} was paid online and not yet refunded (${money(net)} paid in all), so at most that can be refunded through Stripe.` };
  const reason = field(input?.reason, 200);
  if (input?.confirmed !== true) {
    return confirmFirst("refunded", [`- Refund ${money(amount)} to ${fullName(b)}'s card`, `- Booking: ${describe(b)}`, reason && `- Reason: ${reason}`], "refund_payment");
  }
  try {
    await refundBooking(env, b, amount, reason || "Refunded by staff");
  } catch (err) {
    return { ok: false, message: `Not refunded: ${err.message}. Tell staff to check Stripe.` };
  }
  return { ok: true, message: `Refunded ${money(amount)} to ${fullName(b)} (#${b.id}). It usually reaches their card in 5 to 10 working days.` };
}

// ===== HELPERS =====

function poundsToPence(value) {
  const text = String(value ?? "").replace(/[£\s,]/g, "");
  return /^\d{1,5}(\.\d{1,2})?$/.test(text) ? pence(text) : null;
}

function filtersInWords(input) {
  const bits = [input?.name && `name "${input.name}"`, input?.email && `email "${input.email}"`, input?.phone && `phone ${input.phone}`].filter(Boolean);
  return bits.length ? `, ${bits.join(", ")}` : "";
}

const field = (value, max) => (typeof value === "string" ? value.trim().slice(0, max) : "");
const lower = (value) => (typeof value === "string" ? value.trim().toLowerCase() : "");
const digits = (value) => String(value || "").replace(/\D/g, "");
const isDate = (value) => typeof value === "string" && /^\d{4}-\d{2}-\d{2}$/.test(value);

function addDays(ymd, n) {
  const d = new Date(ymd + "T00:00:00Z");
  d.setUTCDate(d.getUTCDate() + n);
  return d.toISOString().slice(0, 10);
}

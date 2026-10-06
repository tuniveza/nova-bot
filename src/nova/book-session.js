// NovaBot booking a session for the customer, straight into the studio's calendar
//
// The customer chooses how to book: NovaBot books it for them in the chat (Nova
// Hub's staff chat with book_session, the website with the booking card,
// booking-form.js), or they book it themselves on the booking page.
//
// Booking it here checks the time is still free, puts it in Google Calendar
// straight away, and emails the customer a confirmation from the studio's Gmail
// with a secure link to pay the 50% deposit (Stripe). Staff phones get "New booking".

import { senderId } from "../enquiries.js";
import { bookingLink, dayInWords, freeSlot, normaliseTime, ukToday } from "./booking.js";
import { bookAndAskForDeposit, isEmail } from "./bookings.js";
import { googleReady } from "./google.js";
import { stripeReady } from "./stripe.js";
import { money, ukToMs } from "./studio.js";

// How many sessions NovaBot will book for one visitor in 24 hours (stops abuse).
// The setting "bookings_per_visitor" in the settings table overrides it ("unlimited" turns it off).
export const DEFAULT_BOOKINGS_PER_VISITOR = 2;

export const BOOK_SESSION_TOOL = {
  name: "book_session",
  description:
    "Book a session in the studio's calendar for the customer, so they don't have to do it themselves. Only use it once they've chosen to have you book it, seen a summary (session, day and date, start time, name, email, phone) and clearly said yes. The time is checked again first, then it goes straight into the calendar and they're emailed a confirmation with a link to pay the 50% deposit.",
  input_schema: {
    type: "object",
    properties: {
      session_type_id: { type: "integer", description: "The ID of the session type, from the BOOKABLE SESSIONS list" },
      date: { type: "string", description: "The day, YYYY-MM-DD (UK date)" },
      time: { type: "string", description: "The start time, 24-hour HH:MM (UK time), e.g. 14:00 for 2pm" },
      first_name: { type: "string", description: "The customer's first name" },
      last_name: { type: "string", description: "The customer's last name" },
      email: { type: "string", description: "The customer's email (the confirmation and deposit link go here)" },
      phone: { type: "string", description: "The customer's phone number" },
      notes: { type: "string", description: "Anything the studio should know (what they're recording, guests, gear), if they said" },
    },
    required: ["session_type_id", "date", "time", "first_name", "last_name", "email", "phone"],
  },
};

// The extra instructions NovaBot gets when it can book for people (staff chat)
export const BOOK_SESSION_RULES = `BOOKING IT FOR THEM (available, and the DEFAULT)
When someone wants a session on the BOOKABLE SESSIONS list, you book it for them
with book_session. Don't give a booking link unless they ask for one, or
book_session says it couldn't book.
1. Work out the session (by the TOTAL length they asked for), the day and the start
   time from everything they've said in the whole chat.
2. Check the day with check_availability. If their time isn't free, say so and offer
   the nearest free times.
3. Ask, in ONE message, for whatever is still missing of: full name, email, phone.
4. Show one short "-" summary (session, day and date, start time, name, email, phone)
   and ask "Shall I book it?".
5. As soon as they say yes in any way ("yes", "correct", "that's right", "book it"),
   call book_session in that same reply. Don't ask again or re-summarise.
- Only say a session is booked in the reply where book_session just said "Booked".
  Never say it otherwise.
- Once book_session says "Booked", say it's in the calendar and a confirmation with a
  link to pay the deposit is on its way to their email.
- If book_session says it couldn't book, say so plainly and do what its message says.
  Book each session once.`;

// Can NovaBot book for people? When the calendar (Google) and payments (Stripe) are connected.
export async function canBookSessions(env) {
  try {
    return (await googleReady(env)) && stripeReady(env);
  } catch (err) {
    console.log("Couldn't check whether booking is available:", err);
    return false;
  }
}

// The current per-visitor limit: a number, or Infinity
export async function bookingsPerVisitor(env) {
  const value = await env.DB.prepare("SELECT value FROM settings WHERE key = 'bookings_per_visitor'").first("value");
  if (String(value).trim().toLowerCase() === "unlimited") return Infinity;
  const n = Number(value);
  return Number.isInteger(n) && n >= 1 && n <= 100 ? n : DEFAULT_BOOKINGS_PER_VISITOR;
}

// Tidy one field: text only, trimmed and capped
function field(value, max) {
  return typeof value === "string" ? value.trim().slice(0, max) : "";
}

// Run the book_session tool. Returns what to tell Claude (`message`), what to tell
// the customer directly (`customer`, for the booking card), and a booking link
// when they need to finish it themselves.
export async function bookSession(env, input, { chatId, ip, staff = false }, today = ukToday()) {
  if (!(await canBookSessions(env))) {
    return {
      ok: false,
      customer: "Booking in the chat isn't available just now. Ask NovaBot for the booking link.",
      message: "Booking for them isn't available. Give them the booking link (booking_link) instead.",
    };
  }
  const person = {
    firstName: field(input?.first_name, 60),
    lastName: field(input?.last_name, 60),
    email: field(input?.email, 200).toLowerCase(),
    phone: field(input?.phone, 40),
  };
  if (!person.firstName || !person.lastName) {
    return { ok: false, field: "name", customer: "Please add your first and last name.", message: "Not booked: their first and last name are needed. Ask for them." };
  }
  if (!isEmail(person.email)) {
    return { ok: false, field: "email", customer: "That email address doesn't look right. Please check it.", message: "Not booked: that email address doesn't look right. Ask them to check it." };
  }
  if (!person.phone) return { ok: false, field: "phone", customer: "Please add your phone number.", message: "Not booked: their phone number is needed. Ask for it." };

  const typeId = Number(input.session_type_id);
  const time = normaliseTime(input.time);
  const date = String(input.date || "");

  // Already booked (e.g. they said yes twice): don't book it again
  const already = await env.DB.prepare("SELECT id FROM bookings WHERE email = ? AND type_id = ? AND status = 'booked' AND starts_at = ?")
    .bind(person.email, typeId, startIso(date, time))
    .first();
  if (already) {
    return {
      ok: true,
      customer: `This session is already booked for you (#${already.id}). Check your email for the confirmation.`,
      message: `Already booked (#${already.id}): you booked this session for them earlier. Don't book it again.`,
    };
  }

  // One visitor can't book too many (staff chat has no limit)
  const sender = staff ? null : await senderId(ip || "unknown");
  if (!staff) {
    const { count } = await env.DB.prepare("SELECT COUNT(*) AS count FROM bookings WHERE sender = ? AND source = 'chat' AND created_at > ?")
      .bind(sender, new Date(Date.now() - 86_400_000).toISOString())
      .first();
    const limit = await bookingsPerVisitor(env);
    if (count >= limit) {
      const link = bookingLink(env, typeId, person);
      return {
        ok: false,
        url: link,
        customer: "That's the most sessions we can book in the chat for you today. Use the link to book this one yourself.",
        message: `Not booked: you've already booked ${limit} sessions for this visitor today. Apologise and give them this link to book it themselves: ${link}`,
      };
    }
  }

  // Still free? (Asked afresh, not from a remembered answer)
  const slot = await freeSlot(env, input, today);
  if (slot.problem) {
    const link = slot.type ? bookingLink(env, slot.type.id, person) : "";
    return {
      ok: false,
      url: link || undefined,
      field: slot.taken ? "time" : undefined,
      customer: slot.taken ? "Sorry, that time has just been taken. Please pick another time." : "That time can't be booked. Please pick another day or time.",
      message:
        `Not booked: ${slot.problem} ` +
        (slot.taken
          ? "Tell them it's just been taken, use check_availability to offer times that are free, and confirm the new one with them before booking."
          : link
            ? `If it can't be sorted, give them this link to book it themselves: ${link}`
            : ""),
    };
  }

  const made = await bookAndAskForDeposit(env, {
    type: slot.type,
    date: slot.date,
    time: slot.time,
    person,
    source: staff ? "staff" : "chat",
    notes: field(input?.notes, 1000),
    chatId: chatId || null,
    sender,
    skipCheck: true,
  });
  if (made.problem) {
    const link = bookingLink(env, slot.type.id, person, { date: slot.date, time: slot.time });
    return {
      ok: false,
      url: link,
      field: made.taken ? "time" : undefined,
      customer: made.taken ? "Sorry, that time has just been taken. Please pick another time." : "Booking in the chat isn't working just now. Use the link to finish booking: your time is already selected.",
      message: `Not booked: ${made.problem} Apologise, and give them this exact link, which opens the booking page with ${dayInWords(slot.date)} at ${slot.time} already selected: ${link}`,
    };
  }

  const b = made.booking;
  const when = `${dayInWords(slot.date)} at ${slot.time}`;
  return {
    ok: true,
    booked: { id: b.id, session: b.session, when: `${when} (UK time)`, name: `${person.firstName} ${person.lastName}`, email: person.email },
    customer: `Booked: ${when}. Your confirmation and a link to pay the ${money(b.deposit_pence)} deposit are on their way to ${person.email}.`,
    message:
      `Booked (#${b.id}): "${slot.type.name}" on ${when} (UK time) is in the calendar in ${person.firstName} ${person.lastName}'s name. ` +
      `Tell them it's booked, and a confirmation with a secure link to pay the ${money(b.deposit_pence)} deposit is on its way to ${person.email}; the deposit secures it. ` +
      "Don't give them a booking link, and don't call book_session again for this booking.",
  };
}

// The UTC start for a UK date and time, or "" if they aren't valid
function startIso(date, time) {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(date) || !time) return "";
  return new Date(ukToMs(date, time)).toISOString();
}

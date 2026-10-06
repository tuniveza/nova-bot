// The booking card: instead of asking for each detail one message at a time,
// NovaBot opens a card in the chat with everything a booking needs (session,
// day, free start times, name, email, phone), already filled in with what the
// customer has said. They choose:
//   "Book it for me"       NovaBot checks the time and fills everything in, then
//                          they pay the deposit on Acuity's booking page to book it
//   "I'll book it myself"  opens Acuity's booking page for that session (in the widget)
// No session is booked until the deposit is paid (book-session.js).
//
//   open_booking_form tool  NovaBot opens the card (the reply carries `form`)
//   POST /booking-form/open  the chat's "Book a session" button -> { form } (or { form: null }
//                            when booking in the chat isn't available: the button opens the booking page)
//   POST /booking-form/times { session_type_id, date } -> { times: ["10:00", ...] }
//   POST /booking-form/book  { chatId, session_type_id, date, time, first_name, last_name, email, phone }
//                            -> { ok, message, payFirst, pay: { url, label } } or { ok: false, message, url?, field? }
//
// "Book it for me" re-checks their details and the time (readyToPay in
// book-session.js) and gives Acuity's booking page with the time selected and
// their details in, to pay the deposit. Nothing is booked here.

import { canBookSessions, readyToPay } from "./book-session.js";
import { ACUITY_OWNER, bookingLink, freeTimesOn, getSessionTypes, normaliseTime, ukToday } from "./booking.js";

const DATE_PATTERN = /^\d{4}-\d{2}-\d{2}$/;

export const BOOKING_FORM_TOOL = {
  name: "open_booking_form",
  description:
    "Open the booking card in the chat: one card where the customer picks the session, day and start time and fills in their name, email and phone, then presses Book. Fill in everything you already know from the chat; leave out anything you don't. Use it as soon as someone wants to book, instead of asking for their details one by one.",
  input_schema: {
    type: "object",
    properties: {
      session_type_id: { type: "integer", description: "The ID of the session type, from the BOOKABLE SESSIONS list, if known" },
      date: { type: "string", description: "The day, YYYY-MM-DD (UK date), if known" },
      time: { type: "string", description: "The start time, 24-hour HH:MM (UK time), if known" },
      first_name: { type: "string", description: "The customer's first name, if known" },
      last_name: { type: "string", description: "The customer's last name, if known" },
      email: { type: "string", description: "The customer's email, if known" },
      phone: { type: "string", description: "The customer's phone number, if known" },
    },
  },
};

// NovaBot's instructions on the website while it can book for people
export const BOOKING_FORM_RULES = `BOOKING IT FOR THEM (available, and the DEFAULT)
When a customer wants to book a session, open the booking card with open_booking_form.
It shows the session, day and free start times, and boxes for their name, email and
phone, all in one go. At the bottom they choose "Book it for me" (the time is
checked and everything filled in, then they pay the deposit on the booking page,
which books it) or "I'll book it myself" (the booking page for that session).
No session is booked until the deposit is paid.
- Fill in everything you already know (session by the TOTAL length they asked for,
  day, start time, name, email, phone). Leave out what you don't know: they pick it
  on the card.
- Don't ask for their name, email or phone in the chat, and don't give a booking link
  unless they ask for one.
- In your reply, say in one short line that the card is open below with the free
  times, and to press "Book it for me" (or "I'll book it myself") when it looks
  right. Don't list their details back.
- You can't book from the chat, and nothing is booked until they pay the deposit
  on the booking page. Never say a session is booked.
- If they'd rather book themselves, give the booking link (booking_link).`;

// What the website needs to show the card: the sessions to choose from, and
// what to fill in
export function formFor(types, input = {}) {
  const text = (value, max) => (typeof value === "string" ? value.trim().slice(0, max) : "");
  const typeId = types.some((t) => t.id === Number(input.session_type_id)) ? Number(input.session_type_id) : null;
  return {
    // page: Acuity's booking page for the session, for "I'll book it myself"
    sessions: types.map((t) => ({ id: t.id, name: t.name, price: t.price || "", duration: t.duration || 0, page: bookingLink(ACUITY_OWNER, t.id) })),
    session_type_id: typeId,
    date: DATE_PATTERN.test(input.date || "") ? input.date : "",
    time: normaliseTime(input.time),
    first_name: text(input.first_name, 60),
    last_name: text(input.last_name, 60),
    email: text(input.email, 200),
    phone: text(input.phone, 40),
    today: ukToday(),
    // Show both choices: "Book it for me" and "I'll book it myself"
    choose: true,
  };
}

// The card asking for free times, or booking (already checked to come from
// the website and not too often, see index.js)
export async function handleBookingForm(request, env, pathname, { chatId, ip }) {
  let body = {};
  try {
    body = await request.json();
  } catch {
    return { status: 400, data: { error: "Bad request" } };
  }

  if (pathname === "/booking-form/open") {
    try {
      if (!(await canBookSessions(env))) return { status: 200, data: { form: null } };
      return { status: 200, data: { form: formFor(await getSessionTypes(ACUITY_OWNER), body) } };
    } catch (err) {
      console.log("Booking card couldn't open:", err);
      return { status: 200, data: { form: null } };
    }
  }

  if (pathname === "/booking-form/times") {
    try {
      const { times, problem } = await freeTimesOn(ACUITY_OWNER, body.session_type_id, String(body.date || ""));
      return { status: 200, data: problem ? { times: [], message: problem } : { times } };
    } catch (err) {
      console.log("Booking card couldn't read free times:", err);
      return { status: 200, data: { times: [], message: "Couldn't check the free times just now. Please try again." } };
    }
  }

  if (pathname === "/booking-form/book") {
    const id = /^[A-Za-z0-9-]{8,64}$/.test(body.chatId || "") ? body.chatId : chatId;
    try {
      const outcome = await readyToPay(ACUITY_OWNER, body);
      if (outcome.payFirst) console.log(`Booking card sent chat ${id || "?"} to pay the deposit for ${outcome.session}, ${outcome.when}`);
      return {
        status: 200,
        data: {
          ok: Boolean(outcome.ok),
          message: outcome.customer || (outcome.ok ? "Pay the deposit to confirm it." : "Sorry, that couldn't be booked."),
          ...(outcome.payFirst ? { payFirst: true, pay: outcome.pay } : {}),
          ...(outcome.url ? { url: outcome.url } : {}),
          ...(outcome.field ? { field: outcome.field } : {}),
        },
      };
    } catch (err) {
      console.log("Booking card couldn't book:", err);
      return { status: 200, data: { ok: false, message: "Sorry, something went wrong booking that. Please try again in a moment." } };
    }
  }

  return { status: 404, data: { error: "Not found" } };
}

// The card's session list, for the open_booking_form tool
export async function bookingFormFrom(input) {
  return formFor(await getSessionTypes(ACUITY_OWNER), input);
}

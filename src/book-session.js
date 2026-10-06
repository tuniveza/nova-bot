// NovaBot getting a session ready for the customer to pay for, in Acuity
//
// The rule: no session is booked until it's paid for. Nobody (not NovaBot,
// not Nova Agent, not the staff chat) puts a booking into Acuity without the
// deposit. So NovaBot never books a session itself. It does everything up to
// the payment: works out the session, checks the time is still free and fills
// in the customer's details. Then it gives them Acuity's own booking page,
// with the time already selected and their details already in, and they pay
// the deposit there, the way Acuity is already set up to take it. Paying is
// what books it: Acuity sends its usual confirmation email and the usual
// new-booking alerts follow. The time isn't held until they've paid.
//
//   readyToPay()   the website's booking card ("Book it for me", booking-form.js)
//   bookSession()  the book_session tool, for Nova Hub's staff chat: the link to
//                  send the customer, so they can pay and it's booked

import { agentNovaProblem } from "./agent-nova.js";
import { bookingLink, dayInWords, freeSlot, ukToday } from "./booking.js";

const EMAIL_PATTERN = /^[^\s@<>"]+@[^\s@<>"]+\.[^\s@<>"]{2,}$/;

export const BOOK_SESSION_TOOL = {
  name: "book_session",
  description:
    "Get a session ready for the customer to pay for: checks the time is still free and makes the link to Acuity's booking page with that time selected and their details filled in. Sessions are only booked once the deposit is paid, so this never books it: the customer pays the deposit with the link, and that books it. Use it once you know the session, day, start time, name, email and phone.",
  input_schema: {
    type: "object",
    properties: {
      session_type_id: { type: "integer", description: "The ID of the session type, from the BOOKABLE SESSIONS list" },
      date: { type: "string", description: "The day, YYYY-MM-DD (UK date)" },
      time: { type: "string", description: "The start time, 24-hour HH:MM (UK time), e.g. 14:00 for 2pm" },
      first_name: { type: "string", description: "The customer's first name" },
      last_name: { type: "string", description: "The customer's last name" },
      email: { type: "string", description: "The customer's email (Acuity sends the confirmation here)" },
      phone: { type: "string", description: "The customer's phone number" },
    },
    required: ["session_type_id", "date", "time", "first_name", "last_name", "email", "phone"],
  },
};

// The extra instructions NovaBot gets in the staff chat
export const BOOK_SESSION_RULES = `GETTING A SESSION READY TO PAY FOR (staff chat)
No session is booked until the deposit is paid: you never book one yourself, and
neither does anyone else. When staff want a session for a customer, use book_session:
it checks the time and gives the link to Acuity's booking page with the time selected
and the customer's details filled in. The customer pays the deposit with that link,
and paying is what books it.
1. Work out the session (by the TOTAL length), the day and the start time.
2. Check the day with check_availability. If the time isn't free, say so and offer
   the nearest free times.
3. Ask for whatever is still missing of: the customer's full name, email, phone.
4. Call book_session, then give the exact link it returns, to send to the customer.
- Never say a session is booked: it's booked once the customer has paid the deposit.
  The time isn't held until then.
- If book_session says it couldn't, say so plainly and do what its message says.`;

// Can NovaBot get sessions ready in the chat? (Shown while Nova Agent, the
// studio's browser helper, is online and live, as before.)
export async function canBookSessions(env) {
  return !(await agentNovaProblem(env, { needLive: true }));
}

// Tidy one field: text only, trimmed and capped
function field(value, max) {
  return typeof value === "string" ? value.trim().slice(0, max) : "";
}

// The customer's name, email and phone, or what's wrong with them
function checkDetails(input) {
  const person = {
    firstName: field(input?.first_name, 60),
    lastName: field(input?.last_name, 60),
    email: field(input?.email, 200).toLowerCase(),
    phone: field(input?.phone, 40),
  };
  if (!person.firstName || !person.lastName) {
    return { person, problem: { ok: false, field: "name", customer: "Please add your first and last name.", message: "Not booked: their first and last name are needed. Ask for them." } };
  }
  if (!EMAIL_PATTERN.test(person.email)) {
    return { person, problem: { ok: false, field: "email", customer: "That email address doesn't look right. Please check it.", message: "Not booked: that email address doesn't look right. Ask them to check it." } };
  }
  if (!person.phone) return { person, problem: { ok: false, field: "phone", customer: "Please add your phone number.", message: "Not booked: their phone number is needed. Ask for it." } };
  return { person };
}

// The website's booking card: check their details and that the time is still
// free, then give them Acuity's booking page with that time and their details
// already filled in, to pay the deposit. Nothing is booked (or held) until
// they've paid there; Acuity confirms it and the usual "new booking" alerts follow.
export async function readyToPay(owner, input, today = ukToday()) {
  const { person, problem } = checkDetails(input);
  if (problem) return problem;

  const slot = await freeSlot(owner, input, today);
  if (slot.problem) {
    const link = slot.type ? bookingLink(owner, slot.type.id, person) : "";
    return {
      ok: false,
      url: link || undefined,
      field: slot.taken ? "time" : undefined,
      reason: slot.problem,
      customer: slot.taken ? "Sorry, that time has just been taken. Please pick another time." : "That time can't be booked. Please pick another day or time.",
    };
  }

  const when = `${dayInWords(slot.date)} at ${slot.time}`;
  const url = bookingLink(owner, slot.type.id, person, { ownerKey: slot.ownerKey, calendarId: slot.calendarId, time: slot.acuityTime });
  return {
    ok: true,
    payFirst: true,
    session: slot.type.name,
    when: `${when} (UK time)`,
    pay: { url, label: "Pay the deposit to book" },
    customer: `${when} is free and everything's filled in. Pay the deposit on the booking page to book it: it isn't booked (or held) until the deposit's paid.`,
  };
}

// Run the book_session tool (staff chat): the same checks as the booking
// card, and the link to send the customer. Never books anything.
export async function bookSession(env, owner, input, visitor, waitUntil, today = ukToday()) {
  const outcome = await readyToPay(owner, input, today);
  if (!outcome.ok) {
    return {
      ok: false,
      url: outcome.url,
      field: outcome.field,
      customer: outcome.customer,
      message:
        (outcome.reason ? `Not ready: ${outcome.reason}` : outcome.message || `Not ready: ${outcome.customer}`) +
        (outcome.field === "time" ? " Use check_availability to offer times that are free." : "") +
        (outcome.url ? ` Or give them this link to book it on the booking page: ${outcome.url}` : ""),
    };
  }
  return {
    ...outcome,
    url: outcome.pay.url,
    message:
      `Ready to pay for, NOT booked: "${outcome.session}" on ${outcome.when} is free. ` +
      `Give this exact link to send to the customer: ${outcome.pay.url} . It opens Acuity's booking page with that time selected and their details filled in; ` +
      "they pay the deposit there and that books it. The time isn't held until they pay. Don't say it's booked.",
  };
}

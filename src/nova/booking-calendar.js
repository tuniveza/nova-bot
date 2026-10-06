// The studio diary for Nova Hub's Calendar tab and staff questions (hub-ask.js):
// every booking from the bookings table, plus anything else in the studio's
// Google Calendar (staff's own events, blocked-off time).

import { eventSpan } from "./booking.js";
import { bookingsBetween, fullName } from "./bookings.js";
import { moneyState } from "./emails.js";
import { googleReady, listEvents } from "./google.js";
import { money, whenInWords } from "./studio.js";

// From a month ago to a year ahead
const PAST_DAYS = 31;
const AHEAD_DAYS = 366;

// Every booking and calendar event, soonest first, or null if the calendar isn't connected.
// Each: { id, name, phone, email, session, price, when, start, end, extra, link, kind }
// (start/end as "20261022T131500Z", the format the app has always read)
export async function listBookings(env, now = Date.now()) {
  if (!(await googleReady(env))) return null;
  const from = new Date(now - PAST_DAYS * 86_400_000).toISOString();
  const until = new Date(now + AHEAD_DAYS * 86_400_000).toISOString();
  const bookings = await bookingsBetween(env, from, until, ["booked"]);
  const items = bookings.map((b) => {
    const { net, balanceDue } = moneyState(b);
    return {
      id: b.id,
      kind: "booking",
      name: fullName(b),
      phone: b.phone,
      email: b.email,
      session: b.session,
      price: money(b.price_pence),
      when: whenInWords(b.starts_at, b.ends_at),
      start: feedTime(b.starts_at),
      end: feedTime(b.ends_at),
      link: b.event_link || null,
      extra: [
        ["Booking", `#${b.id}`],
        ["Paid", net <= 0 ? "nothing yet" : balanceDue > 0 ? `${money(net)} (${money(balanceDue)} to pay)` : "in full"],
        ...(b.notes ? [["Notes", b.notes]] : []),
        ...(b.referral_code ? [["Referral code", b.referral_code]] : []),
      ],
    };
  });

  // Anything else in the calendar
  try {
    const ours = new Set(bookings.map((b) => b.event_id).filter(Boolean));
    for (const e of await listEvents(env, Date.parse(from), Date.parse(until), { max: 1000 })) {
      if (ours.has(e.id) || e.extendedProperties?.private?.novaBooking) continue;
      const span = eventSpan(e);
      if (!span) continue;
      items.push({
        id: null,
        kind: "event",
        name: e.summary || "Busy",
        session: e.transparency === "transparent" ? "Calendar event (doesn't block bookings)" : "Calendar event",
        when: whenInWords(new Date(span[0]).toISOString(), new Date(span[1]).toISOString()),
        start: feedTime(new Date(span[0]).toISOString()),
        end: feedTime(new Date(span[1]).toISOString()),
        link: e.htmlLink || null,
        extra: e.description ? [["Notes", String(e.description).slice(0, 300)]] : [],
      });
    }
  } catch (err) {
    console.log("Couldn't read other calendar events:", err);
  }
  return items.sort((a, b) => String(a.start).localeCompare(String(b.start)));
}

// "2026-10-22T13:15:00.000Z" -> "20261022T131500Z"
export const feedTime = (iso) => new Date(iso).toISOString().replace(/[-:]/g, "").replace(/\.\d{3}/, "");

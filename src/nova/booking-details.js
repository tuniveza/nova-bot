// A booking's details for Nova Hub's Alerts tab: each booking notification is
// shown with the booking as it is now (it may have moved or been paid since).
// Bookings live in our own bookings table, so this is a simple lookup.

import { getBooking, fullName, when } from "./bookings.js";
import { moneyState } from "./emails.js";
import { money } from "./studio.js";

// The details of booking #id, or null if there's no such booking
export async function bookingInfo(env, id) {
  if (!id) return null;
  const b = await getBooking(env, id);
  if (!b) return null;
  const { net, balanceDue } = moneyState(b);
  return {
    session: b.session,
    when: when(b) + (b.status === "cancelled" ? " (cancelled)" : ""),
    price: money(b.price_pence),
    email: b.email,
    name: fullName(b),
    phone: b.phone,
    extra: [
      ["Booking", `#${b.id}`],
      ["Paid", net <= 0 ? "nothing yet" : balanceDue > 0 ? `${money(net)} (${money(balanceDue)} to pay)` : "in full"],
      ...(b.notes ? [["Notes", b.notes]] : []),
    ],
    source: "booking",
    sourceAt: b.updated_at,
    link: b.event_link || null,
  };
}

// The lines of text that describe a booking, for notifications and Alerts
export function describeBooking(info) {
  return [
    info.session,
    info.when,
    info.price && "Price: " + info.price,
    info.name && "Name: " + info.name,
    info.phone && "Phone: " + info.phone,
    info.email && "Email: " + info.email,
    ...(info.extra || []).map(([label, value]) => label + ": " + value),
  ].filter(Boolean);
}

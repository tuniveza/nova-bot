// The studio diary for Nova Agent's AI (read only): bookings, free times, blocked-off times and the
// session list, from Nova's own booking system (the bookings table and the studio's Google
// Calendar). Each answers in the shape Nova Agent already reads, so it keeps working as it is.
// (src/agent-nova.js routes /nova-agent/bookings/… here.)

import { eventSpan, freeTimesOn, ukToday } from "./booking.js";
import { fullName } from "./bookings.js";
import { moneyState } from "./emails.js";
import { listEvents } from "./google.js";
import { SESSION_TYPES, ukToMs } from "./studio.js";
import { ukClock } from "../uk-time.js";

// Pence -> "120.00"
const pounds = (p) => (Math.max(0, Number(p) || 0) / 100).toFixed(2);

// UK days (inclusive) -> [fromIso, untilIso)
function dayRange(from, to) {
  const after = new Date(Date.parse(to + "T00:00:00Z") + 86_400_000).toISOString().slice(0, 10);
  return [new Date(ukToMs(from)).toISOString(), new Date(ukToMs(after)).toISOString()];
}

// A booking as Nova Agent sees it (times in UTC). id is the booking's number.
export function appointmentShape(b) {
  const { net } = moneyState(b);
  return {
    id: b.id,
    start: b.starts_at,
    end: b.ends_at,
    type: b.session || "",
    typeId: b.type_id ?? null,
    name: fullName(b),
    email: b.email || "",
    phone: b.phone || "",
    price: pounds(b.price_pence),
    paid: b.price_pence > 0 && net >= b.price_pence,
    amountPaid: pounds(net),
    notes: b.notes || "",
    canceled: b.status === "cancelled",
    calendar: "",
    calendarId: null,
  };
}

// Bookings starting on these UK days (inclusive), soonest first. Cancelled ones only with
// includeCanceled. Test bookings and unpaid holds never.
export async function listAppointments(env, { from, to, includeCanceled = false }) {
  const [fromIso, untilIso] = dayRange(from, to);
  const statuses = includeCanceled ? ["booked", "cancelled"] : ["booked"];
  const { results } = await env.DB.prepare(
    `SELECT * FROM bookings WHERE status IN (${statuses.map(() => "?").join(", ")}) AND test = 0 AND starts_at >= ? AND starts_at < ? ORDER BY starts_at LIMIT 200`
  )
    .bind(...statuses, fromIso, untilIso)
    .all();
  return results.map(appointmentShape);
}

// Free start times for a session type on one UK day: [{ start (UTC), label ("14:00") }]
export async function availableTimes(env, { typeId, date }) {
  const free = await freeTimesOn(env, typeId, date, ukToday());
  if (free.problem) return [];
  return free.times.map((time) => {
    const start = new Date(ukToMs(date, time)).toISOString();
    return { start, label: ukClock(start) };
  });
}

// Anything else in the studio's calendar on these UK days that blocks time (not a booking)
export async function listBlocks(env, { from, to }) {
  const [fromIso, untilIso] = dayRange(from, to);
  const events = await listEvents(env, Date.parse(fromIso), Date.parse(untilIso), { max: 200 });
  return events
    .filter((e) => !e.extendedProperties?.private?.novaBooking && e.transparency !== "transparent")
    .map((e) => {
      const span = eventSpan(e);
      return span ? { id: e.id, start: new Date(span[0]).toISOString(), end: new Date(span[1]).toISOString(), notes: e.summary || "", calendar: "", calendarId: null } : null;
    })
    .filter(Boolean);
}

// The studio's sessions (nova/studio.js)
export function listTypes() {
  return SESSION_TYPES.map((t) => ({ id: t.id, name: t.name, price: pounds(t.price * 100), duration: t.duration, active: true, private: false }));
}

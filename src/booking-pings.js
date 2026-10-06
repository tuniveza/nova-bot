// Booking notifications: when Acuity's webhook says a booking was made, moved
// or cancelled, staff phones get a notification with every detail we have.
//
// First choice: Acuity's private calendar feed (booking-calendar.js), which has
// the name, phone, email, price and time of every booking, straight away.
// If that isn't set up or doesn't have the booking:
//
// Once Acuity's booking emails are being passed on (booking-emails.js), the
// notification waits for that email, usually under a minute, so it can include
// the name, phone and form answers. It's like waiting for the full letter
// rather than posting the envelope on its own. If the email hasn't come after
// 3 minutes, it goes out with what we have (checked every minute, see index.js).

// Imports: booking details, the session names, and sending notifications
import { bookingInfo, confirmBooking, describeBooking, forgetBookingTime, waitForBookingInfo } from "./booking-details.js";
import { ACUITY_OWNER, getSessionTypes } from "./booking.js";
import { readCalendar } from "./booking-calendar.js";
import { notifyPhones } from "./push.js";

// How long a notification waits for Acuity's email
const EMAIL_WAIT_MINUTES = 3;
// Emails count as "set up" if one arrived in this many days
const EMAILS_ACTIVE_DAYS = 14;
// The first line of the notification, depending on what happened
const TITLES = { scheduled: "New booking", rescheduled: "Booking moved", canceled: "Booking cancelled", changed: "Booking changed" };

// Acuity's webhook says booking #id changed (it has already checked the secret key)
export async function bookingChanged(env, action, id, typeId) {
  // A new booking: the trusted half of the confirmation page's ticket
  if (action === "scheduled") await confirmBooking(env, id);
  // Write the change down, still waiting for its notification
  const { meta } = await env.DB.prepare("INSERT INTO booking_events (appointment_id, action, type_id, received_at) VALUES (?, ?, ?, ?)")
    // Fill in the booking number, what happened, the session type and the time now
    .bind(Number(id), action, Number(typeId) || null, new Date().toISOString())
    // Run it
    .run();
  // The change, as saved
  const event = { id: meta.last_row_id, appointment_id: Number(id), action, type_id: Number(typeId) || null };
  // Look the booking up in Acuity's calendar feed (it has everything); found, or a
  // cancellation of a booking we already have details for: send it now
  if ((await readCalendar(env, id, action)) || (action === "canceled" && (await bookingInfo(env, id))?.source === "calendar")) return ping(env, event);
  // Acuity's emails are coming through: wait for this one (unless it's already here)
  if (await emailsActive(env)) {
    // The latest email about this booking, if it's about this very change
    if (await emailIsFor(env, event)) await ping(env, event);
    // Otherwise the email, or the 3-minute check, sends it
    return;
  }
  // No emails: wait a few seconds for the confirmation page's details instead
  if (action === "scheduled") await waitForBookingInfo(env, id, Number(env.BOOKING_DETAILS_WAIT_SECONDS ?? 20));
  // And send it
  await ping(env, event);
}

// Acuity's email about booking #id has arrived: send whatever was waiting for it
export async function emailArrived(env, id) {
  // Every change to this booking still waiting for its notification
  const { results } = await env.DB.prepare("SELECT * FROM booking_events WHERE appointment_id = ? AND notified_at IS NULL ORDER BY id")
    // For this booking
    .bind(Number(id))
    // Get them
    .all();
  // Send each one
  for (const event of results) await ping(env, event);
}

// Every minute: send the notifications that have waited too long for their email
export async function sendOverduePings(env) {
  // The time before which a waiting notification is overdue
  const cutoff = new Date(Date.now() - EMAIL_WAIT_MINUTES * 60 * 1000).toISOString();
  // Find them
  const { results } = await env.DB.prepare("SELECT * FROM booking_events WHERE notified_at IS NULL AND received_at < ? ORDER BY id LIMIT 20")
    // Older than the cutoff
    .bind(cutoff)
    // Get them
    .all();
  // Send each one with what we have
  for (const event of results) await ping(env, event);
  // Tidy up: forget changes that were sent more than a day ago
  await env.DB.prepare("DELETE FROM booking_events WHERE notified_at < ?").bind(new Date(Date.now() - 86400000).toISOString()).run();
}

// Has an Acuity email arrived recently (so they're being passed on)?
async function emailsActive(env) {
  // The newest email we've had
  const newest = await env.DB.prepare("SELECT MAX(email_at) AS at FROM booking_details").first("at");
  // Recent enough?
  return Boolean(newest) && Date.now() - Date.parse(newest) < EMAILS_ACTIVE_DAYS * 86400000;
}

// Is the latest email about this booking about this very change (and recent)?
async function emailIsFor(env, event) {
  // The latest email's kind and time
  const row = await env.DB.prepare("SELECT email_info, email_at FROM booking_details WHERE id = ?").bind(event.appointment_id).first();
  // No email yet
  if (!row?.email_at) return false;
  // What kind of email it was (scheduled, rescheduled, canceled)
  const kind = JSON.parse(row.email_info || "{}").kind;
  // Same kind of change, within the last 10 minutes
  return kind === event.action && Date.now() - Date.parse(row.email_at) < 10 * 60 * 1000;
}

// Send one booking notification (only once, however many things try to send it)
async function ping(env, event) {
  // Mark it as sent; if something else already did, stop here
  const { meta } = await env.DB.prepare("UPDATE booking_events SET notified_at = ? WHERE id = ? AND notified_at IS NULL")
    // Now, for this change
    .bind(new Date().toISOString(), event.id)
    // Run it
    .run();
  // Already sent
  if (!meta.changes) return;
  // Everything we know about the booking
  let info = await bookingInfo(env, event.appointment_id);
  // A move without its email: the day and time we have are the old ones
  if (info && event.action === "rescheduled" && !info.was && info.source !== "calendar") info = { ...info, was: info.when, when: null };
  // The heading, with the customer's name when we know it
  const title = (TITLES[event.action] || "Booking update") + (info?.name ? ": " + info.name : "");
  // The details, or just the session's name if we have none
  const lines = info ? describeBooking(info) : [await sessionName(event.type_id)];
  // A move we have no new time for: say where to find it
  if (event.action === "rescheduled" && !info?.when) lines.push("Tap to see the new time in Acuity.");
  // Send it to every signed-up phone; tapping it opens Acuity
  await notifyPhones(env, { title, body: lines.join("\n"), url: "https://secure.acuityscheduling.com/", appointmentId: event.appointment_id });
  // After a move, the confirmation page's old day and time are wrong
  if (event.action === "rescheduled") await forgetBookingTime(env, event.appointment_id);
}

// The session's name, looked up on the public booking page by its number
async function sessionName(typeId) {
  // Try it, falling back to a plain description
  try {
    // Find the session with this number
    const type = (await getSessionTypes(ACUITY_OWNER)).find((t) => t.id === Number(typeId));
    // Its name, if we found it
    if (type) return type.name;
  } catch (err) {
    // The booking page couldn't be read: note it
    console.log("Couldn't name the booked session:", err);
  }
  // The plain description
  return "A session";
}

// Booking details from Acuity's private calendar feed: the link under
// Acuity → Sync with Other Calendars → 1-way Calendar Sync, saved as the
// ACUITY_CALENDAR_URL secret. It's the same list Acuity gives Google Calendar
// or an iPhone calendar to show your bookings, and it works on every plan.
//
// Each booking in it has its number (the same one the webhook sends), the
// customer's name, phone, email, the price, any booking-form answers, the
// session and the time. Think of it as a copy of the studio diary that Acuity
// keeps up to date: when the webhook says "booking #123 changed", we look #123
// up in the diary.

// How many times to look, and how long to wait between, if a new booking isn't in the diary yet
const TRIES = 3;
const WAIT_MS = 2000;

// Look booking #id up in the calendar feed and save what it says.
// `action` is what happened (scheduled, rescheduled, canceled).
// Returns true if the booking was found.
export async function readCalendar(env, id, action) {
  // No feed link set up: nothing to read
  if (!env.ACUITY_CALENDAR_URL) return false;
  // Try a few times (a brand-new booking can take a moment to appear)
  for (let attempt = 1; attempt <= TRIES; attempt++) {
    // Read the feed and find the booking
    const event = await fetchCalendar(env).then((events) => events[String(id)], (err) => console.log("Couldn't read the Acuity calendar feed:", err));
    // Found it: save it and stop
    if (event) {
      // What we saved last time (for a moved booking, that's the old time)
      const before = await env.DB.prepare("SELECT calendar_info FROM booking_details WHERE id = ?").bind(Number(id)).first("calendar_info");
      // The old time, only if the booking has moved
      const oldWhen = action === "rescheduled" && before ? JSON.parse(before).when : null;
      // Everything to save: the details, plus the old time if it changed
      const info = { ...event, was: oldWhen && oldWhen !== event.when ? oldWhen : null };
      // Save it against the booking
      await env.DB.prepare(
        "INSERT INTO booking_details (id, calendar_info, calendar_at) VALUES (?, ?, ?) ON CONFLICT (id) DO UPDATE SET calendar_info = excluded.calendar_info, calendar_at = excluded.calendar_at"
      )
        // The booking number, the details as JSON, and the time now
        .bind(Number(id), JSON.stringify(info), new Date().toISOString())
        // Run it
        .run();
      // Found
      return true;
    }
    // A cancelled booking leaves the diary, so there's nothing to wait for
    if (action === "canceled") return false;
    // Not there yet: wait a moment before the next try
    if (attempt < TRIES) await new Promise((resolve) => setTimeout(resolve, WAIT_MS));
  }
  // Never appeared
  return false;
}

// Every booking in the feed, soonest first (for Nova Hub's calendar and questions), or null if the feed isn't set up
export async function listBookings(env) {
  // No feed link: nothing to list
  if (!env.ACUITY_CALENDAR_URL) return null;
  // Read the feed
  const events = await fetchCalendar(env);
  // Each booking with its number, soonest first
  return Object.entries(events)
    .map(([id, event]) => ({ id: Number(id), ...event }))
    .sort((a, b) => String(a.start).localeCompare(String(b.start)));
}

// Read the whole feed: every booking in it, by booking number
async function fetchCalendar(env) {
  // Download the feed (never a stored copy: it must be up to date)
  const res = await fetch(env.ACUITY_CALENDAR_URL, { cache: "no-store" });
  // Acuity said no (the link was reset, for example)
  if (!res.ok) throw new Error("Acuity calendar feed answered " + res.status);
  // Read and unpack it
  return parseCalendar(await res.text());
}

// Unpack the calendar feed (iCalendar format) into bookings by number
export function parseCalendar(ics) {
  // Long lines are folded onto the next line starting with a space: join them back up
  const text = String(ics).replace(/\r\n/g, "\n").replace(/\n[ \t]/g, "");
  // The bookings found
  const events = {};
  // Each event in the feed
  for (const block of text.split("BEGIN:VEVENT").slice(1)) {
    // Just this event's lines
    const body = block.split("END:VEVENT")[0];
    // One field's value, by name ("SUMMARY", "DESCRIPTION", ...)
    const field = (name) => unescape((body.match(new RegExp("^" + name + "(?:;[^:\\n]*)?:(.*)$", "m")) || [])[1] || "");
    // The booking number ("1782089433@scheduling")
    const uid = field("UID").match(/^(\d{5,15})@/);
    // Not a booking (a blocked-off time, for example): skip it
    if (!uid) continue;
    // The "Label: value" lines in the description
    const pairs = field("DESCRIPTION")
      .split("\n")
      .map((line) => line.match(/^([^:]{1,80}):\s*(.*)$/))
      .filter((m) => m && m[2].trim())
      .map((m) => [m[1].trim(), m[2].trim().slice(0, 300)]);
    // One labelled value from the description
    const get = (label) => (pairs.find(([l]) => l.toLowerCase() === label) || [])[1] || null;
    // The customer's name
    const name = get("name");
    // The session: the summary without the name in front or the calendar name at the end
    const session = field("SUMMARY")
      .replace(name ? name + ": " : /^$/, "")
      .replace(/\s*\(Novacane Studios\)$/i, "")
      .trim();
    // Everything we know about this booking
    events[uid[1]] = {
      // The customer
      name,
      phone: get("phone"),
      email: get("email"),
      // The session and price
      session: session || null,
      price: get("price"),
      // The day and time, in UK time ("Thursday, 22 October 2026, 14:15–16:15")
      when: timeRange(field("DTSTART"), field("DTEND")),
      // When it starts and ends ("20261022T131500Z"), for sorting and the calendar
      start: field("DTSTART") || null,
      end: field("DTEND") || null,
      // Everything else in the description (booking-form answers), except the time zone line
      extra: pairs.filter(([l]) => !["name", "phone", "email", "price", "client time zone"].includes(l.toLowerCase())).slice(0, 20),
    };
  }
  // Hand them back
  return events;
}

// Undo the feed's escaping (\n is a new line, "\," is a comma, and so on)
function unescape(value) {
  return value.replace(/\\([nN,;\\])/g, (_, c) => (c === "n" || c === "N" ? "\n" : c));
}

// "20261022T131500Z" and "20261022T151500Z" → "Thursday, 22 October 2026, 14:15–16:15"
function timeRange(start, end) {
  // Turn the feed's date format into a real date
  const toDate = (v) => {
    // Its parts: year, month, day, hour, minute
    const m = v.match(/^(\d{4})(\d{2})(\d{2})T(\d{2})(\d{2})/);
    // A date (UTC, as the feed gives it), or nothing
    return m ? new Date(Date.UTC(+m[1], +m[2] - 1, +m[3], +m[4], +m[5])) : null;
  };
  // The start and end
  const [from, to] = [toDate(start), toDate(end)];
  // No start time: no answer
  if (!from) return null;
  // The day, in UK time
  const day = from.toLocaleDateString("en-GB", { timeZone: "Europe/London", weekday: "long", day: "numeric", month: "long", year: "numeric" });
  // A time of day, in UK time
  const clock = (d) => d.toLocaleTimeString("en-GB", { timeZone: "Europe/London", hour: "2-digit", minute: "2-digit" });
  // Put them together
  return day + ", " + clock(from) + (to ? "–" + clock(to) : "");
}

// The details of each Acuity booking (session, day, time, price, email), for
// staff notifications and Nova Hub's Alerts tab.
//
// Acuity's webhook only says "booking #123 happened" (on the Emerging plan).
// The details come from a small piece of code on Acuity's confirmation page
// (Integrations → Custom conversion tracking, see README.md), which runs in the
// customer's browser and calls:
//
//   GET /acuity/booked?type=&id=&session=&date=&time=&price=&email=&calendar=
//
// Anyone could call that address, so details only count when Acuity's webhook
// (which carries the secret key) confirms the same booking within 15 minutes.
// Name and phone aren't on the confirmation page: they come from Acuity's own
// booking email (see booking-emails.js), or a NovaBot enquiry with the same email.

// How close together the two halves must arrive to count as a match
const MATCH_MINUTES = 15;
// How long booking details are kept
const KEEP_DAYS = 90;
// A tiny see-through picture, sent back to the confirmation page
const PIXEL = Uint8Array.from(atob("R0lGODlhAQABAIAAAAAAAP///yH5BAEAAAAALAAAAAABAAEAAAIBRAA7"), (c) => c.charCodeAt(0));

// The confirmation page sends a booking's details
export async function handleBookedPixel(request, env) {
  // Read the details from the address
  const q = new URL(request.url).searchParams;
  // Tidy each value: plain text, trimmed, never too long
  const text = (name, max = 200) => String(q.get(name) || "").trim().slice(0, max) || null;
  // Acuity's booking number (digits only)
  const id = text("id", 15);
  // Only appointments (not packages or gift certificates), with a real booking number
  const valid = (q.get("type") || "").toLowerCase() === "appointment" && /^\d{1,15}$/.test(id || "");
  // Only a handful per minute from one place, so nobody can flood the table
  const ip = request.headers.get("CF-Connecting-IP") || "";
  // Check the limit (if it's set up), ignoring problems with the limiter itself
  const allowed = !env.CHAT_LIMIT || !ip || (await env.CHAT_LIMIT.limit({ key: "booked:" + ip }).then((r) => r.success, () => true));
  // Save it if it's valid and allowed
  if (valid && allowed) {
    // Try it, without ever breaking the customer's confirmation page
    try {
      // Add the details, unless this booking already has some (the first ones win)
      await env.DB.prepare(
        `INSERT INTO booking_details (id, details_at, session, date, time, price, email, calendar) VALUES (?, ?, ?, ?, ?, ?, ?, ?)
         ON CONFLICT (id) DO UPDATE SET details_at = excluded.details_at, session = excluded.session, date = excluded.date,
           time = excluded.time, price = excluded.price, email = excluded.email, calendar = excluded.calendar
         WHERE booking_details.details_at IS NULL`
      )
        // Fill in the values
        .bind(Number(id), new Date().toISOString(), text("session"), text("date"), text("time"), text("price", 30), text("email", 254), text("calendar"))
        // Run it
        .run();
    } catch (err) {
      // Note it in the Worker's logs
      console.log("Couldn't save booking details:", err);
    }
  }
  // Always answer with the tiny picture, so the page never shows an error
  return new Response(PIXEL, { headers: { "Content-Type": "image/gif", "Cache-Control": "no-store" } });
}

// Acuity's webhook confirms booking #id exists (the trusted half of the ticket)
export async function confirmBooking(env, id) {
  // Note when, unless it was already noted
  await env.DB.prepare(
    "INSERT INTO booking_details (id, webhook_at) VALUES (?, ?) ON CONFLICT (id) DO UPDATE SET webhook_at = excluded.webhook_at WHERE booking_details.webhook_at IS NULL"
  )
    // Fill in the booking number and the time now
    .bind(Number(id), new Date().toISOString())
    // Run it
    .run();
  // Now and then, clear out old bookings (like emptying the bin once in a while)
  if (Math.random() < 0.05) {
    // The date before which details are removed
    const cutoff = new Date(Date.now() - KEEP_DAYS * 24 * 60 * 60 * 1000).toISOString();
    // Remove them
    await env.DB.prepare("DELETE FROM booking_details WHERE COALESCE(webhook_at, details_at) < ?").bind(cutoff).run();
  }
}

// The details of booking #id, or null if there are none we can trust.
// Acuity's email (trusted: it comes with a secret key) wins over the
// confirmation page, which only counts when it matches the webhook.
export async function bookingInfo(env, id) {
  // No booking number: nothing to look up
  if (!id) return null;
  // Find the booking
  const row = await env.DB.prepare("SELECT * FROM booking_details WHERE id = ?").bind(Number(id)).first();
  // Nothing saved for it
  if (!row) return null;
  // How far apart the webhook and the confirmation page arrived, in minutes
  const apart = Math.abs(Date.parse(row.webhook_at) - Date.parse(row.details_at)) / 60000;
  // The confirmation page's details count only when both halves arrived close together
  const page = row.webhook_at && row.details_at && apart <= MATCH_MINUTES ? row : null;
  // What Acuity's calendar feed said (see booking-calendar.js), unpacked from its bundle
  const cal = row.calendar_at ? JSON.parse(row.calendar_info || "{}") : null;
  // What Acuity's email said (if one arrived), unpacked from its bundle
  const mail = row.email_at ? JSON.parse(row.email_info || "{}") : null;
  // No source: nothing we can trust
  if (!page && !mail && !cal) return null;
  // The first of these that has a value (calendar first, then the email, then the confirmation page)
  const pick = (...values) => values.find((v) => v) || null;
  // The customer's email address
  const email = pick(cal?.email, mail?.email, page?.email);
  // Look for a NovaBot enquiry from the same email, for the name and phone if nothing else has them
  const enquiry = email
    ? await env.DB.prepare("SELECT name, phone FROM enquiries WHERE email = ? COLLATE NOCASE ORDER BY id DESC LIMIT 1").bind(email).first()
    : null;
  // Everything we know about the booking
  return {
    // The session booked
    session: pick(cal?.session, mail?.session, page?.session),
    // The day and time
    when: pick(cal?.when, mail?.when, page && [page.date, page.time].filter(Boolean).join(" at ")),
    // The old day and time, for a moved booking
    was: pick(cal?.was, mail?.was),
    // The price
    price: pick(cal?.price, mail?.price, page?.price),
    // The customer's email
    email,
    // The customer's name and phone
    name: pick(cal?.name, mail?.name, enquiry?.name),
    phone: pick(cal?.phone, mail?.phone, enquiry?.phone),
    // Everything else (booking-form answers and so on), from the calendar or the email
    extra: cal?.extra?.length ? cal.extra : mail?.extra || [],
    // Where the details came from, and when we got them (for the Alerts tab)
    source: cal ? "calendar" : mail ? "email" : "page",
    sourceAt: cal ? row.calendar_at : mail ? row.email_at : row.details_at,
    // About Acuity's email, if one arrived: what kind it was, and a link to it in Gmail
    fromEmail: Boolean(mail),
    emailKind: mail?.kind || null,
    gmail: mail?.gmail || null,
  };
}

// Wait a little for the confirmation page's details (they usually arrive
// within seconds of the webhook, but sometimes just after it)
export async function waitForBookingInfo(env, id, seconds) {
  // Keep checking until the time is up
  for (let waited = 0; ; waited += 2) {
    // Look for trusted details
    const info = await bookingInfo(env, id);
    // Found them, or out of time: stop
    if (info || waited >= seconds) return info;
    // Wait two seconds and check again
    await new Promise((resolve) => setTimeout(resolve, 2000));
  }
}

// The day and time are no longer right once a booking moves
export async function forgetBookingTime(env, id) {
  // Clear them, keeping everything else
  await env.DB.prepare("UPDATE booking_details SET date = NULL, time = NULL WHERE id = ?").bind(Number(id)).run();
}

// The lines of text that describe a booking, for notifications and Alerts
export function describeBooking(info) {
  // Each line, leaving out anything we don't know
  return [
    // The session
    info.session,
    // The day and time
    info.when,
    // The old day and time, for a moved booking
    info.was && "Was: " + info.was,
    // The price (the confirmation page sends just the number)
    info.price && "Price: " + (/^[\d.]+$/.test(info.price) ? "£" + info.price : info.price),
    // The customer's name, phone and email
    info.name && "Name: " + info.name,
    info.phone && "Phone: " + info.phone,
    info.email && "Email: " + info.email,
    // Everything else from Acuity's email, one line each ("Instagram: @fanny")
    ...(info.extra || []).map(([label, value]) => label + ": " + value),
  ].filter(Boolean);
}

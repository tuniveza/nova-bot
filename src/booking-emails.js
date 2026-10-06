// Acuity's booking emails, passed on by a small Google script that runs in the
// mailbox Acuity emails (tools/acuity-email-forwarder.gs). They have what the
// webhook leaves out: the customer's name, phone, email, price and their
// answers on the booking form.
//
//   POST /acuity/email   { subject, html, text, messageId, account }   header X-Nova-Key: <ACUITY_EMAIL_KEY>
//
// Like a trusted courier with a key to the back door: only the script knows the
// key. The email never sends a notification by itself; it only fills in the
// details of a booking Acuity's webhook has already told us about.

// When the email arrives, any notification waiting for it goes out
import { emailArrived } from "./booking-pings.js";

// Labels Acuity uses, and which detail each one is (lower case, without the colon)
const LABELS = {
  // The customer's name
  name: "name", "client": "name", "client name": "name", "customer": "name", "full name": "name",
  // Their phone number
  phone: "phone", "phone number": "phone", mobile: "phone", "mobile number": "phone", telephone: "phone",
  // Their email address
  email: "email", "e-mail": "email", "email address": "email",
  // The session
  what: "session", "appointment type": "session", appointment: "session", service: "session", type: "session",
  // The day and time (for a moved booking, the new one)
  when: "when", "new time": "when", time: "when", "date & time": "when", "date and time": "when", date: "when",
  // The old day and time, for a moved booking
  "old time": "was", "previous time": "was", was: "was",
  // The price
  price: "price", amount: "price", total: "price", paid: "price", "amount paid": "price",
};
// The most form answers to keep, and the longest label and answer
const MAX_EXTRA = 20;
const MAX_LABEL = 80;
const MAX_VALUE = 300;

// The Google script hands over one email
export async function handleAcuityEmail(request, env) {
  // Only POSTs with the right key, and only once the key is set up
  if (request.method !== "POST" || !env.ACUITY_EMAIL_KEY || !(await sameText(request.headers.get("X-Nova-Key") || "", env.ACUITY_EMAIL_KEY))) {
    // Turn everything else away
    return Response.json({ error: "Not allowed" }, { status: 401 });
  }
  // Read the email (subject, HTML and plain text), refusing anything huge
  const raw = await request.text();
  // Too big to be one of Acuity's emails
  if (raw.length > 1_000_000) return Response.json({ error: "Too big" }, { status: 413 });
  // Unpack it
  let email;
  try {
    // From JSON
    email = JSON.parse(raw);
  } catch {
    // Not JSON
    return Response.json({ error: "Bad request" }, { status: 400 });
  }
  // Pick the details out of it, and note where it is in Gmail
  const info = { ...parseAcuityEmail(email), gmail: gmailLink(email) };
  // No booking number in the email: use the only booking change from the last 10 minutes still waiting, if there is exactly one
  const id = info.id || (await onlyWaitingBooking(env));
  // Can't tell which booking it's about (or it isn't about a booking): nothing to do
  if (!id || !info.kind) return Response.json({ ok: true, matched: false });
  // Save the details against the booking (replacing any older email's)
  await env.DB.prepare(
    "INSERT INTO booking_details (id, email_info, email_at) VALUES (?, ?, ?) ON CONFLICT (id) DO UPDATE SET email_info = excluded.email_info, email_at = excluded.email_at"
  )
    // The booking number, the details as JSON, and the time now
    .bind(Number(id), JSON.stringify(info), new Date().toISOString())
    // Run it
    .run();
  // Send any notification that was waiting for this email
  await emailArrived(env, id);
  // Tell the script it worked
  return Response.json({ ok: true, matched: true, id: Number(id) });
}

// Pick the booking details out of one of Acuity's emails
export function parseAcuityEmail({ subject = "", html = "", text = "" }) {
  // Make sure each part is text
  [subject, html, text] = [String(subject), String(html), String(text)];
  // What kind of email it is, from its subject line
  const kind = /cancel/i.test(subject) ? "canceled" : /reschedul|moved/i.test(subject) ? "rescheduled" : /new appointment|scheduled|booked/i.test(subject) ? "scheduled" : null;
  // Acuity's booking number, from the links in the email ("apptId=123", "appointments.php?...id=123", ".../appointments/123")
  const idMatch =
    html.match(/[?&;]apptId=(\d{5,15})/i) || html.match(/appointments?(?:\.php)?\?[^"'\s>]*?\bid=(\d{5,15})/i) || html.match(/\/appointments?\/(?:view\/)?(\d{5,15})\b/i);
  // Every "label → value" pair in the email
  const pairs = [...tablePairs(html), ...linePairs(htmlToText(html)), ...linePairs(text)];
  // The details we look for, and everything else
  const found = {};
  const extra = [];
  // Go through the pairs, keeping the first value for each
  for (const [label, value] of pairs) {
    // Which detail this label is (or none)
    const key = LABELS[label.toLowerCase()];
    // A detail we look for, not already found: keep it
    if (key && !found[key]) found[key] = value;
    // Something else (like a form answer), not seen before: keep it as an extra
    else if (!key && extra.length < MAX_EXTRA && !extra.some(([l]) => l === label) && !/^https?:/i.test(value)) extra.push([label, value]);
  }
  // The name: from a "Name" label, a "for Fanny Winters" heading, or the subject's "(Fanny Winters) on ..."
  const name = found.name || (htmlToText(html).match(/^for (.{2,80})$/m) || [])[1] || (subject.match(/\(([^()]{2,80})\)\s+on\s/) || [])[1] || null;
  // The phone: from a "Phone" label, or a tap-to-call link
  const phone = found.phone || decodeURIComponent((html.match(/href=["']tel:([^"']{5,30})["']/i) || [])[1] || "") || null;
  // The email: from an "Email" label, or an email link (not Acuity's or the studio's own)
  const mailto = [...html.matchAll(/href=["']mailto:([^"'?]{3,254})/gi)].map((m) => decodeURIComponent(m[1])).find((a) => !/acuity|novacane/i.test(a));
  // Everything we found, tidied
  return {
    // Which booking
    id: idMatch ? idMatch[1] : null,
    // What happened
    kind,
    // The customer
    name: clean(name),
    phone: clean(phone),
    email: clean(found.email || mailto),
    // The session, without the calendar's name Acuity adds at the end
    session: clean(found.session)?.replace(/\s*\(Novacane Studios\)$/i, "") || null,
    // The day and time, and the old ones for a moved booking
    when: clean(found.when),
    was: clean(found.was),
    // The price
    price: clean(found.price),
    // Everything else
    extra,
  };
}

// A link that opens the email in Gmail (only from a real Gmail number and email address)
function gmailLink({ messageId, account }) {
  // Gmail's number for the email: letters a–f and digits only
  const id = String(messageId || "");
  // The Gmail account it's in
  const user = String(account || "");
  // Anything odd: no link
  if (!/^[0-9a-f]{10,24}$/i.test(id) || !/^[^\s@"'<>&]{1,64}@[^\s@"'<>&]{1,190}$/.test(user)) return null;
  // The link
  return `https://mail.google.com/mail/?authuser=${encodeURIComponent(user)}#all/${id}`;
}

// "label → value" pairs from table rows with exactly two cells (how Acuity lays out its emails)
function tablePairs(html) {
  // The pairs found
  const pairs = [];
  // Each innermost table row
  for (const [, row] of html.matchAll(/<tr[^>]*>((?:(?!<tr[\s>])[\s\S])*?)<\/tr>/gi)) {
    // The text of each cell in the row
    const cells = [...row.matchAll(/<t[dh][^>]*>([\s\S]*?)<\/t[dh]>/gi)].map((m) => htmlToText(m[1]).replace(/\s+/g, " ").trim());
    // Two cells, both filled in, with a short label: a pair
    if (cells.length === 2 && cells[0] && cells[1]) addPair(pairs, cells[0], cells[1]);
  }
  // Hand them back
  return pairs;
}

// "Label: value" pairs from lines of text
function linePairs(text) {
  // The pairs found
  const pairs = [];
  // Each line that looks like "Label: value"
  for (const line of text.split("\n")) {
    // Split it at the first colon (labels are short and start with a letter)
    const m = line.trim().match(/^([A-Za-z][^:\n]{0,79}?):\s+(.+)$/);
    // A match: add it
    if (m) addPair(pairs, m[1], m[2]);
  }
  // Hand them back
  return pairs;
}

// Add one pair, tidied and trimmed to sensible lengths
function addPair(pairs, label, value) {
  // Remove a colon at the end of the label, and extra spaces
  label = label.replace(/:\s*$/, "").replace(/\s+/g, " ").trim();
  // Extra spaces in the value
  value = value.replace(/\s+/g, " ").trim();
  // Skip labels that are too long to be labels, and empty values
  if (!label || !value || label.length > MAX_LABEL) return;
  // Keep it (values cut to a sensible length)
  pairs.push([label, value.slice(0, MAX_VALUE)]);
}

// Turn HTML into plain text, a line per paragraph or row
function htmlToText(html) {
  return (
    String(html)
      // Leave out styles and scripts entirely
      .replace(/<(style|script)[^>]*>[\s\S]*?<\/\1>/gi, "")
      // New lines where the email breaks lines, rows or paragraphs
      .replace(/<(br|\/p|\/div|\/tr|\/h\d|\/li)[^>]*>/gi, "\n")
      // Remove the remaining tags
      .replace(/<[^>]+>/g, " ")
      // Turn codes like &amp; back into characters
      .replace(/&(#\d+|#x[\da-f]+|amp|lt|gt|quot|apos|nbsp|#39);/gi, (code, name) => {
        // Numbered characters (decimal or hex)
        if (name[0] === "#") return String.fromCodePoint(name[1].toLowerCase() === "x" ? parseInt(name.slice(2), 16) : Number(name.slice(1)));
        // Named ones
        return { amp: "&", lt: "<", gt: ">", quot: '"', apos: "'", nbsp: " " }[name.toLowerCase()];
      })
      // Tidy the spaces on each line
      .split("\n")
      .map((line) => line.replace(/[ \t\r]+/g, " ").trim())
      .join("\n")
  );
}

// Trim a detail, or null if it's empty
function clean(value) {
  // Spaces tidied
  const text = String(value || "").replace(/\s+/g, " ").trim();
  // Something, or nothing
  return text ? text.slice(0, MAX_VALUE) : null;
}

// The one booking change from the last 10 minutes still waiting for its email, if there's exactly one
async function onlyWaitingBooking(env) {
  // 10 minutes ago
  const since = new Date(Date.now() - 10 * 60 * 1000).toISOString();
  // The bookings still waiting since then
  const { results } = await env.DB.prepare("SELECT DISTINCT appointment_id FROM booking_events WHERE notified_at IS NULL AND received_at > ?").bind(since).all();
  // Exactly one: it must be that one
  return results.length === 1 ? results[0].appointment_id : null;
}

// Compare without giving away how much matched (same time whatever was sent)
async function sameText(a, b) {
  // A fixed-length fingerprint of each
  const hash = async (s) => new Uint8Array(await crypto.subtle.digest("SHA-256", new TextEncoder().encode(String(s))));
  // Compare the fingerprints
  return crypto.subtle.timingSafeEqual(await hash(a), await hash(b));
}

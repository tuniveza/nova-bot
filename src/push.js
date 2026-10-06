// Nova Hub notifications: sending a message to every signed-up phone.
//
// Think of it like the post: each phone gave us a delivery address (from Apple),
// and we seal each message so only that phone can open it, then hand it to
// Apple, who delivers it even if the app is closed and the phone is asleep.
//
// Needs the VAPID_PUBLIC_KEY and VAPID_PRIVATE_KEY secrets (our "wax seal",
// which proves messages come from us).

// The library that seals messages the way Apple accepts (version 2)
import { buildPushPayload } from "@block65/webcrypto-web-push";
// Booking details, for the Alerts tab
import { bookingInfo, describeBooking } from "./booking-details.js";
// Bookings made with Nova Bot's own booking system (src/nova/, behind the switch in mode.js)
import { bookingInfo as novaBookingInfo, describeBooking as novaDescribeBooking } from "./nova/booking-details.js";

// Save a phone's delivery address (or update it if it's already saved)
export async function savePhone(env, subscription) {
  // The three parts of the address the phone gave us
  const endpoint = String(subscription?.endpoint || "");
  // The phone's public key, used to seal messages for it
  const p256dh = String(subscription?.keys?.p256dh || "");
  // The phone's secret, also used to seal messages for it
  const auth = String(subscription?.keys?.auth || "");
  // Only accept real push addresses (https, and every part present)
  if (!endpoint.startsWith("https://") || !p256dh || !auth || endpoint.length > 1000) return false;
  // Write it into the database, replacing an older copy of the same address
  await env.DB.prepare(
    "INSERT INTO push_subscriptions (endpoint, p256dh, auth, created_at) VALUES (?, ?, ?, ?) " +
      "ON CONFLICT (endpoint) DO UPDATE SET p256dh = excluded.p256dh, auth = excluded.auth"
  )
    // Fill in the four values
    .bind(endpoint, p256dh, auth, new Date().toISOString())
    // Run it
    .run();
  // Tell the caller it worked
  return true;
}

// Forget a phone (when it turns notifications off)
export async function forgetPhone(env, endpoint) {
  // Delete that address from the database
  await env.DB.prepare("DELETE FROM push_subscriptions WHERE endpoint = ?").bind(String(endpoint || "")).run();
}

// How long the Alerts tab keeps notifications
const KEEP_ALERTS_DAYS = 90;

// Send one notification to every signed-up phone. Returns how many it reached.
// `url` is what opens when the notification is tapped. `save: false` keeps it
// out of Nova Hub's Alerts tab (used for test notifications). `appointmentId`
// or `enquiryId` says which booking or enquiry it's about. `style` (optional)
// says how the phone should show it: which Nova app it's from (`source`), what
// kind it is, a `tag` (a newer one replaces an older one with the same tag), how
// long it's worth delivering (`ttl`, in seconds) and whether it's `urgent` (it
// stays on screen until it's answered, with a stronger buzz).
export async function notifyPhones(env, { title, body, url = "/app/", save = true, appointmentId = null, enquiryId = null, style = null }) {
  // Keep the text short enough for Apple (it allows about 4,000 characters in all)
  body = String(body).slice(0, 1500);
  // Send it to every phone and count how many Apple accepted it for
  const delivered = await sendToPhones(env, { title, body, url, style });
  // Only list it in Nova Hub if it actually went through to a phone
  if (save && delivered > 0) await saveAlert(env, { title, body, url, phones: delivered, appointmentId, enquiryId });
  // Report how many phones it reached
  return delivered;
}

// Write a notification into the Alerts list (a copy of what the phone got)
async function saveAlert(env, { title, body, url, phones, appointmentId, enquiryId }) {
  // Try it, but never let a list problem stop anything else
  try {
    // Add it to the list
    await env.DB.prepare("INSERT INTO notifications (created_at, title, body, url, phones, appointment_id, enquiry_id) VALUES (?, ?, ?, ?, ?, ?, ?)")
      // Fill in the values
      .bind(new Date().toISOString(), title, body, url, phones, appointmentId ? Number(appointmentId) : null, enquiryId)
      // Run it
      .run();
    // Now and then, clear out old ones (like emptying the bin once in a while)
    if (Math.random() < 0.05) {
      // The date before which notifications are removed
      const cutoff = new Date(Date.now() - KEEP_ALERTS_DAYS * 24 * 60 * 60 * 1000).toISOString();
      // Remove them
      await env.DB.prepare("DELETE FROM notifications WHERE created_at < ?").bind(cutoff).run();
    }
  } catch (err) {
    // Note it in the Worker's logs and carry on
    console.log("Couldn't save the alert:", err);
  }
}

// The choices for "delete alerts after", in days
export const AUTO_DELETE_CHOICES = [1, 3, 7, 14, 30];

// How many days alerts are kept before deleting themselves (0 = the switch is off)
export async function autoDeleteDays(env) {
  // Read the setting
  const value = await env.DB.prepare("SELECT value FROM settings WHERE key = 'alerts_auto_delete_days'").first("value");
  // A number of days, or 0 if it's off
  return Number(value) || 0;
}

// Turn the switch on (with a number of days) or off (0)
export async function setAutoDelete(env, days) {
  // Save it, replacing the old value
  await env.DB.prepare("INSERT INTO settings (key, value) VALUES ('alerts_auto_delete_days', ?) ON CONFLICT (key) DO UPDATE SET value = excluded.value")
    // The number of days (0 = off)
    .bind(String(days))
    // Run it
    .run();
  // Apply it straight away
  await deleteOldAlerts(env);
}

// Delete alerts older than the switch says (runs every minute, and when the Alerts tab opens)
export async function deleteOldAlerts(env) {
  // How many days to keep them
  const days = await autoDeleteDays(env);
  // Switch off: nothing to do
  if (!days) return;
  // The date before which alerts go
  const cutoff = new Date(Date.now() - days * 24 * 60 * 60 * 1000).toISOString();
  // Delete them
  await env.DB.prepare("DELETE FROM notifications WHERE created_at < ?").bind(cutoff).run();
}

// Delete one alert by its number, or all of them
export async function deleteAlerts(env, { id, all }) {
  // Everything
  if (all === true) return env.DB.prepare("DELETE FROM notifications").run();
  // Just one
  return env.DB.prepare("DELETE FROM notifications WHERE id = ?").bind(Number(id)).run();
}

// The most recent notifications, newest first, for the Alerts tab, each with
// the customer's contact details when we know them
export async function listAlerts(env) {
  // First, clear out any that the auto-delete switch says are too old
  await deleteOldAlerts(env);
  // Read the latest 100, with the enquiry each one is about (if any)
  const { results } = await env.DB.prepare(
    `SELECT n.id, n.created_at, n.title, n.body, n.url, n.phones, n.appointment_id, n.enquiry_id, q.name, q.email, q.phone
     FROM notifications n LEFT JOIN enquiries q ON q.id = n.enquiry_id ORDER BY n.id DESC LIMIT 100`
  ).all();
  // Shape each one for the app, saying what kind of alert it is (and which booking, so the app can check it with Acuity)
  return Promise.all(
    results.map(async (n) => ({ ...(await shapeAlert(env, n)), kind: alertKind(n), appointmentId: n.appointment_id || null }))
  );
}

// What an alert is about, for its label in the Alerts tab
export function alertKind(n) {
  // Sent by Nova Agent: its quests, missions, and its own news
  if (n.title.startsWith("Nova Quest: ")) return "quest";
  if (n.title.startsWith("Nova Mission: ")) return "mission";
  // A test notification
  if (/\btest\b/i.test(n.title)) return "test";
  // A booking made in Acuity, or with Nova Bot's own booking system
  if (n.appointment_id) return /acuityscheduling\.com/.test(n.url) ? "booking" : "nova-booking";
  if (/^NovaBot (booked|couldn't book)/.test(n.title)) return "booking";
  if (n.title.startsWith("Nova Agent")) return "agent";
  // A customer's enquiry
  if (n.enquiry_id) return "enquiry";
  // A problem with the connection to Acuity
  if (/can't reach Acuity|Acuity/i.test(n.title)) return "health";
  return "other";
}

// One alert, with the latest booking or enquiry details
async function shapeAlert(env, n) {
  // A Nova Bot booking (its alerts link to Google Calendar or Nova Hub, never Acuity): shown as it is now
  if (n.appointment_id && !/acuityscheduling\.com/.test(n.url)) return novaAlert(env, n);
  // Booking details, if the confirmation page sent them after the notification went out
  const info = n.appointment_id ? await bookingInfo(env, n.appointment_id) : null;
  // The customer's contact details, from the enquiry or the booking
  const contact = { name: n.name || info?.name || null, email: n.email || info?.email || null, phone: n.phone || info?.phone || null };
  // The booking's details as they are now
  const now = info ? describeBooking(info) : [];
  // A new-booking alert sent before all the details arrived, but more have arrived since
  const late = n.title.startsWith("New booking") && now.length > n.body.split("\n").length;
  // Then show the details now (and the name, if we know it)
  const title = late && info.name ? "New booking: " + info.name : n.title;
  // The text: the details, or what the notification said
  const body = late ? now.join("\n") : n.body;
  // The latest details about this booking from Acuity (always up to date)
  const email = info && info.source !== "page"
    ? {
        // Where they came from: Acuity's calendar, or Acuity's email
        source: info.source,
        // What the email was about (scheduled, rescheduled, canceled)
        kind: info.emailKind,
        // When we got them
        at: info.sourceAt,
        // Every detail in it
        lines: now,
        // Already shown in the alert's own text, so no need to repeat it
        same: now.join("\n") === body,
        // A link that opens it in Gmail
        gmail: info.gmail,
      }
    : null;
  // What the app needs for this alert
  return { id: n.id, created_at: n.created_at, title, body, url: n.url, phones: n.phones, contact, email };
}

// Check a booking with Acuity itself, so staff can tell a real booking from a test or a fake:
// it exists, who it's for, when it was made, whether it's been cancelled, and what's been paid
const ACUITY_API = "https://acuityscheduling.com/api/v1";
export async function verifyBooking(env, id) {
  // Booking numbers are whole numbers
  if (!/^\d{1,12}$/.test(String(id || ""))) return { status: "unknown", title: "No booking number", lines: [] };
  // Can't ask Acuity without its keys
  if (!env.ACUITY_USER_ID || !env.ACUITY_API_KEY) return { status: "unknown", title: "Can't check: Acuity isn't connected", lines: [] };
  let res;
  try {
    // Ask Acuity for this booking (cancelled ones too)
    res = await fetch(`${ACUITY_API}/appointments/${id}?pastFormAnswers=false`, {
      headers: { Authorization: "Basic " + btoa(`${env.ACUITY_USER_ID.trim()}:${env.ACUITY_API_KEY.trim()}`) },
      signal: AbortSignal.timeout(10000),
    });
  } catch {
    return { status: "unknown", title: "Couldn't reach Acuity just now", lines: [] };
  }
  // Acuity has never heard of it
  if (res.status === 404) return { status: "missing", title: "Not found in Acuity", lines: [`Acuity #${id}`, "This may be a test, or not a real booking"] };
  if (!res.ok) return { status: "unknown", title: `Acuity answered ${res.status}`, lines: [] };
  const a = await res.json();
  // "Tue 6 Oct, 20:14" in UK time
  const uk = (iso) => (iso ? new Date(iso).toLocaleString("en-GB", { timeZone: "Europe/London", weekday: "short", day: "numeric", month: "short", hour: "2-digit", minute: "2-digit" }) : "");
  const money = (v) => (v === undefined || v === null || v === "" ? "" : "£" + Number(v).toFixed(2));
  const paid = Number(a.amountPaid || 0);
  const price = Number(a.priceSold || a.price || 0);
  const lines = [
    `Acuity #${a.id}${a.calendar ? " · " + a.calendar : ""}`,
    [a.firstName, a.lastName].filter(Boolean).join(" ") + (a.email ? " · " + a.email : ""),
    `${a.type || "Session"} · ${uk(a.datetime)}`,
    `Booked ${uk(a.datetimeCreated)}`,
    price ? `${a.paid === "yes" ? "Paid in full" : paid ? `Deposit ${money(paid)} of ${money(price)} paid` : `Nothing paid yet of ${money(price)}`}` : paid ? `${money(paid)} paid` : "",
    a.noShow ? "Marked as a no-show" : "",
  ].filter(Boolean);
  if (a.canceled) return { status: "cancelled", title: "Cancelled in Acuity", lines };
  return { status: "real", title: "Real booking: confirmed in Acuity", lines, checkedAt: new Date().toISOString() };
}

// One alert about a Nova Bot booking, with the booking as it is now (it may have moved, been paid or cancelled since)
async function novaAlert(env, n) {
  const info = await novaBookingInfo(env, n.appointment_id).catch(() => null);
  const contact = { name: n.name || info?.name || null, email: n.email || info?.email || null, phone: n.phone || info?.phone || null };
  const now = info ? novaDescribeBooking(info) : [];
  const email = info ? { source: "booking", kind: null, at: info.sourceAt, lines: now, same: n.body.includes(now.join("\n")), link: info.link } : null;
  return { id: n.id, created_at: n.created_at, title: n.title, body: n.body, url: n.url, phones: n.phones, contact, email };
}

// Seal and post one notification to every signed-up phone
async function sendToPhones(env, { title, body, url, style }) {
  // No seal set up yet: nothing can be sent, so stop quietly
  if (!env.VAPID_PUBLIC_KEY || !env.VAPID_PRIVATE_KEY) return 0;
  // Our seal: the contact address Apple sees, plus the two halves of our key
  const vapid = {
    // Who's sending (Apple wants a website or email address)
    subject: "https://novacane.co.uk",
    // The public half of our key (also given to the app)
    publicKey: env.VAPID_PUBLIC_KEY,
    // The secret half (never leaves the Worker)
    privateKey: env.VAPID_PRIVATE_KEY,
  };
  // Get every saved phone from the database
  const { results } = await env.DB.prepare("SELECT endpoint, p256dh, auth FROM push_subscriptions").all();
  // Count the phones the message reached
  let delivered = 0;
  // Go through the phones one by one
  for (const phone of results) {
    // Try each phone separately, so one broken phone doesn't stop the rest
    try {
      // Rebuild the phone's address in the shape the library expects
      const subscription = { endpoint: phone.endpoint, expirationTime: null, keys: { p256dh: phone.p256dh, auth: phone.auth } };
      // Seal the message for this phone (it holds the title, text and where to go on tap)
      const letter = await buildPushPayload(
        // The message itself (with how to show it), and how long Apple should keep trying (1 day, or less for reminders)
        { data: JSON.stringify({ title, body, url, ...(style || {}) }), options: { ttl: style?.ttl || 86400, urgency: "high" } },
        // Which phone it's for
        subscription,
        // Our seal
        vapid
      );
      // Hand the sealed message to Apple (or Google) for this phone
      const res = await fetch(phone.endpoint, letter);
      // Apple says this address no longer exists (app removed): forget it
      if (res.status === 404 || res.status === 410) await forgetPhone(env, phone.endpoint);
      // Apple accepted it (2xx): count it as delivered
      else if (res.ok) delivered++;
      // Anything else: note it in the Worker's logs
      else console.log("Push refused:", res.status, await res.text());
    } catch (err) {
      // Something went wrong for this phone only: note it and carry on
      console.log("Push failed:", err);
    }
  }
  // Report how many phones it reached
  return delivered;
}

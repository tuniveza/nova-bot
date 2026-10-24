// Portal notifications: sending a message to every signed-up phone.
//
// Think of it like the post: each phone gave us a delivery address (from Apple),
// and we seal each message so only that phone can open it, then hand it to
// Apple, who delivers it even if the app is closed and the phone is asleep.
//
// Needs the VAPID_PUBLIC_KEY and VAPID_PRIVATE_KEY secrets (our "wax seal",
// which proves messages come from us).

// The library that seals messages the way Apple accepts (version 2)
import { buildPushPayload } from "@block65/webcrypto-web-push";
// Booking details, for the Alerts tab (Nova Bot's own booking system, src/nova/)
import { bookingInfo, describeBooking } from "./nova/booking-details.js";

// Save a phone's delivery address (or update it if it's already saved). `owner` says who
// turned it on (`staffId`) and what it is (`name`, from phoneName), so reminders can pick it.
export async function savePhone(env, subscription, owner = {}) {
  // The three parts of the address the phone gave us
  const endpoint = String(subscription?.endpoint || "");
  // The phone's public key, used to seal messages for it
  const p256dh = String(subscription?.keys?.p256dh || "");
  // The phone's secret, also used to seal messages for it
  const auth = String(subscription?.keys?.auth || "");
  // Only accept real push addresses (https, and every part present)
  if (!endpoint.startsWith("https://") || !p256dh || !auth || endpoint.length > 1000) return false;
  // Write it into the database, replacing an older copy of the same address
  // (a phone keeps its owner and name unless new ones are given)
  await env.DB.prepare(
    "INSERT INTO push_subscriptions (endpoint, p256dh, auth, created_at, staff_id, name) VALUES (?, ?, ?, ?, ?, ?) " +
      "ON CONFLICT (endpoint) DO UPDATE SET p256dh = excluded.p256dh, auth = excluded.auth, " +
      "staff_id = COALESCE(excluded.staff_id, staff_id), name = COALESCE(excluded.name, name)"
  )
    // Fill in the values
    .bind(endpoint, p256dh, auth, new Date().toISOString(), owner.staffId || null, owner.name ? String(owner.name).slice(0, 60) : null)
    // Run it
    .run();
  // Tell the caller it worked
  return true;
}

// A phone's short id: the same every time, and its delivery address stays private
export async function phoneId(endpoint) {
  const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(String(endpoint || "")));
  return [...new Uint8Array(digest).slice(0, 6)].map((b) => b.toString(16).padStart(2, "0")).join("");
}

// What a phone is, in plain words, from its browser's description ("iPhone", "Android · Pixel 7")
export function phoneName(userAgent = "") {
  const ua = String(userAgent);
  if (/iPad/.test(ua)) return "iPad";
  if (/iPhone/.test(ua)) return "iPhone";
  if (/Android/.test(ua)) {
    // Android names the model after its version: "Android 14; Pixel 7 Build/..." or "...; K)"
    const model = (ua.match(/Android [\d.]+; ([^;)]+?)(?: Build\/[^;)]*)?[;)]/) || [])[1];
    return model && model !== "K" ? `Android · ${model.trim()}` : "Android";
  }
  if (/CrOS/.test(ua)) return "Chromebook";
  if (/Macintosh/.test(ua)) return "Mac";
  if (/Windows/.test(ua)) return "Windows PC";
  if (/Linux/.test(ua)) return "Linux computer";
  return "A phone";
}

// The studio owner: the first admin (phones without an owner count as theirs)
export async function studioOwner(env) {
  return (
    (await env.DB.prepare("SELECT id, display_name FROM staff WHERE role = 'admin' AND status = 'active' ORDER BY created_at LIMIT 1")
      .first()
      .catch(() => null)) || null
  );
}

// Every signed-up phone, for choosing who gets a reminder: [{ id, name, staffId, who }]
export async function listPhones(env) {
  const owner = await studioOwner(env);
  const { results } = await env.DB.prepare(
    "SELECT p.endpoint, p.name, p.staff_id, p.created_at, s.display_name FROM push_subscriptions p LEFT JOIN staff s ON s.id = p.staff_id ORDER BY p.created_at"
  ).all();
  const phones = [];
  for (const p of results) {
    const staffId = p.staff_id || owner?.id || "";
    phones.push({ id: await phoneId(p.endpoint), name: p.name || "A phone", staffId, who: p.display_name || owner?.display_name || "", since: p.created_at });
  }
  return phones;
}

// Forget a phone (when it turns notifications off)
export async function forgetPhone(env, endpoint) {
  // Delete that address from the database
  await env.DB.prepare("DELETE FROM push_subscriptions WHERE endpoint = ?").bind(String(endpoint || "")).run();
}

// How long the Alerts tab keeps notifications
const KEEP_ALERTS_DAYS = 90;

// Send one notification to every signed-up phone (or the ones `to` picks: see pickPhones).
// Returns how many it reached.
// `url` is what opens when the notification is tapped. `save: false` keeps it
// out of Portal's Alerts tab (used for test notifications). `appointmentId`
// or `enquiryId` says which booking or enquiry it's about. `style` (optional)
// says how the phone should show it: which Nova app it's from (`source`), what
// kind it is, a `tag` (a newer one replaces an older one with the same tag), how
// long it's worth delivering (`ttl`, in seconds) and whether it's `urgent` (it
// stays on screen until it's answered, with a stronger buzz).
export async function notifyPhones(env, { title, body, url = "/portal/", save = true, appointmentId = null, enquiryId = null, style = null, to = null }) {
  // Keep the text short enough for Apple (it allows about 4,000 characters in all)
  body = String(body).slice(0, 1500);
  // Send it to every phone and count how many Apple accepted it for
  const delivered = await sendToPhones(env, { title, body, url, style, to });
  // Only list it in Portal if it actually went through to a phone
  if (save && delivered > 0) await saveAlert(env, { title, body, url, phones: delivered, appointmentId, enquiryId });
  // Report how many phones it reached
  return delivered;
}

// Write a notification into the Alerts list (a copy of what the phone got, or, with
// phones: 0, something that couldn't reach any phone)
export async function saveAlert(env, { title, body, url, phones, appointmentId = null, enquiryId = null }) {
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
  // Shape each one for the app, saying what kind of alert it is (and which booking)
  return Promise.all(
    results.map(async (n) => ({ ...(await shapeAlert(env, n)), kind: alertKind(n), appointmentId: n.appointment_id || null }))
  );
}

// What an alert is about, for its label in the Alerts tab
export function alertKind(n) {
  // Sent by Nova Agent: its quests, and its own news (an old "Mission: " alert, from before
  // Missions went from Nova, counts as a quest's)
  if (n.title.startsWith("Quest: ") || n.title.startsWith("Mission: ")) return "quest";
  // A test notification
  if (/\btest\b/i.test(n.title)) return "test";
  // A booking (Nova Bot's own booking system; an old alert from Acuity's days is shown the same)
  if (n.appointment_id || /^NovaBot (booked|couldn't book)/.test(n.title)) return "nova-booking";
  if (n.title.startsWith("Nova Agent")) return "agent";
  // A customer's enquiry
  if (n.enquiry_id) return "enquiry";
  // A problem with the booking system (nova/health.js: Google or Stripe; an old one about Acuity)
  if (/^Bookings need attention|can't reach Acuity/i.test(n.title)) return "health";
  return "other";
}

// One alert, with the latest booking or enquiry details
async function shapeAlert(env, n) {
  if (n.appointment_id) return novaAlert(env, n);
  const contact = { name: n.name || null, email: n.email || null, phone: n.phone || null };
  return { id: n.id, created_at: n.created_at, title: n.title, body: n.body, url: n.url, phones: n.phones, contact, email: null };
}

// One alert about a booking, with the booking as it is now (it may have moved, been paid or cancelled since).
// (An old alert from Acuity's days has an Acuity number that's no booking here: it's shown as it was.)
async function novaAlert(env, n) {
  const info = await bookingInfo(env, n.appointment_id).catch(() => null);
  const contact = { name: n.name || info?.name || null, email: n.email || info?.email || null, phone: n.phone || info?.phone || null };
  const now = info ? describeBooking(info) : [];
  const email = info ? { source: "booking", kind: null, at: info.sourceAt, lines: now, same: n.body.includes(now.join("\n")), link: info.link } : null;
  return { id: n.id, created_at: n.created_at, title: n.title, body: n.body, url: n.url, phones: n.phones, contact, email };
}

// Seal and post one notification to every signed-up phone
// Which of the saved phones a message is for. `to` (optional): { phones: [phone ids],
// staff: [staff ids] }. The chosen phones if any of them are still signed up, otherwise
// every phone belonging to those people (a phone with no owner is the studio owner's).
// No `to`: every phone.
async function pickPhones(env, results, to) {
  if (!to) return results;
  const ids = new Set(Array.isArray(to.phones) ? to.phones : []);
  const withIds = await Promise.all(results.map(async (p) => ({ ...p, id: await phoneId(p.endpoint) })));
  const chosen = withIds.filter((p) => ids.has(p.id));
  if (chosen.length) return chosen;
  const people = new Set(Array.isArray(to.staff) ? to.staff : []);
  const owner = (await studioOwner(env))?.id;
  return withIds.filter((p) => people.has(p.staff_id || owner));
}

async function sendToPhones(env, { title, body, url, style, to }) {
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
  const { results: saved } = await env.DB.prepare("SELECT endpoint, p256dh, auth, staff_id FROM push_subscriptions").all();
  // Just the phones it's for (all of them, unless `to` says otherwise)
  const results = await pickPhones(env, saved, to);
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

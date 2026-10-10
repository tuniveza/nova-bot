// Acuity test booking (Portal → Admin → Test booking): checks the booking system customers
// actually use, end to end, without anyone paying.
//
// It books a real appointment in the studio's Acuity, as staff (admin=true: no payment, no
// availability or form rules) with noEmail=true (Acuity emails nobody), named "Nova TEST
// booking", at a free time about four weeks ahead. Then it checks, step by step:
//
//   1. the time was free            (Acuity's availability)
//   2. Acuity has the booking        (read back from Acuity's API)
//   3. payment                       (not part of this test: Acuity takes payment on its own page)
//   4. Acuity told Nova Bot          (the webhook: a row in booking_events)
//   5. the staff alert               (only to the admin's own phones, if they asked; nobody else's)
//   6. Portal's Calendar             (the booking is in Acuity's calendar feed)
//   7. cancelled in Acuity           (by itself once 5 and 6 are done, or after 15 minutes at most)
//   8. Acuity told Nova Bot about the cancellation
//
// Safety: one test at a time; it's skipped by referral tracking and by staff alerts (see
// referrals.js and booking-pings.js); the every-minute timer cancels any test still booked
// after 15 minutes, so a test can never be left in the diary.
//
// Each test is one row in settings ("acuity_test:<appointment id>", JSON), kept for a day.

import { acuity } from "./manage-bookings.js";
import { listBookings } from "./booking-calendar.js";
import { publicUrl } from "./nova/booking.js";

// The name every test booking has in Acuity (and so in its calendar feed and emails)
export const TEST_FIRST_NAME = "Nova";
export const TEST_LAST_NAME = "TEST booking";
export const TEST_NAME = `${TEST_FIRST_NAME} ${TEST_LAST_NAME}`;

const KEY = "acuity_test:";
// Cancelled by then, whatever else has happened
export const CANCEL_AFTER_MS = 15 * 60_000;
// After cancelling, how long to wait for Acuity to tell Nova Bot
const CANCEL_HEARD_MS = 3 * 60_000;
// How long a finished test is kept for the list
const KEEP_MS = 24 * 3600_000;
// How long the run waits for Acuity's webhook before answering
const WEBHOOK_WAIT_MS = 25_000;
const webhookWait = (env) => Number(env.ACUITY_TEST_WAIT_MS ?? WEBHOOK_WAIT_MS);
// Read Acuity's calendar feed at most this often per test
const FEED_EVERY_MS = 20_000;
// Where the quiet slot is looked for: this many days ahead, for up to two weeks
const DAYS_AHEAD = 28;
const DAYS_TO_TRY = 14;
// Cancelling: give up trying by itself after this many failures (and say so)
const CANCEL_TRIES = 3;

export const STEP_LABELS = {
  slot: "Time is free",
  booking: "Booking made in Acuity",
  payment: "Payment",
  webhook: "Acuity told Nova Bot",
  alert: "Staff alert",
  calendar: "Shows in Portal's Calendar",
  cancel: "Cancelled in Acuity",
  cancelHeard: "Acuity told Nova Bot it was cancelled",
};

export const acuityTestReady = (env) => Boolean(env.ACUITY_USER_ID && env.ACUITY_API_KEY);

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
const step = (status, detail = "") => ({ status, detail });

// "17:00", "Wednesday 4 November 17:00": an Acuity time in UK time
const ukClock = (iso) => new Date(iso).toLocaleTimeString("en-GB", { hour: "2-digit", minute: "2-digit", timeZone: "Europe/London" });
const ukWhen = (iso) =>
  new Date(iso).toLocaleString("en-GB", { weekday: "long", day: "numeric", month: "long", hour: "2-digit", minute: "2-digit", timeZone: "Europe/London" });
const ukDate = (ms) => new Date(ms).toLocaleDateString("en-CA", { timeZone: "Europe/London" });

// ===== Saved tests =====

export async function readTest(env, id) {
  const value = await env.DB.prepare("SELECT value FROM settings WHERE key = ?").bind(KEY + Number(id)).first("value");
  try {
    return value ? JSON.parse(value) : null;
  } catch {
    return null;
  }
}

async function saveTest(env, t) {
  await env.DB.prepare("INSERT INTO settings (key, value) VALUES (?, ?) ON CONFLICT (key) DO UPDATE SET value = excluded.value").bind(KEY + t.id, JSON.stringify(t)).run();
}

async function allTests(env) {
  const { results } = await env.DB.prepare("SELECT value FROM settings WHERE key LIKE 'acuity_test:%'").all();
  return results
    .map((r) => {
      try {
        return JSON.parse(r.value);
      } catch {
        return null;
      }
    })
    .filter(Boolean)
    .sort((a, b) => b.madeAt - a.madeAt);
}

// Is Acuity booking #id one of ours? (booking-pings.js and referrals.js ask)
export async function findAcuityTest(env, id) {
  return /^\d{1,15}$/.test(String(id)) ? readTest(env, id) : null;
}

// ===== Sessions and free times (Acuity's API) =====

// The sessions customers can book (active, not private), cheapest first
export async function acuityTestSessions(env) {
  const { ok, data } = await acuity(env, "GET", "/appointment-types");
  if (!ok || !Array.isArray(data)) throw new Error("Acuity's sessions couldn't be read: " + (data?.message || "no answer"));
  return data
    .filter((t) => t.active !== false && !t.private && (!t.type || t.type === "service"))
    .map((t) => ({ id: t.id, name: t.name, price: t.price ? "£" + t.price : "free", duration: t.duration }))
    .sort((a, b) => parseFloat(a.price.slice(1)) - parseFloat(b.price.slice(1)) || 0);
}

// Free start times on a day: [{ value: Acuity's time ("2026-11-04T17:00:00+0000"), label: "17:00" }]
export async function acuityFreeTimes(env, typeId, date) {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(String(date)) || !Number.isInteger(Number(typeId))) return [];
  const { ok, data } = await acuity(env, "GET", `/availability/times?appointmentTypeID=${Number(typeId)}&date=${date}`);
  if (!ok || !Array.isArray(data)) throw new Error("Acuity's free times couldn't be read: " + (data?.message || "no answer"));
  return data.filter((t) => t && t.time).map((t) => ({ value: t.time, label: ukClock(t.time) }));
}

// A quiet time to test with: the last free time on the first day with any, about four weeks ahead
export async function acuityQuietSlot(env, typeId, now = Date.now()) {
  for (let d = 0; d < DAYS_TO_TRY; d++) {
    const date = ukDate(now + (DAYS_AHEAD + d) * 86_400_000);
    const times = await acuityFreeTimes(env, typeId, date);
    if (times.length) return { date, time: times[times.length - 1].value };
  }
  return null;
}

// ===== Running a test =====

// Book it, read it back, and wait (a little) for Acuity to tell Nova Bot.
// admin: the signed-in admin (their email goes on the booking; Acuity doesn't email it)
export async function runAcuityTest(env, admin, { typeId, datetime, alertMe = false }, now = Date.now()) {
  if (!acuityTestReady(env)) return { error: "Acuity's API isn't set up (it needs the ACUITY_USER_ID and ACUITY_API_KEY secrets)." };
  const running = (await allTests(env)).find((t) => !t.cancelledAt);
  if (running) return { error: `Test booking #${running.id} is still in Acuity. It cancels itself within 15 minutes, or press "Cancel it now".`, test: running };
  typeId = Number(typeId);
  datetime = String(datetime || "");

  // 1. The session and time: a real session, and the time still free
  const sessions = await acuityTestSessions(env);
  const session = sessions.find((s) => s.id === typeId);
  if (!session) return { error: "Pick a session first." };
  const free = await acuityFreeTimes(env, typeId, datetime.slice(0, 10));
  if (!free.some((t) => t.value === datetime)) return { error: "That time isn't free in Acuity any more. Pick another." };

  // 2. Book it: as staff (no payment), with no emails from Acuity
  const { ok, data } = await acuity(env, "POST", "/appointments?admin=true&noEmail=true", {
    appointmentTypeID: typeId,
    datetime,
    firstName: TEST_FIRST_NAME,
    lastName: TEST_LAST_NAME,
    email: String(admin.email || ""),
    notes: "Test booking from Portal (Admin → Test booking). Not a customer: it cancels itself within 15 minutes.",
  });
  if (!ok || !data?.id) return { error: `Acuity didn't make the booking: ${data?.message || "no reason given"}.` };

  const t = {
    id: data.id,
    by: admin.id,
    byName: admin.display_name || "",
    alertMe: alertMe === true,
    madeAt: now,
    datetime,
    when: ukWhen(datetime),
    typeId,
    session: session.name,
    cancelTries: 0,
    steps: {
      slot: step("pass", `${ukWhen(datetime)} was free in Acuity.`),
      booking: step("waiting"),
      payment: step("skip", "Not part of this test: bookings made by staff in Acuity don't take payment. Customers pay a deposit on Acuity's own booking page, through Acuity's card payments."),
      webhook: step("waiting", "Waiting for Acuity…"),
      alert: step("waiting", "Waiting for Acuity to tell Nova Bot…"),
      calendar: env.ACUITY_CALENDAR_URL ? step("waiting", "Waiting for Acuity's calendar feed…") : step("skip", "Acuity's calendar feed isn't set up (ACUITY_CALENDAR_URL)."),
      cancel: step("waiting", "Cancels itself once the checks above are done (15 minutes at most)."),
      cancelHeard: step("waiting"),
    },
  };
  // Saved straight away, so the webhook and the alert know it's a test
  await saveTest(env, t);

  // Read it back from Acuity
  const back = await acuity(env, "GET", `/appointments/${t.id}`);
  t.steps.booking =
    back.ok && back.data?.id === t.id
      ? step("pass", `#${t.id}: ${session.name}, ${t.when}, named "${TEST_NAME}". Acuity emailed nobody.`)
      : step("fail", `Acuity said it made #${t.id}, but couldn't find it when asked again.`);
  await saveTest(env, t);

  // Acuity's webhook usually arrives within seconds
  for (let waited = 0; waited < webhookWait(env); waited += 1000) {
    if (await heard(env, t.id, "scheduled")) break;
    await sleep(1000);
  }
  return { test: await checkAcuityTest(env, t.id, { now: Date.now() }) };
}

// Has Acuity told Nova Bot about this change? (its webhook writes a row in booking_events)
async function heard(env, id, action) {
  return env.DB.prepare("SELECT received_at, notified_at FROM booking_events WHERE appointment_id = ? AND action = ? ORDER BY id DESC LIMIT 1")
    .bind(Number(id), action)
    .first();
}

// The alert for a test booking (booking-pings.js): sent only to the admin who ran it, if
// they asked. Saved on its own (not in the test's row, which the page and the timer rewrite)
export async function noteTestAlert(env, id, action, { title, body, delivered, asked }) {
  await env.DB.prepare("INSERT INTO settings (key, value) VALUES (?, ?) ON CONFLICT (key) DO UPDATE SET value = excluded.value")
    .bind(`acuity_test_alert:${Number(id)}:${action}`, JSON.stringify({ title, body, delivered, asked }))
    .run();
}
async function testAlert(env, id, action) {
  const value = await env.DB.prepare("SELECT value FROM settings WHERE key = ?").bind(`acuity_test_alert:${Number(id)}:${action}`).first("value");
  try {
    return value ? JSON.parse(value) : null;
  } catch {
    return null;
  }
}

// Move a test on: check what's arrived, cancel it when it's time. Called by the page (every
// few seconds while it's open) and by the every-minute timer. Returns the test, or null.
export async function checkAcuityTest(env, id, { now = Date.now(), cancelNow = false } = {}) {
  const t = await readTest(env, id);
  if (!t || t.done) return t;
  const s = t.steps;

  // 4. The webhook
  if (s.webhook.status !== "pass") {
    const row = await heard(env, t.id, "scheduled");
    if (row) {
      s.webhook = step("pass", `After ${Math.max(1, Math.round((Date.parse(row.received_at) - t.madeAt) / 1000))} seconds.`);
      // It's in Acuity's calendar feed by now if it's going to be: look straight away
      t.feedAt = 0;
    }
    else if (now - t.madeAt > webhookWait(env))
      s.webhook = step(
        "fail",
        `Acuity hasn't told Nova Bot yet. In Acuity → Integrations → Webhooks (or API → Webhooks), "New appointment" and "Appointment canceled" should go to ${publicUrl(env)}/acuity/webhook?key=… (the ACUITY_WEBHOOK_KEY secret).`
      );
  }
  // 5. The alert (written by noteTestAlert when booking-pings.js sends it; Acuity may be late)
  if (s.alert.status === "waiting" || (s.alert.status === "skip" && !t.cancelledAt)) {
    const a = await testAlert(env, t.id, "scheduled");
    if (a) {
      t.alert = { title: a.title, body: a.body };
      s.alert = a.asked
        ? a.delivered > 0
          ? step("pass", `Sent to your phone${a.delivered === 1 ? "" : "s"} only (${a.delivered}), marked TEST. Nobody else got it.`)
          : step("fail", "It was ready, but none of your phones took it. Turn notifications on in Portal (the bell) and run it again.")
        : step("pass", "Ready and held back: test bookings don't alert anyone. Tick “Send the alert to my phones” to get it.");
    } else if (s.webhook.status === "pass") s.alert = step("waiting", "Waiting for the booking's details (up to 3 minutes)…");
  }
  if (s.alert.status === "waiting" && s.webhook.status === "fail") s.alert = step("skip", "No alert without Acuity telling Nova Bot.");

  // 6. Portal's Calendar (Acuity's calendar feed)
  if (s.calendar.status === "waiting" && now - (t.feedAt || 0) >= FEED_EVERY_MS) {
    t.feedAt = now;
    try {
      const found = ((await listBookings(env)) || []).some((b) => b.id === t.id);
      if (found) s.calendar = step("pass", "It's in Acuity's calendar feed, so Portal's Calendar shows it.");
    } catch (err) {
      s.calendar = step("waiting", "Acuity's calendar feed couldn't be read just now; trying again…");
    }
  }

  // 7. Cancel: once the checks are done, when asked, or after 15 minutes whatever happened
  const settled = (x) => x.status !== "waiting";
  const due = cancelNow || (settled(s.webhook) && settled(s.alert) && settled(s.calendar)) || now - t.madeAt >= CANCEL_AFTER_MS;
  if (!t.cancelledAt && due && t.cancelTries < CANCEL_TRIES) {
    if (now - t.madeAt >= CANCEL_AFTER_MS) {
      if (s.alert.status === "waiting") s.alert = step("fail", "No alert within 15 minutes.");
      if (s.calendar.status === "waiting") s.calendar = step("fail", "Not in Acuity's calendar feed within 15 minutes.");
    }
    const { ok, data } = await acuity(env, "PUT", `/appointments/${t.id}/cancel?admin=true&noEmail=true`, { cancelNote: "Test booking from Portal: cancelled automatically." });
    // Already cancelled (by hand in Acuity, say) counts as cancelled
    const already = /already|cancel+ed/i.test(String(data?.message || ""));
    if (ok || already) {
      t.cancelledAt = now;
      s.cancel = step("pass", cancelNow ? "Cancelled when you asked. Acuity emailed nobody." : "Cancelled by itself. Acuity emailed nobody.");
      s.cancelHeard = step("waiting", "Waiting for Acuity…");
    } else {
      t.cancelTries += 1;
      s.cancel =
        t.cancelTries >= CANCEL_TRIES
          ? step("fail", `Acuity wouldn't cancel it (${data?.message || "no reason given"}). Cancel booking #${t.id} ("${TEST_NAME}") in Acuity by hand.`)
          : step("waiting", `Acuity didn't cancel it yet (${data?.message || "no answer"}); trying again…`);
    }
  }

  // 8. Acuity tells Nova Bot about the cancellation
  if (t.cancelledAt && s.cancelHeard.status === "waiting") {
    if (await heard(env, t.id, "canceled")) s.cancelHeard = step("pass", "Nova Bot heard about the cancellation too.");
    else if (now - t.cancelledAt >= CANCEL_HEARD_MS) s.cancelHeard = step("fail", "Acuity didn't tell Nova Bot about the cancellation within 3 minutes. Check the webhook includes \"Appointment canceled\".");
  }
  if (s.cancel.status === "fail") s.cancelHeard = step("skip", "");

  t.done = Boolean((t.cancelledAt && s.cancelHeard.status !== "waiting") || s.cancel.status === "fail");
  t.ok = Object.values(s).every((x) => x.status === "pass" || x.status === "skip");
  await saveTest(env, t);
  return t;
}

// The page's list (newest first), each checked on the way
export async function listAcuityTests(env, now = Date.now()) {
  const out = [];
  for (const t of await allTests(env)) out.push(t.done ? t : await checkAcuityTest(env, t.id, { now }));
  return out;
}

// Every minute: move running tests on (so they're cancelled even with the page closed),
// and forget finished ones after a day
export async function tidyAcuityTests(env, now = Date.now()) {
  if (!acuityTestReady(env)) return;
  for (const t of await allTests(env)) {
    if (!t.done) await checkAcuityTest(env, t.id, { now });
    else if (now - t.madeAt > KEEP_MS) await env.DB.prepare("DELETE FROM settings WHERE key = ? OR key LIKE ?").bind(KEY + t.id, `acuity_test_alert:${t.id}:%`).run();
  }
}

// The steps in order, for the page
export function stepList(t) {
  return Object.keys(STEP_LABELS).map((key) => ({ key, label: STEP_LABELS[key], ...t.steps[key] }));
}

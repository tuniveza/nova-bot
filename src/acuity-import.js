// Carrying Acuity's bookings over to Nova's own booking system (a one-off, safe to run again)
//
// REMOVE THIS FILE once the switch is done and every future Acuity booking is in Nova
// (Portal → Admin → Booking system → "Bring Acuity's bookings over" shows nothing left to do).
//
//   GET  /admin/import-acuity         a dry run: every future booking in Acuity's calendar feed and
//                                     what would happen to it (nothing changes). ?format=json for data.
//   POST /admin/import-acuity         does it (admins, from that page: the Origin check in admin.js)
//
// Each future booking in Acuity's private calendar feed (ACUITY_CALENDAR_URL) becomes a Nova booking
// (the bookings table and the studio's Google Calendar), through the same booking engine as every
// other booking (nova/bookings.js createBooking), with these edges:
//   - nobody is emailed: no confirmation, and no day-before reminder later either (reminded_at is
//     set), because Acuity already sent the client theirs. Staff phones aren't pinged.
//   - nothing is charged: paid_pence stays 0. Anything the client paid in Acuity isn't in the feed,
//     so the notes say to check it.
//   - it's kept even if it overlaps another booking (it already exists in Acuity).
//   - name, email, phone, session, time, price and the booking-form answers come from the feed; the
//     session is matched to one of the studio's sessions (nova/studio.js) by name where it can be,
//     and its time is always the feed's.
//   - source 'acuity' and sender 'acuity:<Acuity's booking number>': that's how a second run knows
//     it's already been brought over (and the client list matches it to the client's Acuity history).
//   - Acuity's own test bookings ("Nova TEST booking") are left out.
// It does at most MAX_PER_RUN bookings per press (Google takes a moment per booking); press again
// for the rest.

import { feedTimeToIso, listBookings } from "./booking-calendar.js";
import { createBooking } from "./nova/bookings.js";
import { googleReady } from "./nova/google.js";
import { SESSION_TYPES, money, msToUk, pence, whenInWords } from "./nova/studio.js";

// The name every Acuity test booking had (src/acuity-test-booking.js): never carried over
export const ACUITY_TEST_NAME = "Nova TEST booking";
// How bookings brought over are marked (bookings.source, and bookings.sender = "acuity:<number>")
export const IMPORT_SOURCE = "acuity";
export const importKey = (acuityId) => `acuity:${acuityId}`;
// Acuity's number for a booking brought over, or null
export function acuityIdOf(b) {
  const m = String(b?.sender || "").match(/^acuity:(\d{1,15})$/);
  return b?.source === IMPORT_SOURCE && m ? Number(m[1]) : null;
}

const MAX_PER_RUN = 25;
const LOCK_KEY = "acuity_import_running";
const LOCK_MS = 5 * 60_000;

// "£60.00", "60", "60.00 GBP" -> pence, or null
function feedPrice(value) {
  const m = String(value || "").replace(/,/g, "").match(/(\d+(?:\.\d{1,2})?)/);
  return m ? pence(m[1]) : null;
}

const squash = (s) => String(s || "").toLowerCase().replace(/[–—]/g, "-").replace(/\s+/g, " ").trim();

// The studio's session with this name (exactly, then by the start of the name), or null
export function matchSessionType(name) {
  const want = squash(name);
  if (!want) return null;
  return (
    SESSION_TYPES.find((t) => squash(t.name) === want) ||
    SESSION_TYPES.find((t) => squash(t.name).startsWith(want) || want.startsWith(squash(t.name))) ||
    SESSION_TYPES.find((t) => squash(t.name.replace(/\s*\(.*\)\s*$/, "")) === want.replace(/\s*\(.*\)\s*$/, "")) ||
    null
  );
}

// "Eric Test" -> { firstName: "Eric", lastName: "Test" }
function splitName(name) {
  const parts = String(name || "").trim().split(/\s+/).filter(Boolean);
  if (!parts.length) return { firstName: "Acuity client", lastName: "" };
  return { firstName: parts[0].slice(0, 60), lastName: parts.slice(1).join(" ").slice(0, 60) };
}

// One feed booking -> what it becomes in Nova (or why it's skipped)
function planOne(raw, now) {
  const start = feedTimeToIso(raw.start);
  const end = feedTimeToIso(raw.end);
  const base = { acuityId: Number(raw.id), name: raw.name || "", email: raw.email || "", phone: raw.phone || "", session: raw.session || "", start, end, price: raw.price || "" };
  if (!start || !end || Date.parse(end) <= Date.parse(start)) return { ...base, action: "skip", reason: "Its time couldn't be read from Acuity's feed." };
  if (Date.parse(start) <= now) return null; // started already: not a future booking
  if (raw.name === ACUITY_TEST_NAME) return { ...base, action: "skip", reason: "An Acuity test booking." };
  const type = matchSessionType(raw.session);
  const minutes = Math.round((Date.parse(end) - Date.parse(start)) / 60_000);
  const pricePence = feedPrice(raw.price) ?? (type ? pence(type.price) : 0);
  const notes = [
    `Brought over from Acuity (Acuity booking #${raw.id}). Anything paid in Acuity isn't shown here: check Acuity before asking for money.`,
    ...(Array.isArray(raw.extra) ? raw.extra.map(([label, value]) => `${label}: ${value}`) : []),
  ].join("\n").slice(0, 2000);
  return {
    ...base,
    action: "import",
    typeId: type ? type.id : null,
    typeMatched: Boolean(type),
    sessionName: type ? type.name : raw.session || "Session",
    minutes,
    changeover: type ? type.changeover || 0 : 0,
    pricePence,
    notes,
    when: whenInWords(start, end),
    reason: type ? "" : "No matching session in Nova: it keeps Acuity's name, price and length.",
  };
}

// Every future Acuity booking and what would happen to it. Changes nothing.
// -> { ready, problem?, items: [...], counts: { import, already, skip } }
export async function planAcuityImport(env, now = Date.now()) {
  if (!env.ACUITY_CALENDAR_URL) return { ready: false, problem: "Acuity's calendar feed isn't set up (ACUITY_CALENDAR_URL), so there's nothing to read.", items: [], counts: { import: 0, already: 0, skip: 0 } };
  let feed;
  try {
    feed = (await listBookings(env)) || [];
  } catch (err) {
    return { ready: false, problem: `Acuity's calendar feed couldn't be read (${String(err?.message || err).slice(0, 120)}).`, items: [], counts: { import: 0, already: 0, skip: 0 } };
  }
  const items = feed.map((raw) => planOne(raw, now)).filter(Boolean);
  // Already brought over: by Acuity's number
  const keys = items.map((i) => importKey(i.acuityId));
  const done = new Map();
  for (let i = 0; i < keys.length; i += 50) {
    const chunk = keys.slice(i, i + 50);
    const { results } = await env.DB.prepare(`SELECT id, sender FROM bookings WHERE sender IN (${chunk.map(() => "?").join(", ")})`).bind(...chunk).all();
    for (const r of results) done.set(r.sender, r.id);
  }
  for (const item of items) {
    const id = done.get(importKey(item.acuityId));
    if (id && item.action === "import") Object.assign(item, { action: "already", bookingId: id, reason: `Already in Nova as booking #${id}.` });
  }
  items.sort((a, b) => String(a.start).localeCompare(String(b.start)));
  const counts = { import: 0, already: 0, skip: 0 };
  for (const item of items) counts[item.action]++;
  const ready = await googleReady(env).catch(() => false);
  return { ready, problem: ready ? "" : "Google Calendar isn't connected, so bookings can't go into it yet (Portal → Admin → Google).", items, counts };
}

// Bring them over (up to MAX_PER_RUN). -> { ok, message, imported: [{ acuityId, bookingId }], failed: [...], left }
export async function runAcuityImport(env, now = Date.now(), { limit = MAX_PER_RUN } = {}) {
  const plan = await planAcuityImport(env, now);
  if (plan.problem) return { ok: false, message: plan.problem, imported: [], failed: [], left: plan.counts.import };
  // One run at a time (two presses at once would bring the same booking over twice)
  const stamp = new Date(now).toISOString();
  const { meta } = await env.DB.prepare(
    "INSERT INTO settings (key, value) VALUES (?1, ?2) ON CONFLICT (key) DO UPDATE SET value = excluded.value WHERE settings.value < ?3"
  )
    .bind(LOCK_KEY, stamp, new Date(now - LOCK_MS).toISOString())
    .run();
  if (!meta.changes) return { ok: false, message: "It's already running. Wait a minute, then look again.", imported: [], failed: [], left: plan.counts.import };
  const imported = [];
  const failed = [];
  try {
    const todo = plan.items.filter((i) => i.action === "import");
    for (const item of todo.slice(0, limit)) {
      // Brought over a moment ago by something else? (checked again just before each one)
      const there = await env.DB.prepare("SELECT id FROM bookings WHERE sender = ?").bind(importKey(item.acuityId)).first("id");
      if (there) continue;
      const { date, time } = msToUk(Date.parse(item.start));
      const type = { id: item.typeId, name: item.sessionName, duration: item.minutes, changeover: item.changeover };
      const person = { ...splitName(item.name), email: item.email || "", phone: item.phone || null };
      const made = await createBooking(env, {
        type,
        date,
        time,
        person,
        source: IMPORT_SOURCE,
        status: "booked",
        notes: item.notes,
        sender: importKey(item.acuityId),
        pricePence: item.pricePence,
        skipCheck: true,
        keepOnClash: true,
      });
      if (made.problem) {
        failed.push({ acuityId: item.acuityId, problem: made.problem });
        continue;
      }
      // No day-before reminder from Nova: Acuity already told the client about it
      await env.DB.prepare("UPDATE bookings SET reminded_at = ? WHERE id = ?").bind(stamp, made.booking.id).run();
      imported.push({ acuityId: item.acuityId, bookingId: made.booking.id });
    }
    const left = todo.length - imported.length - failed.length;
    const message = [
      imported.length ? `Brought over ${imported.length} booking${imported.length === 1 ? "" : "s"}.` : "Nothing new to bring over.",
      failed.length ? `${failed.length} didn't go in: ${failed[0].problem}` : "",
      left > 0 ? `${left} still to do: press Bring them over again.` : "",
      "No one was emailed and nothing was charged.",
    ].filter(Boolean).join(" ");
    console.log(`Acuity import: ${imported.length} brought over, ${failed.length} failed, ${left} left.`);
    return { ok: failed.length === 0, message, imported, failed, left: Math.max(0, left) };
  } finally {
    await env.DB.prepare("DELETE FROM settings WHERE key = ?").bind(LOCK_KEY).run().catch(() => {});
  }
}

// ===== THE ADMIN PAGE (admin.js routes here) =====

export async function handleAcuityImport(request, env, url, { page, back, escapeHtml: e }) {
  if (request.method === "POST") {
    const result = await runAcuityImport(env);
    return back(result.message, "/admin/import-acuity");
  }
  const plan = await planAcuityImport(env);
  if (url.searchParams.get("format") === "json") {
    return new Response(JSON.stringify(plan), { headers: { "Content-Type": "application/json", "Cache-Control": "no-store" } });
  }
  const what = { import: "Will be brought over", already: "Already in Nova", skip: "Left out" };
  const rows = plan.items
    .map(
      (i) => `<tr>
        <td>${e(i.when || i.start || "")}</td>
        <td>${e(i.name)}${i.email ? `<br><span class="dim small">${e(i.email)}</span>` : ""}</td>
        <td>${e(i.sessionName || i.session)}${i.action === "import" && !i.typeMatched ? ' <span class="warn small">(not a Nova session)</span>' : ""}</td>
        <td>${i.pricePence != null ? e(money(i.pricePence)) : e(i.price)}</td>
        <td>${e(what[i.action])}${i.bookingId ? ` (#${i.bookingId})` : ""}${i.reason ? `<br><span class="dim small">${e(i.reason)}</span>` : ""}</td>
      </tr>`
    )
    .join("");
  const body = `
  <h2>Bring Acuity's bookings over</h2>
  <div class="card">
    <p>Every future booking in Acuity goes into Nova's own booking system and the studio's Google Calendar.</p>
    <p class="dim small">No one is emailed. Nothing is charged. Safe to press again: a booking already brought over is skipped.</p>
    ${plan.problem ? `<p class="warn">${e(plan.problem)}</p>` : ""}
    <p>${plan.counts.import} to bring over · ${plan.counts.already} already in Nova · ${plan.counts.skip} left out</p>
    ${
      !plan.problem && plan.counts.import
        ? `<form method="post" action="/admin/import-acuity" onsubmit="return confirm('Bring ${plan.counts.import} booking(s) over from Acuity? No one is emailed.')"><button class="btn">Bring them over</button></form>`
        : ""
    }
  </div>
  <div class="card">
    <table>
      <thead><tr><th>When</th><th>Client</th><th>Session</th><th>Price</th><th>What happens</th></tr></thead>
      <tbody>${rows || '<tr><td colspan="5" class="dim">No future bookings in Acuity.</td></tr>'}</tbody>
    </table>
  </div>`;
  return page(env, "Booking system", url, body);
}


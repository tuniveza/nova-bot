// Nova Club (the members' Android app) showing when the studio is booked,
// straight from the studio's Google Calendar, within a second or two of anything
// changing.
//
//   GET /club/busy?from=2026-10-01&until=2026-11-01
//     -> { busy: [[start, end], ...], cancelled: [[start, end], ...] }
//
// Times are milliseconds since 1970. `busy` is every booking and blocked-off
// time (each booking including the changeover kept free after it); `cancelled`
// is times that just came free (bookings cancelled or moved), so the app can stop
// showing them straight away. No names or details are sent, only times, because
// anyone with the app can call this.
//
// The app checks every second or so. So we don't ask Google that often, the
// answer is kept in the club_calendar table and reused until a booking changes
// (calendarChanged, called by bookings.js), or for a minute at most, in case staff
// changed something in Google Calendar by hand.

import { blocksTime, eventSpan } from "./booking.js";
import { googleReady, listEvents, offline } from "./google.js";
import { ukToMs } from "./studio.js";

// Ask Google again after this long even if nothing changed here
const FRESH_MS = 60_000;
// The most days one request may cover (the app asks for one month at a time)
const MAX_DAYS = 70;
// Copies older than this are tidied away
const KEEP_MS = 24 * 60 * 60 * 1000;
// How long a time that's just come free (cancelled or moved) is reported as cancelled
const FREED_MS = 60 * 60 * 1000;
// After Google can't be reached, wait this long before trying again
const RETRY_MS = 10_000;
const DATE_PATTERN = /^\d{4}-\d{2}-\d{2}$/;

// When Google last couldn't be reached (by this copy of the Worker)
let lastFailure = 0;

// GET /club/busy
export async function handleClubBusy(request, env) {
  if (request.method !== "GET") return reply({ error: "Method not allowed" }, 405);
  // One phone can't run up the bill (limit set in wrangler.jsonc)
  if (await tooMany(env.CLUB_LIMIT, request.headers.get("CF-Connecting-IP"))) return reply({ error: "Too many requests" }, 429);

  const params = new URL(request.url).searchParams;
  const from = params.get("from") || "";
  const until = params.get("until") || "";
  const days = (Date.parse(until) - Date.parse(from)) / 86_400_000;
  if (!DATE_PATTERN.test(from) || !DATE_PATTERN.test(until) || !(days >= 1 && days <= MAX_DAYS)) {
    return reply({ error: "Give from and until as YYYY-MM-DD, up to 70 days apart" }, 400);
  }
  if (!(await googleReady(env))) return reply({ error: "The studio calendar isn't connected" }, 503);

  const span = `${from}..${until}`;
  const saved = await env.DB.prepare(
    "SELECT busy, fetched_at, (SELECT fetched_at FROM club_calendar WHERE span = 'changed') AS changed FROM club_calendar WHERE span = ?"
  )
    .bind(span)
    .first();
  const now = Date.now();
  // Still good: made after the last change, and not too old
  if (saved && saved.fetched_at > (saved.changed || 0) && now - saved.fetched_at < FRESH_MS) return reply(saved.busy);

  const unreachable = () => (saved ? reply(saved.busy) : reply({ error: "Couldn't reach the studio calendar" }, 502));
  if (now - lastFailure < RETRY_MS) return unreachable();
  const busy = await readCalendar(env, from, until);
  if (!busy) {
    lastFailure = now;
    return unreachable();
  }
  // Times busy in our last copy and not now have just come free: report them as cancelled for an hour
  const before = saved ? JSON.parse(saved.busy) : {};
  const stillBusy = new Set(busy.map(String));
  const freed = [
    ...(before.freed || []).filter(([start, end, at]) => now - at < FREED_MS && !stillBusy.has(String([start, end]))),
    ...(before.busy || []).filter((b) => !stillBusy.has(String(b))).map(([start, end]) => [start, end, now]),
  ];
  const body = JSON.stringify({ busy, cancelled: freed.map(([start, end]) => [start, end]), freed });
  await env.DB.prepare(
    "INSERT INTO club_calendar (span, fetched_at, busy) VALUES (?, ?, ?) ON CONFLICT (span) DO UPDATE SET fetched_at = excluded.fetched_at, busy = excluded.busy"
  )
    .bind(span, now, body)
    .run();
  return reply(body);
}

// A booking was made, moved, changed or cancelled: every saved copy is now out of date
export async function calendarChanged(env) {
  const now = Date.now();
  await env.DB.batch([
    env.DB.prepare(
      "INSERT INTO club_calendar (span, fetched_at, busy) VALUES ('changed', ?, NULL) ON CONFLICT (span) DO UPDATE SET fetched_at = excluded.fetched_at"
    ).bind(now),
    env.DB.prepare("DELETE FROM club_calendar WHERE span != 'changed' AND fetched_at < ?").bind(now - KEEP_MS),
  ]);
}

// Every busy time from the start of `from` up to (not including) `until`, or null if Google couldn't be read
async function readCalendar(env, from, until) {
  const first = ukToMs(from);
  const last = ukToMs(until);
  try {
    const times = [];
    // Our bookings, each with its changeover (which a calendar event doesn't show)
    const { results } = await env.DB.prepare(
      "SELECT starts_at, ends_at, changeover, event_id FROM bookings WHERE status IN ('hold', 'booked') AND starts_at < ? AND ends_at > ?"
    )
      .bind(new Date(last).toISOString(), new Date(first - 86_400_000).toISOString())
      .all();
    const ours = new Set();
    for (const b of results) {
      if (b.event_id) ours.add(b.event_id);
      times.push([Date.parse(b.starts_at), Date.parse(b.ends_at) + (b.changeover || 0) * 60_000]);
    }
    if (!offline(env)) {
      for (const e of await listEvents(env, first, last, { max: 1000 })) {
        if (ours.has(e.id) || !blocksTime(e)) continue;
        const span = eventSpan(e);
        if (span) times.push(span);
      }
    }
    return times.filter(([start, end]) => start < last && end > first).sort((a, b) => a[0] - b[0] || a[1] - b[1]);
  } catch (err) {
    console.log("Couldn't read the studio calendar (Nova Club):", err);
    return null;
  }
}

function reply(body, status = 200) {
  return new Response(typeof body === "string" ? body : JSON.stringify(body), {
    status,
    headers: { "Content-Type": "application/json", "Cache-Control": "no-store" },
  });
}

async function tooMany(limiter, ip) {
  if (!limiter || !ip) return false;
  try {
    return !(await limiter.limit({ key: ip })).success;
  } catch (err) {
    console.log("Rate limit check failed:", err);
    return false;
  }
}

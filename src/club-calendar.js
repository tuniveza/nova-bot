// Nova Club (the members' Android app) showing when the studio is booked,
// straight from Acuity's private calendar feed (the link under Acuity → Sync
// with Other Calendars, saved as ACUITY_CALENDAR_URL; no API key needed),
// within a second or two of anything changing.
//
//   GET /club/busy?from=2026-10-01&until=2026-11-01
//     -> { busy: [[start, end], ...], cancelled: [[start, end], ...] }
//
// Times are milliseconds since 1970. `busy` is every booking and blocked-off
// time; `cancelled` is times that just came free (bookings cancelled or
// moved), so the app can ignore them in Google Calendar before Acuity's Google
// sync catches up. No names or details are sent, only times, because anyone
// with the app can call this.
//
// The app checks every second or so. So we don't read the feed that often, the
// answer is kept in the club_calendar table and reused until Acuity's webhook
// says a booking changed (calendarChanged, called from referrals.js), or for a
// minute at most in case a webhook goes missing. New bookings are in the feed
// within about half a second of the webhook.

// Read the feed again after this long even if no webhook has come
const FRESH_MS = 60_000;
// The most days one request may cover (the app asks for one month at a time)
const MAX_DAYS = 70;
// Copies older than this are tidied away
const KEEP_MS = 24 * 60 * 60 * 1000;
// How long a time that's just come free (cancelled or moved) is reported as cancelled
const FREED_MS = 60 * 60 * 1000;
// After the feed can't be read, wait this long before trying again
const RETRY_MS = 10_000;
const DATE_PATTERN = /^\d{4}-\d{2}-\d{2}$/;

// When the feed last couldn't be read (by this copy of the Worker)
let lastFailure = 0;

// GET /club/busy
export async function handleClubBusy(request, env) {
  // Only reading is allowed
  if (request.method !== "GET") return reply({ error: "Method not allowed" }, 405);
  // One phone can't run up the bill (limit set in wrangler.jsonc)
  if (await tooMany(env.CLUB_LIMIT, request.headers.get("CF-Connecting-IP"))) return reply({ error: "Too many requests" }, 429);

  // Which dates: from the start of `from` up to (not including) `until`
  const params = new URL(request.url).searchParams;
  const from = params.get("from") || "";
  const until = params.get("until") || "";
  const days = (Date.parse(until) - Date.parse(from)) / 86_400_000;
  if (!DATE_PATTERN.test(from) || !DATE_PATTERN.test(until) || !(days >= 1 && days <= MAX_DAYS)) {
    return reply({ error: "Give from and until as YYYY-MM-DD, up to 70 days apart" }, 400);
  }
  if (!env.ACUITY_CALENDAR_URL) return reply({ error: "The studio calendar isn't connected" }, 503);

  // The copy we have, and when Acuity last said something changed
  const span = `${from}..${until}`;
  const saved = await env.DB.prepare(
    "SELECT busy, fetched_at, (SELECT fetched_at FROM club_calendar WHERE span = 'changed') AS changed FROM club_calendar WHERE span = ?"
  )
    .bind(span)
    .first();
  const now = Date.now();
  // Still good: made after the last change, and not too old
  if (saved && saved.fetched_at > (saved.changed || 0) && now - saved.fetched_at < FRESH_MS) return reply(saved.busy);

  // Just failed: don't try again straight away (the app checks every second)
  const unreachable = () => (saved ? reply(saved.busy) : reply({ error: "Couldn't reach the studio calendar" }, 502));
  if (now - lastFailure < RETRY_MS) return unreachable();
  // Read the feed. The copy is stamped with when we started reading, so a
  // change that lands while we're reading still counts as newer than this copy.
  const busy = await readFeed(env, from, until);
  // Can't be read: the last copy is better than nothing
  if (!busy) {
    lastFailure = now;
    return unreachable();
  }
  // A cancelled or moved booking just leaves the feed, but its old time stays
  // in Google Calendar until Acuity's sync catches up. So times that were busy
  // in our last copy and aren't now count as cancelled for an hour.
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

// Acuity's webhook says a booking was made, moved, changed or cancelled:
// every saved copy is now out of date
export async function calendarChanged(env) {
  const now = Date.now();
  await env.DB.batch([
    env.DB.prepare(
      "INSERT INTO club_calendar (span, fetched_at, busy) VALUES ('changed', ?, NULL) ON CONFLICT (span) DO UPDATE SET fetched_at = excluded.fetched_at"
    ).bind(now),
    // Tidy away old copies while we're here
    env.DB.prepare("DELETE FROM club_calendar WHERE span != 'changed' AND fetched_at < ?").bind(now - KEEP_MS),
  ]);
}

// Every booking and blocked-off time from the start of `from` up to (not
// including) `until`, from Acuity's calendar feed, or null if it couldn't be read
async function readFeed(env, from, until) {
  try {
    // Never a stored copy: it must be up to date
    const res = await fetch(env.ACUITY_CALENDAR_URL, { cache: "no-store", signal: AbortSignal.timeout(8000) });
    if (!res.ok) {
      console.log(`Acuity calendar feed answered ${res.status} (Nova Club calendar)`);
      return null;
    }
    const first = londonMidnight(from);
    const last = londonMidnight(until);
    return feedTimes(await res.text()).filter(([start, end]) => start < last && end > first);
  } catch (err) {
    console.log("Couldn't read the Acuity calendar feed (Nova Club calendar):", err);
    return null;
  }
}

// Every event's start and end in the feed (iCalendar format), in milliseconds:
// bookings and blocked-off time alike
export function feedTimes(ics) {
  // Long lines are folded onto the next line starting with a space: join them back up
  const text = String(ics).replace(/\r\n/g, "\n").replace(/\n[ \t]/g, "");
  const times = [];
  for (const block of text.split("BEGIN:VEVENT").slice(1)) {
    const body = block.split("END:VEVENT")[0];
    if (/^STATUS:CANCELLED/m.test(body)) continue;
    const start = feedTime(body, "DTSTART");
    const end = feedTime(body, "DTEND");
    if (Number.isFinite(start) && Number.isFinite(end) && end > start) times.push([start, end]);
  }
  return times;
}

// One of an event's times: "20261022T131500Z" (UTC), "20261022T141500" (UK
// time, often marked TZID=Europe/London) or "20261022" (a whole day)
function feedTime(body, name) {
  const m = body.match(new RegExp(`^${name}(?:;[^:\\n]*)?:(\\d{4})(\\d{2})(\\d{2})(?:T(\\d{2})(\\d{2})(\\d{2})?(Z?))?`, "m"));
  if (!m) return NaN;
  const [, y, mo, d, h, mi, sec, z] = m;
  if (h === undefined) return londonMidnight(`${y}-${mo}-${d}`);
  const wall = Date.UTC(+y, +mo - 1, +d, +h, +mi, +(sec || 0));
  return z ? wall : wall - londonOffset(wall);
}

// Midnight at the start of a day ("2026-10-22"), UK time, in milliseconds
function londonMidnight(ymd) {
  const wall = Date.parse(ymd + "T00:00:00Z");
  return wall - londonOffset(wall);
}

// How far UK time is ahead of UTC around this moment (nothing, or an hour in summer)
function londonOffset(ms) {
  const parts = Object.fromEntries(
    new Intl.DateTimeFormat("en-GB", { timeZone: "Europe/London", hourCycle: "h23", year: "numeric", month: "2-digit", day: "2-digit", hour: "2-digit", minute: "2-digit" })
      .formatToParts(new Date(ms))
      .map((p) => [p.type, p.value])
  );
  return Date.UTC(+parts.year, +parts.month - 1, +parts.day, +parts.hour, +parts.minute) - Math.floor(ms / 60_000) * 60_000;
}

// The answer, as JSON, never cached on the way (it changes from second to second)
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

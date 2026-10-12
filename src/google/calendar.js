// Google Calendar ⇄ Nova's Calendar, both ways (Portal → Admin → Google → Calendar)
//
//   Nova → Google   Nova's events and day cards go into a calendar of their own in the studio's
//                   Google account, "Novacane Studio" (made on the first sync). Nova Agent's plan
//                   (quests, music time) too, if that's switched on. Acuity's bookings are copied
//                   in as well (read-only copies: bookings are made and changed in Acuity).
//   Google → Nova   events from the studio's own Google Calendar ("primary") and anything added
//                   straight into the Novacane Studio calendar come into Nova's Calendar (ids
//                   "gp-…" and "g-…"), and so count as busy time for quests on the PC.
//   Both ways       a change or a deletion on either side is made on the other. The change made
//                   last wins, as everywhere in Nova's Calendar.
//
// Nothing books, moves or cancels a booking from here: bookings only ever go Acuity → Google.
//
// How it keeps track: google_links ('event': a Nova item ⇄ a Google event, with the hash of what
// was last synced, so an unchanged event isn't sent again and our own writes aren't echoed back),
// Google's sync tokens (only what changed since last time is read), and the calendar's revision
// number (only Nova items changed since last time are sent). Each run does a limited number of
// Google calls (the free Workers plan allows 50 per run) and carries on where it stopped next time.
//
// Times: Nova's Calendar keeps UK wall-clock times ("2026-10-12T17:00"); Google is told they're
// Europe/London. All-day events: Nova's "T00:00"–"T23:59" ⇄ Google's dates (its end date is the
// day after).

import { google } from "../nova/google.js";
import { cleanItem, deleteItem, isAgentItem, saveItem } from "../calendar/items.js";
import { listBookings, feedTimeToIso } from "../booking-calendar.js";
import { dropLink, getLink, linkByGoogle, partOn, putLink, readSetting, sha, writeSetting } from "./common.js";

const API = "https://www.googleapis.com/calendar/v3";
const TZ = "Europe/London";
const STUDIO_KEY = "google_studio_calendar";
const REV_KEY = "google_cal_rev";
const syncKey = (which) => `google_cal_sync_${which}`;
const pageKey = (which) => `google_cal_page_${which}`;
const PULL_BACK_DAYS = 30; // the first pull reads from this long ago
const BOOKING_DAYS = 60; // bookings copied this far ahead

// Nova's colours ⇄ Google's event colours
const COLOR_IDS = { rose: "4", violet: "3", blue: "9", teal: "7", green: "10", amber: "5", orange: "6", red: "11", grey: "8" };
const COLOR_NAMES = Object.fromEntries(Object.entries(COLOR_IDS).map(([k, v]) => [v, k]));

// ===== TIMES =====

const pad = (n) => String(n).padStart(2, "0");
// UTC instant -> UK wall clock "YYYY-MM-DDTHH:MM"
export function ukWall(iso) {
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return null;
  const parts = new Intl.DateTimeFormat("en-GB", { timeZone: TZ, year: "numeric", month: "2-digit", day: "2-digit", hour: "2-digit", minute: "2-digit", hourCycle: "h23" }).formatToParts(d);
  const get = (t) => parts.find((p) => p.type === t)?.value ?? "00";
  return `${get("year")}-${get("month")}-${get("day")}T${get("hour")}:${get("minute")}`;
}
export function addDays(date, n) {
  const t = new Date(Date.parse(date + "T00:00:00Z") + n * 86400000);
  return `${t.getUTCFullYear()}-${pad(t.getUTCMonth() + 1)}-${pad(t.getUTCDate())}`;
}
function addMinutes(stamp, n) {
  const t = new Date(Date.parse(stamp + ":00Z") + n * 60000);
  return t.toISOString().slice(0, 16);
}

// ===== REPEATS: Nova's { freq, interval, byDay, until, count } ⇄ an RRULE =====

const DAYS = ["SU", "MO", "TU", "WE", "TH", "FR", "SA"];
export function toRecurrence(item) {
  const r = item.repeat;
  if (!r) return undefined;
  const parts = [`FREQ=${r.freq.toUpperCase()}`];
  if (r.interval && r.interval > 1) parts.push(`INTERVAL=${r.interval}`);
  if (r.freq === "weekly" && r.byDay?.length) parts.push(`BYDAY=${r.byDay.map((d) => DAYS[d]).join(",")}`);
  if (r.until) parts.push(`UNTIL=${r.until.replace(/-/g, "")}${item.allDay ? "" : "T235959Z"}`);
  else if (r.count) parts.push(`COUNT=${r.count}`);
  const lines = [`RRULE:${parts.join(";")}`];
  const time = item.start.slice(11, 16).replace(":", "") + "00";
  for (const d of item.exdates || []) lines.push(item.allDay ? `EXDATE;VALUE=DATE:${d.replace(/-/g, "")}` : `EXDATE;TZID=${TZ}:${d.replace(/-/g, "")}T${time}`);
  return lines;
}
export function fromRecurrence(lines) {
  if (!Array.isArray(lines)) return {};
  let repeat = null;
  const exdates = [];
  for (const line of lines) {
    if (line.startsWith("RRULE:")) {
      const f = Object.fromEntries(line.slice(6).split(";").map((p) => p.split("=")));
      const freq = String(f.FREQ || "").toLowerCase();
      if (!["daily", "weekly", "monthly", "yearly"].includes(freq)) continue;
      repeat = { freq, interval: Number(f.INTERVAL) || 1 };
      if (freq === "weekly" && f.BYDAY) {
        const days = f.BYDAY.split(",").map((d) => DAYS.indexOf(d.replace(/^[+-]?\d+/, ""))).filter((d) => d >= 0);
        if (days.length) repeat.byDay = days;
      }
      if (f.UNTIL) repeat.until = `${f.UNTIL.slice(0, 4)}-${f.UNTIL.slice(4, 6)}-${f.UNTIL.slice(6, 8)}`;
      else if (f.COUNT) repeat.count = Number(f.COUNT);
    } else if (line.startsWith("EXDATE")) {
      for (const v of line.split(":")[1]?.split(",") || []) if (/^\d{8}/.test(v)) exdates.push(`${v.slice(0, 4)}-${v.slice(4, 6)}-${v.slice(6, 8)}`);
    }
  }
  return repeat ? { repeat, exdates } : {};
}

// ===== NOVA ITEM ⇄ GOOGLE EVENT =====

// What counts as "the same event" on both sides (a hash of it stops echoes and repeats). Taken
// from the item as Nova keeps it (cleanItem), so an item and its saved copy hash the same.
export function itemHash(raw) {
  const item = cleanItem(raw) || raw;
  const r = item.kind === "day"
    ? ["day", item.date, item.title || item.preset || "", item.info || "", item.location || ""]
    : ["event", item.title || "", item.body || "", item.start, item.end, Boolean(item.allDay), item.location || "", item.color || "", item.repeat || null, item.exdates || []];
  return sha(JSON.stringify(r));
}

// A Nova item as a Google event
export function toEvent(item) {
  const base = { extendedProperties: { private: { novaId: item.id } } };
  if (item.kind === "day") {
    return { ...base, summary: item.title || "Day", description: item.info || "", location: item.location || "", start: { date: item.date }, end: { date: addDays(item.date, 1) }, transparency: "transparent" };
  }
  let end = item.end > item.start ? item.end : addMinutes(item.start, 30);
  const event = { ...base, summary: item.title || "(no title)", description: item.body || "", location: item.location || "" };
  if (item.allDay) {
    event.start = { date: item.start.slice(0, 10) };
    event.end = { date: addDays(end.slice(0, 10), 1) };
  } else {
    event.start = { dateTime: `${item.start}:00`, timeZone: TZ };
    event.end = { dateTime: `${end}:00`, timeZone: TZ };
  }
  if (item.color && COLOR_IDS[item.color]) event.colorId = COLOR_IDS[item.color];
  const recurrence = toRecurrence(item);
  event.recurrence = recurrence || [];
  return event;
}

// A Google event as a Nova item (null if it can't be one). `id` is the Nova id it's kept under.
export function fromEvent(event, id) {
  let start, end, allDay = false;
  if (event.start?.date) {
    allDay = true;
    start = `${event.start.date}T00:00`;
    const last = event.end?.date ? addDays(event.end.date, -1) : event.start.date;
    end = `${last < event.start.date ? event.start.date : last}T23:59`;
  } else if (event.start?.dateTime) {
    start = ukWall(event.start.dateTime);
    end = ukWall(event.end?.dateTime || event.start.dateTime) || start;
  }
  if (!start) return null;
  const item = {
    kind: "event",
    id,
    title: String(event.summary || "(no title)").slice(0, 120),
    body: String(event.description || "").replace(/<br\s*\/?>/gi, "\n").replace(/<[^>]+>/g, "").slice(0, 5000),
    author: "Google Calendar",
    start,
    end: end < start ? start : end,
    allDay,
    location: String(event.location || "").slice(0, 160),
    color: COLOR_NAMES[event.colorId] || "",
    reminders: [],
    phones: [],
    updated: new Date(event.updated || Date.now()).toISOString(),
  };
  const rec = fromRecurrence(event.recurrence);
  if (rec.repeat) {
    item.repeat = rec.repeat;
    item.exdates = rec.exdates;
  }
  return item;
}

// The parts of an event both sides can show, as Nova would read them: for telling whether an event
// of ours was changed in Google (Google writes times back its own way, so compare like this)
export function itemSig(item) {
  const end = item.end > item.start ? item.end : item.allDay ? item.end : addMinutes(item.start, 30);
  return JSON.stringify([item.title || "(no title)", item.body || "", item.location || "", item.start, end, Boolean(item.allDay), item.repeat || null, item.exdates || []]);
}
export function eventSig(event) {
  const item = fromEvent(event, "x");
  return item ? itemSig(item) : "";
}

// A Google event id as part of a Nova id (Nova's ids: letters, digits, . : - _; 64 at most)
export async function novaIdFor(prefix, eventId) {
  const clean = String(eventId).replace(/[^\w.:-]/g, "");
  return clean.length + prefix.length <= 64 ? prefix + clean : prefix + "h" + (await sha(eventId));
}

// ===== THE STUDIO CALENDAR =====

async function studioCalendar(env, budget) {
  const saved = await readSetting(env, STUDIO_KEY);
  if (saved) return saved;
  budget.left--;
  const made = await google(env, "POST", `${API}/calendars`, {
    summary: "Novacane Studio",
    description: "Kept in step with Nova Agent's Calendar (events, bookings, and its plan if switched on). Edit here or in Nova: both ways.",
    timeZone: TZ,
  });
  await writeSetting(env, STUDIO_KEY, made.id).run();
  return made.id;
}

const eventsUrl = (calId, path = "") => `${API}/calendars/${encodeURIComponent(calId)}/events${path}`;

// ===== NOVA → GOOGLE =====

// Send Nova's changed items (since the last revision sent). Returns how many were written.
export async function pushItems(env, budget, { plan = false } = {}) {
  const calId = await studioCalendar(env, budget);
  const since = Number(await readSetting(env, REV_KEY)) || 0;
  const { results } = await env.DB.prepare("SELECT * FROM calendar_items WHERE rev > ? ORDER BY rev LIMIT 200").bind(since).all();
  let done = 0;
  let reached = since;
  for (const row of results) {
    if (budget.left <= 2) break;
    const id = row.id;
    const link = await getLink(env, "event", id);
    let item = null;
    try {
      item = row.deleted ? null : { ...JSON.parse(row.data), id, kind: row.kind, updated: row.updated };
    } catch {}
    const agent = isAgentItem(id);
    // Gone in Nova (or the plan isn't wanted in Google any more): gone in Google
    if (!item || (agent && !plan)) {
      if (link) {
        budget.left--;
        await deleteEvent(env, link.extra || calId, link.google_id);
        await dropLink(env, "event", id).run();
        done++;
      }
      reached = row.rev;
      continue;
    }
    const hash = await itemHash(item);
    if (link && link.hash === hash) {
      reached = row.rev;
      continue;
    }
    budget.left--;
    if (link) {
      // An event from Google keeps its own calendar and Google's id
      const event = toEvent(item);
      if (/^gp?-/.test(id)) delete event.extendedProperties;
      try {
        await google(env, "PATCH", eventsUrl(link.extra || calId, `/${encodeURIComponent(link.google_id)}`), event);
      } catch (err) {
        // Someone else's event (an invitation): Google won't let it change. Nova's copy stays as it is.
        if (err.status === 403) {
          await putLink(env, "event", id, link.google_id, { extra: link.extra, hash }).run();
          reached = row.rev;
          continue;
        }
        if (err.status !== 404 && err.status !== 410) throw err;
        // Deleted in Google meanwhile: the pull drops it from Nova
        await dropLink(env, "event", id).run();
        reached = row.rev;
        continue;
      }
      await putLink(env, "event", id, link.google_id, { extra: link.extra || calId, hash }).run();
    } else if (/^gp?-/.test(id)) {
      // From Google, but its link is gone (Google deleted it): leave it to the pull
    } else {
      const made = await google(env, "POST", eventsUrl(calId), toEvent(item));
      await putLink(env, "event", id, made.id, { extra: calId, hash }).run();
    }
    done++;
    reached = row.rev;
  }
  if (reached !== since) await writeSetting(env, REV_KEY, reached).run();
  return done;
}

async function deleteEvent(env, calId, eventId) {
  try {
    await google(env, "DELETE", eventsUrl(calId, `/${encodeURIComponent(eventId)}`));
  } catch (err) {
    if (err.status !== 404 && err.status !== 410) throw err;
  }
}

// ===== GOOGLE → NOVA =====

// Read what changed in one calendar ("primary" or the studio's) and bring it into Nova
export async function pullCalendar(env, budget, which, calId) {
  let syncToken = await readSetting(env, syncKey(which));
  let pageToken = await readSetting(env, pageKey(which));
  let changed = 0;
  for (;;) {
    if (budget.left <= 2) break;
    const params = new URLSearchParams({ maxResults: "100", showDeleted: "true", singleEvents: "false" });
    if (pageToken) params.set("pageToken", pageToken);
    if (syncToken) params.set("syncToken", syncToken);
    else params.set("timeMin", new Date(Date.now() - PULL_BACK_DAYS * 86400000).toISOString());
    budget.left--;
    let data;
    try {
      data = await google(env, "GET", eventsUrl(calId, `?${params}`));
    } catch (err) {
      // Google forgot where we were: start again from the beginning
      if (err.status === 410) {
        await env.DB.batch([writeSetting(env, syncKey(which), ""), writeSetting(env, pageKey(which), "")]);
        syncToken = "";
        pageToken = "";
        continue;
      }
      throw err;
    }
    for (const event of data.items || []) changed += await takeEvent(env, which, calId, event);
    if (data.nextPageToken) {
      pageToken = data.nextPageToken;
      await writeSetting(env, pageKey(which), pageToken).run();
      continue;
    }
    await env.DB.batch([writeSetting(env, syncKey(which), data.nextSyncToken || ""), writeSetting(env, pageKey(which), "")]);
    break;
  }
  return changed;
}

// One event from Google: into Nova (or out of it). Returns 1 if Nova changed.
export async function takeEvent(env, which, calId, event) {
  const priv = event.extendedProperties?.private || {};
  // A booking we copied in: Acuity's, not Google's (bookings never come back from Google)
  if (priv.novaBooking) return 0;
  // One of Nova's own items (we put it there)
  if (priv.novaId) {
    const id = priv.novaId;
    const link = await getLink(env, "event", id);
    if (event.status === "cancelled") {
      if (link) await dropLink(env, "event", id).run();
      // Nova Agent's plan only ever changes from the PC
      if (isAgentItem(id)) return 0;
      await deleteItem(env, id, new Date(event.updated || Date.now()).toISOString());
      return 1;
    }
    if (isAgentItem(id)) return 0;
    const current = await env.DB.prepare("SELECT data, kind, updated, deleted FROM calendar_items WHERE id = ?").bind(id).first();
    if (!current || current.deleted) return 0;
    let base = {};
    try {
      base = JSON.parse(current.data);
    } catch {}
    if (current.kind === "day") return 0; // day cards' art and words are Nova's: they only go out
    // Not changed in Google (only Google's own way of writing it): nothing to do
    if (eventSig(event) === itemSig({ ...base, id })) return 0;
    const incoming = fromEvent(event, id);
    if (!incoming) return 0;
    const merged = { ...base, ...incoming, author: base.author || incoming.author, reminders: base.reminders || [], phones: base.phones || [], art: base.art, color: incoming.color || base.color || "" };
    if (!merged.art) delete merged.art;
    const hash = await itemHash(merged);
    const saved = await saveItem(env, merged);
    if (saved.ok) await putLink(env, "event", id, event.id, { extra: calId, hash }).run();
    return saved.ok ? 1 : 0;
  }
  // From Google itself
  const prefix = which === "primary" ? "gp-" : "g-";
  // One changed or cancelled meeting of a repeating event: the series skips that day, and a moved
  // one becomes an event of its own
  if (event.recurringEventId) {
    const masterId = await novaIdFor(prefix, event.recurringEventId);
    const day = (event.originalStartTime?.dateTime ? ukWall(event.originalStartTime.dateTime) : event.originalStartTime?.date || "")?.slice(0, 10);
    if (day) await skipDay(env, masterId, day);
    if (event.status === "cancelled") return 1;
  }
  const id = await novaIdFor(prefix, event.id);
  const link = await getLink(env, "event", id);
  if (event.status === "cancelled") {
    if (link) await dropLink(env, "event", id).run();
    const gone = await deleteItem(env, id, new Date(event.updated || Date.now()).toISOString());
    return gone.ok ? 1 : 0;
  }
  const item = fromEvent(event, id);
  if (!item) return 0;
  const hash = await itemHash(item);
  if (link && link.hash === hash) return 0;
  const saved = await saveItem(env, item);
  // Saved (or Nova has a later change, which the push sends back to Google)
  await putLink(env, "event", id, event.id, { extra: calId, hash: saved.ok ? hash : link?.hash || null }).run();
  return saved.ok ? 1 : 0;
}

// A repeating Nova event (from Google) skips a day
async function skipDay(env, id, day) {
  const row = await env.DB.prepare("SELECT data, updated, deleted FROM calendar_items WHERE id = ?").bind(id).first();
  if (!row || row.deleted) return;
  let item;
  try {
    item = JSON.parse(row.data);
  } catch {
    return;
  }
  if (!item.repeat || (item.exdates || []).includes(day)) return;
  item.exdates = [...(item.exdates || []), day].sort();
  item.updated = new Date(Math.max(Date.parse(row.updated) + 1, Date.now())).toISOString();
  item.base = row.updated;
  await saveItem(env, item);
  const link = await getLink(env, "event", id);
  if (link) await putLink(env, "event", id, link.google_id, { extra: link.extra, hash: await itemHash(item) }).run();
}

// ===== BOOKINGS: ACUITY → GOOGLE (copies only) =====

export function bookingEvent(b) {
  const start = feedTimeToIso(b.start);
  const end = feedTimeToIso(b.end) || start;
  if (!start) return null;
  return {
    summary: `Booking: ${b.session || "Session"}${b.name ? ` · ${b.name}` : ""}`,
    description: "A copy of the booking in Acuity. Book, move or cancel it in Acuity (changes here are put back).",
    start: { dateTime: start, timeZone: TZ },
    end: { dateTime: end > start ? end : start, timeZone: TZ },
    colorId: "6",
    extendedProperties: { private: { novaBooking: String(b.id) } },
  };
}

export async function pushBookings(env, budget) {
  const calId = await studioCalendar(env, budget);
  const all = (await listBookings(env)) || [];
  const now = Date.now();
  const wanted = all.filter((b) => {
    const t = Date.parse(feedTimeToIso(b.start) || "");
    return t > now - 7 * 86400000 && t < now + BOOKING_DAYS * 86400000;
  });
  const ids = new Set(wanted.map((b) => String(b.id)));
  let done = 0;
  for (const b of wanted) {
    if (budget.left <= 2) break;
    const event = bookingEvent(b);
    if (!event) continue;
    const hash = await sha(JSON.stringify([event.summary, event.start, event.end]));
    const link = await getLink(env, "booking", b.id);
    if (link && link.hash === hash) continue;
    budget.left--;
    if (link) {
      try {
        await google(env, "PATCH", eventsUrl(calId, `/${encodeURIComponent(link.google_id)}`), event);
        await putLink(env, "booking", b.id, link.google_id, { extra: calId, hash }).run();
      } catch (err) {
        if (err.status !== 404 && err.status !== 410) throw err;
        await dropLink(env, "booking", b.id).run();
      }
    } else {
      const made = await google(env, "POST", eventsUrl(calId), event);
      await putLink(env, "booking", b.id, made.id, { extra: calId, hash }).run();
    }
    done++;
  }
  // Bookings no longer in the feed (cancelled), still ahead: their copies go
  const { results } = await env.DB.prepare("SELECT nova_id, google_id, extra FROM google_links WHERE kind = 'booking'").all();
  for (const l of results) {
    if (ids.has(l.nova_id) || budget.left <= 2) continue;
    const b = all.find((x) => String(x.id) === l.nova_id);
    if (b && Date.parse(feedTimeToIso(b.start) || "") < now) continue; // just in the past: leave it
    budget.left--;
    await deleteEvent(env, l.extra || calId, l.google_id);
    await dropLink(env, "booking", l.nova_id).run();
    done++;
  }
  return done;
}

// ===== ONE RUN =====

// Pull from Google, push to it, copy the bookings: as far as the budget goes
export async function syncCalendar(env, budget) {
  const calId = await studioCalendar(env, budget);
  const plan = await partOn(env, "calendarPlan");
  const pulled = (await pullCalendar(env, budget, "primary", "primary")) + (await pullCalendar(env, budget, "studio", calId));
  const pushed = await pushItems(env, budget, { plan });
  const bookings = (await partOn(env, "bookings")) && budget.left > 4 ? await pushBookings(env, budget).catch((err) => {
    // The feed failing doesn't stop the calendar
    if (err?.status) throw err;
    return 0;
  }) : 0;
  const { n } = await env.DB.prepare("SELECT COUNT(*) AS n FROM google_links WHERE kind IN ('event', 'booking')").first();
  return `${n} event${n === 1 ? "" : "s"} in step${pulled + pushed + bookings ? ` (${pulled} in, ${pushed + bookings} out just now)` : ""}`;
}

// The studio's busy times, from both calendars (for Agent's google_calendar_busy)
export async function busyBetween(env, fromIso, untilIso) {
  const calId = await readSetting(env, STUDIO_KEY);
  const items = [{ id: "primary" }, ...(calId ? [{ id: calId }] : [])];
  const data = await google(env, "POST", `${API}/freeBusy`, { timeMin: fromIso, timeMax: untilIso, timeZone: TZ, items });
  const busy = [];
  for (const c of Object.values(data.calendars || {})) for (const b of c.busy || []) busy.push({ start: b.start, end: b.end });
  busy.sort((a, b) => a.start.localeCompare(b.start));
  return busy;
}

export { linkByGoogle };

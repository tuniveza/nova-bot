// Google Calendar ⇄ Nova's Calendar, both ways (Portal → Admin → Google → Calendar)
//
//   Nova → Google   Nova's events and day cards go into a calendar of their own in the studio's
//                   Google account, "Novacane Studio" (made on the first sync). Nova Agent's plan
//                   (quests, music time) too, if that's switched on. (Bookings are real events in
//                   the studio's own calendar already: src/nova/bookings.js.)
//   Google → Nova   events from the studio's own Google Calendar ("primary") and anything added
//                   straight into the Novacane Studio calendar come into Nova's Calendar (ids
//                   "gp-…" and "g-…"), and so count as busy time for quests on the PC.
//   Both ways       a change or a deletion on either side is made on the other. The change made
//                   last wins, as everywhere in Nova's Calendar.
//
// Nothing books, moves or cancels a booking from here: that's src/nova/bookings.js (Portal, the booking
// page, Approvals). The copies of Acuity's bookings made here before (24 Oct 2026) are tidied away.
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
import { flush, forgetLink, keepLink, later, linkByGoogle, linkOf, links, low, partOn, prep, readSetting, sha, spendDb, writeSetting } from "./common.js";

const API = "https://www.googleapis.com/calendar/v3";
const TZ = "Europe/London";
const STUDIO_KEY = "google_studio_calendar";
const REV_KEY = "google_cal_rev";
const syncKey = (which) => `google_cal_sync_${which}`;
const pageKey = (which) => `google_cal_page_${which}`;
const PULL_BACK_DAYS = 30; // the first pull reads from this long ago

// Nova's colours ⇄ Google's event colours
const COLOR_IDS = { rose: "4", violet: "3", blue: "9", teal: "7", green: "10", amber: "5", orange: "6", red: "11", grey: "8" };
const COLOR_NAMES = Object.fromEntries(Object.entries(COLOR_IDS).map(([k, v]) => [v, k]));

// ===== TIMES =====

const pad = (n) => String(n).padStart(2, "0");
// UTC instant -> UK wall clock "YYYY-MM-DDTHH:MM" (one formatter, made once: making it each
// time was most of a run's computer time)
let ukFormat = null;
export function ukWall(iso) {
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return null;
  ukFormat ||= new Intl.DateTimeFormat("en-GB", { timeZone: TZ, year: "numeric", month: "2-digit", day: "2-digit", hour: "2-digit", minute: "2-digit", hourCycle: "h23" });
  const parts = ukFormat.formatToParts(d);
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
    : ["event", item.title || "", item.body || "", item.start, item.end, Boolean(item.allDay), item.location || "", item.color || "", item.repeat || null, item.exdates || [], ...(item.meet ? ["meet"] : [])];
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
  // "Google Meet" ticked: Google makes the link (sent with conferenceDataVersion=1)
  if (item.meet && !item.meetUrl) event.conferenceData = { createRequest: { requestId: `nova-${item.id}`.slice(0, 64), conferenceSolutionKey: { type: "hangoutsMeet" } } };
  return event;
}

// A Google Meet link from Google's answer (an event with a Meet conference)
export function meetLinkOf(event) {
  const link = event?.hangoutLink || (event?.conferenceData?.entryPoints || []).find((e) => e.entryPointType === "video")?.uri || "";
  return /^https:\/\/meet\.google\.com\/[\w-]{3,60}$/.test(link) ? link : "";
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
  const meet = meetLinkOf(event);
  if (meet) {
    item.meet = true;
    item.meetUrl = meet;
  }
  return item;
}

// The parts of an event both sides can show, as Nova would read them: for telling whether an event
// of ours was changed in Google (Google writes times back its own way, so compare like this)
export function itemSig(item) {
  const end = item.end > item.start ? item.end : item.allDay ? item.end : addMinutes(item.start, 30);
  return JSON.stringify([item.title || "(no title)", item.body || "", item.location || "", item.start, end, Boolean(item.allDay), item.repeat || null, item.exdates || [], Boolean(item.meet)]);
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

// Calendar has just switched Google accounts (src/google/calendar-account.js): its sync starts
// afresh in the account it uses now. That account's "Novacane Studio" calendar is found again if
// it has one, so nothing is doubled (otherwise the next run makes one and sends Nova's events
// into it). `sameAccount` false: what Nova had brought in from the old account goes from Nova's
// Calendar (copies only: the events stay in that Google account). Calls Google as it is now.
export async function resetCalendarSync(env, { sameAccount = true } = {}) {
  const old = (await readSetting(env, STUDIO_KEY)) || "";
  const mine = [];
  let pageToken = "";
  do {
    const data = await google(env, "GET", `${API}/users/me/calendarList?minAccessRole=owner&maxResults=250${pageToken ? `&pageToken=${encodeURIComponent(pageToken)}` : ""}`);
    mine.push(...(data.items || []));
    pageToken = data.nextPageToken || "";
  } while (pageToken);
  const found = mine.find((c) => c.id === old)?.id || mine.find((c) => c.summary === "Novacane Studio")?.id || "";
  const fresh = ["primary", "studio"].flatMap((w) => [writeSetting(env, syncKey(w), ""), writeSetting(env, pageKey(w), "")]);
  // Copies to take out of Nova's Calendar: from the old studio calendar, and the old account's own
  const drop = [];
  if (found !== old && old) drop.push(old);
  if (!sameAccount) drop.push("primary");
  const gone = [];
  for (const extra of drop) {
    const { results } = await env.DB.prepare("SELECT nova_id FROM google_links WHERE kind = 'event' AND extra = ?").bind(extra).all();
    gone.push(...results.map((r) => r.nova_id).filter((id) => /^gp?-/.test(id)));
  }
  await env.DB.batch([
    ...fresh,
    ...(found !== old
      ? [
          found ? writeSetting(env, STUDIO_KEY, found) : env.DB.prepare("DELETE FROM settings WHERE key = ?").bind(STUDIO_KEY),
          // Nova's own events go into the calendar found (or made) afresh, all of them
          env.DB.prepare("DELETE FROM google_links WHERE kind = 'event' AND extra = ?").bind(old),
          writeSetting(env, REV_KEY, "0"),
        ]
      : []),
    ...(sameAccount ? [] : [env.DB.prepare("DELETE FROM google_links WHERE kind = 'event' AND extra = 'primary'")]),
  ]);
  for (const id of gone) await deleteItem(env, id);
  return { studio: found ? (found === old ? "kept" : "found") : "new", dropped: gone.length };
}

const eventsUrl = (calId, path = "") => `${API}/calendars/${encodeURIComponent(calId)}/events${path}`;
// (with Meet links: Google only makes or keeps one when told it may)
const withMeet = (url) => url + (url.includes("?") ? "&" : "?") + "conferenceDataVersion=1";

// ===== NOVA → GOOGLE =====

// Send Nova's changed items (since the last revision sent), a few at a time. -> { done, more }
const PUSH_ROWS = 40;
export async function pushItems(env, budget, { plan = false } = {}) {
  prep(budget);
  const calId = await studioCalendar(env, budget);
  const since = Number(await readSetting(env, REV_KEY)) || 0;
  spendDb(budget);
  const { results } = await env.DB.prepare("SELECT * FROM calendar_items WHERE rev > ? ORDER BY rev LIMIT ?").bind(since, PUSH_ROWS).all();
  const L = await links(env, budget, "event");
  const meetOk = await partOn(env, "meet").catch(() => false);
  let done = 0;
  let reached = since;
  let stopped = false;
  for (const row of results) {
    if (low(budget)) {
      stopped = true;
      break;
    }
    const id = row.id;
    const link = L.byNova.get(String(id)) || null;
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
        forgetLink(env, budget, "event", id);
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
      let answer;
      try {
        answer = await google(env, "PATCH", meetOk ? withMeet(eventsUrl(link.extra || calId, `/${encodeURIComponent(link.google_id)}`)) : eventsUrl(link.extra || calId, `/${encodeURIComponent(link.google_id)}`), meetOk ? event : withoutMeet(event));
      } catch (err) {
        // Someone else's event (an invitation): Google won't let it change. Nova's copy stays as it is.
        if (err.status === 403) {
          keepLink(env, budget, "event", id, link.google_id, { extra: link.extra, hash });
          reached = row.rev;
          continue;
        }
        if (err.status !== 404 && err.status !== 410) throw err;
        // Deleted in Google meanwhile: the pull drops it from Nova
        forgetLink(env, budget, "event", id);
        reached = row.rev;
        continue;
      }
      keepLink(env, budget, "event", id, link.google_id, { extra: link.extra || calId, hash });
      await keepMeetLink(env, budget, item, answer);
    } else if (/^gp?-/.test(id)) {
      // From Google, but its link is gone (Google deleted it): leave it to the pull
    } else {
      const event = toEvent(item);
      const made = await google(env, "POST", meetOk ? withMeet(eventsUrl(calId)) : eventsUrl(calId), meetOk ? event : withoutMeet(event));
      keepLink(env, budget, "event", id, made.id, { extra: calId, hash });
      await keepMeetLink(env, budget, item, made);
    }
    done++;
    reached = row.rev;
  }
  if (reached !== since) later(budget, writeSetting(env, REV_KEY, reached));
  return { done, more: stopped || results.length === PUSH_ROWS };
}

// "Google Meet" off (or not allowed): the event goes without asking for a link
function withoutMeet(event) {
  const { conferenceData, ...rest } = event;
  return rest;
}

// Google made a Meet link for one of Nova's events: Nova's Calendar shows it too (the change goes
// back to the PC like any other; its hash is the same, so it isn't sent to Google again)
async function keepMeetLink(env, budget, item, answer) {
  const link = meetLinkOf(answer);
  if (!link || !item.meet || item.meetUrl === link || isAgentItem(item.id)) return;
  spendDb(budget);
  await saveItem(env, { ...item, meetUrl: link, base: item.updated, updated: new Date(Math.max(Date.parse(item.updated) + 1, Date.now())).toISOString() });
}

async function deleteEvent(env, calId, eventId) {
  try {
    await google(env, "DELETE", eventsUrl(calId, `/${encodeURIComponent(eventId)}`));
  } catch (err) {
    if (err.status !== 404 && err.status !== 410) throw err;
  }
}

// ===== GOOGLE → NOVA =====

// Read what changed in one calendar ("primary" or the studio's) and bring it into Nova, a page
// (50 events) at a time. A page is only passed once all of it is in. -> { changed, more }
const PAGE = 50;
export async function pullCalendar(env, budget, which, calId) {
  prep(budget);
  let syncToken = await readSetting(env, syncKey(which));
  let pageToken = await readSetting(env, pageKey(which));
  let changed = 0;
  for (;;) {
    if (low(budget)) return { changed, more: true };
    const params = new URLSearchParams({ maxResults: String(PAGE), showDeleted: "true", singleEvents: "false" });
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
        spendDb(budget);
        syncToken = "";
        pageToken = "";
        continue;
      }
      throw err;
    }
    const items = data.items || [];
    // Nova's own items on this page, read in one go
    const ours = [...new Set(items.map((e) => e.extendedProperties?.private?.novaId).filter(Boolean))];
    const rows = new Map();
    if (ours.length) {
      spendDb(budget);
      const { results } = await env.DB.prepare(`SELECT id, data, kind, updated, deleted FROM calendar_items WHERE id IN (${ours.map(() => "?").join(",")})`).bind(...ours).all();
      for (const r of results) rows.set(r.id, r);
    }
    let all = true;
    for (const event of items) {
      // (each change is a trip to the database: stop in time, and do this page again next run)
      if (budget.db <= 5 || Date.now() > budget.until) {
        all = false;
        break;
      }
      changed += await takeEvent(env, which, calId, event, budget, rows);
    }
    if (!all) return { changed, more: true };
    if (data.nextPageToken) {
      pageToken = data.nextPageToken;
      later(budget, writeSetting(env, pageKey(which), pageToken));
      continue;
    }
    later(budget, writeSetting(env, syncKey(which), data.nextSyncToken || ""));
    later(budget, writeSetting(env, pageKey(which), ""));
    return { changed, more: false };
  }
}

// One event from Google: into Nova (or out of it). Returns 1 if Nova changed. `rows`: Nova's items
// already read (by id), so each event isn't another trip to the database.
export async function takeEvent(env, which, calId, event, budget = prep({ left: 0 }), rows = new Map()) {
  const priv = event.extendedProperties?.private || {};
  // A booking (Nova's own, or an old copy of Acuity's): never comes back from Google
  if (priv.novaBooking) return 0;
  // One of Nova's own items (we put it there)
  if (priv.novaId) {
    const id = priv.novaId;
    const link = await linkOf(env, budget, "event", id);
    if (event.status === "cancelled") {
      if (link) forgetLink(env, budget, "event", id);
      // Nova Agent's plan only ever changes from the PC
      if (isAgentItem(id)) return 0;
      spendDb(budget);
      await deleteItem(env, id, new Date(event.updated || Date.now()).toISOString());
      return 1;
    }
    if (isAgentItem(id)) return 0;
    let current = rows.get(id);
    if (current === undefined) {
      spendDb(budget);
      current = await env.DB.prepare("SELECT data, kind, updated, deleted FROM calendar_items WHERE id = ?").bind(id).first();
    }
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
    spendDb(budget);
    const saved = await saveItem(env, merged);
    if (saved.ok) keepLink(env, budget, "event", id, event.id, { extra: calId, hash });
    return saved.ok ? 1 : 0;
  }
  // From Google itself
  const prefix = which === "primary" ? "gp-" : "g-";
  // One changed or cancelled meeting of a repeating event: the series skips that day, and a moved
  // one becomes an event of its own
  if (event.recurringEventId) {
    const masterId = await novaIdFor(prefix, event.recurringEventId);
    const day = (event.originalStartTime?.dateTime ? ukWall(event.originalStartTime.dateTime) : event.originalStartTime?.date || "")?.slice(0, 10);
    if (day) await skipDay(env, masterId, day, budget);
    if (event.status === "cancelled") return 1;
  }
  const id = await novaIdFor(prefix, event.id);
  const link = await linkOf(env, budget, "event", id);
  if (event.status === "cancelled") {
    if (!link) return 0; // never in Nova (or already gone)
    forgetLink(env, budget, "event", id);
    spendDb(budget);
    const gone = await deleteItem(env, id, new Date(event.updated || Date.now()).toISOString());
    return gone.ok ? 1 : 0;
  }
  const item = fromEvent(event, id);
  if (!item) return 0;
  const hash = await itemHash(item);
  if (link && link.hash === hash) return 0;
  spendDb(budget);
  const saved = await saveItem(env, item);
  // Saved (or Nova has a later change, which the push sends back to Google)
  keepLink(env, budget, "event", id, event.id, { extra: calId, hash: saved.ok ? hash : link?.hash || null });
  return saved.ok ? 1 : 0;
}

// A repeating Nova event (from Google) skips a day
async function skipDay(env, id, day, budget) {
  spendDb(budget);
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
  spendDb(budget);
  await saveItem(env, item);
  const link = await linkOf(env, budget, "event", id);
  if (link) keepLink(env, budget, "event", id, link.google_id, { extra: link.extra, hash: await itemHash(item) });
}

// ===== THE OLD COPIES, ONCE BOOKINGS ARE NOVA'S OWN =====
// With Nova's own booking system every booking is a real event in the studio's Google Calendar
// (nova/bookings.js), so the copies of Acuity's bookings in the Novacane Studio calendar go: the
// ones still to come are deleted (they'd show twice); past ones stay there as history. A few
// each run, as far as the budget goes. Once none are left this does nothing.
export async function removeBookingCopies(env, budget, now = Date.now()) {
  prep(budget);
  const L = await links(env, budget, "booking");
  if (!L.byNova.size) return { done: 0, more: false };
  const calId = await studioCalendar(env, budget);
  let done = 0;
  let stopped = false;
  for (const l of [...L.byNova.values()]) {
    if (low(budget, 2)) {
      stopped = true;
      break;
    }
    const cal = l.extra || calId;
    budget.left--;
    let event = null;
    try {
      event = await google(env, "GET", eventsUrl(cal, `/${encodeURIComponent(l.google_id)}`));
    } catch (err) {
      if (err.status !== 404 && err.status !== 410) throw err;
    }
    const start = Date.parse(event?.start?.dateTime || event?.start?.date || "");
    if (event && event.status !== "cancelled" && !(start < now)) {
      budget.left--;
      await deleteEvent(env, cal, l.google_id);
    }
    forgetLink(env, budget, "booking", l.nova_id);
    done++;
  }
  return { done, more: stopped };
}

// ===== ONE RUN =====

// Pull from Google, push to it, tidy the old booking copies: as far as the budget goes. -> { note, more }
export async function syncCalendar(env, budget) {
  prep(budget);
  try {
    const calId = await studioCalendar(env, budget);
    const plan = await partOn(env, "calendarPlan");
    const primary = await pullCalendar(env, budget, "primary", "primary");
    const studio = await pullCalendar(env, budget, "studio", calId);
    const pushed = await pushItems(env, budget, { plan });
    let bookings = { done: 0, more: false };
    // Bookings are real events already: the old copies of Acuity's go
    if (!low(budget, 4)) bookings = await removeBookingCopies(env, budget);
    await flush(env, budget);
    const L = await links(env, budget, "event");
    const B = await links(env, budget, "booking");
    const n = L.byNova.size + B.byNova.size;
    const pulled = primary.changed + studio.changed;
    const out = pushed.done + bookings.done;
    const more = primary.more || studio.more || pushed.more || bookings.more;
    const note = `${n} event${n === 1 ? "" : "s"} in step${pulled + out ? ` (${pulled} in, ${out} out just now)` : ""}${more ? " · more next run" : ""}`;
    return { note, more };
  } finally {
    await flush(env, budget).catch(() => {});
  }
}

// ===== TODAY (Portal's Today, Agent's what_now) =====

// What's in the calendar today (UK): Nova's own events and the ones from Google, soonest first.
// Read from Nova's Calendar (kept in step with Google), so it costs no Google call. Nova Agent's
// plan (quests, music time) is left out: Quests shows that.
export async function todayEvents(env, at = Date.now()) {
  const day = ukWall(new Date(at).toISOString()).slice(0, 10);
  const { results } = await env.DB.prepare(
    "SELECT id, kind, data FROM calendar_items WHERE deleted = 0 AND kind = 'event' AND start <= ? AND start >= ? ORDER BY start LIMIT 300"
  )
    .bind(`${day}T23:59`, addDays(day, -400))
    .all();
  const out = [];
  for (const r of results) {
    if (isAgentItem(r.id)) continue;
    let it;
    try {
      it = JSON.parse(r.data);
    } catch {
      continue;
    }
    const on = (d) => (it.start.slice(0, 10) <= d && (it.end || it.start).slice(0, 10) >= d) || repeatsOn(it, d);
    if (!on(day)) continue;
    out.push({
      id: r.id,
      title: it.title || "(no title)",
      start: it.allDay ? null : it.start.slice(11, 16),
      end: it.allDay ? null : (it.end || it.start).slice(11, 16),
      allDay: Boolean(it.allDay),
      location: it.location || "",
      meetUrl: it.meetUrl || "",
      from: /^gp?-/.test(r.id) ? "Google Calendar" : it.author || "Nova",
    });
  }
  out.sort((a, b) => (a.allDay === b.allDay ? String(a.start).localeCompare(String(b.start)) : a.allDay ? -1 : 1));
  return out;
}

// Does a repeating event happen on this day? (daily, weekly on its days, monthly on its date,
// yearly; its end date or count and skipped days respected roughly)
function repeatsOn(it, day) {
  const r = it.repeat;
  if (!r || day < it.start.slice(0, 10)) return false;
  if (r.until && day > r.until) return false;
  if ((it.exdates || []).includes(day)) return false;
  const first = Date.parse(it.start.slice(0, 10) + "T00:00:00Z");
  const d = Date.parse(day + "T00:00:00Z");
  const days = Math.round((d - first) / 86400000);
  const every = Math.max(1, Number(r.interval) || 1);
  const dt = new Date(d);
  const ft = new Date(first);
  if (r.freq === "daily") return days % every === 0;
  if (r.freq === "weekly") {
    const byDay = r.byDay?.length ? r.byDay : [ft.getUTCDay()];
    return byDay.includes(dt.getUTCDay()) && Math.floor(days / 7) % every === 0;
  }
  if (r.freq === "monthly") return dt.getUTCDate() === ft.getUTCDate() && ((dt.getUTCFullYear() - ft.getUTCFullYear()) * 12 + dt.getUTCMonth() - ft.getUTCMonth()) % every === 0;
  if (r.freq === "yearly") return dt.getUTCDate() === ft.getUTCDate() && dt.getUTCMonth() === ft.getUTCMonth() && (dt.getUTCFullYear() - ft.getUTCFullYear()) % every === 0;
  return false;
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

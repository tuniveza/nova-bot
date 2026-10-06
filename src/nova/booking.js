// Sessions, free times and booking links
//
// Free times come from the studio's opening hours (studio.js) minus everything
// busy in the studio's Google Calendar: bookings, times held while someone pays
// their deposit, and anything staff have put in by hand. A session also needs its
// changeover kept free after it, and so does every booking already made.
//
// A booking link opens Nova Bot's own booking page (/book, book-page.js) on one
// session, with the customer's details (and a time, if chosen) filled in. They
// pay the 50% deposit on Stripe's checkout page, and the booking goes straight
// into Google Calendar.

import { listEvents, offline } from "./google.js";
import {
  MAX_DAYS_AHEAD,
  MIN_NOTICE_MINUTES,
  OPENING_HOURS,
  SESSION_TYPES,
  SLOT_STEP_MINUTES,
  TIME_ZONE,
  getType,
  money,
  msToUk,
  pence,
  ukToMs,
} from "./studio.js";

// Where the worker lives on the internet (booking links, emails, Stripe's return pages)
export const LIVE_URL = "https://novacane-worker.novacane-studio.workers.dev";
export const publicUrl = (env) => String(env?.PUBLIC_URL || LIVE_URL).replace(/\/+$/, "");

// How long a calendar lookup is reused (a new booking clears it straight away)
const CALENDAR_SECONDS = 30;
// The most days NovaBot can look at in one go
const MAX_DAYS = 14;

// ===== SESSION TYPES =====

// The bookable sessions: [{ id, name, price: "£100", duration, changeover }]
export function getSessionTypes() {
  return SESSION_TYPES.map((t) => ({ id: t.id, name: t.name, price: money(pence(t.price)), duration: t.duration, changeover: t.changeover || 0 }));
}

// For tests: forget remembered calendar lookups
export function forgetSessionTypes() {
  eventsSeen.clear();
}

// Something just changed in the calendar: the next lookup asks Google afresh
export function calendarTouched() {
  eventsSeen.clear();
}

// A link that opens the booking page on one session, details filled in.
// With `at` ({ date, time }), it opens with that time already chosen.
export function bookingLink(env, typeId, person = {}, at = null) {
  const params = new URLSearchParams();
  params.set("session", String(typeId));
  if (at?.date && at?.time) {
    params.set("date", at.date);
    params.set("time", at.time);
  }
  const [first, ...rest] = String(person.name || "").trim().split(/\s+/);
  const firstName = String(person.firstName || first || "").trim();
  const lastName = String(person.lastName || rest.join(" ") || "").trim();
  if (firstName) params.set("first", firstName.slice(0, 60));
  if (lastName) params.set("last", lastName.slice(0, 60));
  if (person.email) params.set("email", String(person.email).trim().slice(0, 200));
  if (person.phone) params.set("phone", String(person.phone).trim().slice(0, 40));
  return `${publicUrl(env)}/book?${params}`;
}

// ===== FOR NOVABOT =====

export const BOOKING_TOOL = {
  name: "booking_link",
  description:
    "Make a direct link to book one of the studio's standard sessions on Novacane's booking page. It opens on that session, with the customer's details filled in if you have them. Give a date and time when the customer has asked for or mentioned a specific start time: it's checked against the calendar, and if it's free the link opens with that time already selected. The customer then checks their details and pays the 50% deposit to confirm.",
  input_schema: {
    type: "object",
    properties: {
      session_type_id: { type: "integer", description: "The ID of the session type, from the BOOKABLE SESSIONS list" },
      date: { type: "string", description: "The day they want, YYYY-MM-DD (UK date), if they've picked or mentioned one" },
      time: { type: "string", description: "The start time they want, 24-hour HH:MM (UK time), e.g. 14:00 for 2pm, if they've picked or mentioned one" },
      first_name: { type: "string", description: "The customer's first name, if they've given it" },
      last_name: { type: "string", description: "The customer's last name, if they've given it" },
      email: { type: "string", description: "The customer's email, if they've given it" },
      phone: { type: "string", description: "The customer's phone number, if they've given it" },
      ask_how_to_book: {
        type: "boolean",
        description:
          "true when they've picked a time but haven't said whether they want you to book it for them or to book it themselves: the chat then shows them a button for each",
      },
    },
    required: ["session_type_id"],
  },
};

// The session list, for NovaBot's instructions
export function sessionList(types) {
  return [
    "BOOKABLE SESSIONS (from the studio's booking system; use these IDs with booking_link and check_availability).",
    'The length in the session\'s name is only part of it: the TOTAL length is the one to match when someone asks for "2 hours", "4 hours" etc.',
    ...types.map((type) => `- ${type.id}: ${type.name}${type.duration ? `, ${hoursInWords(type.duration)} in total` : ""}${type.price ? `, ${type.price}` : ""}`),
  ].join("\n");
}

// 120 -> "2 hours", 90 -> "1.5 hours", 60 -> "1 hour"
function hoursInWords(minutes) {
  const hours = minutes / 60;
  return `${Number.isInteger(hours) ? hours : hours.toFixed(1)} hour${hours === 1 ? "" : "s"}`;
}

// Run the booking_link tool. Returns what to tell Claude, and the link.
// `canBook`: NovaBot can book it for them too, so a free time can come with
// the "Book it for me / I'll book it myself" choice.
export async function makeBookingLink(env, input, today = ukToday(), canBook = false) {
  const type = getType(input?.session_type_id);
  if (!type) {
    return { ok: false, message: "No session type with that ID. Use an ID from the BOOKABLE SESSIONS list." };
  }
  const person = { firstName: input.first_name, lastName: input.last_name, email: input.email, phone: input.phone };
  const url = bookingLink(env, type.id, person);
  const plain = {
    ok: true,
    url,
    message: `Link for "${type.name}": ${url}\nGive the customer this exact link. They pick a time, check their details and pay the 50% deposit to confirm.`,
  };
  if (!input.date && !input.time) return plain;

  // A particular time: only select it if the calendar shows it as free
  const date = String(input.date || "");
  const time = normaliseTime(input.time);
  if (!isRealDate(date) || !time) {
    return { ok: false, url, message: `To select a time, give the date as YYYY-MM-DD and the time as HH:MM (24-hour). Without a time, the plain link is: ${url}` };
  }
  if (date < today || date > addDays(today, MAX_DAYS_AHEAD)) {
    return { ok: false, url, message: `${dayInWords(date)} can't be booked (it's in the past or too far ahead). Plain link: ${url}` };
  }

  let freeThatDay = [];
  try {
    const slots = (await freeStarts(env, type, date, date))[date] || {};
    if (slots[time]) {
      const chosen = bookingLink(env, type.id, person, { date, time });
      if (canBook && input.ask_how_to_book === true) {
        return {
          ok: true,
          url: chosen,
          choice: true,
          message:
            `${dayInWords(date)} at ${time} shows as free right now for "${type.name}". This link opens the booking page with that time already selected: ${chosen}\n` +
            "Two buttons are shown under your reply: \"Book it for me\" (you book it for them here in the chat) and \"I'll book it myself\" (opens that link). " +
            "So just say the time shows as free and ask briefly which they'd prefer. Don't list what you'd need from them yet. The time isn't held until it's booked.",
        };
      }
      return {
        ok: true,
        url: chosen,
        message:
          `${dayInWords(date)} at ${time} shows as free right now. This link opens the booking page with that time already selected for "${type.name}": ${chosen}\n` +
          "Give the customer this exact link and say the time is already selected (don't tell them to pick a time). They check their details and pay the 50% deposit to confirm. The time isn't held until they do.",
      };
    }
    freeThatDay = Object.keys(slots).sort();
  } catch (err) {
    console.log("Couldn't check the time for a booking link:", err);
    return {
      ok: true,
      url,
      message: `Couldn't check ${dayInWords(date)} at ${time} on the calendar just now, so don't say whether it's free. This link opens "${type.name}" and they pick the time there: ${url}`,
    };
  }

  const others = freeThatDay.length ? `Free start times that day: ${describeDay(freeThatDay, type.duration)}.` : "Nothing shows as free that day.";
  let nearby = "";
  try {
    nearby = await nearestFreeDays(env, type, date, today);
  } catch (err) {
    console.log("Couldn't look up nearby free days:", err);
  }
  return {
    ok: false,
    url,
    message:
      `${dayInWords(date)} at ${time} isn't showing as free for "${type.name}". ${others}\n` +
      (nearby ? `Nearest days with free times (start times):\n${nearby}\n` : "") +
      "Tell them, and offer alternatives ONLY from the free times listed here (never suggest any other day or time). When they choose one, call booking_link again with that time. " +
      `If they'd rather pick the time themselves, this link opens the session without a time selected: ${url}`,
  };
}

// Is this exact start time free right now? Asked afresh (not from a remembered
// answer), just before booking it. `ignoreBookingId` leaves one booking out (moving it).
// Returns { type, date, time, startsAt, endsAt }, or { type?, taken?, problem } saying why not.
export async function freeSlot(env, input, today = ukToday(), { ignoreBookingId = null, type: given = null } = {}) {
  const type = given || getType(input?.session_type_id);
  if (!type) return { problem: "No session type with that ID. Use an ID from the BOOKABLE SESSIONS list." };
  const date = String(input?.date || "");
  const time = normaliseTime(input?.time);
  if (!isRealDate(date) || !time) return { type, problem: "Give the date as YYYY-MM-DD and the start time as HH:MM (24-hour)." };
  if (date < today || date > addDays(today, MAX_DAYS_AHEAD)) {
    return { type, problem: `${dayInWords(date)} can't be booked (it's in the past or too far ahead).` };
  }
  const slots = (await freeStarts(env, type, date, date, { fresh: true, ignoreBookingId }))[date] || {};
  if (!slots[time]) return { type, taken: true, problem: `${dayInWords(date)} at ${time} isn't showing as free for "${type.name}" any more.` };
  const startsAt = slots[time];
  const endsAt = new Date(Date.parse(startsAt) + type.duration * 60_000).toISOString();
  return { type, date, time, startsAt, endsAt };
}

// The start times free on one day for one session, sorted ("10:00", ...), for
// the booking card's and booking page's time buttons. Returns { times } or { problem }.
export async function freeTimesOn(env, typeId, date, today = ukToday(), { ignoreBookingId = null } = {}) {
  const type = getType(typeId);
  if (!type) return { problem: "Pick a session first." };
  if (!isRealDate(date) || date < today || date > addDays(today, MAX_DAYS_AHEAD)) return { problem: "That day can't be booked." };
  return { times: Object.keys((await freeStarts(env, type, date, date, { ignoreBookingId }))[date] || {}).sort() };
}

// Up to 3 days nearest to `date` (before or after, not `date` itself) that
// have free times, described for NovaBot
async function nearestFreeDays(env, type, date, today) {
  const from = addDays(date, -3) < today ? today : addDays(date, -3);
  const free = await freeStarts(env, type, from, addDays(date, 7));
  const distance = (day) => Math.abs(new Date(day + "T00:00:00Z") - new Date(date + "T00:00:00Z"));
  return Object.keys(free)
    .filter((day) => day !== date)
    .sort((a, b) => distance(a) - distance(b) || (a < b ? -1 : 1))
    .slice(0, 3)
    .sort()
    .map((day) => `- ${dayInWords(day)}: ${describeDay(Object.keys(free[day]).sort(), type.duration)}`)
    .join("\n");
}

// "2pm", "14:00", "14.00", "1430", "9:30am" -> "14:00" style, or "" if it isn't a time
export function normaliseTime(value) {
  const match = String(value || "")
    .trim()
    .toLowerCase()
    .match(/^(\d{1,2})(?:[:.]?(\d{2}))?\s*(am|pm)?$/);
  if (!match) return "";
  let hours = Number(match[1]);
  const minutes = Number(match[2] || 0);
  if (match[3] === "pm" && hours < 12) hours += 12;
  if (match[3] === "am" && hours === 12) hours = 0;
  if (hours > 23 || minutes > 59) return "";
  return `${String(hours).padStart(2, "0")}:${String(minutes).padStart(2, "0")}`;
}

// ===== FREE TIMES =====

export const AVAILABILITY_TOOL = {
  name: "check_availability",
  description:
    "Look up the start times that show as free right now in the studio's calendar for one session type, between two dates (at most 14 days). Use it when the customer asks about particular dates or times, or the soonest slot. It never books or holds anything.",
  input_schema: {
    type: "object",
    properties: {
      session_type_id: { type: "integer", description: "The ID of the session type, from the BOOKABLE SESSIONS list" },
      from_date: { type: "string", description: "First day to check, YYYY-MM-DD (UK date). Leave out for today." },
      to_date: { type: "string", description: "Last day to check, YYYY-MM-DD. Leave out for a week from from_date." },
      first_name: { type: "string", description: "The customer's first name, if known (fills in the booking page)" },
      last_name: { type: "string", description: "The customer's last name, if known" },
      email: { type: "string", description: "The customer's email, if known" },
      phone: { type: "string", description: "The customer's phone number, if known" },
    },
    required: ["session_type_id"],
  },
};

const eventsSeen = new Map(); // "from|until" -> { at, events }

// Today's date in the UK, as YYYY-MM-DD
export function ukToday(now = new Date()) {
  return new Intl.DateTimeFormat("en-CA", { timeZone: TIME_ZONE }).format(now);
}

// "Thursday 1 October 2026", for NovaBot's instructions
export function ukTodayInWords(now = new Date()) {
  return new Intl.DateTimeFormat("en-GB", { timeZone: TIME_ZONE, weekday: "long", day: "numeric", month: "long", year: "numeric" })
    .format(now)
    .replace(/,/g, "");
}

// The next few weeks with their weekdays, so NovaBot gets dates like "next
// Friday" right: "Thursday 1 October (today), Friday 2 October, ..."
export function upcomingDates(today = ukToday(), days = 21) {
  return Array.from({ length: days }, (_, i) => dayInWords(addDays(today, i)) + (i === 0 ? " (today)" : "")).join(", ");
}

const DATE_PATTERN = /^\d{4}-\d{2}-\d{2}$/;

export function isRealDate(ymd) {
  if (!DATE_PATTERN.test(String(ymd))) return false;
  const date = new Date(ymd + "T00:00:00Z");
  return !Number.isNaN(date.getTime()) && date.toISOString().slice(0, 10) === ymd;
}

export function addDays(ymd, days) {
  const date = new Date(ymd + "T00:00:00Z");
  date.setUTCDate(date.getUTCDate() + days);
  return date.toISOString().slice(0, 10);
}

export function dayInWords(ymd) {
  return new Intl.DateTimeFormat("en-GB", { timeZone: "UTC", weekday: "long", day: "numeric", month: "long" })
    .format(new Date(ymd + "T00:00:00Z"))
    .replace(/,/g, "");
}

// Free start times for one session from `fromDate` to `toDate` (UK days):
// { "2026-10-05": { "10:00": "2026-10-05T09:00:00.000Z", ... } }, days with none left out.
export async function freeStarts(env, type, fromDate, toDate, { fresh = false, ignoreBookingId = null, now = Date.now() } = {}) {
  const fromMs = ukToMs(fromDate);
  const untilMs = ukToMs(addDays(toDate, 1));
  const busy = await busyBetween(env, fromMs, untilMs, { fresh, ignoreBookingId });
  const length = (type.duration + (type.changeover || 0)) * 60_000;
  const soonest = now + MIN_NOTICE_MINUTES * 60_000;
  const days = {};
  for (let day = fromDate; day <= toDate; day = addDays(day, 1)) {
    const hours = OPENING_HOURS[new Date(day + "T12:00:00Z").getUTCDay()];
    if (!hours) continue;
    const open = ukToMs(day, hours[0]);
    const close = ukToMs(day, hours[1]);
    const free = {};
    for (let start = open; start + length <= close; start += SLOT_STEP_MINUTES * 60_000) {
      if (start < soonest) continue;
      const end = start + length;
      if (busy.some(([s, e]) => s < end && e > start)) continue;
      free[msToUk(start).time] = new Date(start).toISOString();
    }
    if (Object.keys(free).length) days[day] = free;
  }
  return days;
}

// Everything busy between two instants, as [[startMs, endMs], ...]:
// - every Google Calendar event that isn't marked "free" (bookings, holds, staff's own events)
// - each of our bookings with its changeover added after it
async function busyBetween(env, fromMs, untilMs, { fresh, ignoreBookingId }) {
  const busy = [];
  // Our bookings (a day either side, for changeovers running over midnight)
  const { results } = await env.DB.prepare(
    "SELECT id, starts_at, ends_at, changeover, event_id FROM bookings WHERE status IN ('hold', 'booked') AND starts_at < ? AND ends_at > ?"
  )
    .bind(new Date(untilMs).toISOString(), new Date(fromMs - 86_400_000).toISOString())
    .all();
  const ignoredEvent = results.find((b) => b.id === ignoreBookingId)?.event_id || null;
  for (const b of results) {
    if (b.id === ignoreBookingId) continue;
    busy.push([Date.parse(b.starts_at), Date.parse(b.ends_at) + (b.changeover || 0) * 60_000]);
  }
  if (offline(env)) return busy;

  const key = `${fromMs}|${untilMs}`;
  const seen = eventsSeen.get(key);
  let events;
  if (!fresh && seen && Date.now() - seen.at < CALENDAR_SECONDS * 1000) events = seen.events;
  else {
    events = await listEvents(env, fromMs, untilMs);
    if (eventsSeen.size > 100) eventsSeen.clear();
    eventsSeen.set(key, { at: Date.now(), events });
  }
  for (const e of events) {
    if (ignoredEvent && e.id === ignoredEvent) continue;
    const span = eventSpan(e);
    if (span && blocksTime(e)) busy.push(span);
  }
  return busy;
}

// An event's start and end in ms (all-day events run midnight to midnight, UK time)
export function eventSpan(e) {
  const start = e.start?.dateTime ? Date.parse(e.start.dateTime) : e.start?.date ? ukToMs(e.start.date) : NaN;
  const end = e.end?.dateTime ? Date.parse(e.end.dateTime) : e.end?.date ? ukToMs(e.end.date) : NaN;
  return Number.isFinite(start) && Number.isFinite(end) && end > start ? [start, end] : null;
}

// Does this event make the studio busy? Not if it's marked "free", or the studio declined it.
export function blocksTime(e) {
  if (e.status === "cancelled" || e.transparency === "transparent") return false;
  const self = (e.attendees || []).find((a) => a.self);
  return !(self && self.responseStatus === "declined");
}

// One day's free start times, split into morning / afternoon / evening, with
// when a session starting then would finish:
// "morning: starts 10:00 to 11:30 (every 30 minutes), finishing 14:00 to 15:30;
//  afternoon: starts 12:00 to 14:00 ..., finishing 16:00 to 18:00; evening: none"
const PARTS = [
  ["morning", 0, 12 * 60],
  ["afternoon", 12 * 60, 17 * 60],
  ["evening", 17 * 60, 24 * 60],
];

export function describeDay(times, durationMinutes) {
  const toMinutes = (t) => Number(t.slice(0, 2)) * 60 + Number(t.slice(3));
  const clock = (m) => `${String(Math.floor(m / 60) % 24).padStart(2, "0")}:${String(m % 60).padStart(2, "0")}`;
  return PARTS.map(([part, from, to]) => {
    const starts = times.filter((t) => toMinutes(t) >= from && toMinutes(t) < to);
    if (starts.length === 0) return `${part}: none`;
    let text = `${part}: starts ${describeTimes(starts)}`;
    if (durationMinutes) {
      const first = clock(toMinutes(starts[0]) + durationMinutes);
      const last = clock(toMinutes(starts.at(-1)) + durationMinutes);
      text += `, finishing ${starts.length === 1 ? first : `${first} to ${last}`}`;
    }
    return text;
  }).join("; ");
}

// "10:00 to 18:30 (every 30 minutes)", or a list when the times are uneven
export function describeTimes(times) {
  const minutes = times.map((t) => Number(t.slice(0, 2)) * 60 + Number(t.slice(3)));
  const gaps = minutes.slice(1).map((m, i) => m - minutes[i]);
  if (times.length >= 3 && gaps.every((gap) => gap === gaps[0])) {
    return `${times[0]} to ${times.at(-1)} (every ${gaps[0]} minutes)`;
  }
  return times.join(", ");
}

// Run the check_availability tool. Returns what to tell Claude.
export async function checkAvailability(env, input, today = ukToday()) {
  const type = getType(input?.session_type_id);
  if (!type) return { ok: false, message: "No session type with that ID. Use an ID from the BOOKABLE SESSIONS list." };

  // Sensible dates only: from today, not too far ahead, at most 14 days
  let from = isRealDate(input.from_date) ? input.from_date : today;
  if (from < today) from = today;
  if (from > addDays(today, MAX_DAYS_AHEAD)) {
    return { ok: false, message: "That's too far ahead to check. Say the calendar doesn't go that far yet and give the booking link." };
  }
  let to = isRealDate(input.to_date) && input.to_date >= from ? input.to_date : addDays(from, 6);
  if (to > addDays(from, MAX_DAYS - 1)) to = addDays(from, MAX_DAYS - 1);
  if (to > addDays(today, MAX_DAYS_AHEAD)) to = addDays(today, MAX_DAYS_AHEAD);

  const days = await freeStarts(env, type, from, to);
  const url = bookingLink(env, type.id, { firstName: input.first_name, lastName: input.last_name, email: input.email, phone: input.phone });
  const range = `${dayInWords(from)} to ${dayInWords(to)}`;
  const freeDays = Object.keys(days).sort();
  const hours = type.duration ? ` (${type.duration / 60} hours)` : "";
  const lines = freeDays.length
    ? [
        `Free START times for ${type.name}${hours}, as the studio calendar shows them right now (UK time), ${range}:`,
        ...freeDays.map((day) => `- ${dayInWords(day)}: ${describeDay(Object.keys(days[day]).sort(), type.duration)}`),
        "These are the times the session can START (morning = before 12:00, afternoon = 12:00 to 17:00, evening = 17:00 on). It then runs for its full length (see the finish times). Any listed start time can be booked.",
        "Days in that range that aren't listed have no free times.",
      ]
    : [
        `No free start times for ${type.name}, ${range}.`,
        "That can mean those days are booked up or the studio is closed. Suggest other dates, or give the booking link to look themselves.",
      ];
  lines.push(
    `Booking link for this session (they choose the time there): ${url}`,
    "When you answer: say these times show as free right now. Never promise or hold a time: it's only theirs once it's booked and the deposit is paid. Give the booking link."
  );
  return { ok: true, url, message: lines.join("\n") };
}

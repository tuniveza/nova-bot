// Direct booking links and free times from Acuity
//
// Acuity's API needs its Powerhouse plan, so nothing here uses it. Instead:
// - The session types (packages) are read from the studio's public booking
//   page, the same page clients see, so they stay up to date when they're
//   changed in Acuity.
// - A booking link opens that page straight on one session type, with the
//   client's name, email and phone already filled in. The client picks a
//   time and pays, and the booking lands in Acuity like any other.
// - Free times come from the same public address the booking page uses to
//   show them. No login: it's only what any visitor can see. It isn't an
//   official Acuity feature, so everything here fails safely: if it stops
//   working, NovaBot just gives the booking link.

// The studio's Acuity account: the number after owner= in the booking
// calendar's address
export const ACUITY_OWNER = "18510650";

const SCHEDULE_PAGE = "https://app.acuityscheduling.com/schedule.php";
const SCHEDULE_BASE = "https://app.acuityscheduling.com/schedule";

// How long to keep the session list before reading the booking page again
const REFRESH_MINUTES = 60;

// Free times: how long to remember a lookup, how long to wait for Acuity, and
// the most days NovaBot can look at in one go / how far ahead
const FREE_TIMES_MINUTES = 2;
const TIMEOUT_MS = 5000;
const MAX_DAYS = 14;
const MAX_DAYS_AHEAD = 180;

const AVAILABILITY_URL = "https://app.acuityscheduling.com/api/scheduling/v1/availability/times";

let remembered = null; // { owner, at, page }

// What NovaBot needs from the booking page: { ownerKey, types }
async function getBookingPage(owner) {
  if (remembered && remembered.owner === owner && Date.now() - remembered.at < REFRESH_MINUTES * 60 * 1000) {
    return remembered.page;
  }
  const res = await fetch(`${SCHEDULE_PAGE}?owner=${encodeURIComponent(owner)}`, {
    headers: { "User-Agent": "NovaBot (Novacane Studios)" },
    signal: AbortSignal.timeout(TIMEOUT_MS),
  });
  if (!res.ok) throw new Error(`Acuity booking page answered ${res.status}`);
  const page = readBookingPage(await res.text());
  if (page.types.length === 0) throw new Error("No session types found on the Acuity booking page");
  remembered = { owner, at: Date.now(), page };
  return page;
}

// The bookable session types: [{ id, name, price, duration, calendarIds }]
export async function getSessionTypes(owner) {
  return (await getBookingPage(owner)).types;
}

// For tests: forget everything remembered
export function forgetSessionTypes() {
  remembered = null;
  freeTimesSeen.clear();
}

// The booking page carries its settings as `var BUSINESS = {...}`
export function readBookingPage(html) {
  const empty = { ownerKey: "", types: [] };
  const marker = html.indexOf("var BUSINESS");
  if (marker === -1) return empty;
  const start = html.indexOf("{", marker);
  const end = matchingBrace(html, start);
  if (start === -1 || end === -1) return empty;
  let business;
  try {
    business = JSON.parse(html.slice(start, end + 1));
  } catch {
    return empty;
  }
  const types = Object.values(business.appointmentTypes || {})
    .flat()
    .filter((type) => type && type.active && !type.private && Number.isInteger(type.id))
    .map((type) => ({
      id: type.id,
      name: String(type.name || "").trim(),
      price: type.price ? `£${type.price}` : "",
      duration: Number(type.duration) || 0,
      calendarIds: (Array.isArray(type.calendarIDs) ? type.calendarIDs : []).filter(Number.isInteger),
    }));
  // The public key the booking page uses to look up free times
  const ownerKey = /^[A-Za-z0-9]{4,32}$/.test(business.ownerKey || "") ? business.ownerKey : "";
  return { ownerKey, types };
}

export function readSessionTypes(html) {
  return readBookingPage(html).types;
}

// Find the } that closes the { at `start`, skipping braces inside strings
function matchingBrace(text, start) {
  let depth = 0;
  let inString = false;
  let escaped = false;
  for (let i = start; i < text.length; i++) {
    const c = text[i];
    if (inString) {
      if (escaped) escaped = false;
      else if (c === "\\") escaped = true;
      else if (c === '"') inString = false;
    } else if (c === '"') inString = true;
    else if (c === "{") depth++;
    else if (c === "}" && --depth === 0) return i;
  }
  return -1;
}

// A link that opens the booking page on one session type, details filled in.
// With `at` ({ ownerKey, calendarId, time }), it opens with that time already
// chosen, on the "your information" step.
// (Acuity fills in first name, last name and phone from the link. It doesn't
// fill in the email, but it's passed anyway in case it does one day.)
export function bookingLink(owner, typeId, person = {}, at = null) {
  const params = new URLSearchParams();
  const [first, ...rest] = String(person.name || "").trim().split(/\s+/);
  const firstName = String(person.firstName || first || "").trim();
  const lastName = String(person.lastName || rest.join(" ") || "").trim();
  const details = new URLSearchParams();
  if (firstName) details.set("firstName", firstName.slice(0, 60));
  if (lastName) details.set("lastName", lastName.slice(0, 60));
  if (person.email) details.set("email", String(person.email).trim().slice(0, 200));
  if (person.phone) details.set("phone", String(person.phone).trim().slice(0, 40));

  if (at) {
    params.set("appointmentTypeIds[]", String(typeId));
    for (const [key, value] of details) params.set(key, value);
    // Acuity writes times as 2026-10-06T14:00:00+0100; its page addresses use +01:00
    const time = at.time.replace(/([+-]\d{2})(\d{2})$/, "$1:$2");
    return `${SCHEDULE_BASE}/${at.ownerKey}/appointment/${typeId}/calendar/${at.calendarId}/datetime/${encodeURIComponent(time)}?${params}`;
  }
  params.set("owner", String(owner));
  params.set("appointmentType", String(typeId));
  for (const [key, value] of details) params.set(key, value);
  return `${SCHEDULE_PAGE}?${params}`;
}

// ===== FOR NOVABOT =====

export const BOOKING_TOOL = {
  name: "booking_link",
  description:
    "Make a direct link to book one of the studio's standard sessions. It opens the booking calendar on that session, with the customer's details filled in if you have them. Give a date and time when the customer has asked for or mentioned a specific start time: it's checked against the calendar, and if it's free the link opens with that time already selected. The customer then fills in their details and pays the deposit themselves.",
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
    "BOOKABLE SESSIONS (live from the booking calendar; use these IDs with booking_link and check_availability).",
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
// `canBook`: NovaBot can book it for them too (see book-session.js), so a
// free time can come with the "Book it for me / I'll book it myself" choice.
export async function makeBookingLink(owner, input, today = ukToday(), canBook = false) {
  const page = await getBookingPage(owner);
  const type = page.types.find((t) => t.id === Number(input?.session_type_id));
  if (!type) {
    return { ok: false, message: "No session type with that ID. Use an ID from the BOOKABLE SESSIONS list." };
  }
  const person = { firstName: input.first_name, lastName: input.last_name, email: input.email, phone: input.phone };
  const url = bookingLink(owner, type.id, person);
  const plain = {
    ok: true,
    url,
    message: `Link for "${type.name}": ${url}\nGive the customer this exact link. They pick a time on the calendar and pay the deposit to confirm.`,
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
  if (!page.ownerKey || type.calendarIds.length === 0) return plain;

  let freeThatDay = [];
  try {
    for (const calendarId of type.calendarIds) {
      const slots = (await freeTimesFrom(page.ownerKey, type.id, calendarId, date))[date] || {};
      if (slots[time]) {
        const chosen = bookingLink(owner, type.id, person, { ownerKey: page.ownerKey, calendarId, time: slots[time] });
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
            "Give the customer this exact link and say the time is already selected (don't tell them to pick a time). They fill in their details and pay the deposit to confirm. The time isn't held until they do.",
        };
      }
      freeThatDay = [...new Set([...freeThatDay, ...Object.keys(slots)])].sort();
    }
  } catch (err) {
    console.log("Couldn't check the time for a booking link:", err);
    return {
      ok: true,
      url,
      message: `Couldn't check ${dayInWords(date)} at ${time} on the calendar just now, so don't say whether it's free. This link opens "${type.name}" and they pick the time there: ${url}`,
    };
  }

  const others = freeThatDay.length
    ? `Free start times that day: ${describeDay(freeThatDay, type.duration)}.`
    : "Nothing shows as free that day.";

  // The nearest days that do have free times, so NovaBot can offer real ones
  let nearby = "";
  try {
    nearby = await nearestFreeDays(page, type, date, today);
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
      `If they'd rather pick on the calendar themselves, this link opens the session without a time selected: ${url}`,
  };
}

// Is this exact start time free right now? For booking it straight away, so
// the calendar is asked afresh. Returns { type, date, time, calendarId,
// acuityTime, ownerKey }, or { type?, taken?, problem } saying why not.
export async function freeSlot(owner, input, today = ukToday()) {
  const page = await getBookingPage(owner);
  const type = page.types.find((t) => t.id === Number(input?.session_type_id));
  if (!type) return { problem: "No session type with that ID. Use an ID from the BOOKABLE SESSIONS list." };
  const date = String(input.date || "");
  const time = normaliseTime(input.time);
  if (!isRealDate(date) || !time) return { type, problem: "Give the date as YYYY-MM-DD and the start time as HH:MM (24-hour)." };
  if (date < today || date > addDays(today, MAX_DAYS_AHEAD)) {
    return { type, problem: `${dayInWords(date)} can't be booked (it's in the past or too far ahead).` };
  }
  if (!page.ownerKey || type.calendarIds.length === 0) return { type, problem: "Times can't be checked for this session." };
  for (const calendarId of type.calendarIds) {
    const slots = (await freeTimesFrom(page.ownerKey, type.id, calendarId, date, { fresh: true }))[date] || {};
    if (slots[time]) return { type, date, time, calendarId, acuityTime: slots[time], ownerKey: page.ownerKey };
  }
  return { type, taken: true, problem: `${dayInWords(date)} at ${time} isn't showing as free for "${type.name}" any more.` };
}

// The start times free on one day for one session, sorted ("10:00", ...), for
// the booking card's time buttons. Returns { times } or { problem }.
export async function freeTimesOn(owner, typeId, date, today = ukToday()) {
  const page = await getBookingPage(owner);
  const type = page.types.find((t) => t.id === Number(typeId));
  if (!type) return { problem: "Pick a session first." };
  if (!isRealDate(date) || date < today || date > addDays(today, MAX_DAYS_AHEAD)) return { problem: "That day can't be booked." };
  if (!page.ownerKey || type.calendarIds.length === 0) return { problem: "Times can't be checked for this session." };
  const times = new Set();
  for (const calendarId of type.calendarIds) {
    Object.keys((await freeTimesFrom(page.ownerKey, type.id, calendarId, date))[date] || {}).forEach((t) => times.add(t));
  }
  return { times: [...times].sort() };
}

// Up to 3 days nearest to `date` (before or after, not `date` itself) that
// have free times, described for NovaBot
async function nearestFreeDays(page, type, date, today) {
  const free = {};
  const starts = [addDays(date, -3) < today ? today : addDays(date, -3), addDays(date, 1)];
  for (const calendarId of type.calendarIds) {
    for (const start of starts) {
      const days = await freeTimesFrom(page.ownerKey, type.id, calendarId, start);
      for (const [day, slots] of Object.entries(days)) {
        if (day !== date) free[day] = [...new Set([...(free[day] || []), ...Object.keys(slots)])].sort();
      }
    }
  }
  const distance = (day) => Math.abs(new Date(day + "T00:00:00Z") - new Date(date + "T00:00:00Z"));
  return Object.keys(free)
    .sort((a, b) => distance(a) - distance(b) || (a < b ? -1 : 1))
    .slice(0, 3)
    .sort()
    .map((day) => `- ${dayInWords(day)}: ${describeDay(free[day], type.duration)}`)
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
    "Look up the start times that show as free right now on the booking calendar for one session type, between two dates (at most 14 days). Use it when the customer asks about particular dates or times, or the soonest slot. It never books or holds anything.",
  input_schema: {
    type: "object",
    properties: {
      session_type_id: { type: "integer", description: "The ID of the session type, from the BOOKABLE SESSIONS list" },
      from_date: { type: "string", description: "First day to check, YYYY-MM-DD (UK date). Leave out for today." },
      to_date: { type: "string", description: "Last day to check, YYYY-MM-DD. Leave out for a week from from_date." },
      first_name: { type: "string", description: "The customer's first name, if known (fills in the booking form)" },
      last_name: { type: "string", description: "The customer's last name, if known" },
      email: { type: "string", description: "The customer's email, if known" },
      phone: { type: "string", description: "The customer's phone number, if known" },
    },
    required: ["session_type_id"],
  },
};

const freeTimesSeen = new Map(); // lookup address -> { at, days }

// Today's date in the UK, as YYYY-MM-DD
export function ukToday(now = new Date()) {
  return new Intl.DateTimeFormat("en-CA", { timeZone: "Europe/London" }).format(now);
}

// "Thursday 1 October 2026", for NovaBot's instructions
export function ukTodayInWords(now = new Date()) {
  return new Intl.DateTimeFormat("en-GB", {
    timeZone: "Europe/London",
    weekday: "long",
    day: "numeric",
    month: "long",
    year: "numeric",
  })
    .format(now)
    .replace(/,/g, "");
}

// The next few weeks with their weekdays, so NovaBot gets dates like "next
// Friday" right: "Thursday 1 October (today), Friday 2 October, ..."
export function upcomingDates(today = ukToday(), days = 21) {
  return Array.from({ length: days }, (_, i) => dayInWords(addDays(today, i)) + (i === 0 ? " (today)" : "")).join(", ");
}

const DATE_PATTERN = /^\d{4}-\d{2}-\d{2}$/;

function isRealDate(ymd) {
  if (!DATE_PATTERN.test(String(ymd))) return false;
  const date = new Date(ymd + "T00:00:00Z");
  return !Number.isNaN(date.getTime()) && date.toISOString().slice(0, 10) === ymd;
}

function addDays(ymd, days) {
  const date = new Date(ymd + "T00:00:00Z");
  date.setUTCDate(date.getUTCDate() + days);
  return date.toISOString().slice(0, 10);
}

export function dayInWords(ymd) {
  return new Intl.DateTimeFormat("en-GB", { timeZone: "UTC", weekday: "long", day: "numeric", month: "long" })
    .format(new Date(ymd + "T00:00:00Z"))
    .replace(/,/g, "");
}

// Ask Acuity for free times from one day. It answers with up to 5 days that
// have free times (days with none are left out). `fresh` skips the
// remembered answer (just before booking a time).
async function freeTimesFrom(ownerKey, typeId, calendarId, startDate, { fresh = false } = {}) {
  const params = new URLSearchParams({
    owner: ownerKey,
    appointmentTypeId: String(typeId),
    calendarId: String(calendarId),
    startDate,
    maxDays: "5",
    timezone: "Europe/London",
  });
  const address = `${AVAILABILITY_URL}?${params}`;
  const seen = freeTimesSeen.get(address);
  if (!fresh && seen && Date.now() - seen.at < FREE_TIMES_MINUTES * 60 * 1000) return seen.days;

  const res = await fetch(address, {
    headers: { Accept: "application/json", "User-Agent": "NovaBot (Novacane Studios)" },
    signal: AbortSignal.timeout(TIMEOUT_MS),
  });
  if (!res.ok) throw new Error(`Acuity free times answered ${res.status}`);
  const days = readFreeSlots(await res.json());

  if (freeTimesSeen.size > 200) freeTimesSeen.clear();
  freeTimesSeen.set(address, { at: Date.now(), days });
  return days;
}

// Check Acuity's answer looks right: { "2026-10-05": [{ time, slotsAvailable }] }
// Returns { "2026-10-05": { "10:00": "2026-10-05T10:00:00+0100", ... } } (free
// start times, with Acuity's exact time), or throws if it's not what's
// expected (e.g. Acuity changed it)
export function readFreeSlots(data) {
  if (!data || typeof data !== "object" || Array.isArray(data)) throw new Error("Free times aren't in the expected shape");
  const days = {};
  for (const [day, slots] of Object.entries(data)) {
    if (!isRealDate(day) || !Array.isArray(slots)) throw new Error("Free times aren't in the expected shape");
    const free = {};
    for (const slot of slots) {
      const time = String(slot?.time || "");
      if (!/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}[+-]\d{2}:?\d{2}$/.test(time) || !time.startsWith(day + "T")) {
        throw new Error("Free times aren't in the expected shape");
      }
      if (slot.slotsAvailable === undefined || slot.slotsAvailable > 0) free[time.slice(11, 16)] = time;
    }
    if (Object.keys(free).length) days[day] = free;
  }
  return days;
}

// The same, as just the sorted start times: { "2026-10-05": ["10:00", ...] }
export function readFreeTimes(data) {
  return Object.fromEntries(Object.entries(readFreeSlots(data)).map(([day, free]) => [day, Object.keys(free).sort()]));
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
export async function checkAvailability(owner, input, today = ukToday()) {
  const page = await getBookingPage(owner);
  const type = page.types.find((t) => t.id === Number(input?.session_type_id));
  if (!type) return { ok: false, message: "No session type with that ID. Use an ID from the BOOKABLE SESSIONS list." };
  if (!page.ownerKey || type.calendarIds.length === 0) {
    return { ok: false, message: "Free times can't be checked for this session. Give the booking link instead." };
  }

  // Sensible dates only: from today, not too far ahead, at most 14 days
  let from = isRealDate(input.from_date) ? input.from_date : today;
  if (from < today) from = today;
  if (from > addDays(today, MAX_DAYS_AHEAD)) {
    return { ok: false, message: "That's too far ahead to check. Say the calendar doesn't go that far yet and give the booking link." };
  }
  let to = isRealDate(input.to_date) && input.to_date >= from ? input.to_date : addDays(from, 6);
  if (to > addDays(from, MAX_DAYS - 1)) to = addDays(from, MAX_DAYS - 1);

  // Each lookup covers up to 5 days with free times; a few lookups cover the range
  const free = {};
  for (const calendarId of type.calendarIds) {
    let cursor = from;
    for (let lookup = 0; lookup < 4 && cursor <= to; lookup++) {
      const days = await freeTimesFrom(page.ownerKey, type.id, calendarId, cursor);
      const found = Object.keys(days).sort();
      for (const day of found) {
        if (day >= from && day <= to) free[day] = [...new Set([...(free[day] || []), ...Object.keys(days[day])])].sort();
      }
      if (found.length === 0) break;
      cursor = addDays(found.at(-1), 1);
    }
  }

  const url = bookingLink(owner, type.id, {
    firstName: input.first_name,
    lastName: input.last_name,
    email: input.email,
    phone: input.phone,
  });
  const range = `${dayInWords(from)} to ${dayInWords(to)}`;
  const freeDays = Object.keys(free).sort();
  const hours = type.duration ? ` (${type.duration / 60} hours)` : "";
  const lines = freeDays.length
    ? [
        `Free START times for ${type.name}${hours}, as the booking calendar shows them right now (UK time), ${range}:`,
        ...freeDays.map((day) => `- ${dayInWords(day)}: ${describeDay(free[day], type.duration)}`),
        "These are the times the session can START (morning = before 12:00, afternoon = 12:00 to 17:00, evening = 17:00 on). It then runs for its full length (see the finish times). Any listed start time can be booked.",
        "Days in that range that aren't listed have no free times.",
      ]
    : [
        `No free start times for ${type.name}, ${range}.`,
        "That can mean those days are booked up, the studio is closed, or the calendar doesn't take bookings that far ahead yet. Suggest other dates, or give the booking link to look themselves.",
      ];
  lines.push(
    `Booking link for this session (they choose the time there): ${url}`,
    "When you answer: say these times show as free right now. Never promise or hold a time: it's only theirs once they book it and pay the deposit. Give the booking link."
  );
  return { ok: true, url, message: lines.join("\n") };
}

// Calendar: when a repeating event happens.
//
// One copy of the rules, used by the Calendar page, by Nova Agent on the studio PC (its
// planner counts every occurrence as busy time) and by Nova Bot (reminders on phones;
// copied into its src/calendar/ at build time).
//
// Times are the studio's local time ("2026-10-09T14:00", UK), never UTC: the arithmetic
// below works on calendar dates, so the clocks going back or forward don't move anything.
//
// An event: { id, title, start, end, allDay?, repeat?, exdates? }
//   repeat: { freq: "daily" | "weekly" | "monthly" | "yearly", interval?: 1,
//             byDay?: [0-6] (weekly; 0 = Sunday), until?: "YYYY-MM-DD", count?: n }
//   exdates: ["YYYY-MM-DD", ...] occurrences that were deleted or moved out of the series

const DAY = 86400000;
const pad = (n) => String(n).padStart(2, "0");

export const FREQS = ["daily", "weekly", "monthly", "yearly"];

// "YYYY-MM-DD" ⇄ a day number (days since 1970-01-01), so dates add up simply
export function dayNumber(date) {
  const [y, m, d] = date.split("-").map(Number);
  return Math.round(Date.UTC(y, m - 1, d) / DAY);
}
export function dateOf(dayNum) {
  const t = new Date(dayNum * DAY);
  return `${t.getUTCFullYear()}-${pad(t.getUTCMonth() + 1)}-${pad(t.getUTCDate())}`;
}
export function addDays(date, n) {
  return dateOf(dayNumber(date) + n);
}
export function weekday(date) {
  return new Date(dayNumber(date) * DAY).getUTCDay();
}
// Minutes between two local stamps ("2026-10-09T14:00")
export function minutesBetween(a, b) {
  const m = (s) => dayNumber(s.slice(0, 10)) * 1440 + Number(s.slice(11, 13) || 0) * 60 + Number(s.slice(14, 16) || 0);
  return m(b) - m(a);
}
// A local stamp moved by some minutes
export function addMinutes(stamp, minutes) {
  const total = dayNumber(stamp.slice(0, 10)) * 1440 + Number(stamp.slice(11, 13) || 0) * 60 + Number(stamp.slice(14, 16) || 0) + minutes;
  const day = Math.floor(total / 1440);
  const rest = total - day * 1440;
  return `${dateOf(day)}T${pad(Math.floor(rest / 60))}:${pad(rest % 60)}`;
}

// A tidy repeat rule (or null for "doesn't repeat")
export function cleanRepeat(r) {
  if (!r || typeof r !== "object" || !FREQS.includes(r.freq)) return null;
  const out = { freq: r.freq, interval: Math.min(Math.max(Math.floor(Number(r.interval) || 1), 1), 99) };
  if (r.freq === "weekly" && Array.isArray(r.byDay)) {
    const days = [...new Set(r.byDay.map(Number).filter((d) => Number.isInteger(d) && d >= 0 && d <= 6))].sort();
    if (days.length) out.byDay = days;
  }
  if (typeof r.until === "string" && /^\d{4}-\d{2}-\d{2}$/.test(r.until)) out.until = r.until;
  else if (Number(r.count) >= 1) out.count = Math.min(Math.floor(Number(r.count)), 1000);
  return out;
}

// Every date the series lands on, from its first, in order (stops at `last`)
function* seriesDates(first, repeat, last) {
  const i = repeat.interval || 1;
  const [fy, fm, fd] = first.split("-").map(Number);
  let n = 0;
  const cap = 20000;
  if (repeat.freq === "daily") {
    for (let d = dayNumber(first), end = dayNumber(last); d <= end && n < cap; d += i, n++) yield dateOf(d);
  } else if (repeat.freq === "weekly") {
    const days = repeat.byDay && repeat.byDay.length ? repeat.byDay : [weekday(first)];
    // Weeks run Sunday to Saturday; every `interval` weeks from the first one
    const firstSunday = dayNumber(first) - weekday(first);
    for (let week = firstSunday, end = dayNumber(last); week <= end && n < cap; week += 7 * i) {
      for (const wd of days) {
        const d = week + wd;
        if (d < dayNumber(first) || d > end) continue;
        n++;
        yield dateOf(d);
      }
    }
  } else if (repeat.freq === "monthly") {
    for (let k = 0; n < cap; k += i, n++) {
      const y = fy + Math.floor((fm - 1 + k) / 12);
      const m = ((fm - 1 + k) % 12) + 1;
      const date = `${y}-${pad(m)}-${pad(fd)}`;
      if (date > last) return;
      // The 31st only in months that have one
      if (new Date(Date.UTC(y, m - 1, fd)).getUTCMonth() === m - 1) yield date;
    }
  } else if (repeat.freq === "yearly") {
    for (let y = fy; n < cap; y += i, n++) {
      const date = `${y}-${pad(fm)}-${pad(fd)}`;
      if (date > last) return;
      // 29 February only in leap years
      if (new Date(Date.UTC(y, fm - 1, fd)).getUTCMonth() === fm - 1) yield date;
    }
  }
}

// The occurrences of an event that touch the dates from..to (inclusive), each
// { start, end, date } with `date` the day that occurrence starts on. A
// non-repeating event gives itself if it touches the range.
export function occurrences(ev, from, to) {
  if (!ev || typeof ev.start !== "string") return [];
  const length = Math.max(0, minutesBetween(ev.start, ev.end || ev.start));
  const spanDays = Math.ceil(length / 1440);
  const repeat = cleanRepeat(ev.repeat);
  const first = ev.start.slice(0, 10);
  const time = ev.start.slice(10);
  const touches = (startDate, endStamp) => startDate <= to && endStamp.slice(0, 10) >= from;
  if (!repeat) {
    const end = ev.end || ev.start;
    return touches(first, end) ? [{ start: ev.start, end, date: first }] : [];
  }
  const skip = new Set(Array.isArray(ev.exdates) ? ev.exdates : []);
  // Look a little before `from` so an occurrence spanning into the range still counts
  const last = repeat.until && repeat.until < to ? repeat.until : to;
  const out = [];
  let count = 0;
  for (const date of seriesDates(first, repeat, last)) {
    count++;
    if (repeat.count && count > repeat.count) break;
    if (skip.has(date)) continue;
    if (date < addDays(from, -spanDays)) continue;
    const start = date + time;
    const end = addMinutes(start, length);
    if (touches(date, end)) out.push({ start, end, date });
  }
  return out;
}

// The last date a series reaches (for "this and following": end the old series the day before)
export function endSeriesBefore(ev, date) {
  const repeat = cleanRepeat(ev.repeat);
  if (!repeat) return ev;
  const { count, ...rest } = repeat;
  return { ...ev, repeat: { ...rest, until: addDays(date, -1) } };
}

// A short description: "Every week on Mon, Wed", "Every 2 days until 30 Nov"
const WD = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"];
const MONTHS = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];
export function describeRepeat(r) {
  const repeat = cleanRepeat(r);
  if (!repeat) return "Doesn't repeat";
  const unit = { daily: "day", weekly: "week", monthly: "month", yearly: "year" }[repeat.freq];
  let s = repeat.interval > 1 ? `Every ${repeat.interval} ${unit}s` : `Every ${unit}`;
  if (repeat.freq === "weekly" && repeat.byDay) s += ` on ${repeat.byDay.map((d) => WD[d]).join(", ")}`;
  if (repeat.until) s += ` until ${Number(repeat.until.slice(8))} ${MONTHS[Number(repeat.until.slice(5, 7)) - 1]}`;
  else if (repeat.count) s += `, ${repeat.count} times`;
  return s;
}

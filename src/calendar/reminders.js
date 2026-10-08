// Calendar reminders on phones: each minute (the cron), events with a reminder due are sent
// to every signed-up phone, once. Times are the studio's (UK) local time. An all-day event's
// reminder counts back from 09:00 on its day ("1 day before" = 09:00 the day before).

import { notifyPhones } from "../push.js";
import { addDays, occurrences } from "./recur.js";

const ZONE = "Europe/London";
const ALL_DAY_AT = "09:00";
// A reminder late by up to this much (the cron missed a minute) still goes
const GRACE_MS = 5 * 60000;

// The UK clock's offset from UTC at a moment (minutes; 60 in summer)
function offsetAt(ms) {
  const p = Object.fromEntries(
    new Intl.DateTimeFormat("en-GB", { timeZone: ZONE, hourCycle: "h23", year: "numeric", month: "2-digit", day: "2-digit", hour: "2-digit", minute: "2-digit" })
      .formatToParts(new Date(ms))
      .map((x) => [x.type, x.value])
  );
  return (Date.UTC(+p.year, +p.month - 1, +p.day, +p.hour, +p.minute) - Math.floor(ms / 60000) * 60000) / 60000;
}
// A UK local stamp ("2026-10-09T14:00") as a moment
export function localToMs(stamp) {
  const asUtc = Date.UTC(+stamp.slice(0, 4), +stamp.slice(5, 7) - 1, +stamp.slice(8, 10), +stamp.slice(11, 13) || 0, +stamp.slice(14, 16) || 0);
  let ms = asUtc - offsetAt(asUtc) * 60000;
  ms = asUtc - offsetAt(ms) * 60000;
  return ms;
}
export function localDate(ms) {
  return new Intl.DateTimeFormat("en-CA", { timeZone: ZONE, year: "numeric", month: "2-digit", day: "2-digit" }).format(new Date(ms));
}

function inWords(minutes) {
  if (minutes === 0) return "Now";
  if (minutes < 60) return `In ${minutes} minutes`;
  if (minutes < 1440) return minutes === 60 ? "In an hour" : `In ${Math.round(minutes / 60)} hours`;
  return minutes === 1440 ? "Tomorrow" : `In ${Math.round(minutes / 1440)} days`;
}

// The reminders due now: [{ key, title, body }]
export function dueReminders(events, now = Date.now()) {
  const today = localDate(now);
  const due = [];
  for (const ev of events) {
    if (!Array.isArray(ev.reminders) || !ev.reminders.length) continue;
    // Reminders reach at most 28 days back from an occurrence
    for (const occ of occurrences(ev, addDays(today, -1), addDays(today, 29))) {
      const startsAt = ev.allDay ? `${occ.date}T${ALL_DAY_AT}` : occ.start;
      const at = localToMs(startsAt);
      for (const minutes of ev.reminders) {
        const fire = at - minutes * 60000;
        if (fire > now || fire <= now - GRACE_MS) continue;
        const time = ev.allDay ? "All day" : `${occ.start.slice(11, 16)}–${occ.end.slice(11, 16)}`;
        due.push({
          key: `${ev.id}|${occ.date}|${minutes}`,
          title: ev.title || "Calendar",
          body: [inWords(minutes), time, ev.location].filter(Boolean).join(" · "),
        });
      }
    }
  }
  return due;
}

export async function sendCalendarReminders(env, now = Date.now()) {
  const { results } = await env.DB.prepare(
    "SELECT data FROM calendar_items WHERE kind = 'event' AND deleted = 0 AND json_array_length(json_extract(data, '$.reminders')) > 0"
  ).all();
  const events = results.map((r) => {
    try {
      return JSON.parse(r.data);
    } catch {
      return null;
    }
  }).filter(Boolean);
  for (const r of dueReminders(events, now)) {
    // Each reminder once, even if two minutes overlap
    const res = await env.DB.prepare("INSERT OR IGNORE INTO calendar_reminders_sent (key, sent_at) VALUES (?, ?)").bind(r.key, new Date(now).toISOString()).run();
    if (!res.meta.changes) continue;
    await notifyPhones(env, { title: r.title, body: r.body, url: "/agent/?open=%2Fcalendar%2F" });
  }
  // Keep the list short: sent reminders older than 40 days aren't needed
  await env.DB.prepare("DELETE FROM calendar_reminders_sent WHERE sent_at < ?").bind(new Date(now - 40 * 864e5).toISOString()).run();
}

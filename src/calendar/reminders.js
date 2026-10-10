// Calendar reminders on phones: each minute (the cron), events with a reminder due are sent
// to the phones the event picked (`phones`: phone ids), or else the studio owner's phones.
// Times are the studio's (UK) local time. An all-day event's reminder counts back from
// 09:00 on its day ("1 day before" = 09:00 the day before).
//
// A reminder only counts as sent once a phone took it (calendar_reminders_sent):
//   sending → sent                     a phone took it
//           ↘ retrying                 no phone took it: tried again the next minute
//                ↘ failed              still not through after 15 minutes: given up on,
//                                      and Portal's Alerts says it didn't arrive

import { notifyPhones, saveAlert, studioOwner } from "../push.js";
import { addDays, occurrences } from "./recur.js";

const ZONE = "Europe/London";
const ALL_DAY_AT = "09:00";
// A reminder is tried for this long after it was due (the cron missed a minute, or no
// phone took it); after that it's marked failed
export const RETRY_MS = 15 * 60000;

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

// The reminders due now: [{ key, title, body, fire, phones }]
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
        if (fire > now || fire <= now - RETRY_MS) continue;
        const time = ev.allDay ? "All day" : `${occ.start.slice(11, 16)}–${occ.end.slice(11, 16)}`;
        due.push({
          key: `${ev.id}|${occ.date}|${minutes}`,
          title: ev.title || "Calendar",
          body: [inWords(minutes), time, ev.location].filter(Boolean).join(" · "),
          fire,
          phones: Array.isArray(ev.phones) ? ev.phones : [],
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
  const owner = await studioOwner(env);
  for (const r of dueReminders(events, now)) await sendOne(env, r, owner, now);
  // Keep the list short: sent reminders older than 40 days aren't needed
  await env.DB.prepare("DELETE FROM calendar_reminders_sent WHERE sent_at < ?").bind(new Date(now - 40 * 864e5).toISOString()).run();
}

// Record how a reminder is getting on
function mark(env, key, status, tries, now) {
  return env.DB.prepare(
    "INSERT INTO calendar_reminders_sent (key, sent_at, status, tries) VALUES (?1, ?2, ?3, ?4) " +
      "ON CONFLICT (key) DO UPDATE SET sent_at = ?2, status = ?3, tries = ?4"
  )
    .bind(key, new Date(now).toISOString(), status, tries)
    .run();
}

// One reminder: sent once a phone takes it, tried again if none did, flagged if it never gets through
async function sendOne(env, r, owner, now) {
  const row = await env.DB.prepare("SELECT status, tries, sent_at FROM calendar_reminders_sent WHERE key = ?").bind(r.key).first();
  // Already through, or already given up on
  if (row && (row.status === "sent" || row.status === "failed")) return;
  // Being sent right now (the last minute's run hasn't finished)
  if (row && row.status === "sending" && now - Date.parse(row.sent_at) < 50000) return;
  const tries = (row?.tries || 0) + 1;
  await mark(env, r.key, "sending", tries, now);
  let delivered = 0;
  try {
    delivered = await notifyPhones(env, { title: r.title, body: r.body, url: "/agent/?open=%2Fcalendar%2F", to: { phones: r.phones, staff: owner ? [owner.id] : [] } });
  } catch (err) {
    console.log("Calendar reminder failed:", err);
  }
  if (delivered > 0) return mark(env, r.key, "sent", tries, now);
  // Next minute's run would be past the 15 minutes: give up, and say so in Portal's Alerts
  if (now + 60000 >= r.fire + RETRY_MS) {
    await mark(env, r.key, "failed", tries, now);
    const when = new Intl.DateTimeFormat("en-GB", { timeZone: ZONE, hour: "2-digit", minute: "2-digit" }).format(new Date(r.fire));
    return saveAlert(env, {
      title: `Reminder didn't reach a phone: ${r.title}`,
      body: `${r.body}\nDue at ${when}; tried ${tries} times. Check notifications are on (Portal → Alerts).`,
      url: "/agent/?open=%2Fcalendar%2F",
      phones: 0,
    });
  }
  return mark(env, r.key, "retrying", tries, now);
}

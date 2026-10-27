// Calendar's Google account (Portal → Admin → Google → Calendar account): the studio's (the account
// Google is connected with) or one of its own, say the engineer's, so bookings land in the calendar
// he actually uses while emails, Drive and the rest stay on the studio's account.
//
// Switching (either way):
//   - every booking still to come goes into the calendar now used, and out of the old one;
//   - Calendar's two-way sync starts afresh there (calendar.js resetCalendarSync), finding that
//     account's "Novacane Studio" calendar again if it has one;
//   - the calendar's owner is emailed about each booking moved in (bookings.js tellCalendarOwner).
// google_cal_synced_account: whose own calendar Nova's Calendar last brought in, so copies from a
// different account are taken out (never known before 27 Oct 2026: nothing is taken out then).

import { calendarAccount, calendarOwn, calendarOwnAccount, forgetCalendarAccount, forgetCalendarRoute } from "../nova/google.js";
import { fullName, moveBookingsToCalendar, tellCalendarOwner } from "../nova/bookings.js";
import { resetCalendarSync } from "./calendar.js";
import { readSetting, writeSetting } from "./common.js";

const SYNCED_KEY = "google_cal_synced_account";
const same = (a, b) => String(a || "").toLowerCase() === String(b || "").toLowerCase();

// How Calendar is set up just now: { own, email } (email: the account whose calendar is used)
export async function calendarNow(env) {
  return { own: await calendarOwn(env), email: await calendarAccount(env) };
}

// use: "own" | "main". `before`: calendarNow() from before a new sign-in for Calendar's own account
// (that sign-in replaced the old one's key, so its calendar can't be reached any more).
// -> { ok, message, moved }
export async function useCalendarAccount(env, use, before = null) {
  const was = before || (await calendarNow(env));
  if (use === "own" && !(await calendarOwnAccount(env))) return { ok: false, message: "Connect Calendar's own account first." };
  await writeSetting(env, "google_cal_use", use === "own" ? "own" : "main").run();
  forgetCalendarRoute();
  const now = await calendarNow(env);
  if (!now.email) return { ok: false, message: "Google isn't connected, so Calendar can't use it." };
  if (same(now.email, was.email)) return { ok: true, message: `Calendar uses ${now.email}'s Google Calendar.`, moved: 0 };

  // Where the old events are: the studio's account, or Calendar's own when it's still signed in
  const from = !was.own ? "main" : before ? null : "calendar";
  const synced = await readSetting(env, SYNCED_KEY);
  let syncNote = "";
  try {
    const reset = await resetCalendarSync(env, { sameAccount: !synced || same(synced, now.email) });
    await writeSetting(env, SYNCED_KEY, now.email).run();
    syncNote = reset.studio === "kept" || reset.studio === "found" ? " Its Novacane Studio calendar was found and is kept in step." : " A Novacane Studio calendar is made there on the next sync.";
  } catch (err) {
    console.log("Couldn't start Calendar's sync afresh:", err?.message);
    syncNote = ` Calendar's sync couldn't start afresh just now (${String(err?.message || err).slice(0, 120)}).`;
  }
  const { moved, missed } = await moveBookingsToCalendar(env, { to: now.own ? "calendar" : "main", from });
  let told = 0;
  for (const b of moved) {
    if (await tellCalendarOwner(env, b, `Booking in your calendar: ${fullName(b)}`, ["This booking is now in your Google Calendar."])) told++;
  }
  const n = moved.length;
  return {
    ok: missed === 0,
    moved: n,
    message:
      `Calendar now uses ${now.email}'s Google Calendar. ` +
      `${n ? `${n} booking${n === 1 ? "" : "s"} still to come moved in${from ? "" : " (the old copies stay in the old account: its sign-in was replaced)"}.` : "No bookings to move."}` +
      (missed ? ` ${missed} couldn't be moved: try the switch again in a minute.` : "") +
      (told ? ` ${now.email} was emailed about ${told === 1 ? "it" : "each one"}.` : "") +
      syncNote,
  };
}

// Forget Calendar's own account: Calendar goes back to the studio's first (bookings moved back)
export async function forgetOwnCalendar(env) {
  let message = "";
  if (await calendarOwn(env)) message = (await useCalendarAccount(env, "main")).message;
  await forgetCalendarAccount(env);
  return { ok: true, message: `Calendar's own account is forgotten.${message ? " " + message : ""}` };
}

// ===== A SIGN-IN LINK FOR SOMEONE ELSE =====
// The calendar's owner may not be on Portal: an admin makes a link (48 hours) and sends it to them.
// It only starts Calendar's own sign-in (/admin/google?invite=…), and is used up once that has worked.

const INVITE_KEY = "google_cal_invite";
const INVITE_HOURS = 48;

export async function makeCalendarInvite(env, origin, by) {
  const ticket = [...crypto.getRandomValues(new Uint8Array(24))].map((b) => b.toString(16).padStart(2, "0")).join("");
  await writeSetting(env, INVITE_KEY, JSON.stringify({ ticket, at: Date.now(), by })).run();
  return { url: `${origin}/admin/google?invite=${ticket}`, hours: INVITE_HOURS };
}

export async function calendarInviteOk(env, ticket) {
  if (!/^[0-9a-f]{48}$/.test(String(ticket))) return false;
  let saved = null;
  try {
    saved = JSON.parse((await readSetting(env, INVITE_KEY)) || "null");
  } catch {}
  return Boolean(saved && saved.ticket === ticket && Date.now() - saved.at < INVITE_HOURS * 3600_000);
}

export async function forgetCalendarInvite(env) {
  await env.DB.prepare("DELETE FROM settings WHERE key = ?").bind(INVITE_KEY).run();
}

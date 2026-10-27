// Calendar's own Google account (Portal → Admin → Google → Calendar account): calls to the Calendar
// API go with that account's token, switching moves the bookings still to come and emails the
// calendar's owner, and the studio's account keeps Gmail.

import { env } from "cloudflare:test";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { bookAndAskForDeposit, createBooking, getBooking } from "../src/nova/bookings.js";
import { keepCalendarRefreshToken } from "../src/nova/google-keys.js";
import { calendarAccount, consentUrl, forgetGoogleToken } from "../src/nova/google.js";
import { forgetOwnCalendar, useCalendarAccount } from "../src/google/calendar-account.js";
import { clearTables, connectGoogle, installFakes, makeGoogle, ukDay } from "./fakes.js";

// Two Google accounts: the studio's (refresh token rt-test) and the engineer's (rt-engineer), each
// with its own calendar; Gmail is the studio's
function twoAccounts() {
  const main = makeGoogle();
  const engineer = makeGoogle();
  engineer.nextId = 500;
  const lists = { main: [], engineer: [{ id: "studio-cal@group.calendar.google.com", summary: "Novacane Studio" }] };
  const who = (init) => (String(init.headers?.Authorization || "").includes("rt-engineer") ? "engineer" : "main");
  return {
    main,
    engineer,
    lists,
    async handle(url, init = {}) {
      const u = new URL(url);
      if (u.hostname === "oauth2.googleapis.com" && u.pathname === "/token") {
        const refresh = new URLSearchParams(String(init.body)).get("refresh_token");
        return Response.json({ access_token: `ya29.${refresh}`, expires_in: 3600 });
      }
      if (u.hostname === "www.googleapis.com" && u.pathname === "/calendar/v3/users/me/calendarList") return Response.json({ items: lists[who(init)] });
      if (u.hostname === "www.googleapis.com" && u.pathname.startsWith("/calendar/v3")) return (who(init) === "engineer" ? engineer : main).handle(url, init);
      if (u.hostname === "gmail.googleapis.com") {
        if (who(init) !== "main") return Response.json({ error: { message: "wrong account" } }, { status: 403 });
        return main.handle(url, init);
      }
      return null;
    },
  };
}

const TYPE = { id: 1, name: "Rap Package - 4 songs", duration: 240, changeover: 0, price: 400 };
const person = { firstName: "Emmanuel", lastName: "Adenmosun", email: "emmanuel@example.com", phone: "07700 900123" };

let g;
beforeEach(async () => {
  await clearTables();
  await env.DB.prepare("DELETE FROM google_links").run();
  g = twoAccounts();
  installFakes({ google: g });
  await connectGoogle();
});
afterEach(() => {
  vi.restoreAllMocks();
  forgetGoogleToken();
});

async function signInEngineer() {
  await env.DB.batch([
    await keepCalendarRefreshToken(env, "rt-engineer"),
    env.DB.prepare("INSERT INTO settings (key, value) VALUES ('google_cal_account', 'engineer@gmail.test') ON CONFLICT (key) DO UPDATE SET value = excluded.value"),
  ]);
}

describe("Calendar's own account", () => {
  it("asks Google for Calendar alone, letting them pick the account", async () => {
    const url = new URL(await consentUrl(env, "https://nova.test", "s1", { calendar: true }));
    expect(url.searchParams.get("scope")).toBe("https://www.googleapis.com/auth/calendar openid email");
    expect(url.searchParams.get("prompt")).toContain("select_account");
  });

  it("moves the bookings still to come into his calendar, out of the studio's, and emails him", async () => {
    const { booking } = await createBooking(env, { type: TYPE, date: ukDay(3), time: "12:30", person, source: "chat", skipCheck: true });
    expect(g.main.events.has(booking.event_id)).toBe(true);

    await signInEngineer();
    const out = await useCalendarAccount(env, "own");
    expect(out.ok).toBe(true);
    expect(out.moved).toBe(1);
    expect(await calendarAccount(env)).toBe("engineer@gmail.test");

    const moved = await getBooking(env, booking.id);
    expect(g.engineer.events.has(moved.event_id)).toBe(true);
    expect(g.main.events.has(booking.event_id)).toBe(false);
    // Reminders on his phone: a day before and an hour before
    expect(g.engineer.events.get(moved.event_id).reminders.overrides.map((r) => r.minutes)).toEqual([1440, 60]);

    // He's emailed, from the studio's Gmail
    const mail = g.main.emails.find((m) => /engineer@gmail\.test/.test(m.to));
    expect(mail).toBeTruthy();
    expect(mail.subject).toContain("Booking in your calendar: Emmanuel Adenmosun");
    // His Novacane Studio calendar is found again (nothing doubled)
    const studio = await env.DB.prepare("SELECT value FROM settings WHERE key = 'google_studio_calendar'").first("value");
    expect(studio).toBe("studio-cal@group.calendar.google.com");
  });

  it("puts new bookings in his calendar and emails him about each one", async () => {
    await signInEngineer();
    await useCalendarAccount(env, "own");
    const { booking } = await bookAndAskForDeposit(env, { type: TYPE, date: ukDay(5), time: "10:00", person, source: "chat", skipCheck: true });
    expect(g.engineer.events.has(booking.event_id)).toBe(true);
    expect(g.main.events.size).toBe(0);
    const mail = g.main.emails.find((m) => /engineer@gmail\.test/.test(m.to));
    expect(mail.subject).toBe("Nova: New booking: Emmanuel Adenmosun");
    expect(mail.text).toContain("In your Google Calendar: https://calendar.google.com/event?eid=");
    // The client's own email still goes from the studio's Gmail too
    expect(g.main.emails.some((m) => /emmanuel@example\.com/.test(m.to))).toBe(true);
  });

  it("switches back to the studio's calendar, taking the bookings with it", async () => {
    await signInEngineer();
    await useCalendarAccount(env, "own");
    const { booking } = await createBooking(env, { type: TYPE, date: ukDay(4), time: "15:00", person, source: "chat", skipCheck: true });
    const out = await useCalendarAccount(env, "main");
    expect(out.moved).toBe(1);
    const back = await getBooking(env, booking.id);
    expect(g.main.events.has(back.event_id)).toBe(true);
    expect(g.engineer.events.has(booking.event_id)).toBe(false);
    expect(await calendarAccount(env)).toBe("studio@novacane.test");
  });

  it("forgetting it goes back to the studio's calendar", async () => {
    await signInEngineer();
    await useCalendarAccount(env, "own");
    await forgetOwnCalendar(env);
    expect(await calendarAccount(env)).toBe("studio@novacane.test");
    expect(await env.DB.prepare("SELECT value FROM settings WHERE key = 'google_cal_refresh_token_enc'").first("value")).toBeNull();
  });

  it("can't be switched on before it's signed in", async () => {
    const out = await useCalendarAccount(env, "own");
    expect(out.ok).toBe(false);
    expect(await calendarAccount(env)).toBe("studio@novacane.test");
  });

  it("leaves past and cancelled bookings where they are", async () => {
    const { booking } = await createBooking(env, { type: TYPE, date: ukDay(-3), time: "12:00", person, source: "chat", skipCheck: true });
    await signInEngineer();
    const out = await useCalendarAccount(env, "own");
    expect(out.moved).toBe(0);
    expect(g.main.events.has(booking.event_id)).toBe(true);
  });
});

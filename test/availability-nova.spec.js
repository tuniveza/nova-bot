import { env } from "cloudflare:test";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  bookingLink,
  checkAvailability,
  dayInWords,
  describeDay,
  freeStarts,
  freeTimesOn,
  getSessionTypes,
  makeBookingLink,
  normaliseTime,
  sessionList,
} from "../src/nova/booking.js";
import { getType } from "../src/nova/studio.js";
import { clearTables, connectGoogle, installFakes, ukDay, ukEvent, ukIso } from "./fakes.js";

const VOICE_1H = 12738216; // 60 minutes + 30 minutes changeover
const RENTAL_8H = 11846238; // 480 minutes, no changeover
const RAP_2 = 64806309; // 240 minutes + 30 changeover

let fakes;
beforeEach(async () => {
  await clearTables();
  fakes = installFakes();
  await connectGoogle();
});
afterEach(() => vi.restoreAllMocks());

describe("sessions", () => {
  it("has the studio's 13 sessions with prices and total lengths", () => {
    const types = getSessionTypes();
    expect(types).toHaveLength(13);
    expect(types.find((t) => t.id === RAP_2)).toMatchObject({ price: "£200", duration: 240, changeover: 30 });
    expect(types.find((t) => t.id === RENTAL_8H)).toMatchObject({ price: "£200", duration: 480, changeover: 0 });
    const list = sessionList(types);
    expect(list).toContain(`${RAP_2}: Rap Package - 2 songs`);
    expect(list).toContain("4 hours in total, £200");
  });

  it("reads times the way people write them", () => {
    expect(normaliseTime("2pm")).toBe("14:00");
    expect(normaliseTime("9:30am")).toBe("09:30");
    expect(normaliseTime("1430")).toBe("14:30");
    expect(normaliseTime("12am")).toBe("00:00");
    expect(normaliseTime("25:00")).toBe("");
  });
});

describe("free times", () => {
  it("offers every half hour from opening, leaving room for the session and its changeover before closing", async () => {
    const day = ukDay(10);
    const free = (await freeStarts(env, getType(VOICE_1H), day, day))[day];
    const times = Object.keys(free);
    // 1 hour + 30 minutes changeover must end by 23:00: last start 21:30
    expect(times[0]).toBe("10:00");
    expect(times.at(-1)).toBe("21:30");
    expect(times).toHaveLength(24);
    expect(free["14:00"]).toBe(ukIso(day, "14:00"));
    // 8 hours, no changeover: last start 15:00
    const rental = Object.keys((await freeStarts(env, getType(RENTAL_8H), day, day))[day]);
    expect(rental.at(-1)).toBe("15:00");
  });

  it("leaves out anything busy in Google Calendar, but not events marked free or declined", async () => {
    const day = ukDay(10);
    fakes.google.add(ukEvent(day, "12:00", "14:00", { summary: "Mix session" }));
    fakes.google.add(ukEvent(day, "16:00", "17:00", { transparency: "transparent" }));
    fakes.google.add(ukEvent(day, "18:00", "19:00", { attendees: [{ self: true, responseStatus: "declined" }] }));
    const times = Object.keys((await freeStarts(env, getType(VOICE_1H), day, day))[day]);
    // 10:30 + 1h + 30m changeover = 12:00, just fits; 11:00 would run into the event
    expect(times).toContain("10:30");
    expect(times).not.toContain("11:00");
    expect(times).not.toContain("12:00");
    expect(times).not.toContain("13:30");
    expect(times).toContain("14:00");
    expect(times).toContain("16:00"); // marked free
    expect(times).toContain("18:00"); // declined
  });

  it("keeps a booking's changeover free after it", async () => {
    const day = ukDay(10);
    const now = new Date().toISOString();
    await env.DB.prepare(
      `INSERT INTO bookings (token, status, source, type_id, session, duration, changeover, starts_at, ends_at, first_name, last_name, email, created_at, updated_at)
       VALUES ('tok-aaaaaaaaaaaaaaaaaaaaaaaa', 'booked', 'website', ?, 'Voiceover', 60, 30, ?, ?, 'A', 'B', 'a@b.co', ?, ?)`
    )
      .bind(VOICE_1H, ukIso(day, "14:00"), ukIso(day, "15:00"), now, now)
      .run();
    const times = Object.keys((await freeStarts(env, getType(RENTAL_8H), day, day))[day] || {});
    // A rental can't start until the changeover ends at 15:30 (and can't overlap 14:00–15:30)
    expect(times).not.toContain("15:00");
    const evening = Object.keys((await freeStarts(env, getType(VOICE_1H), day, day))[day]);
    expect(evening).not.toContain("15:00");
    expect(evening).toContain("15:30");
  });

  it("never offers a time sooner than an hour from now, or a day in the past", async () => {
    const today = ukDay(0);
    const all = Object.values((await freeStarts(env, getType(VOICE_1H), today, today))[today] || {});
    expect(all.every((iso) => Date.parse(iso) >= Date.now() + 59 * 60_000)).toBe(true);
    expect(await freeTimesOn(env, VOICE_1H, ukDay(-1))).toEqual({ problem: "That day can't be booked." });
  });

  it("asks Google once and remembers it briefly", async () => {
    const day = ukDay(12);
    await freeTimesOn(env, VOICE_1H, day);
    await freeTimesOn(env, VOICE_1H, day);
    expect(fakes.google.calls.filter((c) => c.endsWith("/events")).length).toBe(1);
  });
});

describe("check_availability for NovaBot", () => {
  it("lists free start times by part of the day, with the booking link", async () => {
    const from = ukDay(10);
    const to = ukDay(11);
    fakes.google.add(ukEvent(from, "10:00", "23:00", { summary: "Closed for a private event" }));
    const result = await checkAvailability(env, { session_type_id: RAP_2, from_date: from, to_date: to, first_name: "Jo" });
    expect(result.ok).toBe(true);
    expect(result.message).not.toContain(`- ${dayInWords(from)}:`); // the closed day isn't listed
    expect(result.message).toContain("morning: starts 10:00 to 11:30 (every 30 minutes), finishing 14:00 to 15:30");
    expect(result.url).toBe(`https://novacane-worker.test/book?session=${RAP_2}&first=Jo`);
  });

  it("says clearly when nothing is free", async () => {
    const day = ukDay(10);
    fakes.google.add(ukEvent(day, "09:00", "23:30"));
    const result = await checkAvailability(env, { session_type_id: RAP_2, from_date: day, to_date: day });
    expect(result.message).toContain("No free start times");
  });
});

describe("booking links", () => {
  it("open the booking page on the session, with their details", () => {
    expect(bookingLink(env, RAP_2, { firstName: "Kai", lastName: "Lee", email: "kai@x.co", phone: "07700 900000" })).toBe(
      `https://novacane-worker.test/book?session=${RAP_2}&first=Kai&last=Lee&email=kai%40x.co&phone=07700+900000`
    );
  });

  it("selects the time if it shows as free", async () => {
    const day = ukDay(10);
    const result = await makeBookingLink(env, { session_type_id: RAP_2, date: day, time: "2pm", first_name: "Kai" });
    expect(result.ok).toBe(true);
    expect(result.url).toBe(`https://novacane-worker.test/book?session=${RAP_2}&date=${day}&time=14%3A00&first=Kai`);
    expect(result.message).toContain("already selected");
  });

  it("offers real alternatives when the time isn't free", async () => {
    const day = ukDay(10);
    fakes.google.add(ukEvent(day, "13:00", "15:00"));
    const result = await makeBookingLink(env, { session_type_id: RAP_2, date: day, time: "14:00" });
    expect(result.ok).toBe(false);
    expect(result.message).toContain("isn't showing as free");
    expect(result.message).toContain("Free start times that day");
    expect(result.message).toContain("Nearest days with free times");
  });

  it("refuses a session that doesn't exist", async () => {
    expect((await makeBookingLink(env, { session_type_id: 1 })).ok).toBe(false);
  });

  it("describes a day's times compactly", () => {
    expect(describeDay(["10:00", "10:30", "11:00", "18:00"], 60)).toBe(
      "morning: starts 10:00 to 11:00 (every 30 minutes), finishing 11:00 to 12:00; afternoon: none; evening: starts 18:00, finishing 19:00"
    );
  });
});

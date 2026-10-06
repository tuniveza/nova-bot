// Nova Club's /club/busy: busy times from Google Calendar and our bookings
// (with their changeover), cached until something changes, and freed times
// reported as cancelled for an hour.

import { createExecutionContext, env, waitOnExecutionContext } from "cloudflare:test";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import worker from "../src";
import { bookSession } from "../src/nova/book-session.js";
import { cancelBooking, getBooking } from "../src/nova/bookings.js";
import { BASE, clearTables, connectGoogle, installFakes, ukDay, ukEvent, ukIso } from "./fakes.js";

const VOICE_1H = 12738216; // 1 hour + 30 minutes changeover

let fakes;
beforeEach(async () => {
  await clearTables();
  fakes = installFakes();
  await connectGoogle();
});
afterEach(() => vi.restoreAllMocks());

async function busy(from = ukDay(5), until = ukDay(20)) {
  const ctx = createExecutionContext();
  const res = await worker.fetch(new Request(`${BASE}/club/busy?from=${from}&until=${until}`, { headers: { "CF-Connecting-IP": "203.0.113.50" } }), env, ctx);
  await waitOnExecutionContext(ctx);
  return { status: res.status, body: await res.json() };
}

describe("Nova Club's busy times", () => {
  it("sends only times: calendar events, and bookings with their changeover", async () => {
    const day = ukDay(10);
    fakes.google.add(ukEvent(day, "10:00", "12:00", { summary: "Private: Kai's session" }));
    fakes.google.add(ukEvent(day, "13:00", "14:00", { transparency: "transparent" }));
    const out = await bookSession(env, { session_type_id: VOICE_1H, date: day, time: "15:00", first_name: "A", last_name: "B", email: "a@b.co", phone: "1" }, { ip: "x", staff: true });
    expect(out.ok).toBe(true);
    const { status, body } = await busy();
    expect(status).toBe(200);
    expect(body.busy).toEqual([
      [Date.parse(ukIso(day, "10:00")), Date.parse(ukIso(day, "12:00"))],
      [Date.parse(ukIso(day, "15:00")), Date.parse(ukIso(day, "16:30"))],
    ]);
    expect(JSON.stringify(body)).not.toContain("Kai");
  });

  it("reuses its copy until a booking changes, and reports freed times as cancelled", async () => {
    const day = ukDay(10);
    const out = await bookSession(env, { session_type_id: VOICE_1H, date: day, time: "15:00", first_name: "A", last_name: "B", email: "a@b.co", phone: "1" }, { ip: "x", staff: true });
    await busy();
    const lookups = fakes.google.calls.filter((c) => c.endsWith("/events") && c.startsWith("GET")).length;
    await busy();
    expect(fakes.google.calls.filter((c) => c.endsWith("/events") && c.startsWith("GET")).length).toBe(lookups);

    await cancelBooking(env, await getBooking(env, out.booked.id), { by: "staff", notify: false });
    const { body } = await busy();
    expect(body.busy).toEqual([]);
    expect(body.cancelled).toEqual([[Date.parse(ukIso(day, "15:00")), Date.parse(ukIso(day, "16:30"))]]);
  });

  it("checks its dates, and says when the calendar isn't connected", async () => {
    expect((await busy("2026-01-01", "2026-12-31")).status).toBe(400);
    await env.DB.prepare("DELETE FROM settings WHERE key LIKE 'google_%'").run();
    expect((await busy()).status).toBe(503);
  });

  it("keeps answering with its last copy when Google is down", async () => {
    await busy();
    await env.DB.prepare("INSERT INTO club_calendar (span, fetched_at, busy) VALUES ('changed', ?, NULL) ON CONFLICT (span) DO UPDATE SET fetched_at = excluded.fetched_at").bind(Date.now() + 1000).run();
    fakes.google.failCalendar = true;
    const { status, body } = await busy();
    expect(status).toBe(200);
    expect(body.busy).toEqual([]);
  });
});

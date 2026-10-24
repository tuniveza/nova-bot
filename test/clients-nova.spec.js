// The client list from Nova's own bookings (src/clients.js, nova/bookings.js): every real booking
// makes or finds its client and keeps its session up to date (moved, cancelled), a booking brought
// over from Acuity lands on the client's Acuity history, and the 30-minute sync reads the bookings
// table, never Acuity's feed.

import { env } from "cloudflare:test";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { bookingSessionKey, clientDetail, listClients, syncClients } from "../src/clients.js";
import { bookSession } from "../src/nova/book-session.js";
import { cancelBooking, createBooking, getBooking, moveBooking, updateDetails } from "../src/nova/bookings.js";
import { getType } from "../src/nova/studio.js";
import { clearTables, connectGoogle, installFakes, ukDay, ukIso } from "./fakes.js";

const RAP_2 = 64806309;

let fakes;
beforeEach(async () => {
  await clearTables();
  fakes = installFakes();
  await connectGoogle();
});
afterEach(() => vi.restoreAllMocks());

async function makeBooking({ day = ukDay(10), time = "14:00", first = "Dana", last = "Hollis", email = "dana@example.com", phone = "07700 900111" } = {}) {
  const out = await bookSession(env, { session_type_id: RAP_2, date: day, time, first_name: first, last_name: last, email, phone }, { ip: "staff", staff: true });
  expect(out.ok).toBe(true);
  return getBooking(env, out.booked.id);
}
const sessions = async () => (await env.DB.prepare("SELECT * FROM client_sessions ORDER BY id").all()).results;
const clients = async () => (await env.DB.prepare("SELECT * FROM clients ORDER BY id").all()).results;

describe("a Nova booking and its client", () => {
  it("a new booking makes its client and session", async () => {
    const b = await makeBooking();
    const [c] = await clients();
    expect(c).toMatchObject({ name: "Dana Hollis", email: "dana@example.com", phone: "07700 900111", source: "booking", marketing_consent: 0 });
    expect(await sessions()).toEqual([expect.objectContaining({ acuity_id: -b.id, client_id: c.id, session: b.session, starts_at: b.starts_at, ends_at: b.ends_at, price: "£200", status: "booked" })]);
    const { clients: list } = await listClients(env);
    expect(list[0]).toMatchObject({ name: "Dana Hollis", sessionCount: 1, nextBooked: b.starts_at });
    expect((await clientDetail(env, c.id)).sessions).toHaveLength(1);
  });

  it("the same person booking again is the same client; moving and cancelling follow", async () => {
    const first = await makeBooking();
    const second = await makeBooking({ day: ukDay(12), email: "DANA@example.com" });
    expect(await clients()).toHaveLength(1);
    expect(await sessions()).toHaveLength(2);

    await moveBooking(env, first, { date: ukDay(11), time: "10:00", by: "staff", notify: false });
    expect((await sessions())[0].starts_at).toBe(ukIso(ukDay(11), "10:00"));
    await cancelBooking(env, await getBooking(env, second.id), { by: "staff", notify: false });
    expect((await sessions())[1].status).toBe("cancelled");
    // Staff changing the booking's email doesn't move the session to someone else
    await updateDetails(env, await getBooking(env, first.id), { email: "dana.new@example.com" });
    expect(await clients()).toHaveLength(1);
    const [c] = await clients();
    expect((await sessions()).map((s) => s.client_id)).toEqual([c.id, c.id]);
  });

  it("test bookings and unpaid holds aren't clients", async () => {
    const type = getType(RAP_2);
    await createBooking(env, { type, date: ukDay(14), time: "12:00", person: { firstName: "Hold", lastName: "Only", email: "hold@example.com" }, source: "website", status: "hold" });
    await createBooking(env, { type, date: ukDay(15), time: "12:00", person: { firstName: "Nova", lastName: "TEST", email: "test@example.com" }, source: "staff", test: { by: "test-admin", blocks: false } });
    expect(await clients()).toHaveLength(0);
    expect(await sessions()).toHaveLength(0);
  });

  it("a booking brought over from Acuity lands on the client's Acuity history (no second session)", async () => {
    // What the old Acuity sync left: Dana, with Acuity booking #1782089433
    const now = new Date().toISOString();
    const start = ukIso(ukDay(10), "14:00");
    const { meta } = await env.DB.prepare("INSERT INTO clients (name, email, phone, phone_key, source, created_at, updated_at, updated_by) VALUES ('Dana Hollis', 'dana@example.com', NULL, NULL, 'booking', ?, ?, 'acuity')").bind(now, now).run();
    await env.DB.prepare("INSERT INTO client_sessions (acuity_id, client_id, session, starts_at, ends_at, price, status, source, updated_at) VALUES (1782089433, ?, 'Rap Package - 2 songs', ?, NULL, '£200.00', 'booked', 'feed', ?)").bind(meta.last_row_id, start, now).run();
    const made = await createBooking(env, {
      type: { ...getType(RAP_2) },
      date: ukDay(10),
      time: "14:00",
      person: { firstName: "Dana", lastName: "Hollis", email: "dana@example.com", phone: "07700 900111" },
      source: "acuity",
      sender: "acuity:1782089433",
      skipCheck: true,
      keepOnClash: true,
    });
    expect(bookingSessionKey(made.booking)).toBe(1782089433);
    const rows = await sessions();
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ acuity_id: 1782089433, client_id: meta.last_row_id, status: "booked", source: "feed" });
    // The phone was missing: filled in from the booking
    expect((await clients())[0].phone).toBe("07700 900111");
  });
});

describe("the 30-minute sync", () => {
  it("reads the bookings table and the enquiries, never Acuity's feed", async () => {
    const b = await makeBooking();
    await env.DB.batch([env.DB.prepare("DELETE FROM client_sessions"), env.DB.prepare("DELETE FROM clients")]);
    await env.DB.prepare("INSERT INTO enquiries (created_at, name, email, details, status) VALUES (?, 'Kai Moss', 'kai@example.com', 'A mix', 'new')").bind(new Date().toISOString()).run();
    const result = await syncClients({ ...env, ACUITY_CALENDAR_URL: "https://calendar.test/never-read" });
    expect(result.clients.added).toBe(2);
    expect(result.sessions.added).toBe(1);
    expect((await sessions())[0].acuity_id).toBe(-b.id);
    expect(fetch.mock.calls.some(([url]) => String(url).includes("calendar.test"))).toBe(false);
    // Twice changes nothing
    const again = await syncClients(env);
    expect(again.clients.added + again.clients.updated + again.sessions.added + again.sessions.updated).toBe(0);
  });
});

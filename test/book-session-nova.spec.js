// NovaBot booking for people: book_session (Nova Hub's staff chat) and the
// booking card on the website. Both go straight into Google Calendar and email
// a confirmation with a link to pay the deposit.

import { createExecutionContext, env, waitOnExecutionContext } from "cloudflare:test";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import worker from "../src";
import { bookSession, canBookSessions } from "../src/nova/book-session.js";
import { getBooking } from "../src/nova/bookings.js";
import { BASE, clearTables, connectGoogle, installFakes, says, toolUse, ukDay, ukEvent, ukIso } from "./fakes.js";

const RAP_2 = 64806309;
const VOICE_1H = 12738216;

let fakes;
let ip;
beforeEach(async () => {
  await clearTables();
  fakes = installFakes();
  await connectGoogle();
  ip = `192.0.${Math.floor(Math.random() * 250)}.${Math.floor(Math.random() * 250)}`;
});
afterEach(() => vi.restoreAllMocks());

const person = { first_name: "Ola", last_name: "Ade", email: "ola@example.com", phone: "07700 900456" };

describe("book_session", () => {
  it("is only offered when Google and Stripe are connected", async () => {
    expect(await canBookSessions(env)).toBe(true);
    await env.DB.prepare("DELETE FROM settings WHERE key LIKE 'google_%'").run();
    expect(await canBookSessions(env)).toBe(false);
    const out = await bookSession(env, { session_type_id: RAP_2, date: ukDay(10), time: "14:00", ...person }, { ip });
    expect(out.ok).toBe(false);
  });

  it("books it straight into the calendar and emails a confirmation with the deposit link", async () => {
    const day = ukDay(10);
    const out = await bookSession(env, { session_type_id: RAP_2, date: day, time: "2pm", ...person, notes: "Bringing a guitarist" }, { ip, chatId: "chat-12345678" });
    expect(out.ok).toBe(true);
    expect(out.message).toMatch(/^Booked \(#\d+\)/);
    const b = await getBooking(env, out.booked.id);
    expect(b).toMatchObject({ status: "booked", source: "chat", paid_pence: 0, deposit_pence: 10000, starts_at: ukIso(day, "14:00"), notes: "Bringing a guitarist", chat_id: "chat-12345678" });
    expect(fakes.google.events.get(b.event_id).status).toBe("confirmed");
    const email = fakes.google.emails[0];
    expect(email.subject).toMatch(/^You're booked in/);
    expect(email.text).toContain(`Pay the deposit: ${BASE}/pay/${b.token}?for=deposit`);
  });

  it("doesn't book the same session twice", async () => {
    const input = { session_type_id: RAP_2, date: ukDay(10), time: "14:00", ...person };
    await bookSession(env, input, { ip });
    const again = await bookSession(env, input, { ip });
    expect(again.message).toContain("Already booked");
    expect((await env.DB.prepare("SELECT COUNT(*) AS n FROM bookings").first()).n).toBe(1);
  });

  it("says when the time has just been taken", async () => {
    const day = ukDay(10);
    fakes.google.add(ukEvent(day, "14:00", "15:00"));
    const out = await bookSession(env, { session_type_id: VOICE_1H, date: day, time: "14:00", ...person }, { ip });
    expect(out).toMatchObject({ ok: false, field: "time" });
    expect(out.message).toContain("check_availability");
  });

  it("says which box needs fixing, in words for the customer", async () => {
    const base = { session_type_id: RAP_2, date: ukDay(10), time: "14:00", ...person };
    expect(await bookSession(env, { ...base, email: "ola@" }, { ip })).toMatchObject({ ok: false, field: "email" });
    expect(await bookSession(env, { ...base, last_name: "" }, { ip })).toMatchObject({ ok: false, field: "name" });
    expect(await bookSession(env, { ...base, phone: " " }, { ip })).toMatchObject({ ok: false, field: "phone" });
  });

  it("books at most 2 sessions per visitor a day on the website, but staff have no limit", async () => {
    for (let i = 0; i < 2; i++) expect((await bookSession(env, { session_type_id: VOICE_1H, date: ukDay(10 + i), time: "11:00", ...person }, { ip })).ok).toBe(true);
    const third = await bookSession(env, { session_type_id: VOICE_1H, date: ukDay(13), time: "11:00", ...person }, { ip });
    expect(third.ok).toBe(false);
    expect(third.url).toContain("/book?session=");
    expect((await bookSession(env, { session_type_id: VOICE_1H, date: ukDay(14), time: "11:00", ...person }, { ip, staff: true })).ok).toBe(true);
  });

  it("works from Nova Hub's staff chat", async () => {
    const login = await worker.fetch(new Request(`${BASE}/app/api/login`, { method: "POST", headers: { Origin: BASE, "Content-Type": "application/json" }, body: JSON.stringify({ password: "test-admin-password" }) }), env, createExecutionContext());
    const cookie = login.headers.get("Set-Cookie").split(";")[0];
    fakes.claude.replies.push(toolUse("book_session", { session_type_id: RAP_2, date: ukDay(10), time: "14:00", ...person }), says("Booked! Ola's confirmation is on its way."));
    const ctx = createExecutionContext();
    const res = await worker.fetch(
      new Request(`${BASE}/app/api/chat`, { method: "POST", headers: { Origin: BASE, Cookie: cookie, "Content-Type": "application/json" }, body: JSON.stringify({ messages: [{ role: "user", content: "Book Ola in for rap 2 songs" }] }) }),
      env,
      ctx
    );
    await waitOnExecutionContext(ctx);
    expect((await res.json()).reply).toContain("Booked");
    const toolNames = fakes.claude.calls[0].tools.map((t) => t.name);
    expect(toolNames).toEqual(expect.arrayContaining(["book_session", "find_bookings", "cancel_booking", "send_payment_link", "refund_payment"]));
    expect((await env.DB.prepare("SELECT source FROM bookings").first()).source).toBe("staff");
  });
});

describe("the website's booking card", () => {
  async function card(path, body) {
    const ctx = createExecutionContext();
    const res = await worker.fetch(
      new Request(BASE.replace("novacane-worker.test", "x") + path, { method: "POST", headers: { Origin: "https://novacane.co.uk", "CF-Connecting-IP": ip, "Content-Type": "application/json" }, body: JSON.stringify(body) }),
      env,
      ctx
    );
    await waitOnExecutionContext(ctx);
    return res.json();
  }

  it("opens with every session, and none when booking isn't connected", async () => {
    const { form } = await card("/booking-form/open", { session_type_id: RAP_2, first_name: "Ola" });
    expect(form.sessions).toHaveLength(13);
    expect(form).toMatchObject({ session_type_id: RAP_2, first_name: "Ola" });
    await env.DB.prepare("DELETE FROM settings WHERE key LIKE 'google_%'").run();
    expect((await card("/booking-form/open", {})).form).toBeNull();
  });

  it("shows free times and books, offering to pay the deposit straight away", async () => {
    const day = ukDay(10);
    const { times } = await card("/booking-form/times", { session_type_id: VOICE_1H, date: day });
    expect(times[0]).toBe("10:00");
    const out = await card("/booking-form/book", { chatId: "chat-abcdefgh", session_type_id: VOICE_1H, date: day, time: "10:00", ...person });
    expect(out.ok).toBe(true);
    expect(out.message).toContain("£40 deposit");
    const b = await env.DB.prepare("SELECT * FROM bookings").first();
    expect(out.pay).toEqual({ url: `${BASE}/pay/${b.token}?for=deposit`, label: "Pay the £40 deposit now" });
  });
});

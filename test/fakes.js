// Stand-ins for Google (OAuth, Calendar, Gmail), Stripe and Claude, so tests
// never reach the internet. Install them with installFakes() in beforeEach.

import { env } from "cloudflare:test";
import { vi } from "vitest";
import { forgetSessionTypes } from "../src/nova/booking.js";
import { forgetGoogleToken } from "../src/nova/google.js";
import { hmacHex } from "../src/nova/stripe.js";

export const BASE = "https://novacane-worker.test";

// ----- Google -----

export function makeGoogle() {
  const g = {
    events: new Map(), // id -> event
    emails: [], // { raw, to, subject, text, html, attachments }
    calls: [], // "METHOD path"
    failCalendar: false,
    failGmail: false,
    nextId: 1,
  };
  g.add = (event) => {
    const id = event.id || `evt${g.nextId++}`;
    g.events.set(id, { status: "confirmed", ...event, id, htmlLink: `https://calendar.google.com/event?eid=${id}` });
    return id;
  };
  g.handle = async (url, init = {}) => {
    const u = new URL(url);
    const method = (init.method || "GET").toUpperCase();
    if (u.hostname === "oauth2.googleapis.com" && u.pathname === "/token") {
      g.calls.push("POST token");
      return Response.json({ access_token: "ya29.test-access", expires_in: 3600, token_type: "Bearer" });
    }
    if (u.hostname === "www.googleapis.com" && u.pathname.startsWith("/calendar/v3")) {
      g.calls.push(`${method} ${u.pathname}`);
      if (g.failCalendar) return Response.json({ error: { message: "Backend Error" } }, { status: 503 });
      if (u.pathname === "/calendar/v3/freeBusy") {
        const body = JSON.parse(init.body);
        const busy = overlapping(g, Date.parse(body.timeMin), Date.parse(body.timeMax)).filter((e) => e.transparency !== "transparent").map((e) => ({ start: e.start.dateTime, end: e.end.dateTime }));
        return Response.json({ calendars: { primary: { busy } } });
      }
      const m = u.pathname.match(/^\/calendar\/v3\/calendars\/([^/]+)\/events(?:\/([^/]+))?$/);
      if (m) {
        const id = m[2] ? decodeURIComponent(m[2]) : null;
        if (!id && method === "GET") {
          const items = overlapping(g, Date.parse(u.searchParams.get("timeMin")), Date.parse(u.searchParams.get("timeMax"))).sort((a, b) => spanOf(a)[0] - spanOf(b)[0]);
          return Response.json({ items });
        }
        if (!id && method === "POST") {
          const newId = g.add(JSON.parse(init.body));
          return Response.json(g.events.get(newId));
        }
        if (id && method === "PATCH") {
          if (!g.events.has(id)) return Response.json({ error: { message: "Not Found" } }, { status: 404 });
          const patch = JSON.parse(init.body);
          g.events.set(id, { ...g.events.get(id), ...patch });
          return Response.json(g.events.get(id));
        }
        if (id && method === "DELETE") {
          if (!g.events.has(id)) return Response.json({ error: { message: "Resource has been deleted" } }, { status: 410 });
          g.events.delete(id);
          return new Response(null, { status: 204 });
        }
      }
    }
    if (u.hostname === "gmail.googleapis.com" && u.pathname === "/gmail/v1/users/me/messages/send") {
      g.calls.push("POST gmail");
      if (g.failGmail) return Response.json({ error: { message: "Insufficient Permission" } }, { status: 403 });
      const raw = JSON.parse(init.body).raw;
      g.emails.push(readMime(raw));
      return Response.json({ id: `msg${g.emails.length}` });
    }
    return null;
  };
  return g;
}

const spanOf = (e) => [Date.parse(e.start.dateTime || e.start.date), Date.parse(e.end.dateTime || e.end.date)];
function overlapping(g, from, until) {
  return [...g.events.values()].filter((e) => e.status !== "cancelled" && spanOf(e)[0] < until && spanOf(e)[1] > from);
}

// Unpack the MIME email the worker built, enough to check it
export function readMime(rawB64Url) {
  const raw = decodeB64(rawB64Url.replace(/-/g, "+").replace(/_/g, "/"));
  const header = (name) => (raw.match(new RegExp(`^${name}: (.*)$`, "m")) || [])[1] || "";
  const decodeSubject = (s) => s.replace(/=\?UTF-8\?B\?([^?]+)\?=/g, (_, b) => decodeB64(b));
  const parts = [...raw.matchAll(/Content-Type: ([^;\r\n]+)[^\r\n]*\r\n(?:Content-Disposition: [^\r\n]*\r\n)?Content-Transfer-Encoding: base64\r\n\r\n([A-Za-z0-9+/=\r\n]+)/g)].map((m) => ({
    type: m[1],
    content: decodeB64(m[2].replace(/\r\n/g, "")),
  }));
  return {
    raw,
    to: header("To"),
    from: header("From"),
    subject: decodeSubject(header("Subject")),
    text: parts.find((p) => p.type === "text/plain")?.content || "",
    html: parts.find((p) => p.type === "text/html")?.content || "",
    attachments: parts.filter((p) => p.type === "text/calendar"),
  };
}

function decodeB64(b64) {
  const bin = atob(b64);
  return new TextDecoder().decode(Uint8Array.from(bin, (c) => c.charCodeAt(0)));
}

// ----- Stripe -----

export function makeStripe() {
  const s = { sessions: [], refunds: [], expired: [], fail: false, n: 0 };
  s.handle = async (url, init = {}) => {
    const u = new URL(url);
    if (u.hostname !== "api.stripe.com") return null;
    if (s.fail) return Response.json({ error: { message: "Invalid API Key provided" } }, { status: 401 });
    const form = init.body ? Object.fromEntries(new URLSearchParams(init.body)) : {};
    if (u.pathname === "/v1/checkout/sessions" && init.method === "POST") {
      const id = `cs_test_${++s.n}`;
      const session = { id, url: `https://checkout.stripe.com/c/pay/${id}`, form };
      s.sessions.push(session);
      return Response.json({ id, url: session.url, object: "checkout.session" });
    }
    const exp = u.pathname.match(/^\/v1\/checkout\/sessions\/([^/]+)\/expire$/);
    if (exp) {
      s.expired.push(exp[1]);
      return Response.json({ id: exp[1], status: "expired" });
    }
    if (u.pathname === "/v1/refunds") {
      const id = `re_test_${++s.n}`;
      s.refunds.push({ id, paymentIntent: form.payment_intent, amount: Number(form.amount) });
      return Response.json({ id, status: "succeeded" });
    }
    if (u.pathname === "/v1/balance") return Response.json({ object: "balance" });
    return Response.json({ error: { message: "No such route" } }, { status: 404 });
  };
  return s;
}

// A webhook from "Stripe", signed with the test secret
export async function stripeWebhook(event, { secret = env.STRIPE_WEBHOOK_SECRET, t = Math.floor(Date.now() / 1000) } = {}) {
  const payload = JSON.stringify(event);
  const sig = await hmacHex(secret, `${t}.${payload}`);
  return new Request(`${BASE}/stripe/webhook`, { method: "POST", headers: { "Stripe-Signature": `t=${t},v1=${sig}`, "Content-Type": "application/json" }, body: payload });
}

export const paidEvent = (bookingId, amount, { pi = `pi_test_${bookingId}_${amount}`, purpose = "deposit", id = "cs_test_1" } = {}) => ({
  id: `evt_${crypto.randomUUID()}`,
  type: "checkout.session.completed",
  data: { object: { id, object: "checkout.session", payment_status: "paid", amount_total: amount, payment_intent: pi, metadata: { booking_id: String(bookingId), purpose }, client_reference_id: String(bookingId) } },
});

// ----- Claude -----

export function makeClaude() {
  const c = { replies: [], calls: [] };
  c.handle = async (url, init = {}) => {
    if (String(url) !== "https://api.anthropic.com/v1/messages") return null;
    c.calls.push(JSON.parse(init.body));
    const next = c.replies.shift();
    return next ? Response.json(next) : new Response("overloaded", { status: 529 });
  };
  return c;
}

export const toolUse = (name, input, id = "tool1") => ({ stop_reason: "tool_use", content: [{ type: "tool_use", id, name, input }] });
export const says = (text) => ({ stop_reason: "end_turn", content: [{ type: "text", text }] });

// ----- Everything together -----

// Replace fetch with the fakes; anything else throws, so a test can't reach the internet
export function installFakes({ google = makeGoogle(), stripe = makeStripe(), claude = makeClaude(), push = [] } = {}) {
  forgetSessionTypes();
  forgetGoogleToken();
  vi.spyOn(globalThis, "fetch").mockImplementation(async (url, init) => {
    for (const fake of [google, stripe, claude]) {
      const res = await fake.handle(String(url), init || {});
      if (res) return res;
    }
    // Push services (Apple/Google): accept and record
    if (/push\.apple\.com|fcm\.googleapis\.com/.test(String(url))) {
      push.push({ url: String(url) });
      return new Response(null, { status: 201 });
    }
    throw new Error("Unexpected fetch in test: " + url);
  });
  return { google, stripe, claude, push };
}

// Google counts as connected once a refresh token is saved. Nova specs also
// turn the booking system switch to Nova (mode.js); `nova: false` leaves it.
export async function connectGoogle(e = env, { nova = true } = {}) {
  if (nova) await useNova(e);
  await e.DB.batch([
    e.DB.prepare("INSERT INTO settings (key, value) VALUES ('google_refresh_token', 'rt-test') ON CONFLICT (key) DO UPDATE SET value = excluded.value"),
    e.DB.prepare("INSERT INTO settings (key, value) VALUES ('google_account', 'studio@novacane.test') ON CONFLICT (key) DO UPDATE SET value = excluded.value"),
  ]);
}

// The behind-the-scenes switch, set to Nova Bot's own booking system
export async function useNova(e = env) {
  await e.DB.prepare("INSERT INTO settings (key, value) VALUES ('booking_system', 'nova') ON CONFLICT (key) DO UPDATE SET value = excluded.value").run();
}

export async function clearTables(e = env) {
  await e.DB.batch(
    ["bookings", "payments", "outbox", "settings", "appointments", "notifications", "club_calendar", "push_subscriptions", "enquiries"].map((t) => e.DB.prepare(`DELETE FROM ${t}`))
  );
}

// Days and times relative to now, so tests don't go stale
export function ukDay(offsetDays) {
  const d = new Intl.DateTimeFormat("en-CA", { timeZone: "Europe/London" }).format(new Date(Date.now() + offsetDays * 86_400_000));
  return d;
}

// A Google Calendar event in UK time
export function ukEvent(date, from, to, extra = {}) {
  return { summary: "Busy", start: { dateTime: ukIso(date, from) }, end: { dateTime: ukIso(date, to) }, ...extra };
}

export function ukIso(date, time) {
  // Work out the UK offset for that day (BST or GMT)
  const probe = new Date(`${date}T12:00:00Z`);
  const hour = Number(new Intl.DateTimeFormat("en-GB", { timeZone: "Europe/London", hour: "2-digit", hourCycle: "h23" }).format(probe));
  const offset = hour - 12;
  const [h, m] = time.split(":").map(Number);
  return new Date(Date.UTC(...date.split("-").map((n, i) => (i === 1 ? Number(n) - 1 : Number(n))), h - offset, m)).toISOString();
}

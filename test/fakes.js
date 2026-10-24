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
  // intents: test bookings' "Fake a payment" (Stripe test mode); keys: every key Stripe was called with
  const s = { sessions: [], refunds: [], expired: [], intents: [], keys: [], fail: false, n: 0 };
  s.handle = async (url, init = {}) => {
    const u = new URL(url);
    if (u.hostname !== "api.stripe.com") return null;
    const auth = (init.headers && (init.headers.Authorization || init.headers.authorization)) || "";
    s.keys.push(String(auth).replace(/^Bearer /, ""));
    if (s.fail) return Response.json({ error: { message: "Invalid API Key provided" } }, { status: 401 });
    const form = init.body ? Object.fromEntries(new URLSearchParams(init.body)) : {};
    if (u.pathname === "/v1/payment_intents" && init.method === "POST") {
      const id = `pi_test_${++s.n}`;
      s.intents.push({ id, form });
      // Tap to Pay (card_present) waits for the card; test bookings' payments are paid straight away
      const tapToPay = form["payment_method_types[0]"] === "card_present";
      const metadata = { nova: form["metadata[nova]"], mode: form["metadata[mode]"] };
      return Response.json({ id, object: "payment_intent", client_secret: `${id}_secret_x`, amount: Number(form.amount), currency: form.currency, status: tapToPay ? "requires_payment_method" : "succeeded", livemode: false, metadata });
    }
    // Tap to Pay (src/nova/club-terminal.js): the studio's Terminal Location, connection tokens, and
    // reading a payment back (s.tapped marks one as paid by a card tapped on the phone)
    if (u.pathname === "/v1/terminal/locations") {
      s.locations ||= [];
      if (init.method === "POST") {
        const loc = { id: `tml_test_${++s.n}`, display_name: form.display_name, address: { postal_code: form["address[postal_code]"] }, metadata: { nova: form["metadata[nova]"] } };
        s.locations.push(loc);
        return Response.json(loc);
      }
      return Response.json({ object: "list", data: s.locations });
    }
    if (u.pathname === "/v1/terminal/connection_tokens" && init.method === "POST") {
      s.tokens ||= [];
      s.tokens.push({ location: form.location });
      return Response.json({ object: "terminal.connection_token", secret: `pst_test_${++s.n}`, location: form.location });
    }
    const pi = u.pathname.match(/^\/v1\/payment_intents\/([^/]+)$/);
    if (pi && (init.method || "GET") === "GET") {
      const made = s.intents.find((i) => i.id === pi[1]);
      if (!made) return Response.json({ error: { message: `No such payment_intent: '${pi[1]}'` } }, { status: 404 });
      const paid = (s.tapped || []).includes(made.id);
      return Response.json({
        id: made.id, object: "payment_intent", amount: Number(made.form.amount), currency: made.form.currency, livemode: false,
        status: paid ? "succeeded" : "requires_payment_method",
        metadata: { nova: made.form["metadata[nova]"], mode: made.form["metadata[mode]"] },
        latest_charge: paid ? { payment_method_details: { card_present: { brand: "visa", last4: "4242" } } } : null,
      });
    }
    if (u.pathname === "/v1/checkout/sessions" && init.method === "POST") {
      const id = `cs_test_${++s.n}`;
      const session = { id, url: `https://checkout.stripe.com/c/pay/${id}`, form };
      s.sessions.push(session);
      return Response.json({ id, url: session.url, object: "checkout.session", amount_total: Number(form["line_items[0][price_data][unit_amount]"]) || null, livemode: false });
    }
    // Reading a payment page back (Nova Club's QR payments): s.paidSessions marks one as paid by card
    const cs = u.pathname.match(/^\/v1\/checkout\/sessions\/([^/]+)$/);
    if (cs && (init.method || "GET") === "GET") {
      const made = s.sessions.find((x) => x.id === cs[1]);
      if (!made) return Response.json({ error: { message: `No such checkout.session: '${cs[1]}'` } }, { status: 404 });
      const paid = (s.paidSessions || []).includes(made.id);
      const expired = s.expired.includes(made.id);
      return Response.json({
        id: made.id, object: "checkout.session", livemode: false,
        status: paid ? "complete" : expired ? "expired" : "open",
        payment_status: paid ? "paid" : "unpaid",
        amount_total: Number(made.form["line_items[0][price_data][unit_amount]"]),
        metadata: { nova: made.form["metadata[nova]"], mode: made.form["metadata[mode]"] },
        url: paid || expired ? null : made.url,
        payment_intent: paid ? { id: `pi_for_${made.id}`, latest_charge: { payment_method_details: { card: { brand: "visa", last4: "4242", wallet: { type: "apple_pay" } } } } } : null,
      });
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
export function installFakes({ google = makeGoogle(), stripe = makeStripe(), claude = makeClaude(), push = [], extra = [] } = {}) {
  forgetSessionTypes();
  forgetGoogleToken();
  vi.spyOn(globalThis, "fetch").mockImplementation(async (url, init) => {
    // (extra: a spec's own fakes, e.g. Acuity's API, each with handle(url, init) like these)
    for (const fake of [google, stripe, claude, ...extra]) {
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

// Nova Club's Tap to Pay: the studio phone takes a card payment by having the
// client tap their card (or phone) on it, through Stripe Terminal.
//
//   POST /club/terminal/connection-token  { mode }                 -> { secret, location, mode }
//   POST /club/terminal/payments          { mode, amount, note }   -> { id, client_secret, amount, currency, livemode }
//   GET  /club/terminal/payments/<id>?mode=test|live                -> { id, status, amount, currency, livemode, card }
//
// mode "test": Stripe TEST mode (a sk_test_… key: STRIPE_TEST_SECRET_KEY, or STRIPE_SECRET_KEY if
//   that's a test one). No real money. The app's debug builds use this with Stripe's simulated
//   reader, so the whole flow can be tried on any phone, and its "Run full test" button does.
// mode "live": real money, with STRIPE_SECRET_KEY (sk_live_…). Only for the studio's own phones:
//   they send CLUB_TERMINAL_KEY as "Authorization: Bearer …" (Stripe says connection tokens are
//   only for trusted clients).
//
// Pay by QR code (for phones Stripe won't use as a card reader): the app shows a QR code of a Stripe
// payment page, and the client pays on their own phone (card, Apple Pay, Google Pay).
//   GET  /club/terminal/sessions?mode=…&days=7                     -> { sessions: [{ id, name, type, start, end, pricePence, paidPence, duePence }] }
//        today's and the coming days' Acuity sessions (studio phones only, as it has clients' names)
//   POST /club/terminal/qr                  { mode, amount, note, appointment? } -> { id, url, qr_url, amount, livemode }
//        with an Acuity session's id the payment carries its client, session and time (and the client's email)
//   GET  /club/terminal/go/<mode>/<id>                              the short link in the QR code: on to Stripe's page
//   GET  /club/terminal/qr/<id>?mode=…                              -> { id, status, paid, amount, livemode, card }
//   POST /club/terminal/qr/<id>/cancel      { mode }               -> { id, status }
//   GET  /club/terminal/paid, /club/terminal/cancelled               the pages the client lands on afterwards
//
// The reader joins a Stripe Terminal Location for the studio, made the first time it's needed
// (and found again after that by its metadata). Amounts are in pence, from 50p to £2,000.
// The status routes only answer for payments made here (metadata nova=club-terminal / club-qr).

import { getAppointment, listAppointments } from "../acuity/api.js";
import { fanPage } from "../fans.js";
import { formEncode, StripeError, stripeTestKey } from "./stripe.js";

const API = "https://api.stripe.com/v1";
const TIMEOUT_MS = 15_000;
const MIN_PENCE = 50; // Stripe's smallest card payment in GBP
const MAX_PENCE = 200_000; // £2,000: anything bigger goes through the Invoicer
const LOCATION_TAG = "club-terminal";
const PAYMENT_TAG = "club-terminal";
const QR_TAG = "club-qr";
const QR_MINUTES = 30; // the shortest Stripe allows a payment page to stay open
const SESSION_DAYS = 7; // how far ahead the session list looks (it starts today)

// Locations already found, by key (so each copy of the Worker asks Stripe once)
const locations = new Map();

export async function handleClubTerminal(request, env, pathname) {
  // Where the client's phone lands after paying by QR code (no key: it's their browser)
  if (pathname === "/club/terminal/paid") return fanPage("Paid, thank you", "Your payment to Novacane Studios went through. You can close this page.");
  if (pathname === "/club/terminal/cancelled") return fanPage("Payment cancelled", "Nothing was taken. Novacane Studios can show you a new code to try again.");
  // The QR code holds this short link rather than Stripe's long address, so it has far fewer squares to scan
  const go = pathname.match(/^\/club\/terminal\/go\/(test|live)\/(cs_[A-Za-z0-9_]+)$/);
  if (go) return goToPaymentPage(env, request, go[1], go[2]);
  if (await tooMany(env.CLUB_LIMIT, request.headers.get("CF-Connecting-IP"))) return reply({ error: "Too many requests" }, 429);
  const url = new URL(request.url);
  const body = request.method === "POST" ? await request.json().catch(() => ({})) : {};
  const mode = (request.method === "POST" ? body.mode : url.searchParams.get("mode")) === "live" ? "live" : "test";

  const key = terminalKey(env, mode);
  if (!key) {
    return reply(
      { error: mode === "live" ? "Live Tap to Pay needs a live Stripe key (sk_live_…) on Nova Bot." : "Test Tap to Pay needs a Stripe test key (sk_test_…) on Nova Bot: STRIPE_TEST_SECRET_KEY." },
      503
    );
  }
  if (mode === "live" && !trusted(request, env)) return reply({ error: "Live Tap to Pay is only for the studio's phones (CLUB_TERMINAL_KEY)." }, 401);

  try {
    if (pathname === "/club/terminal/connection-token" && request.method === "POST") {
      const location = await studioLocation(key);
      // (if Stripe refuses, the Location is looked up again next time, in case it was deleted)
      const token = await stripe(key, "POST", "/terminal/connection_tokens", { location }).catch((err) => {
        locations.delete(key);
        throw err;
      });
      return reply({ secret: token.secret, location, mode });
    }
    if (pathname === "/club/terminal/payments" && request.method === "POST") {
      const amount = Math.round(Number(body.amount));
      if (!Number.isFinite(amount) || amount < MIN_PENCE || amount > MAX_PENCE) {
        return reply({ error: `Give amount in pence, from ${MIN_PENCE} to ${MAX_PENCE}.` }, 400);
      }
      const note = String(body.note || "").replace(/\s+/g, " ").trim().slice(0, 120);
      const intent = await stripe(key, "POST", "/payment_intents", {
        amount,
        currency: "gbp",
        payment_method_types: ["card_present"],
        capture_method: "automatic",
        description: (mode === "test" ? "TEST " : "") + "Nova Club Tap to Pay" + (note ? `: ${note}` : ""),
        metadata: { nova: PAYMENT_TAG, mode },
      });
      return reply({ id: intent.id, client_secret: intent.client_secret, amount: intent.amount, currency: intent.currency, livemode: intent.livemode });
    }
    if (pathname === "/club/terminal/sessions" && request.method === "GET") {
      if (!trusted(request, env)) return reply({ error: "The session list is only for the studio's phones (CLUB_TERMINAL_KEY)." }, 401);
      const days = Math.min(Math.max(Math.round(Number(url.searchParams.get("days") || SESSION_DAYS)), 1), 31);
      const from = ukDay(0);
      const list = await listAppointments(env, { from, to: ukDay(days - 1) });
      const sessions = list
        .filter((a) => !a.canceled)
        .map((a) => {
          const pricePence = toPence(a.price);
          const paidPence = toPence(a.amountPaid);
          return { id: a.id, name: a.name, type: a.type, start: a.start, end: a.end, pricePence, paidPence, duePence: Math.max(pricePence - paidPence, 0) };
        });
      return reply({ sessions });
    }
    if (pathname === "/club/terminal/qr" && request.method === "POST") {
      const amount = Math.round(Number(body.amount));
      if (!Number.isFinite(amount) || amount < MIN_PENCE || amount > MAX_PENCE) {
        return reply({ error: `Give amount in pence, from ${MIN_PENCE} to ${MAX_PENCE}.` }, 400);
      }
      let note = String(body.note || "").replace(/\s+/g, " ").trim().slice(0, 120);
      // For an Acuity session: who and what it's for, on the payment (studio phones only: it has the client's details)
      let appointment = null;
      if (body.appointment != null && body.appointment !== "") {
        if (!trusted(request, env)) return reply({ error: "Linking a payment to a session is only for the studio's phones (CLUB_TERMINAL_KEY)." }, 401);
        const a = await getAppointment(env, body.appointment);
        if (!a || a.canceled) return reply({ error: "That session isn't in Acuity (or it's been cancelled)." }, 404);
        appointment = a;
        const name = `${a.firstName || ""} ${a.lastName || ""}`.trim();
        note = [a.type, name, ukWhen(a.datetime)].filter(Boolean).join(", ").slice(0, 120);
      }
      const base = (env.PUBLIC_URL || url.origin).replace(/\/$/, "");
      const description = (mode === "test" ? "TEST " : "") + "Nova Club QR payment" + (note ? `: ${note}` : "");
      const session = await stripe(key, "POST", "/checkout/sessions", {
        mode: "payment",
        submit_type: "pay",
        line_items: [{ quantity: 1, price_data: { currency: "gbp", unit_amount: amount, product_data: { name: "Novacane Studios", ...(note ? { description: note } : {}) } } }],
        metadata: { nova: QR_TAG, mode, ...(appointment ? { acuity_appointment: String(appointment.id) } : {}) },
        payment_intent_data: { metadata: { nova: QR_TAG, mode, ...(appointment ? { acuity_appointment: String(appointment.id) } : {}) }, description },
        ...(appointment && /^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(appointment.email || "") ? { customer_email: appointment.email } : {}),
        success_url: `${base}/club/terminal/paid`,
        cancel_url: `${base}/club/terminal/cancelled`,
        expires_at: Math.floor(Date.now() / 1000) + QR_MINUTES * 60 + 30,
      });
      return reply({ id: session.id, url: session.url, qr_url: `${base}/club/terminal/go/${mode}/${session.id}`, amount: session.amount_total ?? amount, livemode: session.livemode === true });
    }
    const qr = pathname.match(/^\/club\/terminal\/qr\/(cs_[A-Za-z0-9_]+)(\/cancel)?$/);
    if (qr) {
      const session = await stripe(key, "GET", `/checkout/sessions/${qr[1]}?expand[]=payment_intent.latest_charge`);
      if (session?.metadata?.nova !== QR_TAG) return reply({ error: "No such QR payment" }, 404);
      if (qr[2] && request.method === "POST") {
        // Stop the page taking money (only while it's still open; a paid one stays paid)
        const done = session.status === "open" ? await stripe(key, "POST", `/checkout/sessions/${qr[1]}/expire`, {}) : session;
        return reply({ id: done.id, status: done.status });
      }
      if (request.method !== "GET") return reply({ error: "Not found" }, 404);
      const card = session.payment_intent?.latest_charge?.payment_method_details?.card;
      return reply({
        id: session.id,
        status: session.status,
        paid: session.payment_status === "paid",
        amount: session.amount_total,
        livemode: session.livemode === true,
        card: card ? { brand: card.brand, last4: card.last4, wallet: card.wallet?.type || null } : null,
      });
    }
    const one = pathname.match(/^\/club\/terminal\/payments\/(pi_[A-Za-z0-9_]+)$/);
    if (one && request.method === "GET") {
      const intent = await stripe(key, "GET", `/payment_intents/${one[1]}?expand[]=latest_charge`);
      if (intent?.metadata?.nova !== PAYMENT_TAG) return reply({ error: "No such Tap to Pay payment" }, 404);
      const card = intent.latest_charge?.payment_method_details?.card_present;
      return reply({
        id: intent.id,
        status: intent.status,
        amount: intent.amount,
        currency: intent.currency,
        livemode: intent.livemode,
        card: card ? { brand: card.brand, last4: card.last4 } : null,
      });
    }
    return reply({ error: "Not found" }, 404);
  } catch (err) {
    if (err instanceof StripeError) return reply({ error: err.message }, 502);
    // Acuity saying no (its API needs Acuity's Powerhouse plan): said plainly, not a crash
    if (/acuity/i.test(String(err?.message || ""))) return reply({ error: String(err.message).replace(/^Error:\s*/, "").slice(0, 300) }, 502);
    throw err;
  }
}

// A UK day this many days from today ("YYYY-MM-DD")
function ukDay(days) {
  return new Date(Date.now() + days * 86_400_000).toLocaleDateString("en-CA", { timeZone: "Europe/London" });
}

// Acuity's "120.00" (or 120) -> 12000 pence
function toPence(value) {
  const n = Number.parseFloat(String(value ?? "0"));
  return Number.isFinite(n) && n > 0 ? Math.round(n * 100) : 0;
}

// Acuity's time ("2026-10-31T17:00:00+0000") -> "Sat 31 Oct, 17:00" in the UK
function ukWhen(datetime) {
  const ms = Date.parse(String(datetime || "").replace(/([+-]\d{2})(\d{2})$/, "$1:$2"));
  if (!Number.isFinite(ms)) return "";
  const d = new Date(ms);
  const day = d.toLocaleDateString("en-GB", { timeZone: "Europe/London", weekday: "short", day: "numeric", month: "short" });
  const time = d.toLocaleTimeString("en-GB", { timeZone: "Europe/London", hour: "2-digit", minute: "2-digit" });
  return `${day}, ${time}`;
}

// The client's phone, from the QR code: straight on to Stripe's payment page while it's open
async function goToPaymentPage(env, request, mode, id) {
  if (await tooMany(env.CLUB_LIMIT, request.headers.get("CF-Connecting-IP"))) return fanPage("Too many tries", "Please wait a minute and scan the code again.", {}, 429);
  const key = terminalKey(env, mode);
  const session = key ? await stripe(key, "GET", `/checkout/sessions/${id}`).catch(() => null) : null;
  if (session?.metadata?.nova !== QR_TAG) return fanPage("Payment not found", "This code isn't a Novacane Studios payment. Ask for a new one.", {}, 404);
  if (session.status === "complete") return fanPage("Already paid", "This payment to Novacane Studios has already been made. Nothing more to do.");
  if (session.status !== "open" || !session.url) return fanPage("This code has run out", "Nothing was taken. Novacane Studios can show you a new code.", {}, 410);
  return new Response(null, { status: 303, headers: { Location: session.url, "Cache-Control": "no-store", "Referrer-Policy": "no-referrer" } });
}

// The Stripe key for this mode, or "" if Nova Bot hasn't got the right kind
export function terminalKey(env, mode) {
  if (mode === "test") return stripeTestKey(env);
  return /^(sk|rk)_live_/.test(String(env.STRIPE_SECRET_KEY || "")) ? env.STRIPE_SECRET_KEY : "";
}

function trusted(request, env) {
  const want = String(env.CLUB_TERMINAL_KEY || "");
  const got = (request.headers.get("Authorization") || "").replace(/^Bearer\s+/i, "");
  return want.length >= 16 && got.length === want.length && timingSafeEqual(got, want);
}

function timingSafeEqual(a, b) {
  let diff = 0;
  for (let i = 0; i < a.length; i++) diff |= a.charCodeAt(i) ^ b.charCodeAt(i);
  return diff === 0;
}

// The studio's Terminal Location in this Stripe account (made if there isn't one yet)
async function studioLocation(key) {
  if (locations.has(key)) return locations.get(key);
  const list = await stripe(key, "GET", "/terminal/locations?limit=100");
  let found = (list.data || []).find((l) => l.metadata?.nova === LOCATION_TAG);
  if (!found) {
    found = await stripe(key, "POST", "/terminal/locations", {
      display_name: "Novacane Studios",
      address: { line1: "10 Clyde Terrace", city: "London", postal_code: "SE23 3BA", country: "GB" },
      metadata: { nova: LOCATION_TAG },
    });
  }
  locations.set(key, found.id);
  return found.id;
}

async function stripe(key, method, path, params) {
  const res = await fetch(API + path, {
    method,
    headers: { Authorization: `Bearer ${key}`, ...(params ? { "Content-Type": "application/x-www-form-urlencoded" } : {}) },
    body: params ? formEncode(params) : undefined,
    signal: AbortSignal.timeout(TIMEOUT_MS),
  });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) {
    const reason = data?.error?.message || res.status;
    console.log(`Stripe ${method} ${path.split("?")[0]} answered ${res.status}:`, String(reason).slice(0, 300));
    throw new StripeError(`Stripe: ${String(reason).slice(0, 200)}`, res.status);
  }
  return data;
}

function reply(body, status = 200) {
  return new Response(JSON.stringify(body), { status, headers: { "Content-Type": "application/json", "Cache-Control": "no-store" } });
}

async function tooMany(limiter, ip) {
  if (!limiter || !ip) return false;
  try {
    return !(await limiter.limit({ key: ip })).success;
  } catch (err) {
    console.log("Rate limit check failed:", err);
    return false;
  }
}

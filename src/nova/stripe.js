// Stripe: deposits, balances and refunds.
//
// Customers pay on Stripe's own checkout page (card, Apple Pay, Google Pay), so
// card details never touch Nova Bot. Stripe then tells us it's paid:
//
//   POST /stripe/webhook   signed by Stripe (STRIPE_WEBHOOK_SECRET)
//     checkout.session.completed  -> the payment is recorded and the booking confirmed (bookings.js)
//     checkout.session.expired    -> a time held for checkout is let go
//
// Secrets: STRIPE_SECRET_KEY (sk_live_… or sk_test_…) and STRIPE_WEBHOOK_SECRET
// (whsec_…, from the webhook endpoint you add in Stripe's dashboard).
//
// Sandbox: with SANDBOX=true and no Stripe key, "checkout" is a local page with a
// Pay button that records the payment straight away (see book-page.js).

const API = "https://api.stripe.com/v1";
const TIMEOUT_MS = 15_000;
// How old a webhook's timestamp may be (stops a captured one being replayed later)
const TOLERANCE_SECONDS = 300;

export function stripeOffline(env) {
  return env.SANDBOX === "true" && !env.STRIPE_SECRET_KEY;
}

export function stripeReady(env) {
  return stripeOffline(env) || Boolean(env.STRIPE_SECRET_KEY);
}

export class StripeError extends Error {
  constructor(message, status) {
    super(message);
    this.status = status;
  }
}

// Call Stripe's API (form-encoded, as Stripe wants). Returns the JSON, or throws StripeError.
async function stripe(env, method, path, params, idempotencyKey) {
  if (!env.STRIPE_SECRET_KEY) throw new StripeError("Stripe isn't set up (no STRIPE_SECRET_KEY).", 0);
  const res = await fetch(API + path, {
    method,
    headers: {
      Authorization: `Bearer ${env.STRIPE_SECRET_KEY}`,
      ...(params ? { "Content-Type": "application/x-www-form-urlencoded" } : {}),
      ...(idempotencyKey ? { "Idempotency-Key": idempotencyKey } : {}),
    },
    body: params ? formEncode(params) : undefined,
    signal: AbortSignal.timeout(TIMEOUT_MS),
  });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) {
    const reason = data?.error?.message || res.status;
    console.log(`Stripe ${method} ${path} answered ${res.status}:`, String(reason).slice(0, 300));
    throw new StripeError(`Stripe: ${String(reason).slice(0, 200)}`, res.status);
  }
  return data;
}

// { a: 1, b: { c: 2 }, d: [{ e: 3 }] } -> "a=1&b[c]=2&d[0][e]=3"
export function formEncode(obj, prefix = "", out = new URLSearchParams()) {
  for (const [key, value] of Object.entries(obj)) {
    if (value === undefined || value === null) continue;
    const name = prefix ? `${prefix}[${key}]` : key;
    if (typeof value === "object") formEncode(value, name, out);
    else out.append(name, String(value));
  }
  return out;
}

// A checkout page for one payment against a booking. Returns { id, url }.
// `purpose`: "deposit", "balance" or "payment" (shown on the receipt).
export async function createCheckout(env, { booking, amountPence, purpose, successUrl, cancelUrl, expiresInMinutes }) {
  const label = purpose === "deposit" ? "Deposit" : purpose === "balance" ? "Balance" : "Payment";
  const minutes = Math.min(Math.max(expiresInMinutes || 60, 30), 23 * 60); // Stripe allows 30 minutes to 24 hours
  const session = await stripe(
    env,
    "POST",
    "/checkout/sessions",
    {
      mode: "payment",
      customer_email: booking.email,
      client_reference_id: String(booking.id),
      line_items: [
        {
          quantity: 1,
          price_data: {
            currency: "gbp",
            unit_amount: amountPence,
            product_data: { name: `${label}: ${booking.session}`.slice(0, 250), description: `Booking #${booking.id}` },
          },
        },
      ],
      metadata: { booking_id: booking.id, purpose },
      payment_intent_data: { metadata: { booking_id: booking.id, purpose }, description: `Novacane booking #${booking.id} (${label.toLowerCase()})` },
      success_url: successUrl,
      cancel_url: cancelUrl,
      expires_at: Math.floor(Date.now() / 1000) + minutes * 60,
    },
    // The same booking, amount and purpose within a minute is the same checkout
    `checkout-${booking.id}-${purpose}-${amountPence}-${Math.floor(Date.now() / 60_000)}`
  );
  return { id: session.id, url: session.url };
}

export async function expireCheckout(env, id) {
  if (!id || stripeOffline(env) || !id.startsWith("cs_")) return;
  try {
    await stripe(env, "POST", `/checkout/sessions/${encodeURIComponent(id)}/expire`, {});
  } catch (err) {
    // Already paid or already expired: nothing to do
    console.log("Couldn't expire checkout:", err.message);
  }
}

// Refund (part of) one payment. Returns the refund's id.
export async function refund(env, { paymentIntent, amountPence, bookingId, reason }) {
  const data = await stripe(
    env,
    "POST",
    "/refunds",
    { payment_intent: paymentIntent, amount: amountPence, metadata: { booking_id: bookingId, note: String(reason || "").slice(0, 400) } },
    `refund-${paymentIntent}-${amountPence}-${bookingId}`
  );
  return data.id;
}

// Can Stripe's API be used with the saved key? "" if so.
export async function stripeProblem(env) {
  if (stripeOffline(env)) return "";
  if (!env.STRIPE_SECRET_KEY) return "The STRIPE_SECRET_KEY secret isn't set.";
  if (!env.STRIPE_WEBHOOK_SECRET) return "The STRIPE_WEBHOOK_SECRET secret isn't set, so payments can't be confirmed.";
  try {
    await stripe(env, "GET", "/balance");
    return "";
  } catch (err) {
    return err.message;
  }
}

// ===== WEBHOOKS =====

// Check a webhook really came from Stripe. Returns the event, or null.
// Stripe-Signature: t=<seconds>,v1=<hex HMAC-SHA256 of "t.body">
export async function verifyWebhook(env, payload, header, now = Date.now()) {
  if (!env.STRIPE_WEBHOOK_SECRET || !header) return null;
  const parts = Object.fromEntries(
    String(header)
      .split(",")
      .map((p) => p.split("="))
      .filter(([k]) => k === "t")
  );
  const signatures = String(header)
    .split(",")
    .map((p) => p.trim())
    .filter((p) => p.startsWith("v1="))
    .map((p) => p.slice(3));
  const t = Number(parts.t);
  if (!Number.isFinite(t) || !signatures.length || Math.abs(now / 1000 - t) > TOLERANCE_SECONDS) return null;
  const expected = await hmacHex(env.STRIPE_WEBHOOK_SECRET, `${t}.${payload}`);
  const ok = signatures.some((s) => sameHex(s, expected));
  if (!ok) return null;
  try {
    return JSON.parse(payload);
  } catch {
    return null;
  }
}

export async function hmacHex(secret, message) {
  const key = await crypto.subtle.importKey("raw", new TextEncoder().encode(secret), { name: "HMAC", hash: "SHA-256" }, false, ["sign"]);
  const mac = new Uint8Array(await crypto.subtle.sign("HMAC", key, new TextEncoder().encode(message)));
  return [...mac].map((b) => b.toString(16).padStart(2, "0")).join("");
}

function sameHex(a, b) {
  const x = new TextEncoder().encode(String(a));
  const y = new TextEncoder().encode(String(b));
  return x.byteLength === y.byteLength && crypto.subtle.timingSafeEqual(x, y);
}

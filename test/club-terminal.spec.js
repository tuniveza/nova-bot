// Nova Club's Tap to Pay (src/nova/club-terminal.js): connection tokens for the studio's Terminal
// Location, card-present payments, and reading one back once the card's been tapped. Test mode
// uses only a test key; live mode only a live key, and only for a phone with CLUB_TERMINAL_KEY.

import { createExecutionContext, env, waitOnExecutionContext } from "cloudflare:test";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import worker from "../src";
import { BASE, installFakes } from "./fakes.js";

const PHONE_KEY = "club-terminal-phone-key-1234";
// How a phone's browser opens a page (a scanned QR code): Nova Bot sends most such pages to Nova Agent, never these
const BROWSER = { "Sec-Fetch-Dest": "document", Accept: "text/html", "CF-Connecting-IP": "203.0.113.78" };

let fakes;
beforeEach(() => {
  fakes = installFakes();
});
afterEach(() => vi.restoreAllMocks());

async function call(path, { method = "GET", body, headers = {}, with: extra = {} } = {}) {
  const ctx = createExecutionContext();
  const req = new Request(BASE + path, {
    method,
    headers: { "CF-Connecting-IP": "203.0.113.77", ...(body ? { "Content-Type": "application/json" } : {}), ...headers },
    body: body ? JSON.stringify(body) : undefined,
  });
  const res = await worker.fetch(req, { ...env, ...extra }, ctx);
  await waitOnExecutionContext(ctx);
  return { status: res.status, body: await res.json() };
}

describe("Nova Club's Tap to Pay", () => {
  it("runs a whole test payment: token, payment, card tapped, paid", async () => {
    // 1. A connection token, for the studio's Location (made the first time)
    const token = await call("/club/terminal/connection-token", { method: "POST", body: { mode: "test" } });
    expect(token.status).toBe(200);
    expect(token.body.secret).toMatch(/^pst_test_/);
    expect(token.body.mode).toBe("test");
    expect(fakes.stripe.locations).toHaveLength(1);
    expect(fakes.stripe.locations[0]).toMatchObject({ display_name: "Novacane Studios", address: { postal_code: "SE23 3BA" } });
    expect(token.body.location).toBe(fakes.stripe.locations[0].id);
    expect(fakes.stripe.tokens.at(-1).location).toBe(token.body.location);

    // The Location is found again, not made twice
    const again = await call("/club/terminal/connection-token", { method: "POST", body: { mode: "test" } });
    expect(again.body.location).toBe(token.body.location);
    expect(fakes.stripe.locations).toHaveLength(1);

    // 2. A £25 card-present payment, waiting for the card
    const made = await call("/club/terminal/payments", { method: "POST", body: { mode: "test", amount: 2500, note: "Studio A,\n2 hours" } });
    expect(made.status).toBe(200);
    expect(made.body).toMatchObject({ amount: 2500, currency: "gbp", livemode: false });
    expect(made.body.client_secret).toContain("_secret_");
    const form = fakes.stripe.intents.at(-1).form;
    expect(form).toMatchObject({ amount: "2500", currency: "gbp", "payment_method_types[0]": "card_present", capture_method: "automatic", "metadata[nova]": "club-terminal" });
    expect(form.description).toBe("TEST Nova Club Tap to Pay: Studio A, 2 hours");

    const waiting = await call(`/club/terminal/payments/${made.body.id}?mode=test`);
    expect(waiting.body).toMatchObject({ status: "requires_payment_method", card: null });

    // 3. The card is tapped on the phone (Stripe's simulated reader in the app's test)
    fakes.stripe.tapped = [made.body.id];
    const paid = await call(`/club/terminal/payments/${made.body.id}?mode=test`);
    expect(paid.status).toBe(200);
    expect(paid.body).toEqual({ id: made.body.id, status: "succeeded", amount: 2500, currency: "gbp", livemode: false, card: { brand: "visa", last4: "4242" } });

    // Only the test key was ever used
    expect(new Set(fakes.stripe.keys)).toEqual(new Set(["sk_test_novacane"]));
  });

  it("prefers STRIPE_TEST_SECRET_KEY for test payments, and refuses without any test key", async () => {
    await call("/club/terminal/connection-token", { method: "POST", body: { mode: "test" }, with: { STRIPE_SECRET_KEY: "sk_live_real", STRIPE_TEST_SECRET_KEY: "sk_test_other" } });
    expect(new Set(fakes.stripe.keys)).toEqual(new Set(["sk_test_other"]));

    const before = fakes.stripe.keys.length;
    const none = await call("/club/terminal/connection-token", { method: "POST", body: { mode: "test" }, with: { STRIPE_SECRET_KEY: "sk_live_real", STRIPE_TEST_SECRET_KEY: "" } });
    expect(none.status).toBe(503);
    expect(none.body.error).toMatch(/test key/);
    expect(fakes.stripe.keys.length).toBe(before);
  });

  it("only gives live tokens to the studio's phones, with a live key", async () => {
    const live = { STRIPE_SECRET_KEY: "sk_live_real", CLUB_TERMINAL_KEY: PHONE_KEY };
    const noKey = await call("/club/terminal/connection-token", { method: "POST", body: { mode: "live" }, with: live });
    expect(noKey.status).toBe(401);
    const wrong = await call("/club/terminal/connection-token", { method: "POST", body: { mode: "live" }, headers: { Authorization: "Bearer club-terminal-phone-key-9999" }, with: live });
    expect(wrong.status).toBe(401);
    expect(fakes.stripe.keys).toEqual([]);

    const ok = await call("/club/terminal/connection-token", { method: "POST", body: { mode: "live" }, headers: { Authorization: `Bearer ${PHONE_KEY}` }, with: live });
    expect(ok.status).toBe(200);
    expect(ok.body.mode).toBe("live");
    expect(new Set(fakes.stripe.keys)).toEqual(new Set(["sk_live_real"]));

    // A test key is never used for live payments
    const testOnly = await call("/club/terminal/connection-token", { method: "POST", body: { mode: "live" }, headers: { Authorization: `Bearer ${PHONE_KEY}` }, with: { CLUB_TERMINAL_KEY: PHONE_KEY } });
    expect(testOnly.status).toBe(503);
    expect(testOnly.body.error).toMatch(/live Stripe key/);
  });

  it("refuses amounts that are too small, too big or not numbers", async () => {
    for (const amount of [49, 200_001, "lots", undefined]) {
      const out = await call("/club/terminal/payments", { method: "POST", body: { mode: "test", amount } });
      expect(out.status).toBe(400);
    }
    expect(fakes.stripe.intents).toHaveLength(0);
  });

  it("won't read back payments that weren't made by Tap to Pay", async () => {
    fakes.stripe.intents.push({ id: "pi_test_other", form: { amount: "9900", currency: "gbp" } });
    const out = await call("/club/terminal/payments/pi_test_other?mode=test");
    expect(out.status).toBe(404);
  });

  it("passes on Stripe's refusal clearly", async () => {
    fakes.stripe.fail = true;
    const out = await call("/club/terminal/connection-token", { method: "POST", body: { mode: "test" } });
    expect(out.status).toBe(502);
    expect(out.body.error).toMatch(/^Stripe: /);
  });

  it("takes a payment by QR code: a Stripe payment page, paid on the client's phone", async () => {
    const made = await call("/club/terminal/qr", { method: "POST", body: { mode: "test", amount: 2500, note: "Studio A, 2 hours" } });
    expect(made.status).toBe(200);
    expect(made.body).toMatchObject({ amount: 2500, livemode: false });
    expect(made.body.url).toMatch(/^https:\/\/checkout\.stripe\.com\//);
    expect(made.body.qr_url).toBe(`https://novacane-worker.test/club/terminal/go/test/${made.body.id}`);
    // The QR code's short link goes on to Stripe's page while it's waiting
    const goCtx = createExecutionContext();
    const go = await worker.fetch(new Request(made.body.qr_url, { redirect: "manual", headers: BROWSER }), env, goCtx);
    await waitOnExecutionContext(goCtx);
    expect(go.status).toBe(303);
    expect(go.headers.get("Location")).toBe(made.body.url);
    const form = fakes.stripe.sessions.at(-1).form;
    expect(form).toMatchObject({
      mode: "payment",
      "line_items[0][price_data][currency]": "gbp",
      "line_items[0][price_data][unit_amount]": "2500",
      "line_items[0][price_data][product_data][name]": "Novacane Studios",
      "metadata[nova]": "club-qr",
      "payment_intent_data[description]": "TEST Nova Club QR payment: Studio A, 2 hours",
      success_url: "https://novacane-worker.test/club/terminal/paid",
      cancel_url: "https://novacane-worker.test/club/terminal/cancelled",
    });

    // Waiting for the client
    const waiting = await call(`/club/terminal/qr/${made.body.id}?mode=test`);
    expect(waiting.body).toMatchObject({ status: "open", paid: false, card: null });

    // The client pays on their phone
    fakes.stripe.paidSessions = [made.body.id];
    const paid = await call(`/club/terminal/qr/${made.body.id}?mode=test`);
    expect(paid.body).toEqual({ id: made.body.id, status: "complete", paid: true, amount: 2500, livemode: false, card: { brand: "visa", last4: "4242", wallet: "apple_pay" } });

    // Scanning it again once paid says so (no second payment)
    const againCtx = createExecutionContext();
    const again = await worker.fetch(new Request(made.body.qr_url, { redirect: "manual", headers: BROWSER }), env, againCtx);
    await waitOnExecutionContext(againCtx);
    expect(again.status).toBe(200);
    expect(await again.text()).toContain("Already paid");

    // A paid one can't be cancelled
    const cancelPaid = await call(`/club/terminal/qr/${made.body.id}/cancel`, { method: "POST", body: { mode: "test" } });
    expect(cancelPaid.body.status).toBe("complete");
    expect(fakes.stripe.expired).not.toContain(made.body.id);
    expect(new Set(fakes.stripe.keys)).toEqual(new Set(["sk_test_novacane"]));
  });

  it("cancels a QR payment nobody's paid, so the page stops taking money", async () => {
    const made = await call("/club/terminal/qr", { method: "POST", body: { mode: "test", amount: 1000 } });
    const cancelled = await call(`/club/terminal/qr/${made.body.id}/cancel`, { method: "POST", body: { mode: "test" } });
    expect(cancelled.body).toEqual({ id: made.body.id, status: "expired" });
    expect(fakes.stripe.expired).toContain(made.body.id);
    // Scanning a cancelled code says it's run out, and doesn't go to Stripe
    const ctx = createExecutionContext();
    const go = await worker.fetch(new Request(made.body.qr_url, { redirect: "manual", headers: BROWSER }), env, ctx);
    await waitOnExecutionContext(ctx);
    expect(go.status).toBe(410);
    expect(await go.text()).toContain("This code has run out");
  });

  it("guards QR payments like card taps: amounts, live key, and only its own pages", async () => {
    for (const amount of [49, 200_001, "lots"]) {
      expect((await call("/club/terminal/qr", { method: "POST", body: { mode: "test", amount } })).status).toBe(400);
    }
    const live = await call("/club/terminal/qr", { method: "POST", body: { mode: "live", amount: 1000 }, with: { STRIPE_SECRET_KEY: "sk_live_real", CLUB_TERMINAL_KEY: PHONE_KEY } });
    expect(live.status).toBe(401);
    // A booking's checkout page isn't readable here
    fakes.stripe.sessions.push({ id: "cs_test_booking", form: { "line_items[0][price_data][unit_amount]": "5000" } });
    expect((await call("/club/terminal/qr/cs_test_booking?mode=test")).status).toBe(404);
    expect(fakes.stripe.sessions.filter((x) => x.form["metadata[nova]"] === "club-qr")).toHaveLength(0);
  });

  it("shows the client a page after paying, or after cancelling", async () => {
    for (const [path, words] of [["/club/terminal/paid", "Paid, thank you"], ["/club/terminal/cancelled", "Payment cancelled"]]) {
      const ctx = createExecutionContext();
      const res = await worker.fetch(new Request(BASE + path, { redirect: "manual", headers: BROWSER }), env, ctx);
      await waitOnExecutionContext(ctx);
      expect(res.status).toBe(200);
      expect(await res.text()).toContain(words);
    }
  });

  describe("linked to a booking", () => {
    // Nova's own bookings (nova/bookings.js): two today, one cancelled, one a test
    const today = new Date().toLocaleDateString("en-CA", { timeZone: "Europe/London" });
    const at = (hourUtc) => `${today}T${String(hourUtc).padStart(2, "0")}:00:00.000Z`;
    let n = 0;
    const book = async ({ first, last, email, session, start, end, price, paid = 0, status = "booked", test = 0 }) => {
      const now = new Date().toISOString();
      const { meta } = await env.DB.prepare(
        `INSERT INTO bookings (token, status, source, type_id, session, duration, changeover, starts_at, ends_at, first_name, last_name, email, price_pence, deposit_pence, paid_pence, created_at, updated_at, test)
         VALUES (?, ?, 'staff', NULL, ?, 60, 0, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
      )
        .bind(`club-terminal-test-token-${++n}-xxxxxxxx`, status, session, start, end, first, last, email, price, Math.round(price / 2), paid, now, now, test)
        .run();
      return meta.last_row_id;
    };
    const staff = { Authorization: `Bearer ${PHONE_KEY}` };
    let kai, ash, sam, tester;
    beforeEach(async () => {
      await env.DB.prepare("DELETE FROM bookings").run();
      await env.DB.prepare("DELETE FROM payments").run();
      kai = await book({ first: "Kai", last: "Morgan", email: "kai@example.com", session: "Studio A (engineered)", start: at(12), end: at(16), price: 12000, paid: 4000 });
      ash = await book({ first: "Ash", last: "Lee", email: "ash@example.com", session: "Vocal booth", start: at(17), end: at(18), price: 3500, paid: 3500 });
      sam = await book({ first: "Sam", last: "Ward", email: "sam@example.com", session: "Mixing", start: at(19), end: at(20), price: 5000, status: "cancelled" });
      tester = await book({ first: "Nova", last: "TEST", email: "test@example.com", session: "Mixing", start: at(20), end: at(21), price: 5000, test: 1 });
    });

    it("lists today's and the coming week's bookings, with what's still due, for the studio's phones only", async () => {
      const refused = await call("/club/terminal/sessions?mode=test", { with: { CLUB_TERMINAL_KEY: PHONE_KEY } });
      expect(refused.status).toBe(401);

      const out = await call("/club/terminal/sessions?mode=test", { headers: staff, with: { CLUB_TERMINAL_KEY: PHONE_KEY } });
      expect(out.status).toBe(200);
      expect(out.body.sessions).toEqual([
        expect.objectContaining({ id: kai, name: "Kai Morgan", type: "Studio A (engineered)", start: at(12), end: at(16), pricePence: 12000, paidPence: 4000, duePence: 8000 }),
        expect.objectContaining({ id: ash, name: "Ash Lee", type: "Vocal booth", pricePence: 3500, paidPence: 3500, duePence: 0 }),
      ]);
    });

    it("puts the client, session and time on the QR payment, and the client's email for their receipt", async () => {
      const made = await call("/club/terminal/qr", { method: "POST", headers: staff, body: { mode: "test", amount: 8000, booking: kai }, with: { CLUB_TERMINAL_KEY: PHONE_KEY } });
      expect(made.status).toBe(200);
      const form = fakes.stripe.sessions.at(-1).form;
      expect(form["metadata[nova_booking]"]).toBe(String(kai));
      expect(form["payment_intent_data[metadata][nova_booking]"]).toBe(String(kai));
      // Test money is never paid against a real booking
      expect(form["metadata[booking_id]"]).toBeUndefined();
      expect(form.customer_email).toBe("kai@example.com");
      expect(form["payment_intent_data[description]"]).toMatch(/^TEST Nova Club QR payment: Studio A \(engineered\), Kai Morgan, \w{3} \d{1,2} \w{3}, \d{2}:00$/);   // (the hour moves with the clocks)
      expect(form["line_items[0][price_data][product_data][description]"]).toContain("Kai Morgan");
    });

    it("in live mode, the payment is paid against the booking (Stripe's webhook knows it by booking_id)", async () => {
      const live = { CLUB_TERMINAL_KEY: PHONE_KEY, STRIPE_SECRET_KEY: "sk_live_club_terminal_test" };
      const made = await call("/club/terminal/qr", { method: "POST", headers: staff, body: { mode: "live", amount: 8000, booking: kai }, with: live });
      expect(made.status).toBe(200);
      const form = fakes.stripe.sessions.at(-1).form;
      expect(form["metadata[booking_id]"]).toBe(String(kai));
      expect(form["payment_intent_data[metadata][booking_id]"]).toBe(String(kai));
      expect(form["payment_intent_data[description]"]).toMatch(/^Nova Club QR payment: Studio A/);
    });

    it("still takes a booking's number as `appointment` (an app from before)", async () => {
      const made = await call("/club/terminal/qr", { method: "POST", headers: staff, body: { mode: "test", amount: 3500, appointment: ash }, with: { CLUB_TERMINAL_KEY: PHONE_KEY } });
      expect(made.status).toBe(200);
      expect(fakes.stripe.sessions.at(-1).form["metadata[nova_booking]"]).toBe(String(ash));
    });

    it("won't link a payment to a cancelled, test or unknown booking, or without the studio's key", async () => {
      const env2 = { CLUB_TERMINAL_KEY: PHONE_KEY };
      expect((await call("/club/terminal/qr", { method: "POST", headers: staff, body: { mode: "test", amount: 5000, booking: sam }, with: env2 })).status).toBe(404);
      expect((await call("/club/terminal/qr", { method: "POST", headers: staff, body: { mode: "test", amount: 5000, booking: tester }, with: env2 })).status).toBe(404);
      expect((await call("/club/terminal/qr", { method: "POST", headers: staff, body: { mode: "test", amount: 5000, booking: 98765 }, with: env2 })).status).toBe(404);
      expect((await call("/club/terminal/qr", { method: "POST", body: { mode: "test", amount: 5000, booking: kai }, with: env2 })).status).toBe(401);
      expect(fakes.stripe.sessions).toHaveLength(0);
    });
  });
});

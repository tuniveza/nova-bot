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

  describe("linked to an Acuity session", () => {
    const today = new Date().toLocaleDateString("en-CA", { timeZone: "Europe/London" });
    // Acuity writes times as the London clock with its offset; 12:00 UTC is safe all year
    const sessions = [
      { id: 9001, firstName: "Kai", lastName: "Morgan", email: "kai@example.com", type: "Studio A (engineered)", datetime: `${today}T13:00:00+0100`, duration: "240", price: "120.00", amountPaid: "40.00", paid: "no", canceled: false },
      { id: 9002, firstName: "Ash", lastName: "Lee", email: "ash@example.com", type: "Vocal booth", datetime: `${today}T18:00:00+0100`, duration: "60", price: "35.00", amountPaid: "35.00", paid: "yes", canceled: false },
      { id: 9003, firstName: "Sam", lastName: "Ward", email: "sam@example.com", type: "Mixing", datetime: `${today}T20:00:00+0100`, duration: "60", price: "50.00", amountPaid: "0.00", paid: "no", canceled: true },
    ];
    const acuity = {
      asked: [],
      handle: async (url) => {
        const u = new URL(url);
        if (u.hostname !== "acuityscheduling.com") return null;
        acuity.asked.push(u.pathname + u.search);
        const one = u.pathname.match(/^\/api\/v1\/appointments\/(\d+)$/);
        if (one) {
          const a = sessions.find((x) => x.id === Number(one[1]));
          return a ? Response.json(a) : Response.json({ status_code: 404, message: "Not found" }, { status: 404 });
        }
        if (u.pathname === "/api/v1/appointments") return Response.json(sessions.filter((a) => !a.canceled));
        return Response.json([], { status: 200 });
      },
    };
    const staff = { Authorization: `Bearer ${PHONE_KEY}` };
    beforeEach(() => {
      acuity.asked = [];
      fakes = installFakes({ extra: [acuity] });
    });

    it("lists today's and the coming week's sessions, with what's still due, for the studio's phones only", async () => {
      const refused = await call("/club/terminal/sessions?mode=test", { with: { CLUB_TERMINAL_KEY: PHONE_KEY } });
      expect(refused.status).toBe(401);
      expect(acuity.asked).toHaveLength(0);

      const out = await call("/club/terminal/sessions?mode=test", { headers: staff, with: { CLUB_TERMINAL_KEY: PHONE_KEY } });
      expect(out.status).toBe(200);
      expect(out.body.sessions).toEqual([
        expect.objectContaining({ id: 9001, name: "Kai Morgan", type: "Studio A (engineered)", pricePence: 12000, paidPence: 4000, duePence: 8000 }),
        expect.objectContaining({ id: 9002, name: "Ash Lee", type: "Vocal booth", pricePence: 3500, paidPence: 3500, duePence: 0 }),
      ]);
      expect(acuity.asked[0]).toContain(`minDate=${today}`);
    });

    it("puts the client, session and time on the QR payment, and the client's email for their receipt", async () => {
      const made = await call("/club/terminal/qr", { method: "POST", headers: staff, body: { mode: "test", amount: 8000, appointment: 9001 }, with: { CLUB_TERMINAL_KEY: PHONE_KEY } });
      expect(made.status).toBe(200);
      const form = fakes.stripe.sessions.at(-1).form;
      expect(form["metadata[acuity_appointment]"]).toBe("9001");
      expect(form["payment_intent_data[metadata][acuity_appointment]"]).toBe("9001");
      expect(form.customer_email).toBe("kai@example.com");
      expect(form["payment_intent_data[description]"]).toMatch(/^TEST Nova Club QR payment: Studio A \(engineered\), Kai Morgan, \w{3} \d{1,2} \w{3}, \d{2}:00$/);   // (the hour moves with the clocks)
      expect(form["line_items[0][price_data][product_data][description]"]).toContain("Kai Morgan");
    });

    it("says plainly when Acuity won't answer (its API needs the Powerhouse plan)", async () => {
      const refusing = { handle: async (url) => (new URL(url).hostname === "acuityscheduling.com" ? Response.json({ status_code: 403, message: "API access is only available on Powerhouse plans" }, { status: 403 }) : null) };
      fakes = installFakes({ extra: [refusing] });
      const out = await call("/club/terminal/sessions?mode=test", { headers: staff, with: { CLUB_TERMINAL_KEY: PHONE_KEY } });
      expect(out.status).toBe(502);
      expect(out.body.error).toMatch(/Acuity/);
      expect(out.body.error).not.toMatch(/at \w+ \(/);   // no stack trace
    });

    it("won't link a payment to a cancelled or unknown session, or without the studio's key", async () => {
      const env2 = { CLUB_TERMINAL_KEY: PHONE_KEY };
      expect((await call("/club/terminal/qr", { method: "POST", headers: staff, body: { mode: "test", amount: 5000, appointment: 9003 }, with: env2 })).status).toBe(404);
      expect((await call("/club/terminal/qr", { method: "POST", headers: staff, body: { mode: "test", amount: 5000, appointment: 1234 }, with: env2 })).status).toBe(404);
      expect((await call("/club/terminal/qr", { method: "POST", body: { mode: "test", amount: 5000, appointment: 9001 }, with: env2 })).status).toBe(401);
      expect(fakes.stripe.sessions).toHaveLength(0);
    });
  });
});

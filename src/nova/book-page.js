// The customer's side of booking, on Nova Bot's own pages (no Acuity):
//
//   GET  /book                      the booking page (?session=&date=&time=&first=&last=&email=&phone=&ref= fill it in)
//   POST /book/api/times            { session, date } -> { times }
//   POST /book/api/checkout         { session, date, time, first, last, email, phone, notes, referral }
//                                   -> holds the time and returns Stripe's checkout { url }
//   GET  /book/cancelled?token=     back from checkout without paying: the held time is let go
//   GET  /booking/<token>           the customer's booking: pay, move or cancel it
//   POST /booking/<token>/times     { date } -> { times } (for moving it)
//   POST /booking/<token>/move      { date, time }
//   POST /booking/<token>/cancel
//   GET  /pay/<token>?for=deposit|balance   a payment link that never runs out: makes a fresh checkout
//   POST /stripe/webhook            Stripe: paid / checkout expired (stripe.js)
//   GET+POST /book/sandbox-pay      sandbox only: a stand-in for Stripe's checkout page
//
// The token in a booking's links is long and random, like a key: whoever has the
// link can see and change that one booking, so it's only ever emailed to the customer.

import { dayInWords, freeTimesOn, getSessionTypes, isRealDate, normaliseTime, ukToday } from "./booking.js";
import {
  createBooking,
  customerCanMove,
  customerCancel,
  fullName,
  getBookingByToken,
  isEmail,
  moveBooking,
  paymentReceived,
  checkoutExpired,
  policyRefund,
  releaseHold,
  startCheckout,
  when,
} from "./bookings.js";
import { moneyState } from "./emails.js";
import { googleReady } from "./google.js";
import { senderId } from "../enquiries.js";
import { stripeOffline, stripeReady, verifyWebhook } from "./stripe.js";
import { CANCEL_NOTICE_HOURS, CUSTOMER_CANCEL_REFUNDS, CUSTOMER_MOVE_HOURS, DEPOSIT_PERCENT, MAX_DAYS_AHEAD, STUDIO, getType, money, ukToMs } from "./studio.js";
import { PAGE_STYLE, escapeHtml as e } from "../referrals.js";

// Website bookings one visitor can start in 24 hours (stops someone holding every slot)
const HOLDS_PER_VISITOR_PER_DAY = 6;

export async function handleBookingPages(request, env) {
  const url = new URL(request.url);
  const path = url.pathname;

  if (path === "/stripe/webhook") return stripeWebhook(request, env);

  // Changes only from these pages themselves (stops other websites acting for a visitor)
  if (request.method === "POST" && request.headers.get("Origin") !== url.origin) return json({ error: "Forbidden" }, 403);
  // Every request here costs a calendar lookup: one visitor can't run up the bill
  if (await tooMany(env.VOICE_LIMIT, request.headers.get("CF-Connecting-IP"))) return json({ error: "Too many requests. Give it a minute." }, 429);

  if (path === "/book" && request.method === "GET") return bookPage(env, url);
  if (path === "/book/api/times" && request.method === "POST") return times(request, env);
  if (path === "/book/api/checkout" && request.method === "POST") return checkout(request, env);
  if (path === "/book/cancelled") return checkoutCancelled(env, url);
  if (path === "/book/sandbox-pay") return sandboxPay(request, env, url);

  const pay = path.match(/^\/pay\/([A-Za-z0-9_-]{20,64})$/);
  if (pay && request.method === "GET") return payLink(env, pay[1], url.searchParams.get("for"));

  const manage = path.match(/^\/booking\/([A-Za-z0-9_-]{20,64})(\/times|\/move|\/cancel)?$/);
  if (manage) {
    const b = await getBookingByToken(env, manage[1]);
    if (!b) return html(messagePage("Booking not found", "That link doesn't match a booking. Check the link in your email, or contact the studio."), 404);
    if (!manage[2] && request.method === "GET") return html(managePage(env, b, url));
    if (manage[2] === "/times" && request.method === "POST") return moveTimes(request, env, b);
    if (manage[2] === "/move" && request.method === "POST") return customerMove(request, env, b);
    if (manage[2] === "/cancel" && request.method === "POST") return json(await customerCancel(env, b));
  }
  return json({ error: "Not found" }, 404);
}

// ===== THE BOOKING PAGE =====

async function bookPage(env, url) {
  const ready = (await googleReady(env)) && stripeReady(env);
  const q = url.searchParams;
  const sessions = getSessionTypes();
  const prefill = {
    session: getType(q.get("session")) ? Number(q.get("session")) : null,
    date: isRealDate(q.get("date")) ? q.get("date") : "",
    time: normaliseTime(q.get("time")),
    first: (q.get("first") || "").slice(0, 60),
    last: (q.get("last") || "").slice(0, 60),
    email: (q.get("email") || "").slice(0, 200),
    phone: (q.get("phone") || "").slice(0, 40),
    referral: (q.get("ref") || "").slice(0, 32),
  };
  const data = { sessions, prefill, today: ukToday(), maxDays: MAX_DAYS_AHEAD, deposit: DEPOSIT_PERCENT, ready };
  return html(bookingHtml(data));
}

async function times(request, env) {
  const body = await readJson(request);
  try {
    const { times, problem } = await freeTimesOn(env, body.session, String(body.date || ""));
    return json(problem ? { times: [], message: problem } : { times });
  } catch (err) {
    console.log("Booking page couldn't read free times:", err);
    return json({ times: [], message: "Couldn't check the free times just now. Please try again." });
  }
}

async function checkout(request, env) {
  const body = await readJson(request);
  const text = (v, max) => (typeof v === "string" ? v.trim().slice(0, max) : "");
  const type = getType(body.session);
  const person = { firstName: text(body.first, 60), lastName: text(body.last, 60), email: text(body.email, 200).toLowerCase(), phone: text(body.phone, 40) };
  if (!type) return json({ ok: false, field: "session", message: "Pick a session." });
  if (!isRealDate(body.date) || !normaliseTime(body.time)) return json({ ok: false, field: "time", message: "Pick a day and a start time." });
  if (!person.firstName || !person.lastName) return json({ ok: false, field: "name", message: "Please add your first and last name." });
  if (!isEmail(person.email)) return json({ ok: false, field: "email", message: "That email address doesn't look right." });
  if (!person.phone) return json({ ok: false, field: "phone", message: "Please add your phone number." });
  if (!((await googleReady(env)) && stripeReady(env))) return json({ ok: false, message: "Online booking isn't available right now. Please contact the studio." });

  const sender = await senderId(request.headers.get("CF-Connecting-IP") || "unknown");
  const { count } = await env.DB.prepare("SELECT COUNT(*) AS count FROM bookings WHERE sender = ? AND source = 'website' AND created_at > ?")
    .bind(sender, new Date(Date.now() - 86_400_000).toISOString())
    .first();
  if (count >= HOLDS_PER_VISITOR_PER_DAY) return json({ ok: false, message: "That's a lot of bookings started today. Please contact the studio to book more." });

  try {
    const made = await createBooking(env, {
      type,
      date: body.date,
      time: normaliseTime(body.time),
      person,
      source: "website",
      status: "hold",
      notes: text(body.notes, 1000),
      referralCode: text(body.referral, 32),
      sender,
    });
    if (made.problem) return json({ ok: false, field: made.taken ? "time" : undefined, message: made.taken ? "Sorry, that time has just been taken. Please pick another." : made.problem });
    const pay = await startCheckout(env, made.booking, "deposit", { hold: true });
    if (pay.problem) {
      await releaseHold(env, made.booking);
      return json({ ok: false, message: pay.problem });
    }
    return json({ ok: true, url: pay.url });
  } catch (err) {
    console.log("Booking page checkout failed:", err);
    return json({ ok: false, message: "Sorry, something went wrong. Please try again in a moment." });
  }
}

async function checkoutCancelled(env, url) {
  const b = await getBookingByToken(env, url.searchParams.get("token"));
  if (b && b.status === "hold" && b.paid_pence === 0) await releaseHold(env, b);
  const again = b ? `/book?session=${b.type_id}&first=${encodeURIComponent(b.first_name)}&last=${encodeURIComponent(b.last_name)}&email=${encodeURIComponent(b.email)}&phone=${encodeURIComponent(b.phone || "")}` : "/book";
  return html(messagePage("Not booked", "No payment was taken and the time has been let go. You can pick a time again whenever you're ready.", [["Book again", again]]));
}

// ===== PAYING =====

async function payLink(env, token, purpose) {
  const b = await getBookingByToken(env, token);
  if (!b) return html(messagePage("Booking not found", "That payment link doesn't match a booking. Please contact the studio."), 404);
  if (b.status !== "booked" && b.status !== "hold") return html(messagePage("Nothing to pay", `This booking is ${b.status}, so there's nothing to pay.`, [["Your booking", `/booking/${b.token}`]]));
  try {
    const pay = await startCheckout(env, b, purpose === "deposit" || purpose === "balance" ? purpose : "auto", { hold: b.status === "hold" });
    if (pay.problem) return html(messagePage("Nothing to pay", pay.problem, [["Your booking", `/booking/${b.token}`]]));
    return Response.redirect(pay.url, 303);
  } catch (err) {
    console.log("Pay link failed:", err);
    return html(messagePage("Payment isn't available", "The payment page couldn't be opened just now. Please try again in a minute.", [["Your booking", `/booking/${b.token}`]]), 502);
  }
}

async function stripeWebhook(request, env) {
  if (request.method !== "POST") return new Response("Method not allowed", { status: 405 });
  const payload = await request.text();
  const event = await verifyWebhook(env, payload, request.headers.get("Stripe-Signature"));
  if (!event) return new Response("Bad signature", { status: 400 });
  const session = event.data?.object || {};
  const bookingId = Number(session.metadata?.booking_id || session.client_reference_id);
  try {
    if ((event.type === "checkout.session.completed" || event.type === "checkout.session.async_payment_succeeded") && session.payment_status === "paid" && bookingId) {
      await paymentReceived(env, { bookingId, amountPence: Number(session.amount_total) || 0, stripeId: String(session.payment_intent || session.id), purpose: session.metadata?.purpose });
    } else if (event.type === "checkout.session.expired" && bookingId) {
      await checkoutExpired(env, { bookingId, checkoutId: session.id });
    }
  } catch (err) {
    console.log("Stripe webhook failed:", err);
    // Stripe tries again later (payments are only counted once)
    return new Response("Error", { status: 500 });
  }
  return new Response("OK");
}

// Sandbox only: a page standing in for Stripe's checkout
async function sandboxPay(request, env, url) {
  if (!stripeOffline(env)) return json({ error: "Not found" }, 404);
  const b = await getBookingByToken(env, url.searchParams.get("token"));
  const amount = Number(url.searchParams.get("amount")) || 0;
  const purpose = url.searchParams.get("for") || "payment";
  if (!b) return html(messagePage("Booking not found", "No such booking."), 404);
  if (request.method === "POST") {
    await paymentReceived(env, { bookingId: b.id, amountPence: amount, stripeId: `sandbox_${crypto.randomUUID()}`, purpose });
    return Response.redirect(`${url.origin}/booking/${b.token}?paid=1`, 303);
  }
  return html(
    messagePage(
      "Sandbox checkout",
      `🧪 This stands in for Stripe's payment page (the sandbox has no Stripe key). Pressing Pay records ${money(amount)} for booking #${b.id} (${purpose}) as if a card had been charged.`,
      [],
      `<form method="post"><button class="btn" type="submit">Pay ${e(money(amount))}</button></form>
       <p><a href="/book/cancelled?token=${encodeURIComponent(b.token)}">Cancel and go back</a></p>`
    )
  );
}

// ===== MANAGING A BOOKING =====

async function moveTimes(request, env, b) {
  if (!customerCanMove(b)) return json({ times: [], message: "This booking can't be moved online." });
  const body = await readJson(request);
  try {
    const { times, problem } = await freeTimesOn(env, b.type_id, String(body.date || ""), ukToday(), { ignoreBookingId: b.id });
    // Only times far enough ahead to be allowed
    const soonest = Date.now() + CUSTOMER_MOVE_HOURS * 3_600_000;
    const allowed = (times || []).filter((t) => ukToMs(String(body.date), t) >= soonest);
    return json(problem ? { times: [], message: problem } : { times: allowed });
  } catch (err) {
    console.log("Couldn't read free times for a move:", err);
    return json({ times: [], message: "Couldn't check the free times just now. Please try again." });
  }
}

async function customerMove(request, env, b) {
  if (!customerCanMove(b)) return json({ ok: false, message: `Bookings can be moved online up to ${CUSTOMER_MOVE_HOURS} hours before. Please contact the studio.` });
  const body = await readJson(request);
  const date = String(body.date || "");
  const time = normaliseTime(body.time);
  if (!isRealDate(date) || !time) return json({ ok: false, message: "Pick a day and a start time." });
  // The new time must also leave the cancellation notice, or moving would dodge the policy
  if ((ukToMs(date, time) - Date.now()) / 3_600_000 < CUSTOMER_MOVE_HOURS) {
    return json({ ok: false, message: `The new time needs to be at least ${CUSTOMER_MOVE_HOURS} hours away. For anything sooner, please contact the studio.` });
  }
  const result = await moveBooking(env, b, { date, time, by: "customer" });
  return json({ ok: result.ok, message: result.ok ? `Moved to ${dayInWords(date)} at ${time}. We've emailed you the new details.` : result.taken ? "Sorry, that time has just been taken." : result.message });
}

function managePage(env, b, url) {
  const { net, depositDue, balanceDue } = moneyState(b);
  const justPaid = url.searchParams.get("paid") === "1";
  const pending = justPaid && b.status === "hold";
  const canMove = customerCanMove(b);
  const refund = policyRefund(b);
  const statusText = {
    hold: pending ? "Confirming your payment…" : "Waiting for the deposit",
    booked: depositDue > 0 ? "Booked: deposit to pay" : "Booked",
    cancelled: "Cancelled",
    expired: "Not booked (the deposit wasn't paid in time)",
  }[b.status];
  const cancelLine =
    net <= 0
      ? "Nothing has been paid, so there's nothing to refund."
      : refund > 0
        ? `You'd get ${money(refund)} back${CUSTOMER_CANCEL_REFUNDS === "auto" ? ", refunded to your card" : "; the team will process the refund"}.`
        : `It's less than ${CANCEL_NOTICE_HOURS} hours away, so the ${money(b.deposit_pence)} deposit is non-refundable.`;
  const rows = [
    ["Session", b.session],
    ["When", `${when(b)} (UK time)`],
    ["Name", fullName(b)],
    ["Booking", `#${b.id}`],
    ["Price", money(b.price_pence)],
    ["Paid", net > 0 ? money(net) : "Nothing yet"],
    ...(b.status === "booked" && balanceDue > 0 ? [["To pay", `${money(balanceDue)}${depositDue > 0 ? ` (deposit ${money(depositDue)} now, the rest on arrival)` : " on arrival, or online now"}`]] : []),
  ];
  const data = { token: b.token, canMove, sessionId: b.type_id, today: ukToday(), maxDays: MAX_DAYS_AHEAD, pending };
  return `<!DOCTYPE html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1">
<title>Your booking | Novacane</title>${pending ? '<meta http-equiv="refresh" content="3">' : ""}
<style>${PAGE_STYLE}${BOOK_STYLE}</style></head><body><main class="card">
<p class="kicker">Novacane Studios · Booking #${b.id}</p>
<h1>${e(statusText)}</h1>
${justPaid && b.status === "booked" ? `<p class="ok">Payment received, thank you. A confirmation is on its way to ${e(b.email)}.</p>` : ""}
${pending ? `<p>Stripe has taken your payment; we're just confirming it with the calendar. This page refreshes itself.</p>` : ""}
<table class="rows">${rows.map(([k, v]) => `<tr><th>${e(k)}</th><td>${e(v)}</td></tr>`).join("")}</table>
<div class="actions">
${b.status === "booked" && depositDue > 0 ? `<a class="btn" href="/pay/${e(b.token)}?for=deposit">Pay the ${e(money(depositDue))} deposit</a>` : ""}
${b.status === "booked" && depositDue === 0 && balanceDue > 0 ? `<a class="btn ghost" href="/pay/${e(b.token)}?for=balance">Pay the ${e(money(balanceDue))} balance now</a>` : ""}
${b.status === "hold" && !pending ? `<a class="btn" href="/pay/${e(b.token)}?for=deposit">Pay the deposit</a>` : ""}
${b.status === "booked" && canMove ? `<button class="btn ghost" type="button" id="move-open">Move it</button>` : ""}
${b.status === "booked" ? `<button class="btn ghost danger" type="button" id="cancel-open">Cancel it</button>` : ""}
${b.status === "cancelled" || b.status === "expired" ? `<a class="btn" href="/book?session=${b.type_id}">Book again</a>` : ""}
</div>
${b.status === "booked" && !canMove ? `<p class="small">It's less than ${CUSTOMER_MOVE_HOURS} hours away, so to move it please contact the studio.</p>` : ""}

<section id="move" hidden>
  <h2>Move it</h2>
  <p class="small">Pick a new day and start time (at least ${CUSTOMER_MOVE_HOURS} hours away).</p>
  <div class="days" id="days"></div>
  <div class="times" id="times"></div>
  <p class="msg" id="move-msg" role="status"></p>
  <button class="btn" type="button" id="move-go" disabled>Move it here</button>
</section>

<section id="cancel" hidden>
  <h2>Cancel it?</h2>
  <p>${e(cancelLine)}</p>
  <p class="msg" id="cancel-msg" role="status"></p>
  <button class="btn danger" type="button" id="cancel-go">Yes, cancel my booking</button>
  <button class="btn ghost" type="button" id="cancel-keep">Keep it</button>
</section>

<p class="small foot">Questions? WhatsApp <a href="${e(STUDIO.whatsappLink)}">${e(STUDIO.whatsapp)}</a> or email <a href="mailto:${e(STUDIO.email)}">${e(STUDIO.email)}</a>.</p>
</main>
<script>const DATA = ${safeJson(data)};${MANAGE_SCRIPT}</script>
</body></html>`;
}

// ===== LOOK AND BEHAVIOUR =====

const BOOK_STYLE = `
  main.card { max-width: 640px; margin: 5vh auto; padding: 34px 28px; background: #150d1f; border-radius: 40px 40px 56px 40px; box-shadow: 0 20px 60px rgba(113, 4, 57, 0.6); }
  .kicker { margin: 0; font-size: 12px; letter-spacing: 0.3em; text-transform: uppercase; color: #ff8cc6; }
  h1 { font-size: clamp(22px, 4vw, 30px); margin: 6px 0 14px; line-height: 1.1; }
  h2 { font-family: Archivo, "Arial Black", sans-serif; font-stretch: 125%; font-weight: 900; text-transform: uppercase; color: #fff; font-size: 17px; margin: 26px 0 10px; }
  p { line-height: 1.55; }
  .small { font-size: 14px; color: rgba(229, 194, 224, 0.75); }
  .ok { color: #8dffc1; font-weight: 600; }
  .rows { width: 100%; border-collapse: collapse; margin: 6px 0 18px; }
  .rows th { text-align: left; font-weight: 500; font-size: 12px; letter-spacing: 0.18em; text-transform: uppercase; color: rgba(229, 194, 224, 0.7); padding: 9px 12px 9px 0; vertical-align: top; width: 32%; border-bottom: 1px solid rgba(229, 194, 224, 0.14); }
  .rows td { padding: 9px 0; color: #fff; border-bottom: 1px solid rgba(229, 194, 224, 0.14); }
  .actions { display: flex; flex-wrap: wrap; gap: 10px; margin: 8px 0 4px; }
  .btn.danger { background: transparent; border: 1px solid #e5484d; color: #ffb1b4; }
  .btn[disabled] { opacity: 0.45; cursor: not-allowed; }
  label { display: block; font-size: 13px; letter-spacing: 0.1em; text-transform: uppercase; margin: 14px 0 6px; color: rgba(229, 194, 224, 0.85); }
  input[type=text], input[type=email], input[type=tel], textarea, select {
    width: 100%; padding: 12px 14px; border-radius: 14px; border: 1px solid rgba(229, 194, 224, 0.35); background: rgba(255, 255, 255, 0.05); color: #fff; font: inherit;
  }
  select option { background: #1c1129; }
  textarea { min-height: 80px; resize: vertical; }
  input:focus, textarea:focus, select:focus { outline: 2px solid #ff5fa8; outline-offset: 1px; }
  .grid2 { display: grid; grid-template-columns: 1fr 1fr; gap: 0 12px; }
  .sessions { display: grid; gap: 8px; }
  .session { display: flex; justify-content: space-between; gap: 12px; align-items: center; text-align: left; width: 100%; padding: 12px 16px; border-radius: 16px; border: 1px solid rgba(229, 194, 224, 0.25); background: rgba(255, 255, 255, 0.03); color: inherit; cursor: pointer; font: inherit; }
  .session small { display: block; color: rgba(229, 194, 224, 0.65); font-size: 13px; margin-top: 2px; }
  .session b { color: #ff5fa8; white-space: nowrap; }
  .session[aria-pressed=true] { border-color: transparent; background: linear-gradient(120deg, #b01d68, #7a1f86); color: #fff; }
  .session[aria-pressed=true] b, .session[aria-pressed=true] small { color: #ffd1ea; }
  .days { display: flex; gap: 8px; overflow-x: auto; padding: 4px 2px 10px; scrollbar-width: thin; }
  .day { flex: none; width: 64px; padding: 8px 0; border-radius: 16px; border: 1px solid rgba(229, 194, 224, 0.25); background: rgba(255, 255, 255, 0.03); color: inherit; cursor: pointer; text-align: center; font: inherit; }
  .day span { display: block; font-size: 11px; letter-spacing: 0.12em; text-transform: uppercase; opacity: 0.75; }
  .day strong { display: block; font-family: Archivo, "Arial Black", sans-serif; font-stretch: 125%; font-size: 20px; color: #fff; }
  .day[aria-pressed=true] { background: linear-gradient(120deg, #b01d68, #7a1f86); border-color: transparent; }
  .times { display: grid; grid-template-columns: repeat(auto-fill, minmax(76px, 1fr)); gap: 8px; margin-top: 6px; }
  .time { padding: 10px 0; border-radius: 12px; border: 1px solid rgba(229, 194, 224, 0.3); background: rgba(255, 255, 255, 0.04); color: #fff; cursor: pointer; font: inherit; font-weight: 600; }
  .time[aria-pressed=true] { background: #ff5fa8; color: #150d1f; border-color: transparent; }
  .msg { min-height: 1.4em; font-weight: 600; }
  .msg.error { color: #ff8fbf; }
  .summary { padding: 14px 16px; border-radius: 16px; background: rgba(255, 95, 168, 0.1); border: 1px solid rgba(255, 95, 168, 0.35); }
  .foot { margin-top: 28px; }
  [hidden] { display: none !important; }
  @media (max-width: 560px) { main.card { margin: 0; min-height: 100vh; border-radius: 0; padding: 26px 18px; } .grid2 { grid-template-columns: 1fr; } }
`;

function bookingHtml(data) {
  return `<!DOCTYPE html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1">
<title>Book a session | Novacane Studios</title>
<style>${PAGE_STYLE}${BOOK_STYLE}</style></head><body><main class="card">
<p class="kicker">Novacane Studios</p>
<h1>Book a session</h1>
${data.ready ? "" : `<p class="msg error">Online booking isn't available right now. Please WhatsApp <a href="${e(STUDIO.whatsappLink)}">${e(STUDIO.whatsapp)}</a> or email <a href="mailto:${e(STUDIO.email)}">${e(STUDIO.email)}</a> and we'll book you in.</p>`}
<form id="book" ${data.ready ? "" : "hidden"} novalidate>
  <h2>1. Session</h2>
  <div class="sessions" id="sessions" role="group" aria-label="Session"></div>
  <h2>2. Day and start time</h2>
  <p class="small">UK time. Times shown are free right now.</p>
  <div class="days" id="days" role="group" aria-label="Day"></div>
  <div class="times" id="times" role="group" aria-label="Start time"></div>
  <p class="msg" id="time-msg" role="status"></p>
  <h2>3. Your details</h2>
  <div class="grid2">
    <div><label for="first">First name</label><input type="text" id="first" autocomplete="given-name" maxlength="60" required></div>
    <div><label for="last">Last name</label><input type="text" id="last" autocomplete="family-name" maxlength="60" required></div>
  </div>
  <label for="email">Email</label><input type="email" id="email" autocomplete="email" maxlength="200" required>
  <label for="phone">Phone</label><input type="tel" id="phone" autocomplete="tel" maxlength="40" required>
  <label for="notes">Anything we should know? (optional)</label><textarea id="notes" maxlength="1000" placeholder="What you're recording, who's coming, gear you're bringing…"></textarea>
  <label for="referral">Referral code (optional)</label><input type="text" id="referral" maxlength="32" autocapitalize="characters" placeholder="e.g. JAMES10">
  <h2>4. Pay the deposit</h2>
  <p class="summary" id="summary">Pick a session and a time.</p>
  <p class="small">A ${data.deposit}% deposit secures your session; the rest is due on arrival. Paid securely with Stripe (card, Apple Pay, Google Pay). Cancelling with less than ${CANCEL_NOTICE_HOURS} hours' notice loses the deposit.</p>
  <p class="msg" id="msg" role="status" aria-live="polite"></p>
  <button class="btn" type="submit" id="go">Continue to payment</button>
</form>
<p class="small foot">Something bigger (an album, a band, custom work)? <a href="${e(STUDIO.website)}/bookings-contact#enquiry">Send an enquiry</a>.</p>
</main>
<script>const DATA = ${safeJson(data)};${BOOK_SCRIPT}</script>
</body></html>`;
}

// The booking page's script (runs in the customer's browser)
const BOOK_SCRIPT = `
const $ = (id) => document.getElementById(id);
const state = { session: DATA.prefill.session, date: DATA.prefill.date, time: DATA.prefill.time };
for (const k of ["first", "last", "email", "phone", "referral"]) if (DATA.prefill[k]) $(k).value = DATA.prefill[k];
const addDays = (ymd, n) => { const d = new Date(ymd + "T00:00:00Z"); d.setUTCDate(d.getUTCDate() + n); return d.toISOString().slice(0, 10); };
const fmt = (ymd, o) => new Date(ymd + "T12:00:00Z").toLocaleDateString("en-GB", { timeZone: "UTC", ...o });
function el(tag, cls, text) { const n = document.createElement(tag); if (cls) n.className = cls; if (text != null) n.textContent = text; return n; }

function drawSessions() {
  $("sessions").replaceChildren(...DATA.sessions.map((s) => {
    const b = el("button", "session"); b.type = "button"; b.setAttribute("aria-pressed", String(s.id === state.session));
    const left = el("span"); left.append(el("span", "", s.name.replace(/\\s*\\(.*\\)\\s*$/, "")));
    const extra = (s.name.match(/\\((.*)\\)/) || [])[1]; const hrs = s.duration / 60; left.append(el("small", "", (extra ? extra + " · " : "") + hrs + (hrs === 1 ? " hour" : " hours") + " in total"));
    b.append(left, el("b", "", s.price));
    b.onclick = () => { state.session = s.id; state.time = ""; drawSessions(); loadTimes(); summary(); };
    return b;
  }));
}
function drawDays() {
  const days = [];
  if (!state.date) state.date = DATA.today;
  for (let i = 0; i < Math.min(DATA.maxDays, 60); i++) {
    const d = addDays(DATA.today, i);
    const b = el("button", "day"); b.type = "button"; b.setAttribute("aria-pressed", String(d === state.date));
    b.append(el("span", "", fmt(d, { weekday: "short" })), el("strong", "", fmt(d, { day: "numeric" })), el("span", "", fmt(d, { month: "short" })));
    b.onclick = () => { state.date = d; state.time = ""; drawDays(); loadTimes(); summary(); };
    days.push(b);
  }
  $("days").replaceChildren(...days);
  const on = $("days").querySelector("[aria-pressed=true]"); if (on) on.scrollIntoView({ block: "nearest", inline: "center" });
}
let ask = 0;
async function loadTimes() {
  const mine = ++ask;
  $("times").replaceChildren();
  if (!state.session) { $("time-msg").textContent = "Pick a session first."; return; }
  $("time-msg").textContent = "Checking the calendar…";
  try {
    const res = await fetch("/book/api/times", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ session: state.session, date: state.date }) });
    const data = await res.json();
    if (mine !== ask) return;
    const times = data.times || [];
    if (state.time && !times.includes(state.time)) state.time = "";
    $("time-msg").textContent = data.message || (times.length ? "" : "Nothing free that day. Try another.");
    $("times").replaceChildren(...times.map((t) => { const b = el("button", "time", t); b.type = "button"; b.setAttribute("aria-pressed", String(t === state.time)); b.onclick = () => { state.time = t; loadTimesPressed(); summary(); }; return b; }));
  } catch { if (mine === ask) $("time-msg").textContent = "Couldn't check the calendar. Please try again."; }
}
function loadTimesPressed() { for (const b of $("times").children) b.setAttribute("aria-pressed", String(b.textContent === state.time)); }
function summary() {
  const s = DATA.sessions.find((x) => x.id === state.session);
  if (!s || !state.time) { $("summary").textContent = "Pick a session and a time."; return; }
  const price = Number(s.price.replace(/[^0-9.]/g, ""));
  const deposit = Math.round(price * DATA.deposit) / 100;
  $("summary").textContent = s.name + " · " + fmt(state.date, { weekday: "long", day: "numeric", month: "long" }) + " at " + state.time + " · deposit £" + (Number.isInteger(deposit) ? deposit : deposit.toFixed(2)) + " of " + s.price;
}
$("book").addEventListener("submit", async (ev) => {
  ev.preventDefault();
  const msg = $("msg"); msg.className = "msg"; msg.textContent = "Holding your time…"; $("go").disabled = true;
  try {
    const res = await fetch("/book/api/checkout", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ session: state.session, date: state.date, time: state.time, first: $("first").value, last: $("last").value, email: $("email").value, phone: $("phone").value, notes: $("notes").value, referral: $("referral").value }) });
    const data = await res.json();
    if (data.ok && data.url) { msg.textContent = "Taking you to secure payment…"; location.href = data.url; return; }
    msg.className = "msg error"; msg.textContent = data.message || data.error || "That didn't work. Please try again.";
    if (data.field === "time") loadTimes();
    if (["first", "last", "email", "phone"].includes(data.field === "name" ? "first" : data.field)) $(data.field === "name" ? "first" : data.field).focus();
  } catch { msg.className = "msg error"; msg.textContent = "Couldn't reach the studio. Please try again."; }
  $("go").disabled = false;
});
drawSessions(); drawDays(); loadTimes(); summary();
`;

// The manage page's script
const MANAGE_SCRIPT = `
const $ = (id) => document.getElementById(id);
const addDays = (ymd, n) => { const d = new Date(ymd + "T00:00:00Z"); d.setUTCDate(d.getUTCDate() + n); return d.toISOString().slice(0, 10); };
const fmt = (ymd, o) => new Date(ymd + "T12:00:00Z").toLocaleDateString("en-GB", { timeZone: "UTC", ...o });
function el(tag, cls, text) { const n = document.createElement(tag); if (cls) n.className = cls; if (text != null) n.textContent = text; return n; }
const post = (path, body) => fetch(location.pathname + path, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body || {}) }).then((r) => r.json());
const move = { date: addDays(DATA.today, 2), time: "" };
if ($("move-open")) $("move-open").onclick = () => { $("move").hidden = false; $("cancel").hidden = true; days(); times(); $("move").scrollIntoView({ behavior: "smooth" }); };
if ($("cancel-open")) $("cancel-open").onclick = () => { $("cancel").hidden = false; $("move").hidden = true; $("cancel").scrollIntoView({ behavior: "smooth" }); };
if ($("cancel-keep")) $("cancel-keep").onclick = () => { $("cancel").hidden = true; };
function days() {
  const list = [];
  for (let i = 2; i < Math.min(DATA.maxDays, 62); i++) { const d = addDays(DATA.today, i); const b = el("button", "day"); b.type = "button"; b.setAttribute("aria-pressed", String(d === move.date)); b.append(el("span", "", fmt(d, { weekday: "short" })), el("strong", "", fmt(d, { day: "numeric" })), el("span", "", fmt(d, { month: "short" }))); b.onclick = () => { move.date = d; move.time = ""; days(); times(); }; list.push(b); }
  $("days").replaceChildren(...list);
}
async function times() {
  $("times").replaceChildren(); $("move-go").disabled = true; $("move-msg").textContent = "Checking the calendar…";
  const data = await post("/times", { date: move.date }).catch(() => ({ times: [], message: "Couldn't check the calendar." }));
  $("move-msg").textContent = data.message || (data.times.length ? "" : "Nothing free that day.");
  $("times").replaceChildren(...data.times.map((t) => { const b = el("button", "time", t); b.type = "button"; b.setAttribute("aria-pressed", "false"); b.onclick = () => { move.time = t; for (const x of $("times").children) x.setAttribute("aria-pressed", String(x.textContent === t)); $("move-go").disabled = false; }; return b; }));
}
if ($("move-go")) $("move-go").onclick = async () => { $("move-go").disabled = true; $("move-msg").textContent = "Moving it…"; const r = await post("/move", move).catch(() => ({ message: "Couldn't reach the studio." })); $("move-msg").textContent = r.message; if (r.ok) setTimeout(() => location.reload(), 1500); else { $("move-go").disabled = false; times(); } };
if ($("cancel-go")) $("cancel-go").onclick = async () => { $("cancel-go").disabled = true; $("cancel-msg").textContent = "Cancelling…"; const r = await post("/cancel").catch(() => ({ message: "Couldn't reach the studio." })); $("cancel-msg").textContent = r.ok ? "Cancelled. We've emailed you." : r.message; if (r.ok) setTimeout(() => location.reload(), 1500); else $("cancel-go").disabled = false; };
`;

function messagePage(title, text, links = [], extra = "") {
  return `<!DOCTYPE html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1"><title>${e(title)} | Novacane</title>
<style>${PAGE_STYLE}${BOOK_STYLE}</style></head><body><main class="card"><p class="kicker">Novacane Studios</p><h1>${e(title)}</h1><p>${e(text)}</p>
${extra}<div class="actions">${links.map(([label, href]) => `<a class="btn" href="${e(href)}">${e(label)}</a>`).join("")}</div></main></body></html>`;
}

// ===== HELPERS =====

const safeJson = (data) => JSON.stringify(data).replace(/</g, "\\u003c").replace(/\u2028|\u2029/g, "");

function html(body, status = 200) {
  return new Response(body, { status, headers: { "Content-Type": "text/html; charset=utf-8", "Cache-Control": "no-store", "Referrer-Policy": "same-origin" } });
}

function json(data, status = 200) {
  return new Response(JSON.stringify(data), { status, headers: { "Content-Type": "application/json", "Cache-Control": "no-store" } });
}

async function readJson(request) {
  try {
    const body = await request.json();
    return body && typeof body === "object" ? body : {};
  } catch {
    return {};
  }
}

async function tooMany(limiter, ip) {
  if (!limiter || !ip) return false;
  try {
    return !(await limiter.limit({ key: "book:" + ip })).success;
  } catch {
    return false;
  }
}


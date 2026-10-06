// Booking notifications and referral tracking for Acuity bookings
//
//   POST /acuity/webhook  Acuity tells us about each booking; we save it
//   GET  /referral        "Did anyone refer you?" page, linked from Acuity's
//                         confirmation page (see README-REFERRALS.md)
//   POST /referral        that page saves the answer against the booking
//
// Booking notifications need the ACUITY_WEBHOOK_KEY secret, added to the end of
// the webhook address in Acuity (…/acuity/webhook?key=…). Referral tracking
// also needs ACUITY_USER_ID and ACUITY_API_KEY (Acuity's Powerhouse plan).

import { bookingChanged } from "./booking-pings.js";
import { calendarChanged } from "./club-calendar.js";

const ACUITY_API = "https://acuityscheduling.com/api/v1";
const APPOINTMENT_ACTIONS = ["scheduled", "rescheduled", "canceled", "changed"];
const MAX_WRONG_CODES = 5;
const CODE_PATTERN = /^[A-Z0-9-]{3,32}$/;

// "james 10" -> "JAMES10"
export function normaliseCode(code) {
  return String(code || "").toUpperCase().replace(/\s+/g, "");
}

export function isValidCodeFormat(code) {
  return CODE_PATTERN.test(code);
}

// ===== ACUITY =====

// Acuity signs each webhook: base64 HMAC-SHA256 of the body, keyed with the API key
async function verifySignature(bodyBytes, signature, apiKey) {
  if (!signature) return false;
  const key = await crypto.subtle.importKey(
    "raw",
    new TextEncoder().encode(apiKey),
    { name: "HMAC", hash: "SHA-256" },
    false,
    ["sign"]
  );
  const mac = await crypto.subtle.sign("HMAC", key, bodyBytes);
  const expected = new TextEncoder().encode(btoa(String.fromCharCode(...new Uint8Array(mac))));
  const given = new TextEncoder().encode(signature);
  return expected.byteLength === given.byteLength && crypto.subtle.timingSafeEqual(expected, given);
}

// Which Acuity account the saved secrets belong to (for the admin page's
// "Check Acuity connection")
export async function checkAcuity(env) {
  if (!env.ACUITY_USER_ID || !env.ACUITY_API_KEY) {
    return { ok: false, message: "The ACUITY_USER_ID and ACUITY_API_KEY secrets aren't set yet." };
  }
  try {
    const res = await fetch(`${ACUITY_API}/me`, {
      headers: { Authorization: "Basic " + btoa(`${env.ACUITY_USER_ID.trim()}:${env.ACUITY_API_KEY.trim()}`) },
    });
    if (res.status === 401) {
      return { ok: false, message: "Acuity didn't accept the User ID and API key (401). One of them is wrong, or they're from different accounts." };
    }
    if (res.status === 403) {
      return {
        ok: false,
        needsPlan: true,
        message: "Acuity accepted the key but refused access (403): this Acuity plan doesn't include the API.",
      };
    }
    if (!res.ok) return { ok: false, message: `Acuity answered with an error (${res.status}). Try again in a minute.` };
    const me = await res.json();
    return { ok: true, account: { id: me.id, name: me.name, email: me.email, plan: me.plan } };
  } catch (err) {
    return { ok: false, message: "Couldn't reach Acuity: " + err.message };
  }
}

// The full appointment from Acuity, or null if it doesn't exist
async function fetchAppointment(env, id) {
  if (!env.ACUITY_USER_ID || !env.ACUITY_API_KEY) {
    throw new Error("ACUITY_USER_ID / ACUITY_API_KEY secrets aren't set");
  }
  const res = await fetch(`${ACUITY_API}/appointments/${id}`, {
    headers: { Authorization: "Basic " + btoa(`${env.ACUITY_USER_ID.trim()}:${env.ACUITY_API_KEY.trim()}`) },
  });
  if (res.status === 400 || res.status === 404) return null;
  if (!res.ok) throw new Error("Acuity API error " + res.status);
  return res.json();
}

async function saveAppointment(env, appt) {
  const now = new Date().toISOString();
  await env.DB.prepare(
    `INSERT INTO appointments
       (id, first_name, last_name, email, phone, appointment_type, starts_at, status, booked_at, updated_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
     ON CONFLICT (id) DO UPDATE SET
       first_name = excluded.first_name, last_name = excluded.last_name,
       email = excluded.email, phone = excluded.phone,
       appointment_type = excluded.appointment_type, starts_at = excluded.starts_at,
       status = excluded.status, updated_at = excluded.updated_at`
  )
    .bind(
      Number(appt.id),
      appt.firstName || null,
      appt.lastName || null,
      appt.email || null,
      appt.phone || null,
      appt.type || null,
      appt.datetime || null,
      appt.canceled ? "canceled" : "scheduled",
      appt.datetimeCreated || now,
      now
    )
    .run();
}

async function findActiveCode(env, code) {
  if (!isValidCodeFormat(code)) return null;
  return env.DB.prepare("SELECT code, referrer FROM referral_codes WHERE code = ? AND active = 1")
    .bind(code)
    .first();
}

async function recordReferral(env, id, { answer, code = null, referrer = null, referredBy = null, invalidCode = null, source }) {
  await env.DB.prepare(
    `UPDATE appointments SET referral_answer = ?, referral_code = ?, referrer_name = ?,
       referred_by = ?, invalid_code = ?, referral_source = ?, referral_at = ?
     WHERE id = ?`
  )
    .bind(answer, code, referrer, referredBy, invalidCode, source, new Date().toISOString(), Number(id))
    .run();
}

// A referral code typed into the Acuity booking form (any field with
// "referral" in its name) is checked and saved too, unless the customer has
// already answered on the referral page.
async function applyFormReferral(env, appt) {
  let typed = "";
  for (const form of appt.forms || []) {
    for (const field of form.values || []) {
      if (/referr/i.test(field.name || "") && String(field.value || "").trim()) typed = String(field.value).trim();
    }
  }
  if (!typed) return;

  const row = await env.DB.prepare("SELECT referral_answer FROM appointments WHERE id = ?").bind(Number(appt.id)).first();
  if (!row || row.referral_answer) return;

  const code = normaliseCode(typed);
  const active = await findActiveCode(env, code);
  if (active) {
    await recordReferral(env, appt.id, { answer: "yes", code: active.code, referrer: active.referrer, source: "booking form" });
  } else {
    // Keep what they typed so the studio can see it in the report
    await recordReferral(env, appt.id, { answer: "yes", invalidCode: typed.slice(0, 64), source: "booking form" });
  }
}

export async function handleAcuityWebhook(request, env, ctx) {
  // Acuity always sends POST; anything else isn't Acuity
  if (request.method !== "POST") return new Response("Method not allowed", { status: 405 });

  // Read the exact bytes Acuity sent (the signature check needs them untouched)
  const bodyBytes = new Uint8Array(await request.arrayBuffer());
  // Unpack the message: which booking, and what happened to it
  const form = new URLSearchParams(new TextDecoder().decode(bodyBytes));

  // Two ways to prove a message really came from Acuity, like two kinds of ID:
  // 1. the secret key in the webhook address (works on every Acuity plan)
  const keyOk = await webhookKeyMatches(request, env);
  // 2. Acuity's signature, checked with the API key (needs the Powerhouse plan)
  const signed = Boolean(env.ACUITY_API_KEY) && (await verifySignature(bodyBytes, request.headers.get("x-acuity-signature"), env.ACUITY_API_KEY.trim()));
  // Neither: turn it away
  if (!keyOk && !signed) {
    // Note it in the logs (never the keys themselves), to help spot a wrong setup
    console.log(`Acuity webhook refused: no valid key or signature (appointment ${form.get("id")}).`);
    // Tell the sender no
    return new Response("Bad signature", { status: 401 });
  }

  // What happened (scheduled, rescheduled, canceled) and to which booking
  const action = form.get("action");
  const id = form.get("id") || "";
  // Orders (packages, gift certificates) aren't appointments; nothing to do
  if (!APPOINTMENT_ACTIONS.includes(action) || !/^\d{1,15}$/.test(id)) {
    return new Response("OK");
  }

  // Nova Club shows the change next time it checks (within a second or two)
  await calendarChanged(env).catch((err) => console.log("Couldn't mark the Nova Club calendar as changed:", err));

  // Referral tracking: looks the booking up with Acuity's API, so only when signed
  if (signed) {
    try {
      const appt = await fetchAppointment(env, id);
      if (appt) {
        await saveAppointment(env, appt);
        await applyFormReferral(env, appt);
      }
    } catch (err) {
      console.log("Acuity webhook failed:", err);
      // A 500 makes Acuity retry for up to 24 hours (no notification yet, so no double ping)
      return new Response("Error", { status: 500 });
    }
  }

  // Ping staff phones about the booking (see booking-pings.js; it may wait for the details)
  const ping = bookingChanged(env, action, id, form.get("appointmentTypeID"));
  // Tell Acuity straight away and finish the ping afterwards, or (in tests) wait for it
  if (ctx) ctx.waitUntil(ping);
  else await ping;
  // Tell Acuity we've got it
  return new Response("OK");
}

// Does the webhook address carry our secret key (?key=...)?
async function webhookKeyMatches(request, env) {
  // No key set up: this way of proving it isn't available
  if (!env.ACUITY_WEBHOOK_KEY) return false;
  // The key in the address Acuity called
  const given = new URL(request.url).searchParams.get("key") || "";
  // Turn text into a fixed-length fingerprint, so the comparison takes the same time whatever was sent
  const fingerprint = async (text) => new Uint8Array(await crypto.subtle.digest("SHA-256", new TextEncoder().encode(text)));
  // Compare the fingerprints
  return crypto.subtle.timingSafeEqual(await fingerprint(given), await fingerprint(env.ACUITY_WEBHOOK_KEY));
}

// ===== THE CUSTOMER'S REFERRAL PAGE =====

// The booking, if the ID and email match (fetched from Acuity if the webhook
// hasn't arrived yet: the customer can get here within seconds of booking)
async function findBooking(env, id, email) {
  let row = await env.DB.prepare("SELECT * FROM appointments WHERE id = ?").bind(Number(id)).first();
  if (!row) {
    try {
      const appt = await fetchAppointment(env, id);
      if (appt) {
        await saveAppointment(env, appt);
        row = await env.DB.prepare("SELECT * FROM appointments WHERE id = ?").bind(Number(id)).first();
      }
    } catch (err) {
      console.log("Couldn't fetch appointment from Acuity:", err);
    }
  }
  if (!row || !row.email || row.email.toLowerCase() !== email.toLowerCase()) return null;
  return row;
}

function json(data, status = 200) {
  return new Response(JSON.stringify(data), {
    status,
    headers: { "Content-Type": "application/json", "Cache-Control": "no-store" },
  });
}

async function saveReferralAnswer(request, env) {
  let body;
  try {
    body = await request.json();
  } catch {
    return json({ error: "Something went wrong. Please try again." }, 400);
  }

  const id = String(body.id || "");
  const email = String(body.email || "").trim().slice(0, 254);
  if (!/^\d{1,15}$/.test(id) || !email) {
    return json({ error: "We couldn't find that booking." }, 404);
  }

  const booking = await findBooking(env, id, email);
  if (!booking) return json({ error: "We couldn't find that booking." }, 404);

  // One answer per booking. The only exception: a code typed on the Acuity form
  // that wasn't valid can be corrected here.
  const onlyBadFormCode = booking.invalid_code && !booking.referral_code;
  if (booking.referral_answer && !onlyBadFormCode) {
    return json({ ok: true, message: "Thanks, we've already got your answer for this booking." });
  }

  if (body.referred !== true) {
    await recordReferral(env, id, { answer: "no", source: "after booking" });
    return json({ ok: true, message: "No problem. See you at the studio 🎙️" });
  }

  const referredBy = String(body.name || "").trim().slice(0, 100) || null;
  const typed = normaliseCode(body.code);

  if (!typed) {
    await recordReferral(env, id, { answer: "yes", referredBy, source: "after booking" });
    return json({ ok: true, message: "Thanks! We've noted that on your booking." });
  }

  if (booking.referral_attempts >= MAX_WRONG_CODES) {
    return json({ error: "Too many tries. Please message the studio and we'll add it for you." }, 429);
  }

  const active = await findActiveCode(env, typed);
  if (!active) {
    await env.DB.prepare("UPDATE appointments SET referral_attempts = referral_attempts + 1 WHERE id = ?")
      .bind(Number(id))
      .run();
    return json({ error: "That code isn't active. Check it and try again, or leave it blank." }, 422);
  }

  await recordReferral(env, id, {
    answer: "yes",
    code: active.code,
    referrer: active.referrer,
    referredBy,
    source: "after booking",
  });
  return json({ ok: true, message: "Thanks! Your referral code has been added to your booking." });
}

export async function handleReferral(request, env) {
  if (request.method === "POST") return saveReferralAnswer(request, env);
  if (request.method !== "GET") return new Response("Method not allowed", { status: 405 });

  const url = new URL(request.url);
  const id = url.searchParams.get("id") || "";
  // A "+" in the email arrives as a space when Acuity doesn't encode it
  const email = (url.searchParams.get("email") || "").replace(/ /g, "+");
  return new Response(referralPage(id, email), {
    headers: { "Content-Type": "text/html; charset=utf-8", "Cache-Control": "no-store" },
  });
}

export function escapeHtml(value) {
  return String(value ?? "").replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c]);
}

// Shared look for the referral and admin pages (Novacane colours and fonts)
export const PAGE_STYLE = `
  @import url("https://fonts.googleapis.com/css2?family=Archivo:wdth,wght@125,900&family=Saira:wght@400..700&display=swap");
  :root { color-scheme: dark; }
  * { box-sizing: border-box; }
  body {
    margin: 0; min-height: 100vh; font-family: Saira, Arial, sans-serif; color: rgb(229, 194, 224);
    background:
      radial-gradient(ellipse at 20% 20%, #7a1747 0%, transparent 55%),
      radial-gradient(ellipse at 80% 70%, #4a1a78 0%, transparent 55%),
      #140b1c;
  }
  h1 { font-family: Archivo, "Arial Black", sans-serif; font-stretch: 125%; font-weight: 900; text-transform: uppercase; color: #fff; }
  a { color: #ff5fa8; }
  input, button, select { font: inherit; }
  input[type=text] {
    width: 100%; padding: 12px 14px; border-radius: 14px; border: 1px solid rgba(229, 194, 224, 0.35);
    background: rgba(255, 255, 255, 0.05); color: #fff;
  }
  input[type=text]:focus { outline: 2px solid #ff5fa8; outline-offset: 1px; }
  .btn {
    display: inline-block; padding: 12px 20px; border: 0; border-radius: 16px 24px 32px 4px; cursor: pointer;
    background: linear-gradient(120deg, #b01d68, #7a1f86); color: #fff; font-weight: 700;
    text-transform: uppercase; letter-spacing: 0.08em; font-size: 14px; text-decoration: none;
  }
  .btn:hover { filter: brightness(1.15); }
  .btn.ghost { background: transparent; border: 1px solid rgba(229, 194, 224, 0.4); color: rgb(229, 194, 224); }
  .btn:focus-visible { outline: 2px solid #ff5fa8; outline-offset: 3px; }
`;

function referralPage(id, email) {
  return `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>Were you referred? | Novacane</title>
<style>
${PAGE_STYLE}
  main {
    max-width: 460px; margin: 8vh auto; padding: 36px 28px; text-align: center;
    background: #150d1f; border-radius: 48px 48px 64px 48px;
    box-shadow: 0 20px 60px rgba(113, 4, 57, 0.6);
  }
  h1 { font-size: 26px; margin: 0 0 6px; }
  p { font-size: 18px; line-height: 1.5; }
  .choices { display: flex; gap: 10px; justify-content: center; flex-wrap: wrap; }
  form { display: grid; gap: 12px; text-align: left; margin-top: 8px; }
  label { font-size: 14px; letter-spacing: 0.06em; text-transform: uppercase; }
  #message { min-height: 1.5em; font-weight: 600; }
  #message.error { color: #ff8fbf; }
  [hidden] { display: none !important; }
  @media (max-width: 480px) { main { margin: 0; min-height: 100vh; border-radius: 0; } h1 { font-size: 21px; } }
</style>
</head>
<body>
<main>
  <h1>You're booked in 🎙️</h1>
  <div id="ask">
    <p>Did anyone refer you to Novacane?</p>
    <div class="choices">
      <button class="btn" type="button" id="yes">Yes</button>
      <button class="btn ghost" type="button" id="no">No, nobody</button>
    </div>
  </div>

  <form id="details" hidden>
    <label for="code">Referral code (optional)</label>
    <input type="text" id="code" maxlength="32" autocomplete="off" autocapitalize="characters" placeholder="e.g. JAMES10">
    <label for="name">Who referred you? (optional)</label>
    <input type="text" id="name" maxlength="100" autocomplete="off">
    <button class="btn" type="submit">Save</button>
  </form>

  <p id="message" role="status" aria-live="polite"></p>
  <p id="done" hidden><a href="https://novacane.co.uk">Back to Novacane</a></p>
</main>
<script>
  const booking = { id: ${JSON.stringify(id).replace(/</g, "\\u003c")}, email: ${JSON.stringify(email).replace(/</g, "\\u003c")} };
  const message = document.getElementById("message");

  async function save(answer) {
    message.className = "";
    message.textContent = "Saving…";
    try {
      const res = await fetch(location.pathname, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ ...booking, ...answer }),
      });
      const data = await res.json();
      if (data.ok) {
        message.textContent = data.message;
        document.getElementById("ask").hidden = true;
        document.getElementById("details").hidden = true;
        document.getElementById("done").hidden = false;
      } else {
        message.className = "error";
        message.textContent = data.error;
      }
    } catch (err) {
      message.className = "error";
      message.textContent = "Couldn't save that. Please try again.";
    }
  }

  document.getElementById("no").addEventListener("click", () => save({ referred: false }));
  document.getElementById("yes").addEventListener("click", () => {
    document.getElementById("ask").hidden = true;
    document.getElementById("details").hidden = false;
    document.getElementById("code").focus();
  });
  document.getElementById("details").addEventListener("submit", (e) => {
    e.preventDefault();
    save({
      referred: true,
      code: document.getElementById("code").value,
      name: document.getElementById("name").value,
    });
  });
</script>
</body>
</html>`;
}

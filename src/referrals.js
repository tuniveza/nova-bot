// Referral tracking: "Did anyone refer you?" after a booking, and the codes the studio hands out
//
//   GET  /referral        the "Did anyone refer you?" page (?id=<booking number>&email=…; see
//                         README-REFERRALS.md)
//   POST /referral        that page saves the answer against the booking
//
// Each booking is a row in the appointments table (Nova's own booking system saves it as the
// booking is made: src/nova/bookings.js), with its referral alongside. A code typed on the booking
// page is checked and saved there too. The codes themselves are kept in Portal's admin pages.

const MAX_WRONG_CODES = 5;
const CODE_PATTERN = /^[A-Z0-9-]{3,32}$/;

// "james 10" -> "JAMES10"
export function normaliseCode(code) {
  return String(code || "").toUpperCase().replace(/\s+/g, "");
}

export function isValidCodeFormat(code) {
  return CODE_PATTERN.test(code);
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

// ===== THE CUSTOMER'S REFERRAL PAGE =====

// The booking, if the number and email match
async function findBooking(env, id, email) {
  const row = await env.DB.prepare("SELECT * FROM appointments WHERE id = ?").bind(Number(id)).first();
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

  // One answer per booking. The only exception: a code typed when booking that
  // wasn't valid can be corrected here.
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
  // A "+" in the email arrives as a space when a link doesn't encode it
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

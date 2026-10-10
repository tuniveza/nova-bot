// The fan sign-up page (Quest 3): /join, for news about releases and studio offers
//
//   GET  /join                 the form: name, email, the consent tick box (and a hidden honeypot)
//   POST /join                 -> a 'pending' fan and a confirmation email (the link works for 7 days)
//   GET  /join/confirm?t=...   -> 'confirmed' (consent recorded now, "Fan sign-up form, confirmed by
//                              email") and a thank-you page. The link works once.
//
// Double opt-in (UK GDPR / PECR): nobody gets a campaign until they've clicked the link in the
// confirmation email (src/campaigns.js only sends to confirmed fans). The page always answers the
// same way, so it never shows whether an email address is already on the list. At most 5 sign-ups
// per visitor an hour, counted by a hash of their IP address with a secret salt (FAN_SIGNUP_SALT,
// else one made once and kept in settings); the address itself is never stored. A filled-in
// honeypot (a field people can't see) is a bot: it gets the same answer and nothing is saved.
//
// Logs say ids and counts only, never anyone's details.

import { sendEmail } from "./enquiries.js";
import { publicUrl } from "./nova/booking.js";
import { campaignFrom } from "./campaigns.js";

const MAX_PER_HOUR = 5;
const LINK_DAYS = 7;
const CONSENT_SOURCE = "Fan sign-up form, confirmed by email";
const CONSENT_TEXT = "Send me news about releases and studio offers from Novacane Studios. I can unsubscribe any time.";
const EMAIL_PATTERN = /^[^\s@<>"]+@[^\s@<>"]+\.[^\s@<>"]{2,}$/;
const TOKEN_PATTERN = /^[0-9a-z]{6,12}\.[0-9a-f]{32}$/;

const nowIso = () => new Date().toISOString();
const hex = (bytes) => [...bytes].map((b) => b.toString(16).padStart(2, "0")).join("");

// A confirmation link's secret: when it was made (base 36 ms), then 16 random bytes
function newToken() {
  return `${Date.now().toString(36)}.${hex(crypto.getRandomValues(new Uint8Array(16)))}`;
}
const tokenMadeAt = (token) => parseInt(token.split(".")[0], 36);

// The visitor's IP, hashed with the salt (for counting sign-ups only)
async function ipHash(env, ip) {
  let salt = env.FAN_SIGNUP_SALT || "";
  if (!salt) {
    await env.DB.prepare("INSERT OR IGNORE INTO settings (key, value) VALUES ('fan_signup_salt', ?)").bind(hex(crypto.getRandomValues(new Uint8Array(24)))).run();
    salt = await env.DB.prepare("SELECT value FROM settings WHERE key = 'fan_signup_salt'").first("value");
  }
  return hex(new Uint8Array(await crypto.subtle.digest("SHA-256", new TextEncoder().encode(`${salt}:${ip}`))));
}

// One more sign-up from this visitor this hour: false if they're over the limit
async function underLimit(env, hash) {
  const key = `fan_signup:${Math.floor(Date.now() / 3600000)}:${hash.slice(0, 32)}`;
  const count = await env.DB.prepare(
    "INSERT INTO settings (key, value) VALUES (?, '1') ON CONFLICT (key) DO UPDATE SET value = CAST(value AS INTEGER) + 1 RETURNING CAST(value AS INTEGER) AS n"
  )
    .bind(key)
    .first("n");
  return count <= MAX_PER_HOUR;
}

export async function handleJoin(request, env, ctx, pathname) {
  if (pathname === "/join/confirm" && (request.method === "GET" || request.method === "HEAD")) return confirm(request, env);
  if (pathname === "/join" && (request.method === "GET" || request.method === "HEAD")) return formPage();
  if (pathname === "/join" && request.method === "POST") return signUp(request, env, ctx);
  return new Response("Method not allowed", { status: 405, headers: { Allow: pathname === "/join" ? "GET, POST" : "GET" } });
}

async function signUp(request, env, ctx) {
  let form;
  try {
    form = await request.formData();
  } catch {
    return formPage({ error: "Something went wrong with the form. Try again." }, 400);
  }
  const value = (key, max) => String(form.get(key) || "").replace(/\s+/g, " ").trim().slice(0, max);
  const name = value("name", 100);
  const email = value("email", 200).toLowerCase();
  const ticked = form.get("consent") === "yes";
  // The honeypot: people never see it, so anything in it is a bot. Same answer, nothing saved.
  if (value("website", 200)) return checkInbox();
  if (!EMAIL_PATTERN.test(email)) return formPage({ error: "That email address doesn't look right.", name, email, ticked }, 400);
  if (!ticked) return formPage({ error: "Tick the box to say you'd like the news.", name, email }, 400);

  const hash = await ipHash(env, request.headers.get("CF-Connecting-IP") || "unknown");
  if (!(await underLimit(env, hash))) return formPage({ error: "Too many sign-ups from here just now. Try again in an hour." }, 429);

  const now = nowIso();
  const token = newToken();
  const fan = await env.DB.prepare("SELECT id, status FROM fans WHERE email = ?").bind(email).first();
  let send = true;
  if (!fan) {
    await env.DB.prepare("INSERT INTO fans (email, name, status, confirm_token, created_at, signup_ip_hash) VALUES (?, ?, 'pending', ?, ?, ?) ON CONFLICT (email) DO NOTHING")
      .bind(email, name, token, now, hash)
      .run();
  } else if (fan.status === "confirmed") {
    // Already on the list: nothing to do (and the page says the same as for anyone else)
    send = false;
  } else {
    // Pending (a new link; the old one stops working), or unsubscribed and signing up again
    await env.DB.prepare("UPDATE fans SET status = 'pending', confirm_token = ?, name = CASE WHEN ? != '' THEN ? ELSE name END, signup_ip_hash = ? WHERE id = ? AND status != 'confirmed'")
      .bind(token, name, name, hash, fan.id)
      .run();
  }
  if (send) {
    const link = `${publicUrl(env)}/join/confirm?t=${token}`;
    const work = sendEmail(env, {
      to: [email],
      from: campaignFrom(env) || undefined,
      subject: "Confirm your sign-up to Novacane Studios news",
      text: [
        `Hi${name ? ` ${name}` : ""},`,
        "",
        "Thanks for signing up for news about releases and studio offers from Novacane Studios.",
        "Please confirm it's you by opening this link:",
        link,
        "",
        `The link works for ${LINK_DAYS} days. If you didn't sign up, ignore this email: you won't hear from us.`,
        "",
        "Novacane Studios, London",
      ].join("\n"),
      idempotencyKey: `fan-confirm-${token}`,
    }).then(
      (result) => {
        if (!result.ok) console.log("Fan sign-up: the confirmation email didn't go");
      },
      () => console.log("Fan sign-up: the confirmation email didn't go")
    );
    // Sent in the background, so the page answers just as fast either way
    if (env.RESEND_API_KEY) ctx.waitUntil(work);
    else console.log("Fan sign-up: email isn't set up (RESEND_API_KEY), so no confirmation email");
  }
  return checkInbox();
}

async function confirm(request, env) {
  const token = new URL(request.url).searchParams.get("t") || "";
  const used = () =>
    page(
      "That link doesn't work",
      "It may have been used already (if you confirmed, you're on the list), or copied wrongly. You can always sign up again.",
      { link: true },
      404
    );
  if (!TOKEN_PATTERN.test(token)) return used();
  const fan = await env.DB.prepare("SELECT id FROM fans WHERE confirm_token = ? AND status = 'pending'").bind(token).first();
  if (!fan) return used();
  if (Date.now() - tokenMadeAt(token) > LINK_DAYS * 86400000) {
    return page("That link has expired", `Confirmation links work for ${LINK_DAYS} days. Sign up again and we'll send a new one.`, { link: true }, 410);
  }
  const now = nowIso();
  // pending -> confirmed, once: the token is cleared in the same step
  const { meta } = await env.DB.prepare(
    "UPDATE fans SET status = 'confirmed', confirm_token = NULL, consent_at = ?, consent_source = ?, confirmed_at = ? WHERE id = ? AND confirm_token = ? AND status = 'pending'"
  )
    .bind(now, CONSENT_SOURCE, now, fan.id, token)
    .run();
  if (!meta.changes) return used();
  console.log(`Fan ${fan.id} confirmed`);
  return page("You're on the list", "Thanks for confirming. You'll hear from Novacane Studios about new releases and studio offers. Every email has a link to unsubscribe.");
}

// ===== PAGES (calm, like the other customer pages) =====

const esc = (s) => String(s ?? "").replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c]);

function checkInbox() {
  return page("Check your inbox", "If that address can get our emails, a message is on its way. Open the link in it to confirm, and you're on the list. (If it isn't there in a few minutes, look in spam.)");
}

function formPage({ error = "", name = "", email = "", ticked = false } = {}, status = 200) {
  const form = `<form method="post" action="/join" novalidate>
<label for="name">Name <span class="opt">(optional)</span></label>
<input id="name" name="name" autocomplete="name" maxlength="100" value="${esc(name)}">
<label for="email">Email</label>
<input id="email" name="email" type="email" autocomplete="email" maxlength="200" required value="${esc(email)}">
<div class="trap" aria-hidden="true"><label for="website">Leave this empty</label><input id="website" name="website" tabindex="-1" autocomplete="off"></div>
<label class="tick"><input type="checkbox" name="consent" value="yes" required${ticked ? " checked" : ""}> <span>${esc(CONSENT_TEXT)}</span></label>
<button type="submit">Sign up</button>
</form>`;
  return page("News from Novacane Studios", "New releases from the studio and the occasional studio offer, now and then. No spam, and you can unsubscribe from any email.", { form, error }, status);
}

function page(title, text, { form = "", error = "", link = false } = {}, status = 200) {
  const html = `<!doctype html><html lang="en-GB"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1"><meta name="robots" content="noindex">
<title>${esc(title)} · Novacane Studios</title>
<style>
:root { color-scheme: light dark; --bg: #f7f5f8; --card: #fff; --ink: #1d1820; --muted: #6b6270; --accent: #c2337a; --line: #e4dfe7; --warn: #a3313a; }
@media (prefers-color-scheme: dark) { :root { --bg: #141016; --card: #1f1922; --ink: #f2edf4; --muted: #a79dac; --accent: #ff7ab8; --line: #3a313e; --warn: #ff8f97; } }
* { box-sizing: border-box; }
body { margin: 0; background: var(--bg); color: var(--ink); font: 16px/1.5 system-ui, -apple-system, "Segoe UI", sans-serif; }
main { max-width: 460px; margin: 10vh auto; padding: 28px 24px; background: var(--card); border-radius: 18px; }
@media (max-width: 500px) { main { margin: 16px; } }
.brand { font-size: 0.8rem; letter-spacing: 0.14em; text-transform: uppercase; color: var(--accent); font-weight: 600; margin: 0 0 12px; }
h1 { font-size: 1.35rem; margin: 0 0 10px; } p { color: var(--muted); margin: 0 0 18px; }
label { display: block; font-weight: 600; margin: 14px 0 6px; } .opt { font-weight: 400; color: var(--muted); }
input[type=email], input:not([type]) { width: 100%; font: inherit; padding: 10px 12px; border: 1px solid var(--line); border-radius: 10px; background: transparent; color: inherit; }
.tick { display: flex; gap: 10px; align-items: flex-start; font-weight: 400; margin: 18px 0; } .tick input { margin-top: 4px; width: 18px; height: 18px; flex: none; accent-color: var(--accent); }
.trap { position: absolute; left: -10000px; width: 1px; height: 1px; overflow: hidden; }
button, .button { display: inline-block; font: inherit; padding: 11px 22px; border: 0; border-radius: 999px; background: var(--accent); color: #fff; cursor: pointer; text-decoration: none; }
.error { color: var(--warn); margin: 0 0 8px; }
small { display: block; margin-top: 18px; color: var(--muted); } small a { color: inherit; }
</style></head><body><main>
<div class="brand">Novacane Studios</div>
<h1>${esc(title)}</h1><p>${esc(text)}</p>
${error ? `<p class="error" role="alert">${esc(error)}</p>` : ""}${form}${link ? `<a class="button" href="/join">Sign up</a>` : ""}
<small>Novacane Studios, Forest Hill, London · <a href="/privacy">Privacy</a></small>
</main></body></html>`;
  return new Response(html, { status, headers: { "Content-Type": "text/html; charset=utf-8", "Cache-Control": "no-store", "Referrer-Policy": "no-referrer" } });
}

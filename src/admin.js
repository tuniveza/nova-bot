// Private admin pages: referrals, enquiries and NovaBot conversations
//
//   GET  /admin                    referral codes + appointments with their referrals
//   POST /admin/codes              add a code
//   POST /admin/codes/toggle       retire / reactivate a code
//   GET  /admin/report.csv         every appointment with its referral, for spreadsheets
//   GET  /admin/enquiries          enquiries NovaBot sent for visitors
//   POST /admin/enquiries/status   mark an enquiry done / not done
//   POST /admin/enquiries/test-email   send a test enquiry email
//   GET  /admin/conversations      recent chats (?chat=ID shows one in full)
//   GET  /admin/feedback           what visitors said about NovaBot (?show=good / bad)
//   GET  /admin/acuity             checks which Acuity account the secrets belong to
//   GET  /admin/connections        the booking system switch (Acuity / Nova), plus Google and Stripe for Nova
//   POST /admin/booking-system     flip the switch { system: "acuity" | "nova" }
//   GET  /admin/google             "Connect Google": off to Google's consent page
//   GET  /admin/google/callback    Google sends the browser back here with access
//   POST /admin/google/disconnect  forget the Google connection
//   POST /admin/connections/test-email  send a test email from the connected Gmail
//
// Protected by the ADMIN_PASSWORD secret (any username).

import { checkAcuity, escapeHtml, isValidCodeFormat, normaliseCode, PAGE_STYLE } from "./referrals.js";
import { emailIsSetUp, emailRecipients, sendTestEmail } from "./enquiries.js";
import { ACUITY_OWNER, bookingLink, getSessionTypes } from "./booking.js";
import { feedbackCounts, recentFeedback } from "./feedback.js";
// Nova Bot's own booking system, behind the switch (mode.js, src/nova/)
import { bookingSystem, setBookingSystem } from "./mode.js";
import { bookingLink as novaBookingLink, getSessionTypes as novaSessionTypes, publicUrl } from "./nova/booking.js";
import { calendarId, connectedAccount, consentUrl, disconnect, finishConnecting, googleProblem, googleReady, offline, redirectUri, sendEmail } from "./nova/google.js";
import { stripeOffline, stripeProblem, stripeReady } from "./nova/stripe.js";

export async function handleAdmin(request, env) {
  if (!env.ADMIN_PASSWORD) {
    return text("The admin page isn't set up yet. Run: npx wrangler secret put ADMIN_PASSWORD", 503);
  }
  if (!(await passwordMatches(request, env.ADMIN_PASSWORD))) {
    return new Response("Password required", {
      status: 401,
      headers: { "WWW-Authenticate": 'Basic realm="Novacane admin", charset="UTF-8"' },
    });
  }

  const url = new URL(request.url);

  if (request.method === "POST") {
    // Only accept forms sent from this admin page (stops other sites
    // submitting forms using the browser's saved password)
    if (request.headers.get("Origin") !== url.origin) return text("Forbidden", 403);
    const form = await request.formData();
    if (url.pathname === "/admin/codes") return addCode(env, form);
    if (url.pathname === "/admin/codes/toggle") return toggleCode(env, form);
    if (url.pathname === "/admin/enquiries/status") return toggleEnquiry(env, form);
    if (url.pathname === "/admin/enquiries/test-email") {
      return back((await sendTestEmail(env)).message, "/admin/enquiries");
    }
    if (url.pathname === "/admin/booking-system") return switchBookingSystem(env, form);
    if (url.pathname === "/admin/google/disconnect") {
      await disconnect(env);
      return back("Google disconnected.", "/admin/connections");
    }
    if (url.pathname === "/admin/connections/test-email") return testBookingEmail(env);
    return text("Not found", 404);
  }

  if (url.pathname === "/admin/report.csv") return report(env);
  if (url.pathname === "/admin/enquiries") return enquiriesPage(env, url);
  if (url.pathname === "/admin/conversations") return conversationsPage(env, url);
  if (url.pathname === "/admin/feedback") return feedbackPage(env, url);
  if (url.pathname === "/admin/acuity") return acuityPage(env, url);
  if (url.pathname === "/admin/connections") return connectionsPage(env, url);
  if (url.pathname === "/admin/google") return connectGoogle(env, url);
  if (url.pathname === "/admin/google/callback") return googleCallback(request, env, url);
  if (url.pathname === "/admin" || url.pathname === "/admin/") return adminPage(env, url);
  return text("Not found", 404);
}

// ===== ACCESS =====

async function passwordMatches(request, password) {
  const header = request.headers.get("Authorization") || "";
  if (!header.startsWith("Basic ")) return false;
  let given = "";
  try {
    const decoded = atob(header.slice(6));
    given = decoded.slice(decoded.indexOf(":") + 1);
  } catch {
    return false;
  }
  // Compare hashes so the check takes the same time whatever was typed
  const hash = async (s) => new Uint8Array(await crypto.subtle.digest("SHA-256", new TextEncoder().encode(s)));
  return crypto.subtle.timingSafeEqual(await hash(given), await hash(password));
}

// ===== CODES =====

async function addCode(env, form) {
  const code = normaliseCode(form.get("code"));
  const referrer = String(form.get("referrer") || "").trim().slice(0, 100);
  const note = String(form.get("note") || "").trim().slice(0, 200) || null;

  if (!isValidCodeFormat(code)) {
    return back("Codes need 3 to 32 letters, numbers or dashes.");
  }
  if (!referrer) return back("Add who the code belongs to.");

  const result = await env.DB.prepare(
    "INSERT INTO referral_codes (code, referrer, note, active, created_at) VALUES (?, ?, ?, 1, ?) ON CONFLICT (code) DO NOTHING"
  )
    .bind(code, referrer, note, new Date().toISOString())
    .run();
  return back(result.meta.changes ? `Added ${code}.` : `${code} already exists.`);
}

async function toggleCode(env, form) {
  const code = normaliseCode(form.get("code"));
  const row = await env.DB.prepare("SELECT active FROM referral_codes WHERE code = ?").bind(code).first();
  if (!row) return back("That code doesn't exist.");
  await env.DB.prepare("UPDATE referral_codes SET active = ? WHERE code = ?").bind(row.active ? 0 : 1, code).run();
  return back(row.active ? `${code} retired. It won't be accepted any more.` : `${code} is active again.`);
}

// ===== REPORT =====

const REPORT_COLUMNS = [
  ["Appointment ID", "id"],
  ["Appointment date", "starts_at"],
  ["First name", "first_name"],
  ["Last name", "last_name"],
  ["Email", "email"],
  ["Phone", "phone"],
  ["Session", "appointment_type"],
  ["Status", "status"],
  ["Booked at", "booked_at"],
  ["Referred?", "referral_answer"],
  ["Referral code", "referral_code"],
  ["Code belongs to", "referrer_name"],
  ["Referred by (typed)", "referred_by"],
  ["Invalid code typed", "invalid_code"],
  ["Referral source", "referral_source"],
  ["Referral recorded at", "referral_at"],
];

async function report(env) {
  const { results } = await env.DB.prepare("SELECT * FROM appointments ORDER BY starts_at DESC").all();
  const cell = (value) => {
    let s = String(value ?? "");
    // Stop spreadsheet apps treating a value as a formula
    if (/^[=+\-@\t\r]/.test(s)) s = "'" + s;
    return /[",\n\r]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
  };
  const lines = [REPORT_COLUMNS.map(([title]) => cell(title)).join(",")];
  for (const row of results) lines.push(REPORT_COLUMNS.map(([, key]) => cell(row[key])).join(","));
  const date = new Date().toISOString().slice(0, 10);
  return new Response(lines.join("\r\n") + "\r\n", {
    headers: {
      "Content-Type": "text/csv; charset=utf-8",
      "Content-Disposition": `attachment; filename="novacane-referrals-${date}.csv"`,
      "Cache-Control": "no-store",
    },
  });
}

// ===== THE PAGE =====

async function adminPage(env, url) {
  const referredOnly = url.searchParams.get("show") === "referred";

  const codes = (
    await env.DB.prepare(
      `SELECT c.*,
         (SELECT COUNT(*) FROM appointments a WHERE a.referral_code = c.code AND a.status != 'canceled') AS bookings
       FROM referral_codes c ORDER BY c.active DESC, c.code`
    ).all()
  ).results;

  const totals = await env.DB.prepare(
    `SELECT COUNT(*) AS appointments,
       SUM(referral_answer = 'yes') AS referred,
       SUM(referral_code IS NOT NULL) AS with_code,
       SUM(invalid_code IS NOT NULL AND referral_code IS NULL) AS invalid
     FROM appointments WHERE status != 'canceled'`
  ).first();

  const appointments = (
    await env.DB.prepare(
      `SELECT * FROM appointments ${referredOnly ? "WHERE referral_answer = 'yes'" : ""}
       ORDER BY starts_at DESC LIMIT 500`
    ).all()
  ).results;

  const e = escapeHtml;

  const codeRows = codes
    .map(
      (c) => `<tr>
        <td><strong>${e(c.code)}</strong></td>
        <td>${e(c.referrer)}</td>
        <td>${e(c.note)}</td>
        <td>${c.active ? "Active" : '<span class="dim">Retired</span>'}</td>
        <td class="num">${c.bookings}</td>
        <td><form method="post" action="/admin/codes/toggle">
          <input type="hidden" name="code" value="${e(c.code)}">
          <button class="btn ghost small">${c.active ? "Retire" : "Reactivate"}</button>
        </form></td>
      </tr>`
    )
    .join("");

  const referral = (a) => {
    if (a.referral_code) return `<strong>${e(a.referral_code)}</strong> <span class="dim">(${e(a.referrer_name)})</span>`;
    if (a.invalid_code) return `<span class="warn">Invalid code: ${e(a.invalid_code)}</span>`;
    return "";
  };
  const answer = (a) => (a.referral_answer === "yes" ? "Yes" : a.referral_answer === "no" ? "No" : '<span class="dim">Not answered</span>');

  const appointmentRows = appointments
    .map(
      (a) => `<tr class="${a.status === "canceled" ? "canceled" : ""}">
        <td>${when(a.starts_at)}</td>
        <td>${e([a.first_name, a.last_name].filter(Boolean).join(" "))}<br><span class="dim">${e(a.email)}</span></td>
        <td>${e(a.appointment_type)}</td>
        <td>${a.status === "canceled" ? "Cancelled" : "Booked"}</td>
        <td>${answer(a)}</td>
        <td>${referral(a)}</td>
        <td>${e(a.referred_by)}</td>
        <td class="dim">${e(a.referral_source)}</td>
      </tr>`
    )
    .join("");

  return page(env, "Referrals", url, `
  <div class="stats">
    <div class="stat"><b>${totals.appointments || 0}</b>Appointments</div>
    <div class="stat"><b>${totals.referred || 0}</b>Say they were referred</div>
    <div class="stat"><b>${totals.with_code || 0}</b>With a valid code</div>
    <div class="stat"><b>${totals.invalid || 0}</b>Invalid code typed</div>
  </div>
  <p class="dim">Counts leave out cancelled appointments.</p>

  <h2>Referral codes</h2>
  <div class="card">
    <table>
      <thead><tr><th>Code</th><th>Belongs to</th><th>Note</th><th>Status</th><th>Bookings</th><th></th></tr></thead>
      <tbody>${codeRows || '<tr><td colspan="6" class="dim">No codes yet. Add one below.</td></tr>'}</tbody>
    </table>
    <form class="add" method="post" action="/admin/codes">
      <input type="text" name="code" placeholder="Code, e.g. JAMES10" maxlength="32" required aria-label="Code">
      <input type="text" name="referrer" placeholder="Belongs to, e.g. James Smith" maxlength="100" required aria-label="Belongs to">
      <input type="text" name="note" placeholder="Note (optional)" maxlength="200" aria-label="Note">
      <button class="btn">Add code</button>
    </form>
  </div>

  <h2>Appointments</h2>
  <p class="filters">
    <a href="/admin" class="${referredOnly ? "" : "current"}">All</a>
    <a href="/admin?show=referred" class="${referredOnly ? "current" : ""}">Referred only</a>
    <a href="/admin/report.csv">Download CSV</a>
    <a href="/admin/acuity">Check Acuity connection</a>
    <a href="/admin/connections">Booking system</a>
  </p>
  <div class="card">
    <table>
      <thead><tr><th>Date</th><th>Client</th><th>Session</th><th>Status</th><th>Referred?</th><th>Code</th><th>Referred by</th><th>Source</th></tr></thead>
      <tbody>${appointmentRows || '<tr><td colspan="8" class="dim">No appointments yet. They appear here as Acuity bookings come in.</td></tr>'}</tbody>
    </table>
    ${appointments.length === 500 ? '<p class="dim">Showing the latest 500. Download the CSV for everything.</p>' : ""}
  </div>
`);
}

// ===== ENQUIRIES =====

async function toggleEnquiry(env, form) {
  const id = Number(form.get("id"));
  const row = await env.DB.prepare("SELECT status FROM enquiries WHERE id = ?").bind(id).first();
  if (!row) return back("That enquiry doesn't exist.", "/admin/enquiries");
  const status = row.status === "done" ? "new" : "done";
  await env.DB.prepare("UPDATE enquiries SET status = ? WHERE id = ?").bind(status, id).run();
  return back(status === "done" ? `Enquiry #${id} marked done.` : `Enquiry #${id} moved back to new.`, "/admin/enquiries");
}

async function enquiriesPage(env, url) {
  const showDone = url.searchParams.get("show") === "all";
  const { results } = await env.DB.prepare(
    `SELECT * FROM enquiries ${showDone ? "" : "WHERE status = 'new'"} ORDER BY created_at DESC LIMIT 500`
  ).all();
  const e = escapeHtml;

  // For the "Booking link" on each enquiry (from the booking system the switch picks)
  const nova = (await bookingSystem(env)) === "nova";
  let types = [];
  try {
    types = nova ? novaSessionTypes() : await getSessionTypes(ACUITY_OWNER);
  } catch (err) {
    console.log("Couldn't read the session types:", err);
  }
  const linkFor = Number(url.searchParams.get("link"));
  const chosenType = types.find((t) => t.id === Number(url.searchParams.get("type")));

  const bookingSection = (q) => {
    if (types.length === 0) return `<p class="dim small">Booking links aren't available right now (couldn't read the Acuity booking page).</p>`;
    const chosen = linkFor === q.id ? chosenType : null;
    const options = types
      .map((t) => `<option value="${t.id}" ${chosen && chosen.id === t.id ? "selected" : ""}>${e(t.name)}${t.price ? ` (${e(t.price)})` : ""}</option>`)
      .join("");
    let made = "";
    if (chosen) {
      const link = nova ? novaBookingLink(env, chosen.id, q) : bookingLink(ACUITY_OWNER, chosen.id, q);
      const first = q.name.split(/\s+/)[0];
      const body = `Hi ${first},\n\nThanks for your enquiry. You can book your session here: pick a time on the calendar and pay the deposit to confirm.\n\n${chosen.name}\n${link}\n\nNovacane Studios`;
      const mailto = `mailto:${encodeURIComponent(q.email)}?subject=${encodeURIComponent("Booking your session at Novacane")}&body=${encodeURIComponent(body)}`;
      made = `<div class="link-made">
          <input type="text" readonly value="${e(link)}" aria-label="Booking link" onfocus="this.select()">
          <button type="button" class="btn ghost small" onclick="navigator.clipboard.writeText(this.previousElementSibling.value).then(() => (this.textContent = 'Copied'))">Copy</button>
          <a class="btn small" href="${e(mailto)}">Email it to them</a>
        </div>
        <p class="dim small">The link opens the booking calendar on ${e(chosen.name)} with their details filled in. They pick a time and pay, and it goes into Acuity.</p>`;
    }
    return `<details class="booklink" ${chosen ? "open" : ""}>
        <summary>Booking link</summary>
        <form method="get" action="/admin/enquiries#enquiry-${q.id}">
          ${showDone ? '<input type="hidden" name="show" value="all">' : ""}
          <input type="hidden" name="link" value="${q.id}">
          <select name="type" aria-label="Session type">${options}</select>
          <button class="btn ghost small">Make link</button>
        </form>
        ${made}
      </details>`;
  };

  const cards = results
    .map(
      (q) => `<article class="card enquiry ${q.status === "done" ? "done" : ""}" id="enquiry-${q.id}">
        <header>
          <div>
            <strong>${e(q.subject || "Enquiry")}</strong> <span class="dim">#${q.id} · ${when(q.created_at)}</span><br>
            ${e(q.name)} · <a href="mailto:${e(q.email)}?subject=${e(encodeURIComponent("Re: " + (q.subject || "Your Novacane enquiry")))}">${e(q.email)}</a>
            ${q.phone ? ` · <a href="tel:${e(q.phone.replace(/[^0-9+]/g, ""))}">${e(q.phone)}</a>` : ""}
          </div>
          <form method="post" action="/admin/enquiries/status">
            <input type="hidden" name="id" value="${q.id}">
            <button class="btn ${q.status === "done" ? "ghost " : ""}small">${q.status === "done" ? "Move back to new" : "Mark done"}</button>
          </form>
        </header>
        <p class="details">${e(q.details)}</p>
        <p class="dim small">
          ${q.page ? `Sent from ${e(q.page)} · ` : ""}${q.emailed ? "Email copy sent" : "No email copy"}
          ${q.chat_id ? ` · <a href="/admin/conversations?chat=${e(encodeURIComponent(q.chat_id))}">Read the chat</a>` : ""}
        </p>
        ${bookingSection(q)}
      </article>`
    )
    .join("");

  const emailStatus = emailIsSetUp(env)
    ? `Email copies: <strong>on</strong>, sent to ${e(emailRecipients(env).join(", "))}.`
    : `Email copies: <strong>off</strong>. Enquiries only show here until the Resend secrets are set (see README-ENQUIRIES.md).`;

  return page(env, "Enquiries", url, `
  <div class="card email-status">
    <span>${emailStatus}</span>
    <form method="post" action="/admin/enquiries/test-email"><button class="btn ghost small">Send a test email</button></form>
  </div>
  <p class="filters">
    <a href="/admin/enquiries" class="${showDone ? "" : "current"}">New</a>
    <a href="/admin/enquiries?show=all" class="${showDone ? "current" : ""}">All</a>
  </p>
  ${cards || `<div class="card dim">${showDone ? "No enquiries yet." : "No new enquiries."} They appear here when a visitor asks NovaBot to send one.</div>`}
`);
}

// ===== CONVERSATIONS =====

async function conversationsPage(env, url) {
  const e = escapeHtml;
  const chatId = url.searchParams.get("chat");

  if (chatId) {
    const { results } = await env.DB.prepare("SELECT * FROM chat_messages WHERE chat_id = ? ORDER BY id").bind(chatId).all();
    const lines = results
      .map(
        (m) => `<div class="line ${m.role === "user" ? "visitor" : "bot"}">
          <span class="dim small">${m.role === "user" ? "Visitor" : "NovaBot"} · ${when(m.created_at)}${m.page ? ` · ${e(m.page)}` : ""}</span>
          <p>${e(m.content)}</p>
        </div>`
      )
      .join("");
    return page(env, "Conversations", url, `
  <p><a href="/admin/conversations">&larr; All conversations</a></p>
  <div class="card transcript">${lines || '<p class="dim">This conversation has been deleted (they\'re kept for 90 days).</p>'}</div>
`);
  }

  const { results } = await env.DB.prepare(
    `SELECT chat_id, MIN(created_at) AS started, MAX(created_at) AS last, COUNT(*) / 2 AS messages,
       (SELECT content FROM chat_messages f WHERE f.chat_id = m.chat_id AND f.role = 'user' ORDER BY f.id LIMIT 1) AS first_question,
       (SELECT COUNT(*) FROM enquiries q WHERE q.chat_id = m.chat_id) AS enquiries
     FROM chat_messages m GROUP BY chat_id ORDER BY last DESC LIMIT 200`
  ).all();
  const rows = results
    .map(
      (c) => `<tr>
        <td>${when(c.started)}</td>
        <td><a href="/admin/conversations?chat=${e(encodeURIComponent(c.chat_id))}">${e(String(c.first_question || "").slice(0, 140))}</a></td>
        <td class="num">${c.messages}</td>
        <td>${c.enquiries ? "Sent enquiry" : ""}</td>
      </tr>`
    )
    .join("");

  return page(env, "Conversations", url, `
  <p class="dim">What visitors asked NovaBot. Conversations are deleted after 90 days.</p>
  <div class="card">
    <table>
      <thead><tr><th>Started</th><th>First question</th><th>Messages</th><th></th></tr></thead>
      <tbody>${rows || '<tr><td colspan="4" class="dim">No conversations yet.</td></tr>'}</tbody>
    </table>
  </div>
`);
}

// ===== ACUITY CONNECTION =====

// ===== FEEDBACK =====

async function feedbackPage(env, url) {
  const e = escapeHtml;
  const show = ["good", "bad"].includes(url.searchParams.get("show")) ? url.searchParams.get("show") : "";
  const [items, counts] = await Promise.all([recentFeedback(env, { rating: show }), feedbackCounts(env)]);
  const face = { good: "👍", bad: "👎", "": "" };
  const when = (iso) => new Date(iso).toLocaleString("en-GB", { timeZone: "Europe/London", dateStyle: "medium", timeStyle: "short" });
  const list = items.length
    ? items
        .map(
          (f) => `<article class="card enquiry">
        <header>
          <div><b>${face[f.rating || ""]} ${f.message ? "" : "<span class='dim'>(no comment)</span>"}</b>${f.spoken ? ` <span class="dim small">🎙️ spoken</span>` : ""}</div>
          <div class="dim small">${e(when(f.created_at))}${f.page ? ` · ${e(f.page)}` : ""}${
            f.chat_id ? ` · <a href="/admin/conversations?chat=${e(encodeURIComponent(f.chat_id))}">Read the chat</a>` : ""
          }</div>
        </header>
        ${f.message ? `<p class="details">${e(f.message)}</p>` : ""}
        ${
          f.recent.length
            ? `<details class="small"><summary class="dim">The last ${f.recent.length} messages before it</summary><div class="transcript">${f.recent
                .map((m) => `<div class="line ${m.role === "user" ? "visitor" : ""}"><b>${m.role === "user" ? "Visitor" : "NovaBot"}</b><p>${e(m.content)}</p></div>`)
                .join("")}</div></details>`
            : ""
        }
      </article>`
        )
        .join("\n")
    : `<p class="dim">No feedback yet.</p>`;
  return page(
    env,
    "Feedback",
    url,
    `<p class="filters">
    <a href="/admin/feedback" class="${show ? "" : "current"}">All (${counts.all})</a>
    <a href="/admin/feedback?show=good" class="${show === "good" ? "current" : ""}">👍 ${counts.good}</a>
    <a href="/admin/feedback?show=bad" class="${show === "bad" ? "current" : ""}">👎 ${counts.bad}</a>
  </p>
  ${list}`
  );
}

async function acuityPage(env, url) {
  const e = escapeHtml;
  const result = await checkAcuity(env);
  const body = result.ok
    ? `<div class="card">
        <p class="notice">Connected. The Worker's secrets belong to this Acuity account:</p>
        <table>
          <tr><th>User ID</th><td>${e(result.account.id)}</td></tr>
          <tr><th>Name</th><td>${e(result.account.name)}</td></tr>
          <tr><th>Email</th><td>${e(result.account.email)}</td></tr>
          <tr><th>Plan</th><td>${e(result.account.plan)}</td></tr>
        </table>
        <p>Bookings only come through if this is the same account as the booking calendar on novacane.co.uk, and its webhooks point at this Worker.</p>
      </div>`
    : `<div class="card"><p class="warn">${e(result.message)}</p>
        ${
          result.needsPlan
            ? "<p>Referral tracking needs the Acuity API, which is only on the Powerhouse plan.</p>"
            : `<p>Set the secrets again from the Acuity account that has your bookings (Integrations &rarr; API &rarr; View credentials):<br>
        <code>npx wrangler secret put ACUITY_USER_ID</code><br><code>npx wrangler secret put ACUITY_API_KEY</code></p>`
        }</div>`;
  return page(env, "Referrals", url, `
  <p><a href="/admin">&larr; Referrals</a></p>
  <h2>Acuity connection</h2>
  ${body}
`);
}

// ===== CONNECTIONS (Google and Stripe) =====

// "Connect Google": a one-off random value, kept in a short-lived cookie, must come back
// from Google unchanged (so nobody can trick the admin into connecting their account)
async function connectGoogle(env, url) {
  if (!env.GOOGLE_CLIENT_ID || !env.GOOGLE_CLIENT_SECRET) {
    return back("Set the GOOGLE_CLIENT_ID and GOOGLE_CLIENT_SECRET secrets first (see README.md).", "/admin/connections");
  }
  const state = crypto.randomUUID();
  return new Response(null, {
    status: 302,
    headers: {
      Location: consentUrl(env, url.origin, state),
      "Set-Cookie": `nv_gstate=${state}; Path=/admin/google; Max-Age=600; HttpOnly; Secure; SameSite=Lax`,
    },
  });
}

async function googleCallback(request, env, url) {
  const cookie = (request.headers.get("Cookie") || "").match(/(?:^|;\s*)nv_gstate=([0-9a-f-]{36})/);
  const clear = { "Set-Cookie": "nv_gstate=; Path=/admin/google; Max-Age=0; HttpOnly; Secure; SameSite=Lax" };
  const fail = (message) => new Response(null, { status: 303, headers: { ...clear, Location: "/admin/connections?msg=" + encodeURIComponent(message) } });
  if (url.searchParams.get("error")) return fail("Google said: " + url.searchParams.get("error") + ". Nothing was connected.");
  if (!cookie || cookie[1] !== url.searchParams.get("state")) return fail("That sign-in didn't start here (or took over 10 minutes). Press Connect Google again.");
  try {
    const email = await finishConnecting(env, url.origin, url.searchParams.get("code") || "");
    return new Response(null, { status: 303, headers: { ...clear, Location: "/admin/connections?msg=" + encodeURIComponent(`Connected as ${email || "your Google account"}.`) } });
  } catch (err) {
    console.log("Google connection failed:", err);
    return fail("Couldn't connect Google: " + err.message);
  }
}

// A test email from the connected Gmail to itself
async function testBookingEmail(env) {
  const to = await connectedAccount(env);
  if (!to) return back("Connect Google first.", "/admin/connections");
  try {
    await sendEmail(env, {
      to,
      subject: "Nova Bot test email ✓",
      text: "This came from Nova Bot through the studio's Gmail. Booking emails will look like they come from this address.",
      html: "<p>This came from <b>Nova Bot</b> through the studio's Gmail. Booking emails will look like they come from this address.</p>",
    });
    return back(`Sent a test email to ${to}.`, "/admin/connections");
  } catch (err) {
    return back("Couldn't send it: " + err.message, "/admin/connections");
  }
}

async function connectionsPage(env, url) {
  const e = escapeHtml;
  const system = await bookingSystem(env);
  const novaReady = (await googleReady(env)) && stripeReady(env);
  const switchSection = `
  <h2>Booking system</h2>
  <div class="card">
    <p>NovaBot is using <b>${system === "nova" ? "Nova Bot's own booking system (Google Calendar, Gmail, Stripe)" : "Acuity"}</b>${system === "acuity" ? " (the default)" : ""}.</p>
    <p class="dim small">Acuity: Acuity's booking page, Nova Agent, Acuity's webhook and emails, as always.
      Nova: Nova Bot's own booking page (/book), the studio's Google Calendar, booking emails from Gmail and deposits with Stripe.
      The switch takes effect straight away, no redeploy. Bookings made with either keep working after switching back.</p>
    ${
      system === "nova"
        ? `<form method="post" action="/admin/booking-system"><input type="hidden" name="system" value="acuity"><button class="btn">Switch back to Acuity</button></form>`
        : novaReady
          ? `<form method="post" action="/admin/booking-system" onsubmit="return confirm('Switch NovaBot to its own booking system? Customers will book on Nova Bot\\'s booking page and pay deposits with Stripe.')"><input type="hidden" name="system" value="nova"><button class="btn ghost">Switch to Nova Bot's booking system</button></form>`
          : `<p class="warn">Nova Bot's booking system can be switched on once Google and Stripe below are both working.</p>`
    }
  </div>`;
  const [account, gProblem, sProblem] = await Promise.all([connectedAccount(env), googleProblem(env), stripeProblem(env)]);
  const connectedAt = await env.DB.prepare("SELECT value FROM settings WHERE key = 'google_connected_at'").first("value");
  const { results: emails } = await env.DB.prepare("SELECT * FROM outbox ORDER BY id DESC LIMIT 25").all();
  const mode = stripeOffline(env) ? "sandbox stand-in" : String(env.STRIPE_SECRET_KEY || "").startsWith("sk_live_") ? "live" : env.STRIPE_SECRET_KEY ? "test mode" : "not set";
  const ok = (problem) => (problem ? `<span class="warn">✗ ${e(problem)}</span>` : `<span>✓ Working</span>`);
  const base = publicUrl(env);
  const body = `
  <h2>Google (calendar and email)</h2>
  <div class="card">
    <table>
      <tr><th>Status</th><td>${offline(env) ? "Sandbox: working offline (no Google keys), emails only go to the list below" : ok(gProblem)}</td></tr>
      <tr><th>Account</th><td>${e(account || "not connected")}${connectedAt ? ` <span class="dim small">since ${when(connectedAt)}</span>` : ""}</td></tr>
      <tr><th>Calendar</th><td>${e(calendarId(env))} <span class="dim small">(GOOGLE_CALENDAR_ID; "primary" is the account's own calendar)</span></td></tr>
      <tr><th>Redirect URI</th><td><code>${e(redirectUri(url.origin))}</code><br><span class="dim small">Add this to the OAuth client in Google Cloud Console.</span></td></tr>
    </table>
    <p>
      <a class="btn" href="/admin/google">${account ? "Reconnect Google" : "Connect Google"}</a>
      ${account ? `<form method="post" action="/admin/connections/test-email" style="display:inline"><button class="btn ghost">Send a test email</button></form>
      <form method="post" action="/admin/google/disconnect" style="display:inline" onsubmit="return confirm('Disconnect Google? Online booking stops until it is connected again.')"><button class="btn ghost">Disconnect</button></form>` : ""}
    </p>
    <p class="dim small">Sign in as the studio's Google account and tick every box on Google's page. Bookings go in its calendar and every booking email is sent from its Gmail.</p>
  </div>

  <h2>Stripe (payments)</h2>
  <div class="card">
    <table>
      <tr><th>Status</th><td>${ok(sProblem)}</td></tr>
      <tr><th>Mode</th><td>${e(mode)}</td></tr>
      <tr><th>Webhook</th><td><code>${e(url.origin)}/stripe/webhook</code><br><span class="dim small">In Stripe: Developers → Webhooks → Add endpoint, with the events checkout.session.completed, checkout.session.async_payment_succeeded and checkout.session.expired. Its signing secret is the STRIPE_WEBHOOK_SECRET secret.</span></td></tr>
    </table>
  </div>

  <h2>Booking page</h2>
  <div class="card">
    <p><a href="${e(base)}/book" target="_blank" rel="noopener">${e(base)}/book</a></p>
    <p class="dim small">${system === "nova" ? "Point the website's \"Book a session\" button here." : "Only after switching to Nova: until then this address sends people to the usual Acuity booking page."} Customers pick a time, pay the deposit with Stripe, and it goes straight into Google Calendar.</p>
  </div>

  <h2>Recent booking emails</h2>
  <div class="card">
    <table>
      <thead><tr><th>When</th><th>To</th><th>Email</th><th>Booking</th><th>Sent?</th></tr></thead>
      <tbody>${
        emails.length
          ? emails
              .map((m) => `<tr><td>${when(m.created_at)}</td><td>${e(m.to_email)}</td><td>${e(m.subject)}</td><td>${m.booking_id ? "#" + m.booking_id : ""}</td><td>${m.sent ? "✓" : `<span class="warn">✗ ${e(m.error || "")}</span>`}</td></tr>`)
              .join("")
          : '<tr><td colspan="5" class="dim">None yet.</td></tr>'
      }</tbody>
    </table>
  </div>`;
  return page(env, "Booking system", url, switchSection + body);
}

// Flip the booking system switch. Nova only once Google and Stripe both work.
async function switchBookingSystem(env, form) {
  const system = String(form.get("system") || "");
  if (system === "nova" && !((await googleReady(env)) && stripeReady(env))) {
    return back("Not switched: connect Google and set up Stripe first.", "/admin/connections");
  }
  try {
    await setBookingSystem(env, system);
  } catch {
    return back("That isn't a booking system.", "/admin/connections");
  }
  return back(system === "nova" ? "Switched: NovaBot now uses its own booking system." : "Switched back: NovaBot uses Acuity.", "/admin/connections");
}

// ===== SHARED =====

const when = (iso) => escapeHtml(String(iso || "").slice(0, 16).replace("T", " "));

// The page around each admin section, with the tabs at the top
async function page(env, title, url, body) {
  const e = escapeHtml;
  const message = url.searchParams.get("msg");
  const { count: newEnquiries } = await env.DB.prepare("SELECT COUNT(*) AS count FROM enquiries WHERE status = 'new'").first();
  const tabs = [
    ["Referrals", "/admin"],
    [`Enquiries${newEnquiries ? ` (${newEnquiries} new)` : ""}`, "/admin/enquiries"],
    ["Conversations", "/admin/conversations"],
    ["Feedback", "/admin/feedback"],
    ["Booking system", "/admin/connections"],
  ]
    .map(([label, href]) => `<a href="${href}" class="${label.startsWith(title) ? "current" : ""}">${e(label)}</a>`)
    .join("");

  const html = `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<meta name="robots" content="noindex">
<title>${e(title)} | Novacane admin</title>
<style>
${PAGE_STYLE}
  main { max-width: 1200px; margin: 0 auto; padding: 32px 20px 60px; }
  h1 { font-size: 28px; margin: 0 0 16px; }
  h2 { color: #fff; margin: 40px 0 12px; font-size: 20px; }
  nav.tabs { display: flex; flex-wrap: wrap; gap: 8px; margin-bottom: 24px; }
  nav.tabs a { padding: 8px 16px; border-radius: 14px; border: 1px solid rgba(229, 194, 224, 0.3); text-decoration: none; color: rgb(229, 194, 224); }
  nav.tabs a.current { background: linear-gradient(120deg, #b01d68, #7a1f86); border-color: transparent; color: #fff; font-weight: 700; }
  .stats { display: flex; flex-wrap: wrap; gap: 12px; }
  .stat { background: #150d1f; border-radius: 20px; padding: 14px 20px; min-width: 150px; }
  .stat b { display: block; font-size: 28px; color: #fff; }
  .card { background: #150d1f; border-radius: 24px; padding: 16px; overflow-x: auto; margin-bottom: 14px; }
  table { width: 100%; border-collapse: collapse; font-size: 15px; }
  th { text-align: left; font-size: 12px; letter-spacing: 0.08em; text-transform: uppercase; color: #fff; }
  th, td { padding: 10px 12px; border-bottom: 1px solid rgba(229, 194, 224, 0.12); vertical-align: top; }
  td.num { font-variant-numeric: tabular-nums; }
  tr.canceled td { opacity: 0.5; }
  .dim { opacity: 0.6; }
  .small { font-size: 13px; }
  .warn { color: #ffb86b; }
  .notice { background: rgba(176, 29, 104, 0.3); border-radius: 14px; padding: 12px 16px; color: #fff; }
  .add { display: grid; grid-template-columns: 1fr 1.5fr 2fr auto; gap: 10px; margin-top: 14px; }
  .btn.small { padding: 6px 12px; font-size: 12px; }
  .filters a { margin-right: 14px; }
  .filters a.current { color: #fff; font-weight: 700; text-decoration: none; }
  .booklink summary { cursor: pointer; color: #fff; font-weight: 600; }
  .booklink form, .link-made { display: flex; gap: 8px; flex-wrap: wrap; align-items: center; margin-top: 10px; }
  .booklink select { flex: 1; min-width: 220px; padding: 8px 10px; border-radius: 12px; border: 1px solid rgba(229, 194, 224, 0.35); background: #1d1230; color: #fff; }
  .link-made input { flex: 1; min-width: 260px; font-size: 13px; }
  .email-status { display: flex; justify-content: space-between; align-items: center; gap: 12px; flex-wrap: wrap; }
  .enquiry header { display: flex; justify-content: space-between; gap: 16px; align-items: flex-start; }
  .enquiry.done { opacity: 0.55; }
  .details { white-space: pre-wrap; color: #fff; }
  .transcript .line { margin: 0 0 14px; }
  .transcript .line p { margin: 4px 0 0; white-space: pre-wrap; }
  .transcript .visitor p { color: #fff; }
  @media (max-width: 700px) { .add { grid-template-columns: 1fr; } .enquiry header { flex-direction: column; } }
</style>
</head>
<body>
<main>
  <h1>Novacane admin</h1>
  <nav class="tabs">${tabs}</nav>
  ${message ? `<p class="notice" role="status">${e(message)}</p>` : ""}
${body}
</main>
</body>
</html>`;

  return new Response(html, {
    headers: { "Content-Type": "text/html; charset=utf-8", "Cache-Control": "no-store", "X-Frame-Options": "DENY" },
  });
}

function back(message, to = "/admin") {
  return new Response(null, { status: 303, headers: { Location: to + "?msg=" + encodeURIComponent(message) } });
}

function text(body, status) {
  return new Response(body, { status, headers: { "Content-Type": "text/plain; charset=utf-8" } });
}

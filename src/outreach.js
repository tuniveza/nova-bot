// One-to-one emails ("outreach"): a personal email to one person (a venue, a label, a brand, a
// client, someone who wrote in), sent through Resend only after an admin approves it
// (migrations/0028_outreach.sql). It works like email campaigns (src/campaigns.js).
//
// Who can do what is decided here and in the routes, whatever any AI says:
//
//   - Nova Agent's AI (AGENT_NOVA_KEY, src/agent-nova.js) can read these, write one and edit one.
//     A new one goes straight to 'pending_approval' and the admins' phones get a quiet ping.
//     Nothing the agent's key reaches approves, sends or test-sends.
//   - Any staff signed in to Portal can do the same (write, edit, read, record an opt-out).
//   - Only an admin signed in to Portal in a browser (role 'admin' and the session cookie: checked
//     in handleOutreachForStaff) can Approve, Reject, or send themselves a test.
//
// Approving is one guarded UPDATE (… WHERE status = <what the admin saw> AND updated_at = <when it
// last changed>), so two presses at once approve it once, and only the request that approved it
// runs the sender. The approval stores a hash of exactly what was approved (who it's to, the
// subject, the email). The sender takes it with another guarded UPDATE (sending_at, only while the
// hash still matches), so it goes once; any edit puts it back to 'pending_approval' with the
// approval cleared.
//
// Who can be emailed (UK GDPR / PECR), checked when it's written, approved and sent:
//   business  a work address at an organisation (B2B marketing is allowed with an easy opt-out).
//             Personal mailboxes (Gmail, Hotmail, iCloud…) count as individuals, so they're
//             refused: those people have to opt in first (the /join page).
//   client    a studio client: only if they said yes to studio news, or when it's about their own
//             booking (a service email, labelled as such).
//   reply     someone who wrote to the studio first (an enquiry from that address), unless they
//             asked not to be contacted.
// Never to anyone on outreach_optouts, and never a business email to a client or fan who hasn't
// agreed to news. Every email ends with who it's from and how to stop them: "reply no thanks, or
// use this link", which goes to /no-thanks (a Confirm button, so a link scanner can't press it).
//
// Logs say ids and counts only, never anyone's details or a key. Times are UTC; Portal shows UK time.

import { notifyPhones } from "./push.js";
import { publicUrl } from "./nova/booking.js";
import { emailRecipients, sendEmail } from "./enquiries.js";
import { campaignFrom } from "./campaigns.js";

export const KINDS = ["business", "client", "reply"];
export const STATUSES = ["draft", "pending_approval", "approved", "rejected", "sent", "failed"];
const KIND_NAMES = { business: "a business", client: "a studio client", reply: "someone who wrote to the studio" };

const MAX_SUBJECT = 150;
const MAX_BODY = 10000;
const MAX_NAME = 100;
const MAX_ORG = 120;
// Emails waiting for approval at once, at most (stops a runaway AI filling the list)
const MAX_WAITING = 20;
// At most this many sent per UK day (keeps the studio's address from looking like a spammer's)
const MAX_PER_DAY = 40;
// A business gets at most one new email a week from here (a reply or a client email isn't counted)
const BUSINESS_GAP_MS = 7 * 86400000;
// An email the sender took this long ago without finishing was cut off part-way
const STUCK_MS = 10 * 60 * 1000;
// One test email per person per this long
const TEST_GAP_MS = 30 * 1000;

const EMAIL_PATTERN = /^[^\s@<>"',;]+@[^\s@<>"',;]+\.[^\s@<>"',;]{2,}$/;
const TOKEN_PATTERN = /^[0-9a-f]{32}$/;
// Personal mailboxes: whoever uses one is an individual under PECR, not a business
const PERSONAL_DOMAINS = new Set(
  [
    "gmail.com", "googlemail.com", "hotmail.com", "hotmail.co.uk", "outlook.com", "outlook.co.uk", "live.com", "live.co.uk", "msn.com",
    "yahoo.com", "yahoo.co.uk", "ymail.com", "icloud.com", "me.com", "mac.com", "aol.com", "aol.co.uk", "btinternet.com", "sky.com",
    "virginmedia.com", "talktalk.net", "protonmail.com", "proton.me", "pm.me", "gmx.com", "gmx.co.uk", "mail.com", "zoho.com", "yandex.com", "hey.com",
  ]
);

const nowIso = () => new Date().toISOString();
const fail = (status, error) => ({ status, error });
const hex = (bytes) => [...bytes].map((b) => b.toString(16).padStart(2, "0")).join("");

function cleanText(value, max) {
  return typeof value === "string" ? value.replace(/\r\n?/g, "\n").replace(/[ \t]+\n/g, "\n").trim().slice(0, max) : "";
}
const oneLine = (value, max) => cleanText(value, max).replace(/\s+/g, " ");

function positiveId(value) {
  const n = typeof value === "string" && /^\d{1,12}$/.test(value.trim()) ? Number(value) : value;
  return Number.isInteger(n) && n > 0 ? n : null;
}

export function cleanEmail(value) {
  const email = typeof value === "string" ? value.trim().toLowerCase() : "";
  return EMAIL_PATTERN.test(email) && email.length <= 200 ? email : "";
}
export const isPersonalMailbox = (email) => PERSONAL_DOMAINS.has(String(email).split("@").pop());

// "Sun 11 Oct 2026, 14:00" (UK)
function ukWhen(iso) {
  return new Date(iso).toLocaleString("en-GB", { weekday: "short", day: "numeric", month: "short", year: "numeric", hour: "2-digit", minute: "2-digit", timeZone: "Europe/London" });
}

async function sha256Hex(text) {
  return hex(new Uint8Array(await crypto.subtle.digest("SHA-256", new TextEncoder().encode(text))));
}

// The hash of exactly what an admin approves: who it's to, what kind, the subject and the email
export function outreachHash(row) {
  return sha256Hex(JSON.stringify(["nova-outreach-v1", row.kind, row.to_email, row.to_name, row.organisation, row.client_id ?? null, row.about_booking ? 1 : 0, row.subject, row.body]));
}

// ===== THE EMAIL =====

const esc = (s) => String(s ?? "").replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c]);
const BARE_URL = /\bhttps?:\/\/[^\s<>"']+[^\s<>"'.,;:!?)]/g;
const paragraphs = (body) => String(body).split(/\n\s*\n/).map((p) => p.trim()).filter(Boolean);

export function optoutUrl(env, row) {
  return `${publicUrl(env)}/no-thanks?t=${row.optout_token}`;
}

// Why they're getting it, in the footer
function whyLine(row) {
  if (row.kind === "reply") return "You're getting this because you got in touch with Novacane Studios.";
  if (row.kind === "client") return row.about_booking ? "You're getting this because of your booking with Novacane Studios." : "You're getting this because you said yes to news from Novacane Studios.";
  return `We're writing to ${row.organisation || "you"} because we think it's relevant to your work.`;
}

// The email as it goes: the text as written, then who it's from and how to stop these emails
export function outreachEmail(env, row) {
  const stop = optoutUrl(env, row);
  const why = whyLine(row);
  const footer = ["—", "Novacane Studios, Forest Hill, London", why, `Don't want emails like this? Reply "no thanks", or use this link and we won't email you again: ${stop}`];
  const text = `${row.body}\n\n${footer.join("\n")}`;
  const inline = (p) => esc(p).replace(BARE_URL, (url) => `<a href="${url}" style="color:#c2337a;">${url}</a>`).replace(/\n/g, "<br>");
  const html = `<!doctype html><html lang="en-GB"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1"></head>
<body style="margin:0;padding:24px 16px;background:#ffffff;color:#1d1820;font:16px/1.55 -apple-system,'Segoe UI',Roboto,Arial,sans-serif;">
<div style="max-width:600px;margin:0 auto;">
${paragraphs(row.body).map((p) => `<p style="margin:0 0 16px;">${inline(p)}</p>`).join("\n")}
<p style="margin:28px 0 0;padding-top:14px;border-top:1px solid #e4dfe7;color:#6b6270;font-size:13px;line-height:1.5;">Novacane Studios, Forest Hill, London<br>${esc(why)}<br>Don't want emails like this? Reply “no thanks”, or <a href="${esc(stop)}" style="color:#6b6270;">use this link</a> and we won't email you again.</p>
</div></body></html>`;
  return { text, html };
}

// ===== READING =====

const SELECT = "SELECT o.*, s.display_name AS decided_by_name, w.display_name AS created_by_name FROM outreach_emails o LEFT JOIN staff s ON s.id = o.decided_by LEFT JOIN staff w ON w.id = o.created_by";
const isStuck = (row) => row.status === "approved" && row.sending_at && Date.now() - Date.parse(row.sending_at) > STUCK_MS;
const waitingStatus = (status) => status === "draft" || status === "pending_approval";

export function publicOutreach(env, row) {
  if (!row) return null;
  const stuck = isStuck(row);
  return {
    id: row.id,
    toName: row.to_name || "",
    toEmail: row.to_email,
    organisation: row.organisation || "",
    kind: row.kind,
    clientId: row.client_id ?? null,
    aboutBooking: Boolean(row.about_booking),
    subject: row.subject,
    body: row.body,
    status: stuck ? "failed" : row.status,
    createdBy: row.created_by,
    createdByName: row.created_by === "agent" ? "Nova Agent" : row.created_by_name || null,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
    decidedBy: row.decided_by || null,
    decidedByName: row.decided_by_name || null,
    decidedAt: row.decided_at || null,
    note: row.decision_note || null,
    sentAt: row.sent_at || null,
    error: stuck ? "It didn't finish sending (Nova Bot stopped part-way). Check Resend's Emails before sending it again." : row.error || null,
    portalUrl: `${publicUrl(env)}/portal/?view=campaigns&outreach=${row.id}`,
  };
}

async function readRow(env, id) {
  return env.DB.prepare(`${SELECT} WHERE o.id = ?`).bind(id).first();
}

export async function getOutreach(env, id) {
  return publicOutreach(env, await readRow(env, id));
}

// status: "waiting" (draft or pending), one status, or "all": waiting ones first, newest first
export async function listOutreach(env, { status = "all", limit = 100 } = {}) {
  const order = "ORDER BY CASE WHEN o.status IN ('draft', 'pending_approval') THEN 0 ELSE 1 END, o.id DESC LIMIT ?";
  let query;
  if (status === "waiting") query = env.DB.prepare(`${SELECT} WHERE o.status IN ('draft', 'pending_approval') ${order}`).bind(limit);
  else if (STATUSES.includes(status)) query = env.DB.prepare(`${SELECT} WHERE o.status = ? ${order}`).bind(status, limit);
  else query = env.DB.prepare(`${SELECT} ${order}`).bind(limit);
  const { results } = await query.all();
  return results.map((row) => publicOutreach(env, row));
}

export async function outreachLog(env, id) {
  const { results } = await env.DB.prepare(
    'SELECT l.id, l.at, l.event, l."by", l.detail, s.display_name AS by_name FROM outreach_log l LEFT JOIN staff s ON s.id = l."by" WHERE l.outreach_id = ? ORDER BY l.id'
  )
    .bind(id)
    .all();
  return results.map((r) => ({ id: r.id, at: r.at, event: r.event, by: r.by, byName: r.by === "agent" ? "Nova Agent" : r.by_name || null, detail: r.detail || null }));
}

const logEntry = (env, id, event, by, detail = null) =>
  env.DB.prepare('INSERT INTO outreach_log (outreach_id, at, event, "by", detail) VALUES (?, ?, ?, ?, ?)').bind(id, nowIso(), event, by, detail);

// ===== WHO CAN BE EMAILED =====

// Is this person someone the studio may email this way? -> null (yes) or the reason not.
// `row`: { kind, to_email, organisation, client_id, about_booking }. `skipGap` for an edit of the
// same email (it doesn't count against itself).
export async function mayEmail(env, row, { selfId = null } = {}) {
  const email = row.to_email;
  const optout = await env.DB.prepare("SELECT at FROM outreach_optouts WHERE email = ?").bind(email).first();
  if (optout) return `${email} asked not to get emails like this (${ukWhen(optout.at)}), so it can't be sent.`;
  const client = await env.DB.prepare("SELECT id, marketing_consent FROM clients WHERE email = ?").bind(email).first();
  const fan = await env.DB.prepare("SELECT status FROM fans WHERE email = ?").bind(email).first();

  if (row.kind === "business") {
    if (!row.organisation) return "organisation: say which business or organisation it's to (business emails go to a work address).";
    if (isPersonalMailbox(email)) {
      return `${email} is a personal mailbox, so under UK law (PECR) they count as a person, not a business: they'd have to opt in first. Send them the fan sign-up link instead, or email a work address.`;
    }
    if (client && !client.marketing_consent) return "That address belongs to a studio client who hasn't said yes to studio news. Write it as a client email about their booking, or record their consent in Portal → Clients first.";
    if (fan && fan.status === "unsubscribed") return "That address unsubscribed from the studio's emails, so it can't be sent.";
    const recent = await env.DB.prepare(
      "SELECT sent_at FROM outreach_emails WHERE to_email = ? AND kind = 'business' AND status = 'sent' AND sent_at > ? AND id != ? ORDER BY sent_at DESC LIMIT 1"
    )
      .bind(email, new Date(Date.now() - BUSINESS_GAP_MS).toISOString(), selfId ?? 0)
      .first();
    if (recent) return `They already got an email from the studio on ${ukWhen(recent.sent_at)}. Give it a week before writing again (unless they reply).`;
    return null;
  }
  if (row.kind === "client") {
    const who = row.client_id ? await env.DB.prepare("SELECT id, email, marketing_consent FROM clients WHERE id = ?").bind(row.client_id).first() : client;
    if (!who) return "That isn't one of the studio's clients (Portal → Clients). Pick the client, or write it as a business email.";
    if (who.email !== email) return "That email address isn't the one on the client's record in Portal → Clients.";
    if (!row.about_booking && !who.marketing_consent) return "That client hasn't said yes to studio news, so only an email about their own booking can go to them.";
    return null;
  }
  if (row.kind === "reply") {
    const wrote = await env.DB.prepare("SELECT COUNT(*) AS n, MAX(do_not_contact_at) AS stop FROM enquiries WHERE lower(email) = ?").bind(email).first();
    if (!wrote || !wrote.n) return "Nobody with that address has written to the studio (no enquiry), so it can't go as a reply. Write it as a business email or a client email.";
    if (wrote.stop) return "They asked not to be contacted, so it can't be sent.";
    return null;
  }
  return `kind must be one of: ${KINDS.join(", ")}.`;
}

// ===== WRITING AND EDITING (the AI, or any staff) =====

// Check the fields. `base` is what's saved (for an edit: only what's given changes).
// -> the row's fields, or { status, error }
async function checkFields(env, input, base = {}) {
  const has = (key) => input && Object.hasOwn(input, key) && input[key] !== undefined;
  const kind = has("kind") ? input.kind : base.kind;
  if (!KINDS.includes(kind)) return fail(400, `kind must be one of: ${KINDS.join(", ")} (business: a work address at an organisation; client: a studio client; reply: someone who wrote to the studio).`);
  const to_email = has("toEmail") ? cleanEmail(input.toEmail) : base.to_email;
  if (!to_email) return fail(400, "toEmail: that email address doesn't look right.");
  const to_name = has("toName") ? oneLine(input.toName, MAX_NAME) : base.to_name || "";
  const organisation = has("organisation") ? oneLine(input.organisation, MAX_ORG) : base.organisation || "";
  let client_id = has("clientId") ? positiveId(input.clientId) : base.client_id ?? null;
  const about_booking = has("aboutBooking") ? (input.aboutBooking ? 1 : 0) : base.about_booking ? 1 : 0;
  const subject = has("subject") ? oneLine(input.subject, MAX_SUBJECT) : base.subject;
  const body = has("body") ? cleanText(input.body, MAX_BODY) : base.body;
  if (!subject) return fail(400, "subject: the email's subject line is needed.");
  if (!body || body.length < 10) return fail(400, "body: write the email (at least a sentence).");
  if (kind === "client" && !client_id) {
    const found = await env.DB.prepare("SELECT id FROM clients WHERE email = ?").bind(to_email).first();
    client_id = found ? found.id : null;
  }
  const fields = { kind, to_email, to_name, organisation, client_id: kind === "client" ? client_id : null, about_booking: kind === "client" ? about_booking : 0, subject, body };
  const why = await mayEmail(env, fields, { selfId: base.id ?? null });
  if (why) return fail(409, why);
  return fields;
}

// A quiet ping to the admins' phones (they're the ones who can approve). Not to the writer.
async function pingAdmins(env, email, { by, edited = false }) {
  try {
    const { results } = await env.DB.prepare("SELECT id FROM staff WHERE role = 'admin' AND status = 'active' AND id != ?").bind(String(by)).all();
    if (!results.length) return;
    const who = by === "agent" ? "Agent" : "A colleague";
    await notifyPhones(env, {
      title: edited ? "Email changed: approve it again" : "Email to approve",
      body: `${who} ${edited ? "changed" : "wrote"} an email to ${email.toName || email.organisation || "someone"}: "${email.subject}". Nothing is sent until an admin approves it in Portal → Campaigns.`,
      url: `/portal/?view=campaigns&outreach=${email.id}`,
      style: { source: "portal", kind: "outreach", tag: `outreach-${email.id}`, ttl: 12 * 3600, urgent: false },
      to: { staff: results.map((r) => r.id) },
    });
  } catch (err) {
    console.log(`Outreach ${email.id}: the ping failed (${err?.message})`);
  }
}

// A new email, waiting for approval. by: 'agent' or a staff id.
export async function createOutreach(env, input, by) {
  const fields = await checkFields(env, input || {});
  if (fields.error) return fields;
  const { count } = await env.DB.prepare("SELECT COUNT(*) AS count FROM outreach_emails WHERE status IN ('draft', 'pending_approval')").first();
  if (count >= MAX_WAITING) return fail(429, "There are already many emails waiting for approval. Ask an admin to go through them in Portal → Campaigns first.");
  const now = nowIso();
  const token = hex(crypto.getRandomValues(new Uint8Array(16)));
  const row = await env.DB.prepare(
    `INSERT INTO outreach_emails (to_name, to_email, organisation, kind, client_id, about_booking, subject, body, status, created_by, created_at, updated_at, submitted_at, optout_token)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, 'pending_approval', ?, ?, ?, ?, ?) RETURNING id`
  )
    .bind(fields.to_name, fields.to_email, fields.organisation, fields.kind, fields.client_id, fields.about_booking, fields.subject, fields.body, String(by), now, now, now, token)
    .first();
  await env.DB.batch([logEntry(env, row.id, "created", String(by), `To ${KIND_NAMES[fields.kind]}${fields.about_booking ? " (about their booking)" : ""}`), logEntry(env, row.id, "submitted", String(by))]);
  const email = await getOutreach(env, row.id);
  console.log(`Outreach ${row.id} written by ${by === "agent" ? "agent" : "staff"}; waiting for approval`);
  await pingAdmins(env, email, { by });
  return { outreach: email };
}

// Change one: back to 'pending_approval', approval cleared. Sent ones, and one being sent, can't.
export async function editOutreach(env, by, id, input) {
  id = positiveId(id);
  if (!id) return fail(400, "Which email?");
  const row = await readRow(env, id);
  if (!row) return fail(404, "That email doesn't exist.");
  if (row.status === "sent") return fail(409, "That email has already been sent.");
  if (row.status === "approved" && !isStuck(row)) return fail(409, "It's being sent right now.");
  const fields = await checkFields(env, input || {}, row);
  if (fields.error) return fields;
  const keys = ["kind", "to_email", "to_name", "organisation", "client_id", "about_booking", "subject", "body"];
  const changed = keys.filter((key) => (fields[key] ?? null) !== (row[key] ?? null));
  if (!changed.length && waitingStatus(row.status)) return { outreach: publicOutreach(env, row), unchanged: true };
  const now = nowIso();
  const { meta } = await env.DB.prepare(
    `UPDATE outreach_emails SET kind = ?, to_email = ?, to_name = ?, organisation = ?, client_id = ?, about_booking = ?, subject = ?, body = ?,
       status = 'pending_approval', approved_hash = NULL, decided_by = NULL, decided_at = NULL, sending_at = NULL, resend_id = NULL, error = NULL,
       updated_at = ?, submitted_at = ?
     WHERE id = ? AND status = ? AND updated_at = ?`
  )
    .bind(fields.kind, fields.to_email, fields.to_name, fields.organisation, fields.client_id, fields.about_booking, fields.subject, fields.body, now, now, id, row.status, row.updated_at)
    .run();
  if (!meta.changes) return fail(409, "Someone else changed it at the same moment. Look at it again.");
  const names = { to_email: "address", to_name: "name", client_id: "client", about_booking: "what it's about" };
  const what = changed.length ? `Changed: ${changed.map((k) => names[k] || k).join(", ")}` : "Sent for approval again";
  await env.DB.batch([logEntry(env, id, "edited", String(by), what + (row.status === "rejected" ? " (after it was rejected)" : "")), logEntry(env, id, "submitted", String(by))]);
  const email = await getOutreach(env, id);
  console.log(`Outreach ${id} edited (was ${row.status}); waiting for approval again`);
  await pingAdmins(env, email, { by, edited: true });
  return { outreach: email };
}

// ===== AN ADMIN DECIDES (a person pressed a button in Portal; handleOutreachForStaff checks who) =====

export function outreachFrom(env) {
  return String(env.ENQUIRY_REPLY_FROM || env.CAMPAIGN_FROM || campaignFrom(env) || "").trim();
}
export function outreachReady(env) {
  return Boolean(env.RESEND_API_KEY && outreachFrom(env));
}
const NOT_READY = "One-to-one emails aren't set up yet: they need Resend's sending key (RESEND_API_KEY) and the from address (ENQUIRY_REPLY_FROM or CAMPAIGN_FROM).";

function replyTo(env) {
  return env.OUTREACH_REPLY_TO || env.CAMPAIGN_REPLY_TO || env.ENQUIRY_REPLY_TO || emailRecipients(env)[0] || undefined;
}

// Sent today (UK day), counting ones being sent
async function sentToday(env) {
  const day = new Date().toLocaleDateString("en-CA", { timeZone: "Europe/London" });
  const start = new Date(Date.now() - 36 * 3600000).toISOString();
  const { results } = await env.DB.prepare("SELECT COALESCE(sent_at, sending_at) AS at FROM outreach_emails WHERE COALESCE(sent_at, sending_at) > ?").bind(start).all();
  return results.filter((r) => new Date(r.at).toLocaleDateString("en-CA", { timeZone: "Europe/London" }) === day).length;
}

// Approve, then send straight away. Only from 'pending_approval' (or 'draft').
export async function approveOutreach(env, me, { id }) {
  id = positiveId(id);
  if (!id) return fail(400, "Which email?");
  const row = await readRow(env, id);
  if (!row) return fail(404, "That email doesn't exist.");
  if (row.status === "approved" || row.status === "sent") return { outreach: publicOutreach(env, row), repeated: true };
  if (row.status === "rejected") return fail(409, "That email was rejected. Edit it to send it for approval again.");
  if (row.status === "failed") return fail(409, "That email didn't send. Edit it (or just save it again) to send it for approval again.");
  if (!outreachReady(env)) return fail(409, NOT_READY);
  const why = await mayEmail(env, row, { selfId: id });
  if (why) return fail(409, why);
  if ((await sentToday(env)) >= MAX_PER_DAY) return fail(429, `${MAX_PER_DAY} one-to-one emails have gone today already. Approve it tomorrow (it keeps).`);

  const hash = await outreachHash(row);
  const now = nowIso();
  const { meta } = await env.DB.prepare(
    `UPDATE outreach_emails SET status = 'approved', approved_hash = ?, decided_by = ?, decided_at = ?, decision_note = NULL, error = NULL, updated_at = ?
     WHERE id = ? AND status = ? AND updated_at = ?`
  )
    .bind(hash, me.id, now, now, id, row.status, row.updated_at)
    .run();
  if (!meta.changes) {
    const latest = await readRow(env, id);
    if (latest && (latest.status === "approved" || latest.status === "sent")) return { outreach: publicOutreach(env, latest), repeated: true };
    return fail(409, "It changed while you were looking at it. Check it again, then approve.");
  }
  await logEntry(env, id, "approved", me.id).run();
  console.log(`Outreach ${id} approved by ${me.id}`);
  return { outreach: await sendApproved(env, id) };
}

export async function rejectOutreach(env, me, { id, note }) {
  id = positiveId(id);
  if (!id) return fail(400, "Which email?");
  const text = cleanText(note, 500) || null;
  const now = nowIso();
  const { meta } = await env.DB.prepare(
    `UPDATE outreach_emails SET status = 'rejected', approved_hash = NULL, decided_by = ?, decided_at = ?, decision_note = ?, updated_at = ?
     WHERE id = ? AND status IN ('draft', 'pending_approval')`
  )
    .bind(me.id, now, text, now, id)
    .run();
  if (!meta.changes) {
    const row = await readRow(env, id);
    if (!row) return fail(404, "That email doesn't exist.");
    return { ...fail(409, `That email is already ${row.status.replace("_", " ")}.`), outreach: publicOutreach(env, row) };
  }
  await logEntry(env, id, "rejected", me.id, text).run();
  console.log(`Outreach ${id} rejected by ${me.id}`);
  return { outreach: await getOutreach(env, id) };
}

// "Send me a test": the email, once, to the admin who pressed it and nobody else, marked [TEST]
export async function testSendOutreach(env, me, { id }) {
  id = positiveId(id);
  if (!id) return fail(400, "Which email?");
  const row = await readRow(env, id);
  if (!row) return fail(404, "That email doesn't exist.");
  if (!outreachReady(env)) return fail(409, NOT_READY);
  const to = String(me.email || "").trim().toLowerCase();
  if (!to || !to.includes("@")) return fail(409, "Your account has no email address.");
  const key = "outreach_test_" + me.id;
  const last = await env.DB.prepare("SELECT value FROM settings WHERE key = ?").bind(key).first("value");
  if (last && Date.now() - Date.parse(last) < TEST_GAP_MS) return fail(429, "One just went. Wait half a minute before sending another.");
  await env.DB.prepare("INSERT INTO settings (key, value) VALUES (?, ?) ON CONFLICT (key) DO UPDATE SET value = excluded.value").bind(key, nowIso()).run();
  // The opt-out link in a test goes nowhere real (a test isn't the person saying no)
  const email = outreachEmail(env, { ...row, optout_token: "test" });
  const result = await sendEmail(env, { to: [to], from: outreachFrom(env), replyTo: replyTo(env), subject: `[TEST] ${row.subject}`, text: email.text, html: email.html });
  return result.ok ? { ok: true, to, message: `Test sent to ${to}. Check the inbox (and spam).` } : fail(502, result.message);
}

// ===== SENDING =====

// Send an approved email. Only status 'approved' with an approval hash that still matches what's
// saved goes, once (the sending_at claim); anything else is handed back untouched (or, if it
// changed after approval, back to 'pending_approval'). Called only by the request that approved it.
export async function sendApproved(env, id) {
  const row = await readRow(env, id);
  if (!row || row.status !== "approved") return publicOutreach(env, row);
  const failWith = async (error) => {
    await env.DB.batch([
      env.DB.prepare("UPDATE outreach_emails SET status = 'failed', error = ?, updated_at = ? WHERE id = ? AND status = 'approved'").bind(error, nowIso(), id),
      logEntry(env, id, "failed", "nova", error),
    ]);
    console.log(`Outreach ${id}: failed`);
    return getOutreach(env, id);
  };
  if (!row.approved_hash || (await outreachHash(row)) !== row.approved_hash) {
    await env.DB.batch([
      env.DB.prepare(
        "UPDATE outreach_emails SET status = 'pending_approval', approved_hash = NULL, decided_by = NULL, decided_at = NULL, sending_at = NULL, error = ?, updated_at = ? WHERE id = ? AND status = 'approved'"
      ).bind("It changed after it was approved, so it wasn't sent. Check it and approve it again.", nowIso(), id),
      logEntry(env, id, "failed", "nova", "Not sent: it changed after it was approved"),
    ]);
    console.log(`Outreach ${id}: refused, it changed after approval`);
    return getOutreach(env, id);
  }
  if (row.sending_at) return publicOutreach(env, row);
  if (!outreachReady(env)) return failWith(NOT_READY);
  // Someone may have said no since it was approved
  const why = await mayEmail(env, row, { selfId: id });
  if (why) return failWith(why);
  // Take it: once, and only while what's saved is still what was approved
  const { meta } = await env.DB.prepare("UPDATE outreach_emails SET sending_at = ? WHERE id = ? AND status = 'approved' AND sending_at IS NULL AND approved_hash = ?").bind(nowIso(), id, row.approved_hash).run();
  if (!meta.changes) return getOutreach(env, id);

  const email = outreachEmail(env, row);
  const result = await sendEmail(env, {
    to: [row.to_name ? `${row.to_name.replace(/["<>]/g, "")} <${row.to_email}>` : row.to_email],
    from: outreachFrom(env),
    replyTo: replyTo(env),
    subject: row.subject,
    text: email.text,
    html: email.html,
    headers: { "List-Unsubscribe": `<${optoutUrl(env, row)}>` },
    idempotencyKey: `outreach-${id}-${row.approved_hash.slice(0, 16)}`,
  });
  if (!result.ok) return failWith(result.message || "Resend didn't send it.");
  const now = nowIso();
  await env.DB.batch([
    env.DB.prepare("UPDATE outreach_emails SET status = 'sent', resend_id = ?, sent_at = ?, error = NULL, updated_at = ? WHERE id = ? AND status = 'approved'").bind(result.id || null, now, now, id),
    logEntry(env, id, "sent", "nova", "Sent through Resend"),
  ]);
  console.log(`Outreach ${id}: sent`);
  return getOutreach(env, id);
}

// ===== SAYING NO =====

// Record that someone doesn't want these emails (the link, or staff after a "no thanks" reply)
export async function recordOptout(env, email, source, outreachId = null) {
  const clean = cleanEmail(email);
  if (!clean) return fail(400, "That email address doesn't look right.");
  await env.DB.prepare("INSERT INTO outreach_optouts (email, at, source, outreach_id) VALUES (?, ?, ?, ?) ON CONFLICT (email) DO NOTHING").bind(clean, nowIso(), source, outreachId).run();
  // Anything still waiting to them won't go
  const now = nowIso();
  const { results } = await env.DB.prepare(
    "UPDATE outreach_emails SET status = 'rejected', decision_note = 'They asked not to get emails like this', approved_hash = NULL, updated_at = ? WHERE to_email = ? AND status IN ('draft', 'pending_approval') RETURNING id"
  )
    .bind(now, clean)
    .all();
  if (results.length) await env.DB.batch(results.map((r) => logEntry(env, r.id, "rejected", "nova", "They asked not to get emails like this")));
  return { ok: true, email: clean, stopped: results.length };
}

// /no-thanks?t=…: a Confirm button (GET changes nothing, so a link scanner can't say no for them);
// pressing it (POST) records the opt-out
export async function handleNoThanks(request, env) {
  const url = new URL(request.url);
  let token = url.searchParams.get("t") || "";
  const press = request.method === "POST";
  if (!press && request.method !== "GET" && request.method !== "HEAD") return new Response("Method not allowed", { status: 405, headers: { Allow: "GET, POST" } });
  if (press) {
    try {
      token = String((await request.formData()).get("t") || "");
    } catch {
      token = "";
    }
  }
  const broken = () => page("That link doesn't work", "It may have been copied wrongly. To stop emails from Novacane Studios, just reply to one with “no thanks”.", "", 404);
  if (!TOKEN_PATTERN.test(token)) return broken();
  const row = await env.DB.prepare("SELECT id, to_email FROM outreach_emails WHERE optout_token = ?").bind(token).first();
  if (!row) return broken();
  if (!press) {
    return page("Stop these emails?", "Press the button and Novacane Studios won't send you emails like this again.", `<form method="post" action="/no-thanks"><input type="hidden" name="t" value="${esc(token)}"><button type="submit">Don't email me again</button></form>`);
  }
  await recordOptout(env, row.to_email, "The link in an email", row.id);
  console.log(`Outreach ${row.id}: opted out by link`);
  return page("Done", "You won't get emails like this from Novacane Studios again. Sorry to have bothered you.");
}

function page(title, text, form = "", status = 200) {
  const html = `<!doctype html><html lang="en-GB"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1"><meta name="robots" content="noindex">
<title>${esc(title)} · Novacane Studios</title>
<style>
:root { color-scheme: light dark; --bg: #f7f5f8; --card: #fff; --ink: #1d1820; --muted: #6b6270; --accent: #c2337a; }
@media (prefers-color-scheme: dark) { :root { --bg: #141016; --card: #1f1922; --ink: #f2edf4; --muted: #a79dac; --accent: #ff7ab8; } }
* { box-sizing: border-box; }
body { margin: 0; background: var(--bg); color: var(--ink); font: 16px/1.5 system-ui, -apple-system, "Segoe UI", sans-serif; }
main { max-width: 460px; margin: 10vh auto; padding: 28px 24px; background: var(--card); border-radius: 18px; }
@media (max-width: 500px) { main { margin: 16px; } }
.brand { font-size: 0.8rem; letter-spacing: 0.14em; text-transform: uppercase; color: var(--accent); font-weight: 600; margin: 0 0 12px; }
h1 { font-size: 1.35rem; margin: 0 0 10px; } p { color: var(--muted); margin: 0 0 18px; }
button { font: inherit; padding: 11px 22px; border: 0; border-radius: 999px; background: var(--accent); color: #fff; cursor: pointer; }
small { display: block; margin-top: 18px; color: var(--muted); } small a { color: inherit; }
</style></head><body><main>
<div class="brand">Novacane Studios</div>
<h1>${esc(title)}</h1><p>${esc(text)}</p>${form}
<small>Novacane Studios, Forest Hill, London · <a href="/privacy">Privacy</a></small>
</main></body></html>`;
  return new Response(html, { status, headers: { "Content-Type": "text/html; charset=utf-8", "Cache-Control": "no-store", "Referrer-Policy": "no-referrer" } });
}

// ===== ROUTES =====

const canDecide = (me) => me.role === "admin" && me.session_kind === "cookie";

// Portal's /app/api/outreach… (src/app-page.js has already checked the sign-in and the Origin).
// -> a Response, or null
export async function handleOutreachForStaff(request, env, me, route) {
  const url = new URL(request.url);
  if (route === "/outreach" && request.method === "GET") {
    const { n } = await env.DB.prepare("SELECT COUNT(*) AS n FROM outreach_optouts").first();
    return json({ outreach: await listOutreach(env, { status: url.searchParams.get("status") || "all" }), canDecide: canDecide(me), ready: outreachReady(env), optouts: n, sentToday: await sentToday(env), perDay: MAX_PER_DAY });
  }
  const one = route.match(/^\/outreach\/(\d{1,12})$/);
  if (one && request.method === "GET") {
    const row = await readRow(env, Number(one[1]));
    if (!row) return json({ error: "That email doesn't exist." }, 404);
    return json({ outreach: publicOutreach(env, row), log: await outreachLog(env, row.id), email: outreachEmail(env, row).text });
  }
  if (request.method !== "POST") return null;
  if (route === "/outreach") return answer(await createOutreach(env, await readJson(request), me.id));
  // Someone replied "no thanks": anyone in the team can record it
  if (route === "/outreach/optouts") {
    const body = await readJson(request);
    return answer(await recordOptout(env, body.email, `Said no thanks (recorded by ${me.display_name || me.id})`));
  }
  const edit = route.match(/^\/outreach\/(\d{1,12})\/edit$/);
  if (edit) return answer(await editOutreach(env, me.id, Number(edit[1]), await readJson(request)));
  const decide = route.match(/^\/outreach\/(\d{1,12})\/(approve|reject)$/);
  if (!decide && route !== "/outreach/test-send") return null;
  if (!canDecide(me)) {
    return json({ error: "Only an admin, with Portal open in a browser and signed in, can approve, reject or test-send an email.", onlineUrl: `${publicUrl(env)}/portal/?view=campaigns` }, 403);
  }
  const body = await readJson(request);
  if (route === "/outreach/test-send") return answer(await testSendOutreach(env, me, { id: body.id }));
  if (decide[2] === "approve") return answer(await approveOutreach(env, me, { id: Number(decide[1]) }));
  return answer(await rejectOutreach(env, me, { id: Number(decide[1]), note: body.note }));
}

// Only these fields are read from the agent: a status, hash or approver sent along is ignored
const AGENT_FIELDS = ["kind", "toEmail", "toName", "organisation", "clientId", "aboutBooking", "subject", "body"];
const pick = (body) => {
  const out = {};
  for (const key of AGENT_FIELDS) if (body && Object.hasOwn(body, key)) out[key] = body[key];
  return out;
};

// Nova Agent's /nova-agent/outreach… (src/agent-nova.js has already checked the key). Read, write and
// edit only: there is no approve, send or test-send for the agent's key.
export async function handleOutreachForAgent(env, pathname, body) {
  if (pathname === "/nova-agent/outreach/draft") return answer(await createOutreach(env, pick(body), "agent"));
  if (pathname === "/nova-agent/outreach") return json({ outreach: await listOutreach(env, { status: typeof body?.status === "string" ? body.status : "all", limit: 50 }) });
  const one = pathname.match(/^\/nova-agent\/outreach\/(\d{1,12})$/);
  if (one) {
    const email = await getOutreach(env, Number(one[1]));
    return email ? json({ outreach: email, log: await outreachLog(env, email.id) }) : json({ error: "That email doesn't exist." }, 404);
  }
  const edit = pathname.match(/^\/nova-agent\/outreach\/(\d{1,12})\/edit$/);
  if (edit) return answer(await editOutreach(env, "agent", Number(edit[1]), pick(body)));
  return json({ error: "Not found" }, 404);
}

// ===== SHARED =====

function answer(result) {
  if (result?.error) {
    const { status, ...rest } = result;
    return json(rest, status || 400);
  }
  return json({ ok: true, ...result });
}

async function readJson(request) {
  try {
    return (await request.json()) || {};
  } catch {
    return {};
  }
}

function json(data, status = 200) {
  return new Response(JSON.stringify(data), { status, headers: { "Content-Type": "application/json", "Cache-Control": "no-store" } });
}

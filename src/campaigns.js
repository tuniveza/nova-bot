// Email campaigns (Quest 3): newsletters to fans and studio clients, sent by the studio's own mail
// server (on the VPS: vps/mail/server.mjs, through Postfix), only after an admin approves them
// (migrations/0025_email_campaigns.sql)
//
// Who can do what is decided here and in the routes, whatever any AI says:
//
//   - Nova Agent's AI (AGENT_NOVA_KEY, src/agent-nova.js) can read campaigns, write a draft and
//     edit one. A draft goes straight to 'pending_approval' and the admins' phones get a quiet
//     ping. Nothing the agent's key reaches approves, sends, schedules or test-sends.
//   - Any staff signed in to Portal can do the same (write, edit, read).
//   - Only an admin signed in to Portal in a browser (role 'admin' and the session cookie: checked
//     in handleCampaignsForStaff) can Approve, Reject, or send themselves a test.
//
// Approving is one guarded UPDATE (… WHERE status = <what the admin saw> AND updated_at = <when
// it last changed>), so two presses at once approve it once, and only the request that approved
// it runs the sender. The approval stores a hash of exactly what was approved (subject, body,
// audience, send time). Nothing goes unless the status is 'scheduled' (only approving gets it
// there) and the hash still matches; any edit puts the campaign back to 'pending_approval' with
// the approval cleared (a scheduled one can be changed until its first email has gone).
//
// The sender: approving makes the campaign's list (everyone on the audience who has opted in, kept
// in settings as campaign_queue:<id>) and the campaign becomes 'scheduled'. Every minute (index.js)
// a small batch goes out, with a pause between emails (CAMPAIGN_BATCH emails, 10 by default;
// CAMPAIGN_GAP_MS apart, 3 s by default), so the studio's new mail server builds a good name with
// Gmail and the rest instead of looking like a spammer. Before each batch everyone left is checked
// again, so anyone who unsubscribed in the meantime is skipped. Each email has its own idempotency
// key, so a batch cut off part-way and run again doesn't send anyone a second copy. When the list
// is done -> 'sent', with how many it went to.
//
// Who's on the lists (UK GDPR / PECR): confirmed fans (the /join page, double opt-in) and
// clients with marketing_consent = 1. Every email says who it's from and why they're getting it,
// and has its own unsubscribe link (signed, so nobody can unsubscribe someone else) plus the
// List-Unsubscribe and List-Unsubscribe-Post headers, so email apps show their own Unsubscribe
// button. /unsubscribe asks first (a link scanner can't press the button); an email app's one-click
// unsubscribe (a POST) works straight away. A fan becomes 'unsubscribed'; a client's consent goes
// to NO with a client_consent_log entry (by 'customer').
//
// Logs say ids and counts only, never anyone's details or a key. Times are UTC; emails and
// Portal show UK time.

import { notifyPhones } from "./push.js";
import { publicUrl } from "./nova/booking.js";
import { emailRecipients, mailReady, sendEmail } from "./enquiries.js";
import { readTime } from "./acuity/api.js";
import { fanPage } from "./fans.js";

export const AUDIENCES = ["fans", "clients", "everyone"];
const AUDIENCE_NAMES = { fans: "fans", clients: "studio clients", everyone: "fans and studio clients" };
// What the email says when someone has no `why` (they always should)
const WHY_FALLBACK = { fans: "you signed up for news from Novacane Studios", clients: "you said yes to news from Novacane Studios", everyone: "you said yes to news from Novacane Studios" };

const MAX_SUBJECT = 150;
const MAX_BODY = 20000;
// Campaigns waiting for approval at once, at most (stops a runaway AI filling the list)
const MAX_WAITING = 20;
// A campaign still 'approved' (sending) after this long was cut off part-way
const STUCK_MS = 10 * 60 * 1000;
// A send time must be at least this far ahead to be scheduled (sooner = send now)
const SCHEDULE_MIN_MS = 2 * 60 * 1000;
const MAX_AHEAD_MS = 365 * 86400000;
// Sending: this many emails a minute, this far apart (CAMPAIGN_BATCH, CAMPAIGN_GAP_MS), each address
// tried this many times at most; a batch holds the list for this long (so two never run at once)
const BATCH = 10;
const GAP_MS = 3000;
const MAX_TRIES = 3;
const LEASE_MS = 5 * 60 * 1000;
// One test email per person per this long
const TEST_GAP_MS = 30 * 1000;

const queueKey = (id) => `campaign_queue:${id}`;
const UNSUB_SECRET_KEY = "campaign_unsubscribe_secret";
const HOURLY_KEY = "campaigns_hourly_at";
const CLIENT_UNSUB_SOURCE = "Unsubscribed from a Nova email";

const nowIso = () => new Date().toISOString();
const fail = (status, error) => ({ status, error });

// ===== TIDYING WHAT COMES IN =====

function cleanText(value, max) {
  return typeof value === "string" ? value.replace(/\r\n?/g, "\n").replace(/[ \t]+\n/g, "\n").trim().slice(0, max) : "";
}

function positiveId(value) {
  const n = typeof value === "string" && /^\d{1,12}$/.test(value.trim()) ? Number(value) : value;
  return Number.isInteger(n) && n > 0 ? n : null;
}

// A send time (UTC ISO, or the UK clock "YYYY-MM-DDTHH:MM") -> { iso } (null = as soon as it's
// approved) or { problem }
function readSendAt(value) {
  if (value === undefined || value === null || value === "") return { iso: null };
  const date = readTime(String(value));
  if (!date) return { problem: 'sendAt must be a UK time "YYYY-MM-DDTHH:MM" or a UTC time (ISO 8601), or empty to send once approved.' };
  if (date.getTime() < Date.now()) return { problem: `sendAt (${ukWhen(date)}) is in the past.` };
  if (date.getTime() > Date.now() + MAX_AHEAD_MS) return { problem: "sendAt is more than a year ahead." };
  return { iso: date.toISOString() };
}

// "3 Oct 2026" (UK)
export function ukDay(iso) {
  return new Date(iso).toLocaleDateString("en-GB", { day: "numeric", month: "short", year: "numeric", timeZone: "Europe/London" });
}

// "Sun 11 Oct 2026, 14:00" (UK)
function ukWhen(iso) {
  return new Date(iso).toLocaleString("en-GB", { weekday: "short", day: "numeric", month: "short", year: "numeric", hour: "2-digit", minute: "2-digit", timeZone: "Europe/London" });
}

async function sha256Hex(text) {
  const bytes = new Uint8Array(await crypto.subtle.digest("SHA-256", new TextEncoder().encode(text)));
  return [...bytes].map((b) => b.toString(16).padStart(2, "0")).join("");
}

// The hash of exactly what an admin approves: subject, body, audience and send time
export function campaignHash(row) {
  return sha256Hex(JSON.stringify(["nova-campaign-v1", row.subject, row.body, row.audience, row.send_at || null]));
}

// ===== THE EMAIL =====

const esc = (s) => String(s).replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c]);

const LINK = /\[([^\]\n]{1,200})\]\(((?:https?:\/\/|mailto:)[^\s)]+)\)/g;
const BARE_URL = /\bhttps?:\/\/[^\s<>"']+[^\s<>"'.,;:!?)]/g;

// **bold** in already-escaped text
const bold = (html) => html.replace(/\*\*([^*\n][^*]*?)\*\*/g, "<strong>$1</strong>");

// One paragraph's text -> HTML: links ([text](https://…) and bare https://…), **bold**, line breaks
function inlineHtml(text) {
  const a = (href, label) => `<a href="${esc(href)}" style="color:#c2337a;">${label}</a>`;
  const plain = (part) =>
    bold(esc(part)).replace(BARE_URL, (url) => a(url.replace(/&amp;/g, "&"), url));
  let html = "";
  let last = 0;
  for (const m of text.matchAll(LINK)) {
    html += plain(text.slice(last, m.index)) + a(m[2], bold(esc(m[1])));
    last = m.index + m[0].length;
  }
  return (html + plain(text.slice(last))).replace(/\n/g, "<br>");
}

const paragraphs = (body) => String(body).split(/\n\s*\n/).map((p) => p.trim()).filter(Boolean);

// The footer's "why" and unsubscribe link: filled in for each person as their email is sent
const whyTag = (audience) => `{{{why|${WHY_FALLBACK[audience] || WHY_FALLBACK.everyone}}}}`;
const UNSUBSCRIBE_TAG = "{{{unsubscribe_url}}}";

// The email: Novacane Studios header, the paragraphs, and the footer (who it's from, why
// they're getting it, and their unsubscribe link). -> { html, text }
export function campaignEmail(row) {
  const why = whyTag(row.audience);
  const html = `<!doctype html><html lang="en-GB"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1"><title>${esc(row.subject)}</title></head>
<body style="margin:0;padding:0;background:#f7f5f8;">
<div style="max-width:560px;margin:0 auto;padding:28px 18px;font:16px/1.6 -apple-system,'Segoe UI',Helvetica,Arial,sans-serif;color:#1d1820;">
<div style="font-size:13px;letter-spacing:0.14em;text-transform:uppercase;font-weight:600;color:#c2337a;margin:0 4px 16px;">Novacane Studios</div>
<div style="background:#ffffff;border-radius:16px;padding:26px 24px;">
${paragraphs(row.body).map((p) => `<p style="margin:0 0 16px;">${inlineHtml(p)}</p>`).join("\n")}
</div>
<p style="font-size:13px;line-height:1.5;color:#6b6270;margin:20px 4px 0;">You're getting this because ${why}. Novacane Studios, London. Unsubscribe: <a href="${UNSUBSCRIBE_TAG}" style="color:#6b6270;">${UNSUBSCRIBE_TAG}</a></p>
</div>
</body></html>`;
  const textBody = paragraphs(row.body)
    .map((p) => p.replace(LINK, "$1 ($2)").replace(/\*\*([^*\n][^*]*?)\*\*/g, "$1"))
    .join("\n\n");
  const text = `Novacane Studios\n\n${textBody}\n\n--\nYou're getting this because ${why}. Novacane Studios, London. Unsubscribe: ${UNSUBSCRIBE_TAG}`;
  return { html, text };
}

// One person's email (and Portal's preview, and a test email): the placeholders filled in (made
// safe for HTML in the HTML version)
export function filledIn(content, { why, unsubscribe }, { html = false } = {}) {
  const safe = (v) => (html ? esc(v) : String(v));
  return content.replace(/\{\{\{why\|([^}]*)\}\}\}/g, (_, fallback) => safe(why || fallback)).split(UNSUBSCRIBE_TAG).join(safe(unsubscribe));
}

export function previewHtml(row) {
  return filledIn(campaignEmail(row).html, { why: "", unsubscribe: "#unsubscribe" }, { html: true });
}

// ===== READING =====

const SELECT = "SELECT c.*, s.display_name AS decided_by_name FROM email_campaigns c LEFT JOIN staff s ON s.id = c.decided_by";

function parseStats(value) {
  try {
    return value ? JSON.parse(value) : null;
  } catch {
    return null;
  }
}

const isStuck = (row) => row.status === "approved" && Date.now() - Date.parse(row.updated_at) > STUCK_MS;

// A campaign as Portal and Nova Agent see it
export function publicCampaign(env, row) {
  if (!row) return null;
  const stuck = isStuck(row);
  const stats = parseStats(row.stats);
  return {
    id: row.id,
    subject: row.subject,
    body: row.body,
    audience: row.audience,
    sendAt: row.send_at || null,
    status: stuck ? "failed" : row.status,
    createdBy: row.created_by,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
    submittedAt: row.submitted_at || null,
    decidedBy: row.decided_by || null,
    decidedByName: row.decided_by_name || null,
    decidedAt: row.decided_at || null,
    note: row.decision_note || null,
    recipients: row.recipients ?? null,
    sentAt: row.sent_at || null,
    error: stuck ? "It didn't finish getting ready to send (Nova Bot stopped part-way). Save it again to send it for approval again." : row.error || null,
    stats,
    // Going out now (a scheduled one whose time has come): how many have gone, of how many
    sending: row.status === "scheduled" && (!row.send_at || Date.parse(row.send_at) <= Date.now()) ? { sent: Number(stats?.sent) || 0, total: row.recipients ?? 0 } : null,
    portalUrl: `${publicUrl(env)}/portal/?view=campaigns&campaign=${row.id}`,
  };
}

async function readRow(env, id) {
  return env.DB.prepare(`${SELECT} WHERE c.id = ?`).bind(id).first();
}

export async function getCampaign(env, id) {
  return publicCampaign(env, await readRow(env, id));
}

// status: "waiting" (draft or pending approval), one status, or "all" (the default): newest
// first, the ones waiting for approval before the rest, 100 at most
export async function listCampaigns(env, { status = "all", limit = 100 } = {}) {
  const order = "ORDER BY CASE WHEN c.status IN ('draft', 'pending_approval') THEN 0 ELSE 1 END, c.id DESC LIMIT ?";
  let query;
  if (status === "waiting") query = env.DB.prepare(`${SELECT} WHERE c.status IN ('draft', 'pending_approval') ${order}`).bind(limit);
  else if (["draft", "pending_approval", "approved", "rejected", "scheduled", "sent", "failed"].includes(status)) query = env.DB.prepare(`${SELECT} WHERE c.status = ? ${order}`).bind(status, limit);
  else query = env.DB.prepare(`${SELECT} ${order}`).bind(limit);
  const { results } = await query.all();
  return results.map((row) => publicCampaign(env, row));
}

export async function campaignLog(env, id) {
  const { results } = await env.DB.prepare(
    'SELECT l.id, l.at, l.event, l."by", l.detail, s.display_name AS by_name FROM email_campaign_log l LEFT JOIN staff s ON s.id = l."by" WHERE l.campaign_id = ? ORDER BY l.id'
  )
    .bind(id)
    .all();
  return results.map((r) => ({ id: r.id, at: r.at, event: r.event, by: r.by, byName: r.by_name || null, detail: r.detail || null }));
}

const logEntry = (env, id, event, by, detail = null) =>
  env.DB.prepare('INSERT INTO email_campaign_log (campaign_id, at, event, "by", detail) VALUES (?, ?, ?, ?, ?)').bind(id, nowIso(), event, by, detail);

// How many people have opted in, per audience (fans: confirmed; clients: marketing consent yes
// with an email address; everyone: both, each address once)
export async function audienceCounts(env) {
  const row = await env.DB.prepare(
    `SELECT (SELECT COUNT(*) FROM fans WHERE status = 'confirmed') AS fans,
       (SELECT COUNT(*) FROM clients WHERE marketing_consent = 1 AND email IS NOT NULL) AS clients,
       (SELECT COUNT(*) FROM (SELECT email FROM fans WHERE status = 'confirmed' UNION SELECT email FROM clients WHERE marketing_consent = 1 AND email IS NOT NULL)) AS everyone,
       (SELECT COUNT(*) FROM fans WHERE status = 'pending') AS pending`
  ).first();
  return { fans: row.fans, clients: row.clients, everyone: row.everyone, pendingFans: row.pending };
}

// ===== WRITING AND EDITING (the AI, or any staff) =====

// Check a campaign's fields. `base` is what's saved (for an edit: only what's given changes).
// -> { subject, body, audience, send_at } or { status, error }
function checkFields(input, base = {}) {
  const has = (key) => input && Object.hasOwn(input, key) && input[key] !== undefined;
  const subject = has("subject") ? cleanText(input.subject, MAX_SUBJECT).replace(/\s*\n\s*/g, " ") : base.subject;
  const body = has("body") ? cleanText(input.body, MAX_BODY) : base.body;
  const audience = has("audience") ? input.audience : base.audience;
  if (!subject) return fail(400, "subject: the email's subject line is needed.");
  if (!body || body.length < 10) return fail(400, "body: write the email (at least a sentence).");
  if (!AUDIENCES.includes(audience)) return fail(400, `audience must be one of: ${AUDIENCES.join(", ")}.`);
  let send_at = base.send_at ?? null;
  if (has("sendAt")) {
    const when = readSendAt(input.sendAt);
    if (when.problem) return fail(400, when.problem);
    send_at = when.iso;
  }
  return { subject, body, audience, send_at };
}

// A quiet ping to the admins' phones (only theirs: they're the ones who can approve). Not to
// the person who wrote it, if that's an admin.
async function pingAdmins(env, campaign, { by, edited = false }) {
  try {
    const { results } = await env.DB.prepare("SELECT id FROM staff WHERE role = 'admin' AND status = 'active' AND id != ?").bind(String(by)).all();
    if (!results.length) return;
    const who = by === "agent" ? "Agent" : by === "staff-chat" ? "Portal's staff chat" : "A colleague";
    await notifyPhones(env, {
      title: edited ? "Email campaign changed: approve it again" : "Email campaign to approve",
      body: `${who} ${edited ? "changed" : "wrote"} "${campaign.subject}" for ${AUDIENCE_NAMES[campaign.audience]}. Nothing is sent until an admin approves it in Portal → Campaigns.`,
      url: `/portal/?view=campaigns&campaign=${campaign.id}`,
      style: { source: "portal", kind: "campaign", tag: `campaign-${campaign.id}`, ttl: 12 * 3600, urgent: false },
      to: { staff: results.map((r) => r.id) },
    });
  } catch (err) {
    console.log(`Campaign ${campaign.id}: the ping failed (${err?.message})`);
  }
}

// A new campaign, waiting for approval. by: 'agent', 'staff-chat' or a staff id.
export async function createCampaign(env, input, by) {
  const fields = checkFields(input || {});
  if (fields.error) return fields;
  const { count } = await env.DB.prepare("SELECT COUNT(*) AS count FROM email_campaigns WHERE status IN ('draft', 'pending_approval')").first();
  if (count >= MAX_WAITING) return fail(429, "There are already many campaigns waiting for approval. Ask an admin to go through them in Portal → Campaigns first.");
  const now = nowIso();
  const row = await env.DB.prepare(
    `INSERT INTO email_campaigns (subject, body, audience, send_at, status, created_by, created_at, updated_at, submitted_at)
     VALUES (?, ?, ?, ?, 'pending_approval', ?, ?, ?, ?) RETURNING id`
  )
    .bind(fields.subject, fields.body, fields.audience, fields.send_at, String(by), now, now, now)
    .first();
  await env.DB.batch([logEntry(env, row.id, "created", String(by), `For ${AUDIENCE_NAMES[fields.audience]}`), logEntry(env, row.id, "submitted", String(by))]);
  const campaign = await getCampaign(env, row.id);
  console.log(`Campaign ${row.id} written by ${by === "agent" || by === "staff-chat" ? by : "staff"}; waiting for approval`);
  await pingAdmins(env, campaign, { by });
  return { campaign };
}

// Change a campaign: back to 'pending_approval', approval cleared (a scheduled one's list is
// dropped). Sent ones, and one whose emails have started going out, can't change.
export async function editCampaign(env, by, id, input) {
  id = positiveId(id);
  if (!id) return fail(400, "Which campaign?");
  const row = await readRow(env, id);
  if (!row) return fail(404, "That campaign doesn't exist.");
  if (row.status === "sent") return fail(409, "That campaign has already been sent.");
  if (row.status === "approved" && !isStuck(row)) return fail(409, "It's being sent right now.");
  const fields = checkFields(input || {}, row);
  if (fields.error) return fields;
  const changed = ["subject", "body", "audience", "send_at"].filter((key) => (fields[key] ?? null) !== (row[key] ?? null));
  if (!changed.length && ["draft", "pending_approval", "scheduled"].includes(row.status)) return { campaign: publicCampaign(env, row), unchanged: true };

  // Scheduled: only while none of its emails have gone (and no batch is running)
  if (row.status === "scheduled") {
    const queue = await readQueue(env, id);
    if (queue && (queue.sent || queue.failed || queue.busyUntil > Date.now())) return fail(409, `It's going out right now (${queue.sent} sent so far), so it can't change.`);
  }
  const now = nowIso();
  const { meta } = await env.DB.prepare(
    `UPDATE email_campaigns SET subject = ?, body = ?, audience = ?, send_at = ?, status = 'pending_approval', approved_hash = NULL,
       decided_by = NULL, decided_at = NULL, broadcast_id = NULL, recipients = NULL, stats = NULL, error = NULL, updated_at = ?, submitted_at = ?
     WHERE id = ? AND status = ? AND updated_at = ?`
  )
    .bind(fields.subject, fields.body, fields.audience, fields.send_at, now, now, id, row.status, row.updated_at)
    .run();
  if (!meta.changes) return fail(409, "Someone else changed it at the same moment. Look at it again.");
  if (row.status === "scheduled") await env.DB.prepare("DELETE FROM settings WHERE key = ?").bind(queueKey(id)).run();
  const what = changed.length ? `Changed: ${changed.map((k) => (k === "send_at" ? "send time" : k)).join(", ")}` : "Sent for approval again";
  await env.DB.batch([
    logEntry(env, id, "edited", String(by), what + (row.status === "scheduled" ? " (it was taken back before it went)" : row.status === "rejected" ? " (after it was rejected)" : "")),
    logEntry(env, id, "submitted", String(by)),
  ]);
  const campaign = await getCampaign(env, id);
  console.log(`Campaign ${id} edited (was ${row.status}); waiting for approval again`);
  await pingAdmins(env, campaign, { by, edited: true });
  return { campaign };
}

// ===== AN ADMIN DECIDES (a person pressed a button in Portal; handleCampaignsForStaff checks who) =====

// The address campaigns come from (the studio's own domain, set as a secret)
export function campaignFrom(env) {
  return String(env.CAMPAIGN_FROM || env.ENQUIRY_REPLY_FROM || env.ENQUIRY_EMAIL_FROM || "").trim();
}

// Campaigns can go: the studio's mail server and the from address
export function campaignsReady(env) {
  return Boolean(mailReady(env) && campaignFrom(env));
}

const NOT_READY = "Email campaigns aren't set up yet: they need the studio's mail server (MAIL_API_URL and MAIL_KEY) and the from address (CAMPAIGN_FROM).";

// Approve, then send (or schedule) straight away. Only from 'pending_approval' (or 'draft').
export async function approveCampaign(env, me, { id }) {
  id = positiveId(id);
  if (!id) return fail(400, "Which campaign?");
  const row = await readRow(env, id);
  if (!row) return fail(404, "That campaign doesn't exist.");
  if (["approved", "scheduled", "sent"].includes(row.status)) return { campaign: publicCampaign(env, row), repeated: true };
  if (row.status === "rejected") return fail(409, "That campaign was rejected. Edit it to send it for approval again.");
  if (row.status === "failed") return fail(409, "That campaign didn't send. Edit it (or just save it again) to send it for approval again.");
  if (!campaignsReady(env)) return fail(409, NOT_READY);
  if (row.send_at && Date.parse(row.send_at) < Date.now()) return fail(409, `Its send time (${ukWhen(row.send_at)}) has passed. Edit the time (or clear it to send now), then approve.`);
  const counts = await audienceCounts(env);
  if (!counts[row.audience]) return fail(409, `Nobody on the ${AUDIENCE_NAMES[row.audience]} list has opted in yet, so there's no one to send it to.`);

  const hash = await campaignHash(row);
  const now = nowIso();
  // pending -> approved, once, and only as the admin saw it: a second press, or an edit in between,
  // finds it changed and approves nothing
  const { meta } = await env.DB.prepare(
    `UPDATE email_campaigns SET status = 'approved', approved_hash = ?, decided_by = ?, decided_at = ?, decision_note = NULL, error = NULL, updated_at = ?
     WHERE id = ? AND status = ? AND updated_at = ?`
  )
    .bind(hash, me.id, now, now, id, row.status, row.updated_at)
    .run();
  if (!meta.changes) {
    const latest = await readRow(env, id);
    if (latest && ["approved", "scheduled", "sent"].includes(latest.status)) return { campaign: publicCampaign(env, latest), repeated: true };
    return fail(409, "It changed while you were looking at it. Check it again, then approve.");
  }
  await logEntry(env, id, "approved", me.id, `To ${AUDIENCE_NAMES[row.audience]}${row.send_at ? `, at ${ukWhen(row.send_at)} (UK)` : ", now"}`).run();
  console.log(`Campaign ${id} approved by ${me.id}`);
  return { campaign: await sendApproved(env, id) };
}

export async function rejectCampaign(env, me, { id, note }) {
  id = positiveId(id);
  if (!id) return fail(400, "Which campaign?");
  const text = cleanText(note, 500) || null;
  const now = nowIso();
  const { meta } = await env.DB.prepare(
    `UPDATE email_campaigns SET status = 'rejected', approved_hash = NULL, decided_by = ?, decided_at = ?, decision_note = ?, updated_at = ?
     WHERE id = ? AND status IN ('draft', 'pending_approval')`
  )
    .bind(me.id, now, text, now, id)
    .run();
  if (!meta.changes) {
    const row = await readRow(env, id);
    if (!row) return fail(404, "That campaign doesn't exist.");
    return { ...fail(409, `That campaign is already ${row.status.replace("_", " ")}.`), campaign: publicCampaign(env, row) };
  }
  await logEntry(env, id, "rejected", me.id, text).run();
  console.log(`Campaign ${id} rejected by ${me.id}`);
  return { campaign: await getCampaign(env, id) };
}

// "Send me a test": the email, once, to the admin who pressed it and nobody else, marked [TEST].
// The campaign itself doesn't change.
export async function testSendCampaign(env, me, { id }) {
  id = positiveId(id);
  if (!id) return fail(400, "Which campaign?");
  const row = await readRow(env, id);
  if (!row) return fail(404, "That campaign doesn't exist.");
  if (!campaignsReady(env)) return fail(409, NOT_READY);
  const to = String(me.email || "").trim().toLowerCase();
  if (!to || !to.includes("@")) return fail(409, "Your account has no email address.");
  const key = "campaign_test_" + me.id;
  const last = await env.DB.prepare("SELECT value FROM settings WHERE key = ?").bind(key).first("value");
  if (last && Date.now() - Date.parse(last) < TEST_GAP_MS) return fail(429, "One just went. Wait half a minute before sending another.");
  await env.DB.prepare("INSERT INTO settings (key, value) VALUES (?, ?) ON CONFLICT (key) DO UPDATE SET value = excluded.value").bind(key, nowIso()).run();
  const email = campaignEmail(row);
  const fill = { why: `this is a test of campaign #${id}, sent only to you from Portal`, unsubscribe: `${publicUrl(env)}/join` };
  const result = await sendEmail(env, {
    to: [to],
    from: campaignFrom(env),
    replyTo: replyTo(env),
    subject: `[TEST] ${row.subject}`,
    text: filledIn(email.text, fill),
    html: filledIn(email.html, fill, { html: true }),
  });
  return result.ok ? { ok: true, to, message: `Test sent to ${to}. Check the inbox (and spam).` } : fail(502, result.message);
}

function replyTo(env) {
  return env.CAMPAIGN_REPLY_TO || env.ENQUIRY_REPLY_TO || emailRecipients(env)[0] || undefined;
}

// ===== SENDING =====

// Hand an approved campaign to the every-minute sender: its list (everyone on the audience who
// has opted in), and status 'scheduled'. Only status 'approved' with an approval hash that still
// matches what's saved goes on; anything else is handed back untouched (or, if it changed after
// approval, back to 'pending_approval'). Called only by the request whose press approved it.
export async function sendApproved(env, id) {
  const row = await readRow(env, id);
  if (!row || row.status !== "approved") return publicCampaign(env, row);
  const failWith = async (error) => {
    const now = nowIso();
    await env.DB.batch([
      env.DB.prepare("UPDATE email_campaigns SET status = 'failed', error = ?, updated_at = ? WHERE id = ? AND status = 'approved'").bind(error, now, id),
      logEntry(env, id, "failed", "nova", error),
    ]);
    console.log(`Campaign ${id}: failed`);
    return getCampaign(env, id);
  };

  // Exactly what was approved, or nothing
  if (!row.approved_hash || (await campaignHash(row)) !== row.approved_hash) {
    const now = nowIso();
    await env.DB.batch([
      env.DB.prepare(
        "UPDATE email_campaigns SET status = 'pending_approval', approved_hash = NULL, decided_by = NULL, decided_at = NULL, error = ?, updated_at = ? WHERE id = ? AND status = 'approved'"
      ).bind("It changed after it was approved, so it wasn't sent. Check it and approve it again.", now, id),
      logEntry(env, id, "failed", "nova", "Not sent: it changed after it was approved"),
    ]);
    console.log(`Campaign ${id}: refused, it changed after approval`);
    return getCampaign(env, id);
  }
  if (!campaignsReady(env)) return failWith(NOT_READY);
  const people = [...(await optedInPeople(env)).values()].filter((p) => inAudience(p, row.audience));
  if (!people.length) return failWith(`Nobody on the ${AUDIENCE_NAMES[row.audience]} list has opted in, so it wasn't sent.`);

  await writeSetting(env, queueKey(id), JSON.stringify({ hash: row.approved_hash, left: people.map((p) => p.email), sent: 0, failed: 0, skipped: 0, tries: {}, busyUntil: 0 }));
  const now = nowIso();
  const { meta } = await env.DB.prepare(
    "UPDATE email_campaigns SET status = 'scheduled', recipients = ?, stats = ?, error = NULL, updated_at = ? WHERE id = ? AND status = 'approved' AND approved_hash = ?"
  )
    .bind(people.length, JSON.stringify({ sent: 0, failed: 0, skipped: 0, unsubscribed: 0 }), now, id, row.approved_hash)
    .run();
  if (!meta.changes) {
    await env.DB.prepare("DELETE FROM settings WHERE key = ?").bind(queueKey(id)).run();
    return getCampaign(env, id);
  }
  const later = row.send_at && Date.parse(row.send_at) > Date.now();
  const who = `${people.length} ${people.length === 1 ? "person" : "people"} on the ${AUDIENCE_NAMES[row.audience]} list`;
  await logEntry(env, id, "scheduled", "nova", `${later ? `Goes at ${ukWhen(row.send_at)} (UK) to` : "Going out now to"} ${who}, ${batchSize(env)} a minute`).run();
  console.log(`Campaign ${id}: ${later ? "scheduled" : "going out"} to ${people.length}`);
  return getCampaign(env, id);
}

const wait = (ms) => (ms > 0 ? new Promise((resolve) => setTimeout(resolve, ms)) : Promise.resolve());
const whole = (value, fallback, min) => {
  const n = Number(value ?? fallback);
  return Number.isInteger(n) && n >= min ? n : fallback;
};
const batchSize = (env) => whole(env.CAMPAIGN_BATCH, BATCH, 1);
const gapMs = (env) => whole(env.CAMPAIGN_GAP_MS, GAP_MS, 0);

// One campaign's list as saved: the text (for swapping it safely) and what it says
async function readQueueText(env, id) {
  return readSetting(env, queueKey(id));
}
async function readQueue(env, id) {
  try {
    return JSON.parse((await readQueueText(env, id)) || "null");
  } catch {
    return null;
  }
}

// The next few emails of a campaign that's going out. Takes the list first (only if nobody else
// has it), checks everyone left is still opted in, sends with a pause between, and marks it
// 'sent' when the list is done. -> how many went
async function sendBatch(env, row) {
  const before = await readQueueText(env, row.id);
  let queue = null;
  try {
    queue = JSON.parse(before || "null");
  } catch {}
  const stop = async (error) => {
    const now = nowIso();
    await env.DB.batch([
      env.DB.prepare("UPDATE email_campaigns SET status = 'failed', error = ?, updated_at = ? WHERE id = ? AND status = 'scheduled'").bind(error, now, row.id),
      logEntry(env, row.id, "failed", "nova", error),
      env.DB.prepare("DELETE FROM settings WHERE key = ?").bind(queueKey(row.id)),
    ]);
    console.log(`Campaign ${row.id}: stopped`);
    return 0;
  };
  if (!queue || !Array.isArray(queue.left)) return stop("Its list of people went missing, so it stopped. Check who got it before sending it again.");
  if (queue.busyUntil > Date.now()) return 0;
  // Exactly what was approved, or nothing
  if (!row.approved_hash || queue.hash !== row.approved_hash || (await campaignHash(row)) !== row.approved_hash) return stop("It changed after it was approved, so it stopped.");

  // Take it: only if the list is still exactly as read (two runs can't both send)
  queue.busyUntil = Date.now() + LEASE_MS;
  const { meta } = await env.DB.prepare("UPDATE settings SET value = ? WHERE key = ? AND value = ?").bind(JSON.stringify(queue), queueKey(row.id), before).run();
  if (!meta.changes) return 0;

  const people = await optedInPeople(env);
  const email = campaignEmail(row);
  const from = campaignFrom(env);
  const reply = replyTo(env);
  const size = batchSize(env);
  const gap = gapMs(env);
  let tried = 0;
  let went = 0;
  let lastProblem = "";
  while (queue.left.length && tried < size) {
    const address = queue.left[0];
    const person = people.get(address);
    // Unsubscribed (or no longer on this audience) since the list was made: skipped
    if (!person || !inAudience(person, row.audience)) {
      queue.left.shift();
      queue.skipped++;
      continue;
    }
    if (tried) await wait(gap);
    tried++;
    const unsubscribe = await unsubscribeUrl(env, address, row.id);
    const fill = { why: person.why, unsubscribe };
    const result = await sendEmail(env, {
      to: [address],
      from,
      replyTo: reply,
      subject: row.subject,
      text: filledIn(email.text, fill),
      html: filledIn(email.html, fill, { html: true }),
      headers: { "List-Unsubscribe": `<${unsubscribe}>`, "List-Unsubscribe-Post": "List-Unsubscribe=One-Click", "List-Id": "Novacane Studios news <news.novacane.co.uk>" },
      idempotencyKey: `campaign-${row.id}-${row.approved_hash.slice(0, 12)}-${(await sha256Hex(address)).slice(0, 16)}`,
    });
    if (result.ok) {
      queue.left.shift();
      queue.sent++;
      went++;
      delete queue.tries[address];
      continue;
    }
    lastProblem = result.message || "";
    const tries = (queue.tries[address] || 0) + 1;
    // The mail server said no to this address (4xx), or it's been tried enough: it doesn't go
    if ((result.status >= 400 && result.status < 500) || tries >= MAX_TRIES) {
      queue.left.shift();
      queue.failed++;
      delete queue.tries[address];
    } else {
      queue.tries[address] = tries;
      // The mail server couldn't take it just now: the rest wait for the next minute
      break;
    }
  }

  queue.busyUntil = 0;
  const now = nowIso();
  const counts = [queue.sent, queue.failed, queue.skipped];
  if (queue.left.length) {
    await env.DB.batch([
      env.DB.prepare("UPDATE settings SET value = ? WHERE key = ?").bind(JSON.stringify(queue), queueKey(row.id)),
      env.DB.prepare("UPDATE email_campaigns SET stats = json_set(COALESCE(stats, '{}'), '$.sent', ?, '$.failed', ?, '$.skipped', ?) WHERE id = ?").bind(...counts, row.id),
    ]);
    return went;
  }
  // The list is done
  const summary = [
    `Sent to ${queue.sent} ${queue.sent === 1 ? "person" : "people"} on the ${AUDIENCE_NAMES[row.audience]} list`,
    queue.failed ? `${queue.failed} didn't go` : "",
    queue.skipped ? `${queue.skipped} unsubscribed before it reached them` : "",
  ].filter(Boolean).join("; ");
  const statements = [
    env.DB.prepare("UPDATE email_campaigns SET stats = json_set(COALESCE(stats, '{}'), '$.sent', ?, '$.failed', ?, '$.skipped', ?, '$.fetchedAt', ?) WHERE id = ?").bind(...counts, now, row.id),
    env.DB.prepare("DELETE FROM settings WHERE key = ?").bind(queueKey(row.id)),
  ];
  if (queue.sent) {
    statements.unshift(env.DB.prepare("UPDATE email_campaigns SET status = 'sent', recipients = ?, sent_at = ?, error = NULL, updated_at = ? WHERE id = ? AND status = 'scheduled'").bind(queue.sent, now, now, row.id));
    statements.push(logEntry(env, row.id, "sent", "nova", summary));
  } else {
    const error = queue.failed ? `None of its emails went (the mail server said: ${lastProblem.slice(0, 160) || "no"}).` : "Everyone on its list had unsubscribed, so nobody got it.";
    statements.unshift(env.DB.prepare("UPDATE email_campaigns SET status = 'failed', error = ?, updated_at = ? WHERE id = ? AND status = 'scheduled'").bind(error, now, row.id));
    statements.push(logEntry(env, row.id, "failed", "nova", error));
  }
  await env.DB.batch(statements);
  console.log(`Campaign ${row.id}: done (${queue.sent} sent, ${queue.failed} didn't go, ${queue.skipped} skipped)`);
  return went;
}

// ===== WHO'S ON THE LISTS, AND UNSUBSCRIBING =====

async function readSetting(env, key) {
  return env.DB.prepare("SELECT value FROM settings WHERE key = ?").bind(key).first("value");
}
async function writeSetting(env, key, value) {
  await env.DB.prepare("INSERT INTO settings (key, value) VALUES (?, ?) ON CONFLICT (key) DO UPDATE SET value = excluded.value").bind(key, value).run();
}

// Everyone who has opted in, by email: { email, firstName, lastName, fan, client, why }.
async function optedInPeople(env) {
  const [fans, clients] = await env.DB.batch([
    env.DB.prepare("SELECT email, name, confirmed_at FROM fans WHERE status = 'confirmed'"),
    env.DB.prepare(
      `SELECT c.email, c.name, c.consent_at,
         (SELECT MAX(l.id) FROM client_consent_log l WHERE l.client_id = c.id AND l.consent = 1) AS yes_id
       FROM clients c WHERE c.marketing_consent = 1 AND c.email IS NOT NULL`
    ),
  ]);
  const people = new Map();
  const person = (email) => {
    const key = String(email).trim().toLowerCase();
    if (!people.has(key)) people.set(key, { email: key, name: "", fan: null, client: null });
    return people.get(key);
  };
  for (const f of fans.results) Object.assign(person(f.email), { fan: f, name: f.name || "" });
  for (const c of clients.results) {
    const p = person(c.email);
    p.client = c;
    if (!p.name) p.name = c.name || "";
  }
  for (const p of people.values()) {
    const [firstName, ...rest] = String(p.name).trim().split(/\s+/);
    p.firstName = firstName || "";
    p.lastName = rest.join(" ");
    // One reason per person (the same on every list): signing up as a fan, else their yes as a client
    p.why = p.fan
      ? `you signed up for Novacane Studios news on ${ukDay(p.fan.confirmed_at)}`
      : `you said yes to studio news from Novacane Studios on ${ukDay(p.client.consent_at || nowIso())}`;
  }
  return people;
}

const inAudience = (p, audience) => (audience === "fans" ? Boolean(p.fan) : audience === "clients" ? Boolean(p.client) : Boolean(p.fan || p.client));

// Someone unsubscribed (the link in a campaign, or their email app's Unsubscribe button): a fan
// becomes 'unsubscribed'; a client's marketing consent goes to NO, written in their consent log
// (by 'customer'). -> how many records changed
export async function markUnsubscribed(env, email) {
  const address = String(email || "").trim().toLowerCase();
  if (!address) return 0;
  const now = nowIso();
  let changed = 0;
  const fan = await env.DB.prepare("UPDATE fans SET status = 'unsubscribed', unsubscribed_at = ? WHERE email = ? AND status = 'confirmed'").bind(now, address).run();
  changed += fan.meta.changes;
  const { results } = await env.DB.prepare(
    `UPDATE clients SET marketing_consent = 0, consent_at = ?, consent_source = ?, consent_by = 'customer', updated_at = ?, updated_by = 'customer'
     WHERE email = ? AND marketing_consent = 1 RETURNING id`
  )
    .bind(now, CLIENT_UNSUB_SOURCE, now, address)
    .all();
  if (results.length) {
    await env.DB.batch(
      results.map((c) => env.DB.prepare('INSERT INTO client_consent_log (client_id, consent, at, source, "by", recorded_at) VALUES (?, 0, ?, ?, \'customer\', ?)').bind(c.id, now, CLIENT_UNSUB_SOURCE, now))
    );
  }
  return changed + results.length;
}

// The secret the unsubscribe links are signed with: made once, kept in settings
async function unsubscribeSecret(env) {
  let secret = await readSetting(env, UNSUB_SECRET_KEY);
  if (!secret) {
    const fresh = [...crypto.getRandomValues(new Uint8Array(32))].map((b) => b.toString(16).padStart(2, "0")).join("");
    await env.DB.prepare("INSERT OR IGNORE INTO settings (key, value) VALUES (?, ?)").bind(UNSUB_SECRET_KEY, fresh).run();
    secret = await readSetting(env, UNSUB_SECRET_KEY);
  }
  return secret;
}

async function unsubscribeSignature(env, address, id) {
  const key = await crypto.subtle.importKey("raw", new TextEncoder().encode(await unsubscribeSecret(env)), { name: "HMAC", hash: "SHA-256" }, false, ["sign"]);
  const sig = new Uint8Array(await crypto.subtle.sign("HMAC", key, new TextEncoder().encode(`nova-unsubscribe-v1|${address}|${id}`)));
  return [...sig.slice(0, 16)].map((b) => b.toString(16).padStart(2, "0")).join("");
}

const toBase64Url = (text) => btoa(String.fromCharCode(...new TextEncoder().encode(text))).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
function fromBase64Url(text) {
  try {
    const bin = atob(String(text).replace(/-/g, "+").replace(/_/g, "/"));
    return new TextDecoder().decode(Uint8Array.from(bin, (c) => c.charCodeAt(0)));
  } catch {
    return "";
  }
}

// One person's unsubscribe link for one campaign (signed: it only works for that address)
export async function unsubscribeUrl(env, address, id) {
  const email = String(address).trim().toLowerCase();
  return `${publicUrl(env)}/unsubscribe?e=${toBase64Url(email)}&c=${id}&s=${await unsubscribeSignature(env, email, id)}`;
}

// /unsubscribe?e=…&c=…&s=…: opening the link asks first (a Confirm button, so a link scanner can't
// unsubscribe anyone); pressing it, or an email app's one-click Unsubscribe (a POST to the same
// address, RFC 8058), unsubscribes them from the studio's news
export async function handleUnsubscribe(request, env) {
  const press = request.method === "POST";
  if (!press && request.method !== "GET" && request.method !== "HEAD") return new Response("Method not allowed", { status: 405, headers: { Allow: "GET, POST" } });
  const url = new URL(request.url);
  const read = { e: url.searchParams.get("e") || "", c: url.searchParams.get("c") || "", s: url.searchParams.get("s") || "" };
  if (press) {
    try {
      const form = await request.formData();
      for (const k of ["e", "c", "s"]) if (form.get(k)) read[k] = String(form.get(k));
    } catch {}
  }
  const address = fromBase64Url(read.e).trim().toLowerCase();
  const id = /^\d{1,12}$/.test(read.c) ? Number(read.c) : 0;
  const good = address.includes("@") && id > 0 && /^[0-9a-f]{32}$/.test(read.s) && read.s === (await unsubscribeSignature(env, address, id));
  if (!good) return fanPage("That link doesn't work", "It may have been copied wrongly. To stop getting news from Novacane Studios, reply to any of our emails and say so.", {}, 404);
  if (!press) {
    const hidden = (k) => `<input type="hidden" name="${k}" value="${esc(read[k])}">`;
    return fanPage("Unsubscribe?", "Press the button and you won't get news emails from Novacane Studios any more.", { form: `<form method="post" action="/unsubscribe">${hidden("e")}${hidden("c")}${hidden("s")}<button type="submit">Unsubscribe</button></form>` });
  }
  const changed = await markUnsubscribed(env, address);
  if (changed) {
    await env.DB.prepare("UPDATE email_campaigns SET stats = json_set(COALESCE(stats, '{}'), '$.unsubscribed', COALESCE(json_extract(stats, '$.unsubscribed'), 0) + 1) WHERE id = ?").bind(id).run();
    console.log(`Campaign ${id}: someone unsubscribed`);
  }
  return fanPage("You're unsubscribed", "You won't get news emails from Novacane Studios any more. Changed your mind? You can sign up again any time.", { link: true });
}

// ===== EVERY MINUTE (index.js's cron) =====

// Campaigns going out (scheduled ones whose time has come): the next batch of each. Every hour:
// old sign-up counters cleared.
export async function campaignsOnSchedule(env, at = Date.now()) {
  if (!campaignsReady(env)) return null;
  const { results } = await env.DB.prepare(`${SELECT} WHERE c.status = 'scheduled' AND (c.send_at IS NULL OR c.send_at <= ?) ORDER BY c.id`).bind(new Date(at).toISOString()).all();
  let sent = 0;
  for (const row of results) {
    sent += await sendBatch(env, row).catch((err) => {
      console.log(`Campaign ${row.id}: a batch failed (${err?.name})`);
      return 0;
    });
  }
  const last = await readSetting(env, HOURLY_KEY);
  if (last && at - Date.parse(last) < 3600000) return { sent, hourly: false };
  await writeSetting(env, HOURLY_KEY, new Date(at).toISOString());
  await env.DB.prepare("DELETE FROM settings WHERE key LIKE 'fan_signup:%' AND key < ?").bind(`fan_signup:${Math.floor(at / 3600000) - 1}`).run();
  return { sent, hourly: true };
}

// ===== FOR NOVA AGENT'S suggest_campaign =====

export async function campaignContext(env) {
  const [audiences, recent] = await Promise.all([audienceCounts(env), env.DB.prepare(`${SELECT} ORDER BY c.id DESC LIMIT 5`).all()]);
  return {
    audiences: { fans: audiences.fans, clients: audiences.clients, everyone: audiences.everyone },
    recent: recent.results.map((row) => publicCampaign(env, row)),
    today: new Date().toLocaleDateString("en-CA", { timeZone: "Europe/London" }),
  };
}

// ===== ROUTES =====

// Approve, reject and test-send: an admin with Portal open in a browser (the cookie), never an
// app's token, other staff, or Nova Agent's key
const canDecide = (me) => me.role === "admin" && me.session_kind === "cookie";

// Portal's /app/api/campaigns… (src/app-page.js has already checked the sign-in and the Origin).
// -> a Response, or null
export async function handleCampaignsForStaff(request, env, me, route) {
  const url = new URL(request.url);
  if (route === "/campaigns" && request.method === "GET") {
    const counts = await audienceCounts(env);
    return json({
      campaigns: await listCampaigns(env, { status: url.searchParams.get("status") || "all" }),
      canDecide: canDecide(me),
      audiences: { fans: counts.fans, clients: counts.clients, everyone: counts.everyone },
      pendingFans: counts.pendingFans,
      signupUrl: `${publicUrl(env)}/join`,
      ready: campaignsReady(env),
    });
  }
  // The email as its own little page, for Portal's preview frame: Portal's own rules block the
  // email's inline styles, so the preview gets rules of its own (styles only: no scripts, nothing else)
  const preview = route.match(/^\/campaigns\/(\d{1,12})\/preview$/);
  if (preview && request.method === "GET") {
    const row = await readRow(env, Number(preview[1]));
    if (!row) return json({ error: "That campaign doesn't exist." }, 404);
    return new Response(previewHtml(row), {
      headers: {
        "Content-Type": "text/html; charset=utf-8",
        "Cache-Control": "no-store",
        "Content-Security-Policy": "default-src 'none'; style-src 'unsafe-inline'; img-src https: data:; frame-ancestors 'self'; sandbox",
        "X-Frame-Options": "SAMEORIGIN",
        "Referrer-Policy": "no-referrer",
      },
    });
  }
  const one = route.match(/^\/campaigns\/(\d{1,12})$/);
  if (one && request.method === "GET") {
    const row = await readRow(env, Number(one[1]));
    if (!row) return json({ error: "That campaign doesn't exist." }, 404);
    return json({ campaign: publicCampaign(env, row), log: await campaignLog(env, row.id), previewHtml: previewHtml(row) });
  }
  if (request.method !== "POST") return null;
  if (route === "/campaigns") return answer(await createCampaign(env, await readJson(request), me.id));
  const edit = route.match(/^\/campaigns\/(\d{1,12})\/edit$/);
  if (edit) return answer(await editCampaign(env, me.id, Number(edit[1]), await readJson(request)));

  const decide = route.match(/^\/campaigns\/(\d{1,12})\/(approve|reject)$/);
  if (!decide && route !== "/campaigns/test-send") return null;
  if (!canDecide(me)) {
    return json({ error: "Only an admin, with Portal open in a browser and signed in, can approve, reject or test-send a campaign.", onlineUrl: `${publicUrl(env)}/portal/?view=campaigns` }, 403);
  }
  const body = await readJson(request);
  if (route === "/campaigns/test-send") return answer(await testSendCampaign(env, me, { id: body.id }));
  if (decide[2] === "approve") return answer(await approveCampaign(env, me, { id: Number(decide[1]) }));
  return answer(await rejectCampaign(env, me, { id: Number(decide[1]), note: body.note }));
}

// Nova Agent's /nova-agent/campaigns… (src/agent-nova.js has already checked the key). Read,
// write and edit only: there is no approve, send, schedule or test-send for the agent's key.
export async function handleCampaignsForAgent(env, pathname, body) {
  if (pathname === "/nova-agent/campaigns/context") return json(await campaignContext(env));
  if (pathname === "/nova-agent/campaigns/draft") {
    // Only these fields are read: a status, hash or approver sent along is ignored
    return answer(await createCampaign(env, { subject: body?.subject, body: body?.body, audience: body?.audience, sendAt: body?.sendAt }, "agent"));
  }
  if (pathname === "/nova-agent/campaigns") return json({ campaigns: await listCampaigns(env, { status: typeof body?.status === "string" ? body.status : "all", limit: 50 }) });
  const one = pathname.match(/^\/nova-agent\/campaigns\/(\d{1,12})$/);
  if (one) {
    const campaign = await getCampaign(env, Number(one[1]));
    return campaign ? json({ campaign, log: await campaignLog(env, campaign.id) }) : json({ error: "That campaign doesn't exist." }, 404);
  }
  const edit = pathname.match(/^\/nova-agent\/campaigns\/(\d{1,12})\/edit$/);
  if (edit) {
    const changes = {};
    for (const key of ["subject", "body", "audience", "sendAt"]) if (body && Object.hasOwn(body, key)) changes[key] = body[key];
    return answer(await editCampaign(env, "agent", Number(edit[1]), changes));
  }
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

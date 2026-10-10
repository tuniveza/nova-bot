// Email campaigns (Quest 3): newsletters to fans and studio clients, on Resend, only after an
// admin approves them (migrations/0025_email_campaigns.sql)
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
// audience, send time). The sender sends only from status 'approved' with a matching hash; any
// edit puts the campaign back to 'pending_approval' with the approval cleared (a scheduled one is
// cancelled in Resend first).
//
// The sender: puts the audience's opted-in people into its Resend segment (and everyone else
// out), makes the broadcast, and sends it now or schedules it for send_at -> 'sent' or
// 'scheduled' (or 'failed', with the reason).
//
// Who's on the lists (UK GDPR / PECR): confirmed fans (the /join page, double opt-in) and
// clients with marketing_consent = 1. Every email says who it's from and why they're getting it
// (a contact property, `why`, set when they're put into Resend) and has Resend's unsubscribe
// link. Unsubscribes come back every hour: a fan becomes 'unsubscribed'; a client's consent goes
// to NO with a client_consent_log entry (by 'customer').
//
// Every minute (index.js): scheduled campaigns whose time has come become 'sent' once Resend
// says so. Every hour: unsubscribes come back, scheduled campaigns' lists are brought up to
// date, and the numbers (delivered, opened, clicked…) are refreshed for campaigns sent in the
// last 14 days.
//
// Logs say ids and counts only, never anyone's details or a key. Times are UTC; emails and
// Portal show UK time.

import { notifyPhones } from "./push.js";
import { publicUrl } from "./nova/booking.js";
import { emailRecipients, sendEmail } from "./enquiries.js";
import { readTime } from "./acuity/api.js";
import { ResendError, listAll, marketingKey, resendApi, resendReason } from "./resend-marketing.js";

export const AUDIENCES = ["fans", "clients", "everyone"];
const AUDIENCE_NAMES = { fans: "fans", clients: "studio clients", everyone: "fans and studio clients" };
const SEGMENT_NAMES = { fans: "Nova · Fans", clients: "Nova · Studio clients", everyone: "Nova · Everyone" };
// What the email says when a contact has no `why` (it always should)
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
// The numbers are refreshed for campaigns sent this recently, counting at most this many per kind
const STATS_DAYS = 14;
const STATS_CAP = 2000;
const STAT_TYPES = ["sent", "delivered", "opened", "clicked", "bounced", "unsubscribed", "complained"];
// One test email per person per this long
const TEST_GAP_MS = 30 * 1000;

const RESEND_SETUP_KEY = "campaign_resend";
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

// The footer's "why", as Resend fills it in from the contact's `why` property
const whyTag = (audience) => `{{{contact.why|${WHY_FALLBACK[audience] || WHY_FALLBACK.everyone}}}}`;
const UNSUBSCRIBE_TAG = "{{{RESEND_UNSUBSCRIBE_URL}}}";

// The email: Novacane Studios header, the paragraphs, and the footer (who it's from, why
// they're getting it, and Resend's unsubscribe link). -> { html, text }
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

// The email as Portal previews it (and a test email): the placeholders filled in
function filledIn(content, { why, unsubscribe }) {
  return content.replace(/\{\{\{contact\.why\|([^}]*)\}\}\}/g, (_, fallback) => why || fallback).split(UNSUBSCRIBE_TAG).join(unsubscribe);
}

export function previewHtml(row) {
  return filledIn(campaignEmail(row).html, { why: "", unsubscribe: "#unsubscribe" });
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
    error: stuck ? "It didn't finish sending (Nova Bot stopped part-way). Check Resend's Broadcasts before sending it again." : row.error || null,
    stats: parseStats(row.stats),
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

// Change a campaign: back to 'pending_approval', approval cleared. A scheduled one is cancelled
// in Resend first (if Resend won't, nothing changes). Sent ones, and one being sent right now,
// can't change.
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

  // Scheduled in Resend: take it back first
  if (row.status === "scheduled" && row.broadcast_id) {
    let answer;
    try {
      answer = await resendApi(env, "DELETE", `/broadcasts/${encodeURIComponent(row.broadcast_id)}`);
    } catch (err) {
      return fail(503, `${err.message} It's still scheduled; try the change again in a minute.`);
    }
    if (!answer.ok && answer.status !== 404) return fail(409, `Resend wouldn't cancel the scheduled send, so nothing changed. ${resendReason(answer)}`);
  }
  const now = nowIso();
  const { meta } = await env.DB.prepare(
    `UPDATE email_campaigns SET subject = ?, body = ?, audience = ?, send_at = ?, status = 'pending_approval', approved_hash = NULL,
       decided_by = NULL, decided_at = NULL, broadcast_id = NULL, recipients = NULL, error = NULL, updated_at = ?, submitted_at = ?
     WHERE id = ? AND status = ? AND updated_at = ?`
  )
    .bind(fields.subject, fields.body, fields.audience, fields.send_at, now, now, id, row.status, row.updated_at)
    .run();
  if (!meta.changes) return fail(409, "Someone else changed it at the same moment. Look at it again.");
  const what = changed.length ? `Changed: ${changed.map((k) => (k === "send_at" ? "send time" : k)).join(", ")}` : "Sent for approval again";
  await env.DB.batch([
    logEntry(env, id, "edited", String(by), what + (row.status === "scheduled" ? " (the scheduled send was cancelled)" : row.status === "rejected" ? " (after it was rejected)" : "")),
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

// Resend is set up for campaigns: a key and the from address
export function campaignsReady(env) {
  return Boolean(marketingKey(env) && campaignFrom(env));
}

const NOT_READY = "Email campaigns aren't set up yet: they need a full-access Resend key (RESEND_MARKETING_KEY) and the from address (CAMPAIGN_FROM).";

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
  if (!env.RESEND_API_KEY && !marketingKey(env)) return fail(409, NOT_READY);
  const to = String(me.email || "").trim().toLowerCase();
  if (!to || !to.includes("@")) return fail(409, "Your account has no email address.");
  const key = "campaign_test_" + me.id;
  const last = await env.DB.prepare("SELECT value FROM settings WHERE key = ?").bind(key).first("value");
  if (last && Date.now() - Date.parse(last) < TEST_GAP_MS) return fail(429, "One just went. Wait half a minute before sending another.");
  await env.DB.prepare("INSERT INTO settings (key, value) VALUES (?, ?) ON CONFLICT (key) DO UPDATE SET value = excluded.value").bind(key, nowIso()).run();
  const email = campaignEmail(row);
  const fill = { why: `this is a test of campaign #${id}, sent only to you from Portal`, unsubscribe: `${publicUrl(env)}/join` };
  const result = await sendEmail(
    { ...env, RESEND_API_KEY: env.RESEND_API_KEY || marketingKey(env) },
    {
      to: [to],
      from: campaignFrom(env) || undefined,
      replyTo: replyTo(env),
      subject: `[TEST] ${row.subject}`,
      text: filledIn(email.text, fill),
      html: filledIn(email.html, fill),
    }
  );
  return result.ok ? { ok: true, to, message: `Test sent to ${to}. Check the inbox (and spam).` } : fail(502, result.message);
}

function replyTo(env) {
  return env.CAMPAIGN_REPLY_TO || env.ENQUIRY_REPLY_TO || emailRecipients(env)[0] || undefined;
}

// ===== SENDING =====

// Send (or schedule) an approved campaign. Only status 'approved' with an approval hash that
// still matches what's saved goes; anything else is handed back untouched (or, if it changed
// after approval, back to 'pending_approval'). Called only by the request whose press approved it.
export async function sendApproved(env, id) {
  const row = await readRow(env, id);
  if (!row || row.status !== "approved") return publicCampaign(env, row);
  const failWith = async (error, { keepBroadcast = false } = {}) => {
    const now = nowIso();
    await env.DB.batch([
      env.DB.prepare(`UPDATE email_campaigns SET status = 'failed', error = ?, ${keepBroadcast ? "" : "broadcast_id = NULL, "}updated_at = ? WHERE id = ? AND status = 'approved'`).bind(error, now, id),
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
  if (row.broadcast_id) return publicCampaign(env, row);
  if (!campaignsReady(env)) return failWith(NOT_READY);
  const scheduleAt = row.send_at && Date.parse(row.send_at) > Date.now() + SCHEDULE_MIN_MS ? row.send_at : null;

  let broadcastId = null;
  try {
    const setup = await resendSetup(env);
    const recipients = await syncAudience(env, row.audience, setup);
    if (!recipients) return failWith(`Nobody on the ${AUDIENCE_NAMES[row.audience]} list has opted in, so it wasn't sent.`);
    const { html, text } = campaignEmail(row);
    const created = await resendApi(env, "POST", "/broadcasts", {
      segment_id: setup.segments[row.audience],
      from: campaignFrom(env),
      subject: row.subject,
      html,
      text,
      name: `Nova #${id}: ${row.subject}`.slice(0, 200),
      ...(replyTo(env) ? { reply_to: replyTo(env) } : {}),
    });
    if (!created.ok || !created.data.id) return failWith(`Resend didn't make the broadcast. ${resendReason(created)}`);
    broadcastId = String(created.data.id);
    // Claim it: only one broadcast per approval, and only while what's saved is still what was approved
    const { meta } = await env.DB.prepare("UPDATE email_campaigns SET broadcast_id = ?, updated_at = ? WHERE id = ? AND status = 'approved' AND broadcast_id IS NULL AND approved_hash = ?")
      .bind(broadcastId, nowIso(), id, row.approved_hash)
      .run();
    const latest = await readRow(env, id);
    if (!meta.changes || !latest || (await campaignHash(latest)) !== row.approved_hash) {
      await resendApi(env, "DELETE", `/broadcasts/${encodeURIComponent(broadcastId)}`).catch(() => null);
      return getCampaign(env, id);
    }
    let sent;
    try {
      sent = await resendApi(env, "POST", `/broadcasts/${encodeURIComponent(broadcastId)}/send`, scheduleAt ? { scheduled_at: scheduleAt } : {});
    } catch (err) {
      return failWith(`${err.message} It may or may not have gone: check Resend's Broadcasts before sending it again.`, { keepBroadcast: true });
    }
    if (!sent.ok) {
      await resendApi(env, "DELETE", `/broadcasts/${encodeURIComponent(broadcastId)}`).catch(() => null);
      return failWith(`Resend didn't send it. ${resendReason(sent)}`);
    }
    const now = nowIso();
    await env.DB.batch([
      env.DB.prepare("UPDATE email_campaigns SET status = ?, recipients = ?, sent_at = ?, error = NULL, updated_at = ? WHERE id = ? AND status = 'approved'").bind(
        scheduleAt ? "scheduled" : "sent",
        recipients,
        scheduleAt ? null : now,
        now,
        id
      ),
      logEntry(env, id, scheduleAt ? "scheduled" : "sent", "nova", `${scheduleAt ? `Scheduled for ${ukWhen(scheduleAt)} (UK), to` : "Sent to"} ${recipients} ${recipients === 1 ? "person" : "people"} on the ${AUDIENCE_NAMES[row.audience]} list (${SEGMENT_NAMES[row.audience]})`),
    ]);
    console.log(`Campaign ${id}: ${scheduleAt ? "scheduled" : "sent"} to ${recipients}`);
    return getCampaign(env, id);
  } catch (err) {
    if (broadcastId) await resendApi(env, "DELETE", `/broadcasts/${encodeURIComponent(broadcastId)}`).catch(() => null);
    return failWith(err instanceof ResendError ? err.message : "Something went wrong sending it.");
  }
}

// ===== RESEND: SEGMENTS, CONTACTS, UNSUBSCRIBES =====

async function readSetting(env, key) {
  return env.DB.prepare("SELECT value FROM settings WHERE key = ?").bind(key).first("value");
}
async function writeSetting(env, key, value) {
  await env.DB.prepare("INSERT INTO settings (key, value) VALUES (?, ?) ON CONFLICT (key) DO UPDATE SET value = excluded.value").bind(key, value).run();
}

// The three segments ("Nova · Fans", "Nova · Studio clients", "Nova · Everyone") and the contact
// properties (why, nova_optin), made once; their ids are kept in settings
export async function resendSetup(env) {
  let saved = null;
  try {
    saved = JSON.parse((await readSetting(env, RESEND_SETUP_KEY)) || "null");
  } catch {}
  if (saved?.segments && AUDIENCES.every((a) => saved.segments[a]) && saved.properties) return saved;

  const segments = { ...(saved?.segments || {}) };
  if (!AUDIENCES.every((a) => segments[a])) {
    const existing = await resendApi(env, "GET", "/segments");
    if (!existing.ok) throw new ResendError(`Resend's segments couldn't be read. ${resendReason(existing)}`, existing.status);
    const list = Array.isArray(existing.data.data) ? existing.data.data : [];
    for (const audience of AUDIENCES) {
      if (segments[audience]) continue;
      const found = list.find((s) => s.name === SEGMENT_NAMES[audience]);
      if (found) {
        segments[audience] = found.id;
        continue;
      }
      const made = await resendApi(env, "POST", "/segments", { name: SEGMENT_NAMES[audience] });
      if (!made.ok || !made.data.id) throw new ResendError(`Resend didn't make the "${SEGMENT_NAMES[audience]}" segment. ${resendReason(made)}`, made.status);
      segments[audience] = made.data.id;
    }
  }
  // The contact properties the emails and the sync use (already there is fine)
  for (const [key, fallback] of [["why", WHY_FALLBACK.everyone], ["nova_optin", ""]]) {
    const made = await resendApi(env, "POST", "/contact-properties", { key, type: "string", ...(fallback ? { fallback_value: fallback } : {}) });
    if (!made.ok && ![409, 422].includes(made.status)) throw new ResendError(`Resend didn't make the "${key}" contact property. ${resendReason(made)}`, made.status);
  }
  const setup = { segments, properties: true };
  await writeSetting(env, RESEND_SETUP_KEY, JSON.stringify(setup));
  return setup;
}

// Everyone who has opted in, by email: { email, firstName, lastName, fan, client, why, stamp }.
// `stamp` changes whenever they opt in again (a fan confirming, a client's consent recorded as
// yes), so an unsubscribe in Resend is never undone except by a newer opt-in.
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
    // One reason per person (the same in every segment): signing up as a fan, else their yes as a client
    p.why = p.fan
      ? `you signed up for Novacane Studios news on ${ukDay(p.fan.confirmed_at)}`
      : `you said yes to studio news from Novacane Studios on ${ukDay(p.client.consent_at || nowIso())}`;
    p.stamp = `f:${p.fan?.confirmed_at || ""}|c:${p.client ? p.client.yes_id || p.client.consent_at || "" : ""}`;
  }
  return people;
}

const inAudience = (p, audience) => (audience === "fans" ? Boolean(p.fan) : audience === "clients" ? Boolean(p.client) : Boolean(p.fan || p.client));

// Someone unsubscribed in Resend: a fan becomes 'unsubscribed'; a client's marketing consent goes
// to NO, written in their consent log (by 'customer'). -> how many records changed
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

const propertyValue = (contact, key) => {
  const p = contact?.properties?.[key];
  return p && typeof p === "object" ? (p.value ?? null) : (p ?? null);
};

// A contact Resend says is unsubscribed, who's opted in here. If they opted in again since they
// were put into Resend (their stamp is newer), they're subscribed again; otherwise the
// unsubscribe comes back here. -> "resubscribed" or "unsubscribed"
async function settleUnsubscribed(env, contactRef, person) {
  const got = await resendApi(env, "GET", `/contacts/${encodeURIComponent(contactRef)}`);
  if (!got.ok) throw new ResendError(`A contact couldn't be read from Resend. ${resendReason(got)}`, got.status);
  const pushed = propertyValue(got.data, "nova_optin");
  if (pushed && person.stamp !== pushed) {
    const patched = await resendApi(env, "PATCH", `/contacts/${encodeURIComponent(contactRef)}`, { unsubscribed: false, properties: { why: person.why, nova_optin: person.stamp } });
    if (!patched.ok) throw new ResendError(`A contact couldn't be updated in Resend. ${resendReason(patched)}`, patched.status);
    return "resubscribed";
  }
  await markUnsubscribed(env, person.email);
  return "unsubscribed";
}

// Read the three segments from Resend, and bring unsubscribes back. -> { contacts: Map email ->
// { id, unsubscribed, segments: Set }, unsubscribed, resubscribed }
export async function pullUnsubscribes(env, setup) {
  const contacts = new Map();
  for (const audience of AUDIENCES) {
    const { items } = await listAll(env, `/contacts?segment_id=${encodeURIComponent(setup.segments[audience])}`);
    for (const c of items) {
      const email = String(c.email || "").trim().toLowerCase();
      if (!email) continue;
      if (!contacts.has(email)) contacts.set(email, { id: c.id, unsubscribed: c.unsubscribed === true, segments: new Set() });
      contacts.get(email).segments.add(setup.segments[audience]);
    }
  }
  const people = await optedInPeople(env);
  let unsubscribed = 0;
  let resubscribed = 0;
  for (const [email, c] of contacts) {
    if (!c.unsubscribed) continue;
    const person = people.get(email);
    if (!person) continue; // already off the lists here
    if ((await settleUnsubscribed(env, c.id || email, person)) === "resubscribed") {
      c.unsubscribed = false;
      resubscribed++;
    } else unsubscribed++;
  }
  if (unsubscribed || resubscribed) console.log(`Campaigns: ${unsubscribed} unsubscribe(s) came back from Resend, ${resubscribed} re-subscribed after opting in again`);
  return { contacts, unsubscribed, resubscribed };
}

// Put an audience's opted-in people into its segment, and everyone else out. -> how many are in
// it (subscribed) now
export async function syncAudience(env, audience, setup) {
  const segmentId = setup.segments[audience];
  const { contacts } = await pullUnsubscribes(env, setup);
  const people = await optedInPeople(env);
  const wanted = [...people.values()].filter((p) => inAudience(p, audience));
  const wantedEmails = new Set(wanted.map((p) => p.email));
  let added = 0;
  let removed = 0;

  // Out: anyone in the segment who hasn't opted in (any more)
  for (const [email, c] of contacts) {
    if (!c.segments.has(segmentId) || wantedEmails.has(email)) continue;
    const out = await resendApi(env, "DELETE", `/contacts/${encodeURIComponent(c.id)}/segments/${encodeURIComponent(segmentId)}`);
    if (!out.ok && out.status !== 404) throw new ResendError(`Someone couldn't be taken off the list in Resend. ${resendReason(out)}`, out.status);
    c.segments.delete(segmentId);
    removed++;
  }

  // In: opted-in people not in it yet
  let count = 0;
  for (const p of wanted) {
    const known = contacts.get(p.email);
    if (known?.segments.has(segmentId)) {
      if (!known.unsubscribed) count++;
      continue;
    }
    let contactRef = known?.id || null;
    if (!contactRef) {
      const made = await resendApi(env, "POST", "/contacts", {
        email: p.email,
        ...(p.firstName ? { first_name: p.firstName } : {}),
        ...(p.lastName ? { last_name: p.lastName } : {}),
        segments: [{ id: segmentId }],
        properties: { why: p.why, nova_optin: p.stamp },
      });
      if (made.ok) {
        added++;
        count++;
        continue;
      }
      if (![409, 422].includes(made.status)) throw new ResendError(`Someone couldn't be added to the list in Resend. ${resendReason(made)}`, made.status);
      // Already a contact (outside these segments): look at them first
      const got = await resendApi(env, "GET", `/contacts/${encodeURIComponent(p.email)}`);
      if (!got.ok) throw new ResendError(`A contact couldn't be read from Resend. ${resendReason(got)}`, got.status);
      contactRef = got.data.id || p.email;
      if (got.data.unsubscribed === true && (await settleUnsubscribed(env, contactRef, p)) === "unsubscribed") continue;
      const patched = await resendApi(env, "PATCH", `/contacts/${encodeURIComponent(contactRef)}`, { properties: { why: p.why, nova_optin: p.stamp } });
      if (!patched.ok) throw new ResendError(`A contact couldn't be updated in Resend. ${resendReason(patched)}`, patched.status);
    } else if (known.unsubscribed) continue; // settled by pullUnsubscribes: they stay out
    const added1 = await resendApi(env, "POST", `/contacts/${encodeURIComponent(contactRef)}/segments/${encodeURIComponent(segmentId)}`);
    if (!added1.ok && added1.status !== 409) throw new ResendError(`Someone couldn't be added to the list in Resend. ${resendReason(added1)}`, added1.status);
    added++;
    count++;
  }
  if (added || removed) console.log(`Campaigns: ${audience} list synced (+${added}, -${removed}, ${count} in it)`);
  return count;
}

// ===== EVERY MINUTE AND EVERY HOUR (index.js's cron) =====

// Scheduled campaigns whose time has come: 'sent' once Resend says so
export async function checkScheduled(env, at = Date.now()) {
  const { results } = await env.DB.prepare("SELECT id, broadcast_id, send_at FROM email_campaigns WHERE status = 'scheduled' AND send_at <= ? AND broadcast_id IS NOT NULL").bind(new Date(at).toISOString()).all();
  let done = 0;
  for (const c of results) {
    const answer = await resendApi(env, "GET", `/broadcasts/${encodeURIComponent(c.broadcast_id)}`);
    if (!answer.ok) continue;
    const status = String(answer.data.status || "");
    const now = nowIso();
    if (status === "sent") {
      await env.DB.batch([
        env.DB.prepare("UPDATE email_campaigns SET status = 'sent', sent_at = ?, updated_at = ? WHERE id = ? AND status = 'scheduled'").bind(resendTime(answer.data.sent_at) || c.send_at, now, c.id),
        logEntry(env, c.id, "sent", "resend", "Resend sent it at the scheduled time"),
      ]);
      done++;
    } else if (status === "canceled" || status === "cancelled" || status === "failed") {
      await env.DB.batch([
        env.DB.prepare("UPDATE email_campaigns SET status = 'failed', error = ?, updated_at = ? WHERE id = ? AND status = 'scheduled'").bind(`Resend says the broadcast was ${status}.`, now, c.id),
        logEntry(env, c.id, "failed", "resend", `Resend says the broadcast was ${status}`),
      ]);
    }
  }
  return done;
}

// A time as Resend writes it ("2026-10-06 23:47:56.678+00", or ISO) -> UTC ISO, or null
function resendTime(value) {
  if (typeof value !== "string" || !value) return null;
  const text = value.trim().replace(" ", "T").replace(/([+-]\d{2})$/, "$1:00");
  const ms = Date.parse(text);
  return Number.isNaN(ms) ? null : new Date(ms).toISOString();
}

// How many recipients of a broadcast had each event (counting up to STATS_CAP of each)
export async function fetchStats(env, broadcastId) {
  const stats = {};
  let capped = false;
  for (const type of STAT_TYPES) {
    const { items, capped: hitCap } = await listAll(env, `/broadcasts/${encodeURIComponent(broadcastId)}/recipients?type=${type}`, { max: STATS_CAP });
    stats[type] = items.length;
    capped = capped || hitCap;
  }
  return { ...stats, ...(capped ? { capped: true } : {}), fetchedAt: nowIso() };
}

// The numbers for campaigns sent in the last 14 days
export async function refreshStats(env, at = Date.now()) {
  const since = new Date(at - STATS_DAYS * 86400000).toISOString();
  const { results } = await env.DB.prepare("SELECT id, broadcast_id, stats FROM email_campaigns WHERE status = 'sent' AND broadcast_id IS NOT NULL AND sent_at >= ? ORDER BY id").bind(since).all();
  for (const c of results) {
    try {
      const stats = await fetchStats(env, c.broadcast_id);
      const before = parseStats(c.stats) || {};
      const changed = STAT_TYPES.some((t) => before[t] !== stats[t]);
      const statements = [env.DB.prepare("UPDATE email_campaigns SET stats = ? WHERE id = ?").bind(JSON.stringify(stats), c.id)];
      if (changed) statements.push(logEntry(env, c.id, "stats", "resend", STAT_TYPES.map((t) => `${t} ${stats[t]}`).join(", ")));
      await env.DB.batch(statements);
    } catch (err) {
      console.log(`Campaign ${c.id}: the numbers couldn't be read (${err?.name})`);
    }
  }
  return results.length;
}

// Every minute: scheduled ones that are due. Every hour: unsubscribes, scheduled campaigns' lists,
// the numbers, and old sign-up counters.
export async function campaignsOnSchedule(env, at = Date.now()) {
  if (!marketingKey(env)) return null;
  const due = await env.DB.prepare("SELECT COUNT(*) AS n FROM email_campaigns WHERE status = 'scheduled' AND send_at <= ?").bind(new Date(at).toISOString()).first("n");
  if (due) await checkScheduled(env, at).catch((err) => console.log("Campaigns: scheduled check failed:", err?.name));

  const last = await readSetting(env, HOURLY_KEY);
  if (last && at - Date.parse(last) < 3600000) return { hourly: false };
  // Stamp it first, so a slow run isn't started again by the next minute's cron
  await writeSetting(env, HOURLY_KEY, new Date(at).toISOString());
  await env.DB.prepare("DELETE FROM settings WHERE key LIKE 'fan_signup:%' AND key < ?").bind(`fan_signup:${Math.floor(at / 3600000) - 1}`).run();
  const { n } = await env.DB.prepare("SELECT COUNT(*) AS n FROM email_campaigns WHERE status IN ('scheduled', 'sent')").first();
  if (!n) return { hourly: true };
  try {
    const setup = await resendSetup(env);
    await pullUnsubscribes(env, setup);
    // Scheduled ones still to go: their lists brought up to date (someone may have opted out)
    const { results } = await env.DB.prepare("SELECT DISTINCT audience FROM email_campaigns WHERE status = 'scheduled' AND send_at > ?").bind(new Date(at).toISOString()).all();
    for (const { audience } of results) await syncAudience(env, audience, setup);
  } catch (err) {
    console.log("Campaigns: unsubscribe sync failed:", err?.name, err?.status || "");
  }
  await refreshStats(env, at).catch((err) => console.log("Campaigns: stats failed:", err?.name));
  return { hourly: true };
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

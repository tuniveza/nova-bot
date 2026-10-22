// Replying to enquiries: one conversation per enquiry (migrations/0022_enquiry_replies.sql)
//
// Staff answer enquiries from Portal (and from Nova Agent's Agent, through the same staff
// routes), and Nova Agent's AI can draft a reply for a person to check. Who can do what is
// decided here and in the routes, whatever any AI says:
//
//   - Staff signed in to Portal in a browser (the session cookie, plus the Origin check in
//     src/app-page.js) can send a reply, add a note, edit / approve & send / discard a draft,
//     retry a failed send, and switch "Don't contact" on or off.
//   - Nova Agent's AI (AGENT_NOVA_KEY, src/agent-nova.js) can list and read enquiries and add a
//     DRAFT. Nothing else: agentDraft() only ever writes status 'draft', and no route that takes
//     the agent key approves or sends anything.
//   - The customer can stop emails with the link at the foot of every one (/enquiry/stop).
//
// A message goes out only from status 'approved', which only a person's press sets (Send, or
// Approve & send). Each step is one guarded UPDATE (… WHERE status = 'draft'), so a double click
// or a retried request can't send the same reply twice. Email goes only to the enquiry's own
// address. Times are stored in UTC; emails show dates in UK time.

import { dialNumber, emailIsSetUp, emailRecipients, mobileNumber, pickSender } from "./enquiries.js";
import { sendStudioEmail } from "./google/gmail.js";
import { notifyPhones } from "./push.js";
import { publicUrl } from "./nova/booking.js";

// The longest reply or note
const MAX_BODY = 8000;
// A reply still "sending" after this long was cut off (the Worker stopped part-way): staff can retry it
const STUCK_MS = 2 * 60 * 1000;
// Drafts from the AI waiting on one enquiry at most (stops a runaway loop filling the thread)
const MAX_WAITING_DRAFTS = 5;

// How Nova itself sends a reply: email. (WhatsApp and texts go from the person's own phone,
// and are only recorded here: see staffLogged.) A text-message provider could slot in here
// later: { ready(env), send(env, message, enquiry, attempt) } returning { ok, id } or
// { ok: false, message }, plus its secrets (see README-ENQUIRIES.md).
export const CHANNELS = {
  email: { ready: (env) => emailIsSetUp(env), notReady: "Email isn't set up yet (it needs the mail server (MAIL_API_URL, MAIL_KEY) and ENQUIRY_EMAIL_TO).", send: sendByEmail },
};

const nowIso = () => new Date().toISOString();

// A reply or note as typed: text only, tidied, capped
function cleanBody(value) {
  return typeof value === "string" ? value.replace(/\r\n?/g, "\n").replace(/[ \t]+\n/g, "\n").trim().slice(0, MAX_BODY) : "";
}

// The page's id for one press of Send (so the same press is never saved twice)
function cleanKey(value) {
  return typeof value === "string" && /^[\w-]{8,64}$/.test(value) ? value : null;
}

// new / open / replied / closed / spam / do-not-contact ('done' is stored for closed: Portal's
// "Done"; 'open' and 'spam' are the inbox's, src/inbox.js)
export function enquiryState(e) {
  if (e.status === "spam") return "spam";
  if (e.do_not_contact_at) return "do-not-contact";
  if (e.status === "done") return "closed";
  if (e.status === "replied") return "replied";
  if (e.status === "open") return "open";
  return "new";
}

// A date in UK time, in words: "10 October 2026"
export function ukDate(iso) {
  return new Date(iso).toLocaleDateString("en-GB", { day: "numeric", month: "long", year: "numeric", timeZone: "Europe/London" });
}

const fail = (status, error) => ({ status, error });

// ===== READING =====

const ENQUIRY_FIELDS =
  "id, created_at, name, email, phone, subject, details, page, chat_id, emailed, status, consent_at, consent_source, do_not_contact_at, do_not_contact_by, assigned_to, label, spam_reason, state_at";

// The enquiry and its conversation (drafts included; discarded ones left out), or null
export async function enquiryThread(env, id) {
  const e = await env.DB.prepare(`SELECT ${ENQUIRY_FIELDS} FROM enquiries WHERE id = ?`).bind(id).first();
  if (!e) return null;
  const { results } = await env.DB.prepare(
    `SELECT m.id, m.direction, m.channel, m.body, m.status, m.created_by, m.author_staff_id, m.created_at, m.updated_at,
       m.approved_by, m.approved_at, m.sent_at, m.attempts, m.error,
       a.display_name AS author_name, b.display_name AS approver_name
     FROM enquiry_messages m
     LEFT JOIN staff a ON a.id = m.author_staff_id
     LEFT JOIN staff b ON b.id = m.approved_by
     WHERE m.enquiry_id = ? AND (m.status IS NULL OR m.status != 'discarded')
     ORDER BY m.id`
  )
    .bind(id)
    .all();
  const stuckBefore = Date.now() - STUCK_MS;
  return {
    enquiry: { ...e, state: enquiryState(e), mobile: mobileNumber(e.phone || "") || null, dial: dialNumber(e.phone || "") || null },
    // "sending" is an approved reply on its way; one stuck that way for minutes can be retried
    messages: results.map((m) => ({ ...m, stuck: m.status === "approved" && Date.parse(m.updated_at) < stuckBefore })),
  };
}

// Enquiries for a list: newest first, with what's waiting in each conversation.
// show: "new" (the ones still to answer), "open" (new, open or replied), "all" (everything but
// Spam), or "spam". box: one inbox state (src/inbox.js: new, open, replied, done, spam) instead.
// q: words to look for (name, email, subject, message, label).
export async function listEnquiries(env, { show = "new", box = null, q = "", limit = 300 } = {}) {
  const terms = [];
  const binds = [];
  if (box) {
    terms.push("e.status = ?");
    binds.push(box);
  } else if (show === "open") terms.push("e.status IN ('new', 'open', 'replied') AND e.do_not_contact_at IS NULL");
  else if (show === "spam") terms.push("e.status = 'spam'");
  else if (show === "all") terms.push("e.status != 'spam'");
  else terms.push("e.status = 'new'");
  const words = String(q || "").trim().slice(0, 100);
  if (words) {
    terms.push("(e.name LIKE ? ESCAPE '\\' OR e.email LIKE ? ESCAPE '\\' OR e.subject LIKE ? ESCAPE '\\' OR e.details LIKE ? ESCAPE '\\' OR e.label LIKE ? ESCAPE '\\')");
    const like = "%" + words.replace(/[\\%_]/g, (c) => "\\" + c) + "%";
    binds.push(like, like, like, like, like);
  }
  const where = terms.length ? "WHERE " + terms.join(" AND ") : "";
  const { results } = await env.DB.prepare(
    `SELECT e.id, e.created_at, e.name, e.email, e.phone, e.subject, e.details, e.page, e.chat_id, e.emailed, e.status,
       e.consent_at, e.consent_source, e.do_not_contact_at, e.do_not_contact_by,
       e.assigned_to, e.label, e.spam_reason, e.state_at, (SELECT s.display_name FROM staff s WHERE s.id = e.assigned_to) AS assigned_name,
       (SELECT COUNT(*) FROM enquiry_messages m WHERE m.enquiry_id = e.id AND m.status = 'draft') AS drafts,
       (SELECT COUNT(*) FROM enquiry_messages m WHERE m.enquiry_id = e.id AND m.status = 'sent') AS replies,
       (SELECT COUNT(*) FROM enquiry_messages m WHERE m.enquiry_id = e.id AND m.status = 'failed') AS failed,
       (SELECT MAX(m.updated_at) FROM enquiry_messages m WHERE m.enquiry_id = e.id) AS last_activity
     FROM enquiries e ${where} ORDER BY e.created_at DESC LIMIT ?`
  )
    .bind(...binds, limit)
    .all();
  return results.map((e) => ({ ...e, state: enquiryState(e), dial: dialNumber(e.phone || "") || null }));
}

async function readMessage(env, messageId) {
  return env.DB.prepare(
    `SELECT m.*, e.do_not_contact_at FROM enquiry_messages m JOIN enquiries e ON e.id = m.enquiry_id WHERE m.id = ?`
  )
    .bind(messageId)
    .first();
}

// ===== STAFF (a person pressed a button in Portal or Agent) =====

// Send: a reply a person wrote and sent. Emailed straight away, to the enquiry's address only.
export async function staffReply(env, me, { id, body, key }) {
  const text = cleanBody(body);
  if (!Number.isInteger(id)) return fail(400, "Which enquiry?");
  if (!text) return fail(400, "Write a reply first.");
  const e = await env.DB.prepare("SELECT id, do_not_contact_at FROM enquiries WHERE id = ?").bind(id).first();
  if (!e) return fail(404, "That enquiry doesn't exist.");
  if (e.do_not_contact_at) return fail(409, "They've asked not to be contacted, so nothing can be sent.");
  const clientKey = cleanKey(key);
  const now = nowIso();
  // The same press again (double click, a retried request): hand back the first one, don't send twice
  const { meta } = await env.DB.prepare(
    `INSERT INTO enquiry_messages (enquiry_id, direction, channel, body, status, created_by, author_staff_id, created_at, updated_at, approved_by, approved_at, client_key)
     VALUES (?, 'out', 'email', ?, 'approved', 'staff', ?, ?, ?, ?, ?, ?)
     ON CONFLICT (enquiry_id, client_key) DO NOTHING`
  )
    .bind(id, text, me.id, now, now, me.id, now, clientKey)
    .run();
  if (!meta.changes) {
    const same = await env.DB.prepare("SELECT id FROM enquiry_messages WHERE enquiry_id = ? AND client_key = ?").bind(id, clientKey).first();
    return { message: await publicMessage(env, same.id), repeated: true };
  }
  return { message: await deliver(env, meta.last_row_id) };
}

// An internal note: for the team only, never sent
export async function staffNote(env, me, { id, body, key }) {
  const text = cleanBody(body);
  if (!Number.isInteger(id)) return fail(400, "Which enquiry?");
  if (!text) return fail(400, "Write the note first.");
  const e = await env.DB.prepare("SELECT id FROM enquiries WHERE id = ?").bind(id).first();
  if (!e) return fail(404, "That enquiry doesn't exist.");
  const now = nowIso();
  const clientKey = cleanKey(key);
  const { meta } = await env.DB.prepare(
    `INSERT INTO enquiry_messages (enquiry_id, direction, channel, body, status, created_by, author_staff_id, created_at, updated_at, client_key)
     VALUES (?, 'note', 'email', ?, NULL, 'staff', ?, ?, ?, ?)
     ON CONFLICT (enquiry_id, client_key) DO NOTHING`
  )
    .bind(id, text, me.id, now, now, clientKey)
    .run();
  if (!meta.changes) {
    const same = await env.DB.prepare("SELECT id FROM enquiry_messages WHERE enquiry_id = ? AND client_key = ?").bind(id, clientKey).first();
    return { message: await publicMessage(env, same.id), repeated: true };
  }
  return { message: await publicMessage(env, meta.last_row_id) };
}

// Edit a draft (from the AI) before approving it
export async function editDraft(env, me, { messageId, body }) {
  const text = cleanBody(body);
  if (!Number.isInteger(messageId)) return fail(400, "Which draft?");
  if (!text) return fail(400, "The draft can't be empty.");
  const { meta } = await env.DB.prepare("UPDATE enquiry_messages SET body = ?, updated_at = ? WHERE id = ? AND status = 'draft'")
    .bind(text, nowIso(), messageId)
    .run();
  if (!meta.changes) return (await readMessage(env, messageId)) ? fail(409, "That draft has already been sent or discarded.") : fail(404, "That draft doesn't exist.");
  return { message: await publicMessage(env, messageId) };
}

// Approve & send: a person's press, the only way a draft goes out. `body` (optional) is the
// text they're looking at, so what they approved is exactly what's sent.
export async function approveDraft(env, me, { messageId, body }) {
  if (!Number.isInteger(messageId)) return fail(400, "Which draft?");
  const text = body === undefined || body === null ? null : cleanBody(body);
  if (text === "") return fail(400, "The draft can't be empty.");
  const now = nowIso();
  // draft → approved, once: a second press finds it no longer a draft and sends nothing.
  // Never for someone who asked not to be contacted.
  const { meta } = await env.DB.prepare(
    `UPDATE enquiry_messages SET status = 'approved', body = COALESCE(?, body), approved_by = ?, approved_at = ?, updated_at = ?
     WHERE id = ? AND status = 'draft' AND direction = 'out'
       AND NOT EXISTS (SELECT 1 FROM enquiries e WHERE e.id = enquiry_messages.enquiry_id AND e.do_not_contact_at IS NOT NULL)`
  )
    .bind(text, me.id, now, now, messageId)
    .run();
  if (!meta.changes) {
    const m = await readMessage(env, messageId);
    if (!m || m.direction !== "out" || m.status === "discarded") return fail(404, "That draft doesn't exist.");
    if (m.status === "draft" && m.do_not_contact_at) return fail(409, "They've asked not to be contacted, so nothing can be sent.");
    // Already approved (another press, or someone else got there first): nothing more is sent
    return { message: await publicMessage(env, messageId), repeated: true };
  }
  return { message: await deliver(env, messageId) };
}

// Discard a draft (kept for the record, not shown)
export async function discardDraft(env, me, { messageId }) {
  if (!Number.isInteger(messageId)) return fail(400, "Which draft?");
  const { meta } = await env.DB.prepare("UPDATE enquiry_messages SET status = 'discarded', updated_at = ? WHERE id = ? AND status = 'draft'")
    .bind(nowIso(), messageId)
    .run();
  if (!meta.changes) return (await readMessage(env, messageId)) ? fail(409, "That draft has already been sent or discarded.") : fail(404, "That draft doesn't exist.");
  return { ok: true };
}

// Retry a reply that failed (or one cut off while sending, after a couple of minutes)
export async function retrySend(env, me, { messageId }) {
  if (!Number.isInteger(messageId)) return fail(400, "Which reply?");
  const m = await readMessage(env, messageId);
  if (!m || m.direction !== "out") return fail(404, "That reply doesn't exist.");
  if (m.do_not_contact_at) return fail(409, "They've asked not to be contacted, so nothing can be sent.");
  const stuck = m.status === "approved" && Date.parse(m.updated_at) < Date.now() - STUCK_MS;
  if (m.status !== "failed" && !stuck) {
    return m.status === "sent" ? fail(409, "That reply has already been sent.") : fail(409, m.status === "approved" ? "It's still sending." : "Only a reply that failed can be retried.");
  }
  const now = nowIso();
  // failed → approved, once (two Retry presses can't both win). A stuck one keeps its attempt,
  // so the mail server sees the same idempotency key and won't send it twice if the first one went.
  const { meta } = await env.DB.prepare(
    `UPDATE enquiry_messages SET status = 'approved', error = NULL, approved_by = ?, approved_at = ?, updated_at = ?
     WHERE id = ? AND status = ? AND updated_at = ?`
  )
    .bind(me.id, now, now, messageId, m.status, m.updated_at)
    .run();
  if (!meta.changes) return { message: await publicMessage(env, messageId), repeated: true };
  return { message: await deliver(env, messageId, { sameAttempt: stuck }) };
}

// Don't contact: on (staff, or the customer's stop link) blocks every send; off only undoes a staff one
export async function setDoNotContact(env, { id, on, by }) {
  if (!Number.isInteger(id)) return fail(400, "Which enquiry?");
  const e = await env.DB.prepare("SELECT id, do_not_contact_at, do_not_contact_by FROM enquiries WHERE id = ?").bind(id).first();
  if (!e) return fail(404, "That enquiry doesn't exist.");
  if (on) {
    if (!e.do_not_contact_at) {
      await env.DB.prepare("UPDATE enquiries SET do_not_contact_at = ?, do_not_contact_by = ? WHERE id = ? AND do_not_contact_at IS NULL").bind(nowIso(), by, id).run();
    }
    return { ok: true };
  }
  // The customer asked (the stop link): only they can change that, by getting in touch again
  if (e.do_not_contact_by === "customer") return fail(409, "They asked to stop with the link in an email, so it stays on. If they get in touch again, that's a new enquiry.");
  await env.DB.prepare("UPDATE enquiries SET do_not_contact_at = NULL, do_not_contact_by = NULL WHERE id = ?").bind(id).run();
  return { ok: true };
}

// Change an enquiry's status from Portal: new / open / replied / done (closed). (Spam, who's on
// it and labels: src/inbox.js's sortEnquiry.)
export async function setEnquiryStatus(env, { id, status }) {
  if (status === "closed") status = "done";
  if (!Number.isInteger(id) || !["new", "open", "replied", "done"].includes(status)) return fail(400, "Bad request");
  const { meta } = await env.DB.prepare("UPDATE enquiries SET status = ?, state_at = ?, spam_reason = NULL WHERE id = ?").bind(status, nowIso(), id).run();
  if (!meta.changes) return fail(404, "That enquiry doesn't exist.");
  return { ok: true };
}

// ===== WHATSAPP, TEXTS AND CALLS (from the person's own phone) =====
// Portal opens WhatsApp, Messages or the phone's dialler with the customer's number (and the
// reply) filled in, and the person sends or calls from there: Nova sends nothing itself. Once
// they say it went, it's written into the conversation so the whole team can see it.

// How a call went (what the person picked after hanging up)
export const CALL_OUTCOMES = { spoke: "Spoke to them", voicemail: "Left a voicemail", "no-answer": "No answer" };
// The first line of a call's entry in the conversation (Portal shows these as calls)
export const CALL_PREFIX = "Phone call: ";

// Record a WhatsApp message or text the person sent (kind "whatsapp" / "sms", body = what
// they sent), or a call they made (kind "call", outcome from CALL_OUTCOMES, body = an
// optional note). Contact, so it moves a new enquiry on to "replied" (a missed call doesn't).
export async function staffLogged(env, me, { id, kind, body, outcome, key }) {
  if (!Number.isInteger(id)) return fail(400, "Which enquiry?");
  if (!["whatsapp", "sms", "call"].includes(kind)) return fail(400, "WhatsApp, text or call?");
  const call = kind === "call";
  if (call && !CALL_OUTCOMES[outcome]) return fail(400, "How did the call go?");
  const text = cleanBody(body);
  if (!call && !text) return fail(400, "What did you send?");
  const e = await env.DB.prepare("SELECT id, phone, do_not_contact_at FROM enquiries WHERE id = ?").bind(id).first();
  if (!e) return fail(404, "That enquiry doesn't exist.");
  if (e.do_not_contact_at) return fail(409, "They've asked not to be contacted.");
  const to = dialNumber(e.phone || "");
  if (!to) return fail(409, "This enquiry has no mobile number.");
  const clientKey = cleanKey(key);
  const now = nowIso();
  const row = call
    ? env.DB.prepare(
        `INSERT INTO enquiry_messages (enquiry_id, direction, channel, body, status, created_by, author_staff_id, created_at, updated_at, client_key)
         VALUES (?, 'note', 'email', ?, NULL, 'staff', ?, ?, ?, ?)
         ON CONFLICT (enquiry_id, client_key) DO NOTHING`
      ).bind(id, CALL_PREFIX + CALL_OUTCOMES[outcome] + (text ? "\n" + text : ""), me.id, now, now, clientKey)
    : env.DB.prepare(
        `INSERT INTO enquiry_messages (enquiry_id, direction, channel, body, status, created_by, author_staff_id, created_at, updated_at, approved_by, approved_at, sent_at, sent_to, attempts, client_key)
         VALUES (?, 'out', ?, ?, 'sent', 'staff', ?, ?, ?, ?, ?, ?, ?, 1, ?)
         ON CONFLICT (enquiry_id, client_key) DO NOTHING`
      ).bind(id, kind, text, me.id, now, now, me.id, now, now, to, clientKey);
  const { meta } = await row.run();
  if (!meta.changes) {
    const same = await env.DB.prepare("SELECT id FROM enquiry_messages WHERE enquiry_id = ? AND client_key = ?").bind(id, clientKey).first();
    return { message: await publicMessage(env, same.id), repeated: true };
  }
  if (outcome !== "no-answer") await env.DB.prepare("UPDATE enquiries SET status = 'replied', state_at = ? WHERE id = ? AND status IN ('new', 'open')").bind(now, id).run();
  return { message: await publicMessage(env, meta.last_row_id) };
}

// ===== NOVA AGENT'S AI: drafts only =====

// Save a draft reply from the AI. It's never sent from here: it waits, status 'draft', until a
// signed-in person presses Approve & send. Staff phones get a quiet nudge.
export async function agentDraft(env, { id, body }) {
  const text = cleanBody(body);
  if (!Number.isInteger(id)) return fail(400, "Which enquiry?");
  if (!text) return fail(400, "The draft is empty.");
  const e = await env.DB.prepare("SELECT id, name, email, subject, do_not_contact_at FROM enquiries WHERE id = ?").bind(id).first();
  if (!e) return fail(404, "That enquiry doesn't exist.");
  if (e.do_not_contact_at) return fail(409, "They've asked not to be contacted, so don't draft a reply.");
  const { count } = await env.DB.prepare("SELECT COUNT(*) AS count FROM enquiry_messages WHERE enquiry_id = ? AND status = 'draft'").bind(id).first();
  if (count >= MAX_WAITING_DRAFTS) return fail(429, "There are already several drafts waiting on this enquiry. Ask staff to approve or discard them first.");
  const now = nowIso();
  const { meta } = await env.DB.prepare(
    `INSERT INTO enquiry_messages (enquiry_id, direction, channel, body, status, created_by, created_at, updated_at)
     VALUES (?, 'out', 'email', ?, 'draft', 'agent', ?, ?)`
  )
    .bind(id, text, now, now)
    .run();
  const draftId = meta.last_row_id;
  const portalPath = `/portal/?view=enquiries&enquiry=${id}`;
  // A quiet ping to staff (not the customer): a newer one for the same enquiry replaces it
  await notifyPhones(env, {
    title: "Draft reply to approve",
    body: `Agent drafted a reply to ${e.name}${e.subject ? ` (${e.subject})` : ""}. Check it and approve it in Portal.`,
    url: portalPath,
    enquiryId: id,
    style: { source: "portal", kind: "enquiry", tag: `enquiry-draft-${id}`, ttl: 12 * 3600, urgent: false },
  }).catch((err) => console.log("Draft ping failed:", err.message));
  return {
    draft: { id: draftId, enquiryId: id, body: text, status: "draft" },
    enquiry: { id, name: e.name, email: e.email, subject: e.subject },
    portalUrl: publicUrl(env) + portalPath,
  };
}

// ===== SENDING =====

// A message as Portal shows it
async function publicMessage(env, messageId) {
  const row = await env.DB.prepare("SELECT enquiry_id FROM enquiry_messages WHERE id = ?").bind(messageId).first();
  if (!row) return null;
  const thread = await enquiryThread(env, row.enquiry_id);
  return thread.messages.find((m) => m.id === messageId) || null;
}

// Send one approved message, and record how it went. Only status 'approved' goes (a person
// pressed Send or Approve & send); anything else is handed back untouched.
async function deliver(env, messageId, { sameAttempt = false } = {}) {
  const m = await env.DB.prepare(
    `SELECT m.*, e.email, e.name, e.subject, e.created_at AS enquiry_at, e.consent_at, e.consent_source, e.do_not_contact_at
     FROM enquiry_messages m JOIN enquiries e ON e.id = m.enquiry_id WHERE m.id = ?`
  )
    .bind(messageId)
    .first();
  if (!m || m.status !== "approved" || m.direction !== "out") return publicMessage(env, messageId);
  const failWith = async (error) => {
    await env.DB.prepare("UPDATE enquiry_messages SET status = 'failed', error = ?, updated_at = ? WHERE id = ? AND status = 'approved'")
      .bind(error, nowIso(), messageId)
      .run();
    return publicMessage(env, messageId);
  };
  // Checked again right before sending: "Don't contact" may have been switched on meanwhile
  if (m.do_not_contact_at) return failWith("They asked not to be contacted, so it wasn't sent.");
  const channel = CHANNELS[m.channel];
  if (!channel) return failWith(`Sending by ${m.channel} isn't set up yet.`);
  if (!channel.ready(env)) return failWith(channel.notReady);
  // Count the try (a stuck one that's retried keeps its number: see retrySend)
  const attempt = sameAttempt
    ? Math.max(m.attempts, 1)
    : (await env.DB.prepare("UPDATE enquiry_messages SET attempts = attempts + 1, updated_at = ? WHERE id = ? AND status = 'approved' RETURNING attempts").bind(nowIso(), messageId).first())?.attempts;
  if (!attempt) return publicMessage(env, messageId);
  let result;
  try {
    result = await channel.send(env, m, attempt);
  } catch (err) {
    result = { ok: false, message: err.message };
  }
  if (!result.ok) return failWith(result.message || "It didn't send.");
  const now = nowIso();
  await env.DB.batch([
    env.DB.prepare("UPDATE enquiry_messages SET status = 'sent', sent_at = ?, sent_to = ?, error = NULL, updated_at = ? WHERE id = ? AND status = 'approved'").bind(
      now,
      result.to || null,
      now,
      messageId
    ),
    // A reply moves a new or open enquiry on to "replied" (waiting on them)
    env.DB.prepare("UPDATE enquiries SET status = 'replied', state_at = ? WHERE id = ? AND status IN ('new', 'open')").bind(now, m.enquiry_id),
  ]);
  return publicMessage(env, messageId);
}

// The stop link for an enquiry's emails (its secret is made the first time it's needed)
async function stopLink(env, enquiryId) {
  const token = [...crypto.getRandomValues(new Uint8Array(24))].map((b) => b.toString(16).padStart(2, "0")).join("");
  await env.DB.prepare("UPDATE enquiries SET stop_token = ? WHERE id = ? AND stop_token IS NULL").bind(token, enquiryId).run();
  const { stop_token } = await env.DB.prepare("SELECT stop_token FROM enquiries WHERE id = ?").bind(enquiryId).first();
  return `${publicUrl(env)}/enquiry/stop?t=${stop_token}`;
}

// The email a customer gets: the reply, who it's from, why they're getting it, and how to stop
export function replyEmail(env, m, stopUrl) {
  const asked = ukDate(m.consent_at || m.enquiry_at);
  const text = [
    m.body,
    "",
    "--",
    "Novacane Studios",
    "Reply to this email to get back to us.",
    "",
    `You're getting this because you sent Novacane Studios an enquiry on ${asked}${m.consent_source ? ` (${m.consent_source})` : ""}. We only email you about your enquiry.`,
    `To ask us to stop emailing you, open this link: ${stopUrl}`,
  ].join("\n");
  return {
    subject: "Re: " + (m.subject || "your enquiry to Novacane Studios"),
    text,
    // Email apps' own "Unsubscribe" button uses the same link (one click, RFC 8058)
    headers: { "List-Unsubscribe": `<${stopUrl}>`, "List-Unsubscribe-Post": "List-Unsubscribe=One-Click" },
  };
}

// Email: from the studio, to the enquiry's address and nobody else, replies to the studio inbox
async function sendByEmail(env, m, attempt) {
  const to = String(m.email || "").trim().toLowerCase();
  if (!to) return { ok: false, message: "This enquiry has no email address." };
  const mail = replyEmail(env, m, await stopLink(env, m.enquiry_id));
  // (the studio's own mail server, with Gmail as the backup: src/google/gmail.js)
  const result = await sendStudioEmail(env, {
    ...mail,
    to: [to],
    from: pickSender(env.ENQUIRY_REPLY_FROM, env.ENQUIRY_EMAIL_FROM) || "Novacane Studios <hello@novacane.co.uk>",
    replyTo: env.ENQUIRY_REPLY_TO || emailRecipients(env)[0],
    // The mail server sends a request with the same key at most once (a retry after a failure gets a new one)
    idempotencyKey: `enquiry-reply-${m.id}-${attempt}`,
  }, { kind: "enquiry", id: m.enquiry_id });
  return result.ok ? { ok: true, id: result.id, to } : result;
}

// ===== THE STOP LINK =====
// GET shows a page with a button (so a mail scanner opening the link changes nothing);
// POST (the button, or an email app's one-click unsubscribe) marks the enquiry "don't contact".

export async function handleStop(request, env) {
  const url = new URL(request.url);
  let token = url.searchParams.get("t") || "";
  if (request.method === "POST" && !token) {
    try {
      token = String((await request.formData()).get("t") || "");
    } catch {}
  }
  token = /^[0-9a-f]{48}$/.test(token) ? token : "";
  const e = token ? await env.DB.prepare("SELECT id, do_not_contact_at FROM enquiries WHERE stop_token = ?").bind(token).first() : null;
  if (!e) return stopPage("That link doesn't work", "It may have been copied wrongly. To ask Novacane Studios to stop contacting you, reply to any of our emails and say so.", null, 404);
  if (request.method === "POST") {
    if (!e.do_not_contact_at) {
      const now = nowIso();
      await env.DB.batch([
        env.DB.prepare("UPDATE enquiries SET do_not_contact_at = ?, do_not_contact_by = 'customer' WHERE id = ? AND do_not_contact_at IS NULL").bind(now, e.id),
        // The team sees it in the conversation
        env.DB.prepare(
          "INSERT INTO enquiry_messages (enquiry_id, direction, channel, body, status, created_by, created_at, updated_at) VALUES (?, 'note', 'email', ?, NULL, 'customer', ?, ?)"
        ).bind(e.id, "They asked the studio to stop contacting them (the link in an email). Nothing more can be sent.", now, now),
      ]);
    }
    return stopPage("Done", "Novacane Studios won't email you about your enquiry again. If you get in touch with us later, we'll reply to that.", null);
  }
  if (e.do_not_contact_at) return stopPage("Already done", "Novacane Studios won't email you about your enquiry again.", null);
  return stopPage(
    "Stop emails from Novacane Studios?",
    "You sent us an enquiry, and we've been replying to it by email. Press the button and we won't contact you about it again.",
    token
  );
}

function stopPage(title, text, token, status = 200) {
  const esc = (s) => String(s).replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c]);
  const html = `<!doctype html><html lang="en-GB"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1"><meta name="robots" content="noindex">
<title>${esc(title)} · Novacane Studios</title>
<style>
:root { color-scheme: light dark; --bg: #f7f5f8; --card: #fff; --ink: #1d1820; --muted: #6b6270; --accent: #c2337a; }
@media (prefers-color-scheme: dark) { :root { --bg: #141016; --card: #1f1922; --ink: #f2edf4; --muted: #a79dac; --accent: #ff7ab8; } }
body { margin: 0; background: var(--bg); color: var(--ink); font: 16px/1.5 system-ui, -apple-system, "Segoe UI", sans-serif; }
main { max-width: 460px; margin: 12vh auto; padding: 28px 24px; background: var(--card); border-radius: 18px; }
h1 { font-size: 1.35rem; margin: 0 0 10px; } p { color: var(--muted); margin: 0 0 18px; }
button { font: inherit; padding: 11px 20px; border: 0; border-radius: 999px; background: var(--accent); color: #fff; cursor: pointer; }
small { display: block; margin-top: 18px; color: var(--muted); }
</style></head><body><main>
<h1>${esc(title)}</h1><p>${esc(text)}</p>
${token ? `<form method="post" action="/enquiry/stop"><input type="hidden" name="t" value="${esc(token)}"><button type="submit">Stop emails</button></form>` : ""}
<small>Novacane Studios, Forest Hill, London</small>
</main></body></html>`;
  return new Response(html, { status, headers: { "Content-Type": "text/html; charset=utf-8", "Cache-Control": "no-store", "Referrer-Policy": "no-referrer" } });
}

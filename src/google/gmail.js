// Gmail: approved emails go from the studio's Gmail, and customers' replies come back into
// Enquiries (Portal → Admin → Google → "Send approved emails from Gmail", "Customers' replies").
//
// Sending: sendStudioEmail() takes the place of Resend for the emails a person approved (enquiry
// replies, one-to-one emails, invoices and their reminders). With Gmail connected and switched on,
// they go from the studio's Gmail, so they're in its Sent folder and a reply comes straight back
// to it; each one remembers its Gmail thread, so the next email about the same thing joins it.
// Otherwise (or if Gmail turns it down) they go through Resend, as before. Nothing here decides
// whether something may be sent: the callers only call it after an admin's approval.
// Campaigns stay on Resend (it handles unsubscribes for lists).
//
// Reading replies (every hour, gmail.readonly: nothing in Gmail is changed):
//   - every thread an approved email started (or joined) in the last 45 days, and
//   - emails from the people with open enquiries (sent through Resend, they reply to the studio's
//     inbox),
// and each new message from them lands in the right enquiry as their reply (a reply about a
// one-to-one email or an invoice starts a new enquiry), with a quiet ping to the team.
//
// Logs say counts only, never addresses or what anyone wrote.

import { buildMime, base64Url, connectedAccount, google, GoogleError } from "../nova/google.js";
import { sendEmail as resendEmail } from "../enquiries.js";
import { notifyPhones } from "../push.js";
import { getLink, partOn, putLink, readSetting, writeSetting } from "./common.js";

const GMAIL = "https://gmail.googleapis.com/gmail/v1/users/me";
const THREAD_DAYS = 45;
const SEARCH_PER_RUN = 12;

// ===== SENDING =====

// Send one approved email. `msg`: what Resend's sendEmail takes ({ to, from, replyTo, subject,
// text, html, headers, idempotencyKey }). `ref`: what it's about ({ kind: "enquiry" | "outreach" |
// "invoice", id }). -> { ok, id, via: "gmail" | "resend" } or { ok: false, message }
export async function sendStudioEmail(env, msg, ref = null) {
  if (await partOn(env, "send").catch(() => false)) {
    try {
      return await gmailSend(env, msg, ref);
    } catch (err) {
      // Gmail answered no (not a time-out, when it may have gone): Resend tries instead
      if (!(err instanceof GoogleError) || !err.status) {
        return { ok: false, message: "Gmail didn't answer in time: it may or may not have gone. Check the studio's Sent folder before trying again." };
      }
      console.log(`Gmail turned an email down (${err.status}); sending through Resend instead`);
    }
  }
  const result = await resendEmail(env, msg);
  return result.ok ? { ...result, via: "resend" } : result;
}

async function gmailSend(env, msg, ref) {
  const account = await connectedAccount(env);
  const to = Array.isArray(msg.to) ? msg.to.join(", ") : String(msg.to || "");
  const key = ref ? `${ref.kind}:${ref.id}` : null;
  const thread = key ? await getLink(env, "gmail-thread", key) : null;
  const messageId = `<nova-${crypto.randomUUID()}@${(account.split("@")[1] || "novacane.studio").replace(/[^\w.-]/g, "")}>`;
  const headers = { ...(msg.headers || {}), "Message-ID": messageId };
  if (thread?.extra) {
    headers["In-Reply-To"] = thread.extra;
    headers.References = thread.extra;
  }
  const raw = buildMime({
    from: account ? `Novacane Studios <${account}>` : "",
    to,
    replyTo: msg.replyTo && msg.replyTo !== account ? msg.replyTo : undefined,
    subject: msg.subject,
    text: msg.text,
    html: msg.html,
    headers,
  });
  const sent = await google(env, "POST", `${GMAIL}/messages/send`, { raw: base64Url(raw), ...(thread ? { threadId: thread.google_id } : {}) });
  if (key && sent.threadId) await putLink(env, "gmail-thread", key, sent.threadId, { extra: messageId }).run();
  // Our own message: never read back as their reply
  if (sent.id) await putLink(env, "gmail-in", sent.id, sent.threadId || "", { extra: "ours" }).run();
  return { ok: true, id: sent.id || null, via: "gmail" };
}

// ===== READING REPLIES =====

// The text someone wrote, from a Gmail message (format=full): the plain part, without the
// quoted email underneath
export function messageText(payload) {
  const find = (part, type) => {
    if (!part) return null;
    if (part.mimeType === type && part.body?.data) return part.body.data;
    for (const p of part.parts || []) {
      const got = find(p, type);
      if (got) return got;
    }
    return null;
  };
  const decode = (data) => {
    try {
      const bin = atob(data.replace(/-/g, "+").replace(/_/g, "/"));
      return new TextDecoder().decode(Uint8Array.from(bin, (c) => c.charCodeAt(0)));
    } catch {
      return "";
    }
  };
  let text = "";
  const plain = find(payload, "text/plain");
  if (plain) text = decode(plain);
  else {
    const html = find(payload, "text/html");
    if (html) text = decode(html).replace(/<(br|\/p|\/div)\s*\/?>/gi, "\n").replace(/<[^>]+>/g, "").replace(/&nbsp;/g, " ").replace(/&amp;/g, "&").replace(/&lt;/g, "<").replace(/&gt;/g, ">");
  }
  return stripQuoted(text);
}

// Cut the earlier emails quoted under a reply
export function stripQuoted(text) {
  const lines = String(text || "").replace(/\r\n?/g, "\n").split("\n");
  const out = [];
  for (const line of lines) {
    if (/^On .{4,200}wrote:\s*$/.test(line.trim()) || /^-{2,}\s*Original Message\s*-{2,}/i.test(line.trim()) || /^From: .+/.test(line) && out.length > 0 && /^\s*$/.test(out[out.length - 1] || "")) break;
    if (/^\s*>/.test(line)) continue;
    out.push(line);
  }
  return out.join("\n").replace(/\n{3,}/g, "\n\n").trim().slice(0, 5000);
}

const header = (msg, name) => (msg.payload?.headers || []).find((h) => h.name.toLowerCase() === name.toLowerCase())?.value || "";
const fromAddress = (value) => (String(value).match(/<([^>]+)>/)?.[1] || String(value)).trim().toLowerCase();
const fromName = (value) => String(value).replace(/<[^>]+>/, "").replace(/"/g, "").trim();

// A message from them, not from us, not seen before -> where it goes. Returns 1 if added.
async function takeMessage(env, msg, { ref = null, account }) {
  if (await getLink(env, "gmail-in", msg.id)) return 0;
  const from = fromAddress(header(msg, "From"));
  if (!from || from === account.toLowerCase() || (msg.labelIds || []).includes("SENT")) {
    await putLink(env, "gmail-in", msg.id, msg.threadId || "", { extra: "ours" }).run();
    return 0;
  }
  const body = messageText(msg.payload) || String(msg.snippet || "").slice(0, 500);
  const at = new Date(Number(msg.internalDate) || Date.now()).toISOString();
  const now = new Date().toISOString();
  let enquiryId = null;
  if (ref?.kind === "enquiry") enquiryId = Number(ref.id);
  if (!enquiryId) {
    const e = await env.DB.prepare("SELECT id FROM enquiries WHERE email = ? AND status != 'spam' ORDER BY id DESC LIMIT 1").bind(from).first();
    if (e && !ref) enquiryId = e.id;
  }
  const subject = header(msg, "Subject").slice(0, 200);
  if (!enquiryId) {
    // A reply about a one-to-one email or an invoice (or someone new): a new enquiry, so the team sees it
    const what = ref?.kind === "outreach" ? "Reply to a one-to-one email" : ref?.kind === "invoice" ? "Reply about an invoice" : "Email";
    const row = await env.DB.prepare(
      `INSERT INTO enquiries (created_at, name, email, subject, details, page, status, state_at, state_by) VALUES (?, ?, ?, ?, ?, 'gmail', 'new', ?, 'gmail') RETURNING id`
    )
      .bind(at, fromName(header(msg, "From")) || from, from, subject || what, `${what}:\n\n${body}`, now)
      .first();
    enquiryId = row.id;
  } else {
    await env.DB.batch([
      env.DB.prepare(
        `INSERT INTO enquiry_messages (enquiry_id, direction, channel, body, status, created_by, created_at, updated_at) VALUES (?, 'in', 'email', ?, NULL, 'customer', ?, ?)`
      ).bind(enquiryId, body || "(no text)", at, now),
      // Their reply needs looking at: Waiting on them / Done -> Open
      env.DB.prepare("UPDATE enquiries SET status = 'open', state_at = ?, state_by = 'gmail' WHERE id = ? AND status IN ('replied', 'done', 'new')").bind(now, enquiryId),
    ]);
  }
  await putLink(env, "gmail-in", msg.id, msg.threadId || "", { extra: `enquiry:${enquiryId}` }).run();
  return 1;
}

// Every hour: replies in the threads we started, and emails from people with open enquiries
export async function pullReplies(env, budget) {
  const account = await connectedAccount(env);
  if (!account) return "Not connected";
  let added = 0;
  const since = new Date(Date.now() - THREAD_DAYS * 86400000).toISOString();
  const { results: threads } = await env.DB.prepare("SELECT nova_id, google_id FROM google_links WHERE kind = 'gmail-thread' AND synced_at >= ? ORDER BY synced_at DESC LIMIT 25").bind(since).all();
  for (const t of threads) {
    if (budget.left <= 3) break;
    budget.left--;
    let data;
    try {
      data = await google(env, "GET", `${GMAIL}/threads/${encodeURIComponent(t.google_id)}?format=full`);
    } catch (err) {
      if (err.status === 404) continue;
      throw err;
    }
    const [kind, id] = t.nova_id.split(":");
    for (const msg of data.messages || []) added += await takeMessage(env, msg, { ref: { kind, id }, account });
  }
  // Open enquiries' people, a few each hour (in turn)
  const offset = Number(await readSetting(env, "google_replies_offset")) || 0;
  const { results: people } = await env.DB.prepare(
    "SELECT DISTINCT email FROM enquiries WHERE status IN ('new', 'open', 'replied') AND email LIKE '%@%' AND created_at >= ? ORDER BY email LIMIT ? OFFSET ?"
  )
    .bind(new Date(Date.now() - 60 * 86400000).toISOString(), SEARCH_PER_RUN, offset)
    .all();
  await writeSetting(env, "google_replies_offset", people.length < SEARCH_PER_RUN ? 0 : offset + people.length).run();
  for (const p of people) {
    if (budget.left <= 3) break;
    budget.left--;
    const q = `from:${p.email} newer_than:30d -in:sent -in:spam -in:trash`;
    const list = await google(env, "GET", `${GMAIL}/messages?${new URLSearchParams({ q, maxResults: "5" })}`);
    for (const m of list.messages || []) {
      if (budget.left <= 2) break;
      if (await getLink(env, "gmail-in", m.id)) continue;
      budget.left--;
      const msg = await google(env, "GET", `${GMAIL}/messages/${encodeURIComponent(m.id)}?format=full`);
      added += await takeMessage(env, msg, { account });
    }
  }
  if (added) {
    try {
      await notifyPhones(env, {
        title: added === 1 ? "A customer replied" : `${added} customer replies`,
        body: "In Portal → Enquiries.",
        url: "/portal/?view=enquiries",
        style: { source: "portal", kind: "enquiry", tag: "gmail-replies", ttl: 6 * 3600, urgent: false },
      });
    } catch {}
  }
  const { n } = await env.DB.prepare("SELECT COUNT(*) AS n FROM google_links WHERE kind = 'gmail-in' AND extra != 'ours'").first();
  return `${n} repl${n === 1 ? "y" : "ies"} brought in${added ? ` (${added} new just now)` : ""}`;
}

// ===== FOR AGENT (read-only) =====

// Search the studio's Gmail: who, subject, when and a short snippet (never the whole email)
export async function searchGmail(env, query, max = 8) {
  const list = await google(env, "GET", `${GMAIL}/messages?${new URLSearchParams({ q: String(query || "").slice(0, 200), maxResults: String(Math.min(max, 10)) })}`);
  const out = [];
  for (const m of list.messages || []) {
    const msg = await google(env, "GET", `${GMAIL}/messages/${encodeURIComponent(m.id)}?format=metadata&metadataHeaders=From&metadataHeaders=Subject&metadataHeaders=Date`);
    out.push({ from: header(msg, "From"), subject: header(msg, "Subject"), date: new Date(Number(msg.internalDate) || Date.now()).toISOString(), snippet: String(msg.snippet || "").slice(0, 240) });
  }
  return out;
}

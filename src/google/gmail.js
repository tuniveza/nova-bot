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

import { buildMime, base64Url, canUse, connectedAccount, google, GoogleError } from "../nova/google.js";
import { spamCheck, spamReason } from "../inbox.js";
import { sendEmail as resendEmail } from "../enquiries.js";
import { notifyPhones } from "../push.js";
import { flush, forgetLink, getLink, keepLink, later, links, low, partOn, prep, putLink, readSetting, spendDb, writeSetting } from "./common.js";

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

// What a run reads once: the messages already seen (the last 60 days: older ones are never asked
// for again) and each email address's latest enquiry
async function readContext(env, budget) {
  if (budget.gmail) return budget.gmail;
  const seen = await links(env, budget, "gmail-in", { since: new Date(Date.now() - 60 * 86400000).toISOString() });
  spendDb(budget);
  const { results } = await env.DB.prepare("SELECT id, email FROM enquiries WHERE status != 'spam' AND email LIKE '%@%' ORDER BY id").all();
  const byEmail = new Map(results.map((e) => [String(e.email).toLowerCase(), e.id]));
  budget.gmail = { seen, byEmail };
  return budget.gmail;
}

// A message from them, not from us, not seen before -> where it goes. Returns 1 if added.
async function takeMessage(env, msg, { ref = null, account, budget }) {
  const { seen, byEmail } = await readContext(env, budget);
  if (seen.byNova.has(msg.id)) return 0;
  const markSeen = (extra) => {
    keepLink(env, budget, "gmail-in", msg.id, msg.threadId || "", { extra });
    seen.byNova.set(msg.id, { nova_id: msg.id, extra });
  };
  const from = fromAddress(header(msg, "From"));
  if (!from || from === account.toLowerCase() || (msg.labelIds || []).includes("SENT")) {
    markSeen("ours");
    return 0;
  }
  const body = messageText(msg.payload) || String(msg.snippet || "").slice(0, 500);
  const at = new Date(Number(msg.internalDate) || Date.now()).toISOString();
  const now = new Date().toISOString();
  let enquiryId = null;
  if (ref?.kind === "enquiry") enquiryId = Number(ref.id);
  if (!enquiryId && !ref) enquiryId = byEmail.get(from) || null;
  const subject = header(msg, "Subject").slice(0, 200);
  if (!enquiryId) {
    // A reply about a one-to-one email or an invoice (or someone new): a new enquiry, so the team sees it
    const what = ref?.kind === "outreach" ? "Reply to a one-to-one email" : ref?.kind === "invoice" ? "Reply about an invoice" : "Email";
    spendDb(budget);
    const row = await env.DB.prepare(
      `INSERT INTO enquiries (created_at, name, email, subject, details, page, status, state_at, state_by) VALUES (?, ?, ?, ?, ?, 'gmail', 'new', ?, 'gmail') RETURNING id`
    )
      .bind(at, fromName(header(msg, "From")) || from, from, subject || what, `${what}:\n\n${body}`, now)
      .first();
    enquiryId = row.id;
    byEmail.set(from, enquiryId);
  } else {
    later(
      budget,
      env.DB.prepare(
        `INSERT INTO enquiry_messages (enquiry_id, direction, channel, body, status, created_by, created_at, updated_at) VALUES (?, 'in', 'email', ?, NULL, 'customer', ?, ?)`
      ).bind(enquiryId, body || "(no text)", at, now)
    );
    // Their reply needs looking at: Waiting on them / Done -> Open
    later(budget, env.DB.prepare("UPDATE enquiries SET status = 'open', state_at = ?, state_by = 'gmail' WHERE id = ? AND status IN ('replied', 'done', 'new')").bind(now, enquiryId));
  }
  markSeen(`enquiry:${enquiryId}`);
  return 1;
}

// Threads looked at each run (in turn), and people searched for
const THREADS_PER_RUN = 8;

// Every hour: replies in the threads we started, and emails from people with open enquiries.
// Threads are read small (only which messages they have), and only new messages are read whole.
export async function pullReplies(env, budget) {
  prep(budget);
  try {
    const account = await connectedAccount(env);
    if (!account) return "Not connected";
    let added = 0;
    let more = false;
    const { seen } = await readContext(env, budget);
    const since = new Date(Date.now() - THREAD_DAYS * 86400000).toISOString();
    spendDb(budget);
    const { results: allThreads } = await env.DB.prepare("SELECT nova_id, google_id FROM google_links WHERE kind = 'gmail-thread' AND synced_at >= ? ORDER BY synced_at DESC LIMIT 60").bind(since).all();
    const tAt = Number(await readSetting(env, "google_replies_thread_at")) || 0;
    const start = tAt < allThreads.length ? tAt : 0;
    const threads = allThreads.slice(start, start + THREADS_PER_RUN);
    later(budget, writeSetting(env, "google_replies_thread_at", start + threads.length >= allThreads.length ? 0 : start + threads.length));
    for (const t of threads) {
      if (low(budget, 3)) {
        more = true;
        break;
      }
      budget.left--;
      let data;
      try {
        data = await google(env, "GET", `${GMAIL}/threads/${encodeURIComponent(t.google_id)}?format=minimal&fields=messages(id,labelIds)`);
      } catch (err) {
        if (err.status === 404) continue;
        throw err;
      }
      const [kind, id] = t.nova_id.split(":");
      for (const m of data.messages || []) {
        if (seen.byNova.has(m.id)) continue;
        if ((m.labelIds || []).includes("SENT")) {
          keepLink(env, budget, "gmail-in", m.id, t.google_id, { extra: "ours" });
          seen.byNova.set(m.id, { nova_id: m.id });
          continue;
        }
        if (low(budget, 2)) {
          more = true;
          break;
        }
        budget.left--;
        const msg = await google(env, "GET", `${GMAIL}/messages/${encodeURIComponent(m.id)}?format=full`);
        added += await takeMessage(env, msg, { ref: { kind, id }, account, budget });
      }
    }
    // Open enquiries' people, a few each run (in turn)
    const offset = Number(await readSetting(env, "google_replies_offset")) || 0;
    spendDb(budget);
    const { results: people } = await env.DB.prepare(
      "SELECT DISTINCT email FROM enquiries WHERE status IN ('new', 'open', 'replied') AND email LIKE '%@%' AND created_at >= ? ORDER BY email LIMIT ? OFFSET ?"
    )
      .bind(new Date(Date.now() - 60 * 86400000).toISOString(), SEARCH_PER_RUN, offset)
      .all();
    later(budget, writeSetting(env, "google_replies_offset", people.length < SEARCH_PER_RUN ? 0 : offset + people.length));
    for (const p of people) {
      if (low(budget, 3)) {
        more = true;
        break;
      }
      budget.left--;
      const q = `from:${p.email} newer_than:30d -in:sent -in:spam -in:trash`;
      const list = await google(env, "GET", `${GMAIL}/messages?${new URLSearchParams({ q, maxResults: "5" })}`);
      for (const m of list.messages || []) {
        if (seen.byNova.has(m.id)) continue;
        if (low(budget, 2)) {
          more = true;
          break;
        }
        budget.left--;
        const msg = await google(env, "GET", `${GMAIL}/messages/${encodeURIComponent(m.id)}?format=full`);
        added += await takeMessage(env, msg, { account, budget });
      }
    }
    await flush(env, budget);
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
    const n = [...seen.byNova.values()].filter((l) => l.extra && l.extra !== "ours").length;
    return { note: `${n} repl${n === 1 ? "y" : "ies"} brought in (last 60 days)${added ? ` · ${added} new just now` : ""}${more ? " · more next run" : ""}`, more };
  } finally {
    await flush(env, budget).catch(() => {});
  }
}

// ===== THE STUDIO'S GMAIL AS ENQUIRIES' INBOX =====
//
// Every 15 minutes, new emails to the studio's Gmail (its Primary inbox, the last 3 days) come into
// Enquiries, like the website's enquiry form: newsletters, notifications, mailing lists and other
// automatic email stay out, and likely spam goes to Enquiries' Spam folder (src/inbox.js's check).
// A reply in a thread that's already an enquiry joins that enquiry instead. With the gmail.modify
// permission, each one gets a "Nova" label in Gmail, and an enquiry marked Done is archived in Gmail
// (back in the inbox if it's opened again). Nothing is ever sent from here.

const INBOX_PER_RUN = 10;
const ARCHIVE_PER_RUN = 5;
const LABEL_KEY = "google_gmail_label";
const AUTO_FROM = /(^|[._+-])(no-?reply|do-?not-?reply|notifications?|notify|alerts?|mailer-daemon|postmaster|bounces?|newsletters?|news|marketing|updates?|digest|receipts?|billing|invoices?)([._+-]|@)/i;
const AUTO_DOMAINS = /@([\w-]+\.)*(google\.com|googlemail\.com|youtube\.com|facebookmail\.com|facebook\.com|instagram\.com|linkedin\.com|x\.com|twitter\.com|tiktok\.com|stripe\.com|paypal\.(com|co\.uk)|acuityscheduling\.com|squarespace\.com|mailchimp\.com|mailerlite\.com|resend\.(com|dev)|cloudflare\.com|github\.com|apple\.com|amazon\.(com|co\.uk)|soundcloud\.com|spotify\.com|distrokid\.com|canva\.com|zoom\.us|eventbrite\.(com|co\.uk))>?$/i;

// Sent by a machine (a newsletter, a notification, a mailing list, an auto-reply)?
export function looksAutomated(msg) {
  const h = (name) => header(msg, name);
  if (h("List-Id") || h("List-Unsubscribe") || h("List-Post")) return true;
  if (/^(bulk|list|junk|auto_reply)$/i.test(h("Precedence").trim())) return true;
  const auto = h("Auto-Submitted").trim().toLowerCase();
  if (auto && auto !== "no") return true;
  if (h("X-Auto-Response-Suppress") || h("X-Autoreply") || h("X-Autorespond")) return true;
  const from = fromAddress(h("From"));
  return AUTO_FROM.test(from) || AUTO_DOMAINS.test(from);
}

// Gmail's "Nova" label (made once), or null without the permission
async function novaLabel(env, budget) {
  const saved = await readSetting(env, LABEL_KEY);
  if (saved) return saved;
  budget.left--;
  const list = await google(env, "GET", `${GMAIL}/labels`);
  let id = (list.labels || []).find((l) => l.name === "Nova")?.id;
  if (!id) {
    budget.left--;
    id = (await google(env, "POST", `${GMAIL}/labels`, { name: "Nova", labelListVisibility: "labelShow", messageListVisibility: "show" })).id;
  }
  later(budget, writeSetting(env, LABEL_KEY, id));
  return id;
}

const META_HEADERS = ["From", "Subject", "Message-ID", "List-Id", "List-Unsubscribe", "List-Post", "Precedence", "Auto-Submitted", "X-Auto-Response-Suppress", "X-Autoreply", "X-Autorespond"];

export async function pullInbox(env, budget) {
  prep(budget);
  try {
    const account = await connectedAccount(env);
    if (!account) return "Not connected";
    const { seen } = await readContext(env, budget);
    const threads = await links(env, budget, "gmail-thread");
    const modify = await canUse(env, "modify").catch(() => false);
    const label = modify ? await novaLabel(env, budget) : null;
    budget.left--;
    const list = await google(env, "GET", `${GMAIL}/messages?${new URLSearchParams({ q: "in:inbox category:primary -from:me newer_than:3d -in:chats", maxResults: "25" })}`);
    const fresh = (list.messages || []).filter((m) => !seen.byNova.has(m.id)).reverse(); // oldest first
    let added = 0;
    let spam = 0;
    let skipped = 0;
    let more = fresh.length > INBOX_PER_RUN;
    const newOnes = [];
    for (const m of fresh.slice(0, INBOX_PER_RUN)) {
      if (low(budget, 4)) {
        more = true;
        break;
      }
      budget.left--;
      const params = new URLSearchParams({ format: "metadata" });
      for (const h of META_HEADERS) params.append("metadataHeaders", h);
      const meta = await google(env, "GET", `${GMAIL}/messages/${encodeURIComponent(m.id)}?${params}`);
      const from = fromAddress(header(meta, "From"));
      if (!from || from === account.toLowerCase()) {
        keepLink(env, budget, "gmail-in", m.id, meta.threadId || "", { extra: "ours" });
        seen.byNova.set(m.id, { extra: "ours" });
        continue;
      }
      if (looksAutomated(meta)) {
        keepLink(env, budget, "gmail-in", m.id, meta.threadId || "", { extra: "skipped" });
        seen.byNova.set(m.id, { extra: "skipped" });
        skipped++;
        continue;
      }
      budget.left--;
      const msg = await google(env, "GET", `${GMAIL}/messages/${encodeURIComponent(m.id)}?format=full`);
      // A reply in a thread that's already an enquiry: it joins that one
      const thread = threads.byGoogle.get(String(meta.threadId || ""));
      if (thread && /^enquiry:\d+$/.test(thread.nova_id)) {
        added += await takeMessage(env, msg, { ref: { kind: "enquiry", id: thread.nova_id.split(":")[1] }, account, budget });
        continue;
      }
      const body = messageText(msg.payload) || String(msg.snippet || "").slice(0, 500);
      const name = fromName(header(meta, "From")) || from;
      const subject = header(meta, "Subject").slice(0, 200) || "Email";
      const check = spamCheck({ name, email: from, subject, details: body });
      const at = new Date(Number(msg.internalDate) || Date.now()).toISOString();
      const now = new Date().toISOString();
      spendDb(budget);
      const row = await env.DB.prepare(
        `INSERT INTO enquiries (created_at, name, email, subject, details, page, consent_at, consent_source, status, spam_reason, state_at, state_by)
         VALUES (?, ?, ?, ?, ?, 'gmail', ?, 'Emailed the studio (Gmail)', ?, ?, ?, 'gmail') RETURNING id`
      )
        .bind(at, name.slice(0, 100), from, subject, body || "(no text)", at, check.spam ? "spam" : "new", check.spam ? spamReason(check) : null, now)
        .first();
      // So a reply from Enquiries joins this Gmail thread, and their next email lands here too
      keepLink(env, budget, "gmail-thread", `enquiry:${row.id}`, msg.threadId || meta.threadId, { extra: header(meta, "Message-ID") || null });
      keepLink(env, budget, "gmail-in", m.id, msg.threadId || "", { extra: `enquiry:${row.id}` });
      seen.byNova.set(m.id, { extra: `enquiry:${row.id}` });
      if (label && !low(budget, 2)) {
        budget.left--;
        await google(env, "POST", `${GMAIL}/messages/${encodeURIComponent(m.id)}/modify`, { addLabelIds: [label] }).catch(() => {});
      }
      if (check.spam) spam++;
      else {
        added++;
        newOnes.push(name);
      }
    }
    const archived = modify ? await archiveDone(env, budget) : 0;
    await flush(env, budget);
    if (newOnes.length) {
      try {
        await notifyPhones(env, {
          title: newOnes.length === 1 ? `New email: ${newOnes[0]}` : `${newOnes.length} new emails`,
          body: "In Portal → Enquiries.",
          url: "/portal/?view=enquiries",
          style: { source: "portal", kind: "enquiry", tag: "gmail-inbox", ttl: 12 * 3600, urgent: false },
        });
      } catch {}
    }
    const parts = [added && `${added} new`, spam && `${spam} to Spam`, skipped && `${skipped} automatic left out`, archived && `${archived} archived in Gmail`].filter(Boolean);
    return { note: `Inbox checked${parts.length ? ` · ${parts.join(", ")}` : " · nothing new"}${more ? " · more next run" : ""}`, more };
  } finally {
    await flush(env, budget).catch(() => {});
  }
}

// Enquiries from Gmail marked Done: archived in Gmail; opened again: back in the inbox
async function archiveDone(env, budget) {
  const done = await links(env, budget, "gmail-archived");
  spendDb(budget);
  const { results } = await env.DB.prepare(
    `SELECT e.id, e.status, l.google_id AS thread FROM enquiries e JOIN google_links l ON l.kind = 'gmail-thread' AND l.nova_id = 'enquiry:' || e.id
     WHERE e.page = 'gmail' AND (e.status = 'done' OR e.id IN (SELECT CAST(nova_id AS INTEGER) FROM google_links WHERE kind = 'gmail-archived'))
     ORDER BY e.id DESC LIMIT 50`
  ).all();
  let n = 0;
  for (const e of results) {
    if (n >= ARCHIVE_PER_RUN || low(budget, 2)) break;
    const archived = done.byNova.has(String(e.id));
    if (e.status === "done" && !archived) {
      budget.left--;
      await google(env, "POST", `${GMAIL}/threads/${encodeURIComponent(e.thread)}/modify`, { removeLabelIds: ["INBOX"] }).catch(() => {});
      keepLink(env, budget, "gmail-archived", e.id, e.thread);
      n++;
    } else if (e.status !== "done" && archived) {
      budget.left--;
      await google(env, "POST", `${GMAIL}/threads/${encodeURIComponent(e.thread)}/modify`, { addLabelIds: ["INBOX"] }).catch(() => {});
      forgetLink(env, budget, "gmail-archived", e.id);
      n++;
    }
  }
  return n;
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

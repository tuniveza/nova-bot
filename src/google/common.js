// Google, everywhere it helps: what the parts share (src/google/*.js; migrations/0032_google.sql).
//
// The options (each part can be switched off in Portal → Admin → Google), where each sync got to,
// how each part last went (for Portal's status: "Calendar · synced 2 min ago" or what's wrong, in
// plain words), and the links between Nova's things and Google's (google_links).
//
// Logs say kinds and counts only, never anyone's details or a key.

import { canUse, connectedAccount, googleReady, offline } from "../nova/google.js";

// ===== OPTIONS =====

// Every part, its default, and the permission it needs (FEATURE_SCOPES in nova/google.js). Names short enough for one
// line on a phone held upright, the rest of the old words at the start of the help line (24 Oct 2026: rules.js
// into the base code; Nova Phone's Google switches wrapped)
export const OPTIONS = {
  calendar: { label: "Calendar", on: true, needs: "calendar", help: "Nova's Calendar and Google Calendar, both ways." },
  calendarPlan: { label: "Quests and music time", on: false, needs: "calendar", help: "Quests and music time in Google Calendar: also put Nova Agent's plan into the Novacane Studio calendar." },
  bookings: { label: "Bookings in Calendar", on: true, needs: "calendar", help: "Bookings in Google Calendar: copies of Acuity's bookings (they're still booked in Acuity)." },
  send: { label: "Send from Gmail", on: true, needs: "send", help: "Send approved emails from Gmail: replies, one-to-one emails, invoices and reminders go from the studio's Gmail, so they're in its Sent folder." },
  replies: { label: "Replies into Enquiries", on: true, needs: "replies", help: "Customers' replies to those emails to those emails land back in the right enquiry." },
  contacts: { label: "Clients in Contacts", on: true, needs: "contacts", help: "Clients in Google Contacts, under a \"Novacane clients\" label, both ways." },
  drive: { label: "Pictures in Drive", on: true, needs: "drive", help: "Pictures, videos and receipts in Google Drive, in a \"Nova Agent\" folder, so posts go out even with the studio PC off." },
  backups: { label: "Nightly backups", on: true, needs: "drive", help: "Nightly backups to Google Drive: Index and the PC's files, every night." },
  sheets: { label: "Money in Sheets", on: true, needs: "drive", help: "Money in Google Sheets: a live sheet of invoices, payments and expenses for the accountant." },
  inbox: { label: "Gmail as the inbox", on: true, needs: "replies", help: "Gmail as Enquiries' inbox: new customer emails to the studio's Gmail come into Enquiries (newsletters, notifications and spam stay out). With the Gmail permission they get a \"Nova\" label, and they're archived in Gmail when they're done." },
  meet: { label: "Google Meet links", on: true, needs: "calendar", help: "Events you tick \"Google Meet\" on in Calendar, and online-session bookings, get a Meet link." },
  tasks: { label: "Quests in Tasks", on: true, needs: "tasks", help: "Quests in Google Tasks, in a \"Nova quests\" list; ticking one off in Google Tasks marks it done in Nova." },
  docs: { label: "Notes in Docs", on: true, needs: "drive", help: "Notes kept in Google Docs: notes you mark \"Keep in Google Docs\" stay in step with their Google Doc, both ways (the newest change wins; the other is kept as a copy)." },
  files: { label: "Files in Drive", on: true, needs: "drive", help: "Files and invoices in Drive: Agent's files in \"Nova Agent/Files\" and each sent invoice in \"Nova Agent/Invoices\", kept up to date." },
  youtube: { label: "YouTube", on: true, needs: "youtube", help: "The channel's numbers in Social, and YouTube as a place to post videos (uploaded only after an admin's Approve)." },
};

const optKey = (name) => `google_opt_${name}`;

export async function readSetting(env, key) {
  return env.DB.prepare("SELECT value FROM settings WHERE key = ?").bind(key).first("value").catch(() => null);
}
export function writeSetting(env, key, value) {
  return env.DB.prepare("INSERT INTO settings (key, value) VALUES (?, ?) ON CONFLICT (key) DO UPDATE SET value = excluded.value").bind(key, String(value));
}

// { calendar: true, ... } as chosen (or the defaults)
export async function readOptions(env) {
  const { results } = await env.DB.prepare("SELECT key, value FROM settings WHERE key LIKE 'google_opt_%'").all();
  const saved = Object.fromEntries(results.map((r) => [r.key.slice("google_opt_".length), r.value === "1"]));
  return Object.fromEntries(Object.entries(OPTIONS).map(([k, o]) => [k, k in saved ? saved[k] : o.on]));
}

export async function setOptions(env, changes) {
  const statements = [];
  for (const [k, v] of Object.entries(changes || {})) if (k in OPTIONS && typeof v === "boolean") statements.push(writeSetting(env, optKey(k), v ? "1" : "0"));
  if (statements.length) await env.DB.batch(statements);
  return readOptions(env);
}

// Is this part on, and does the connection allow it? (false in the sandbox without Google)
export async function partOn(env, name) {
  if (offline(env)) return false;
  const opt = OPTIONS[name];
  if (!opt || !(await googleReady(env))) return false;
  if (!(await readOptions(env))[name]) return false;
  return canUse(env, opt.needs);
}

// ===== ONE RUN, WITHIN THE FREE WORKERS PLAN =====
//
// Nova Bot runs on Cloudflare Workers' free plan: each run may make about 50 outside calls (and
// about 50 trips to the database), use only a few milliseconds of computer time, and has to be done
// well inside 30 seconds. So every part works in small steps: each Google call takes one from
// `left`, each database trip one from `db`, and a part stops when either runs low or its time is
// up, saves where it got to, and carries on next time (status: "… finishing next run"). Links are
// read once per kind per run (into maps), and the links it makes are written together at the end.
//
// A budget: { left, db, until, ops, kinds }. Tests pass a plain { left: 40 }: the rest is filled in.

export const RUN_CALLS = 40;
export const RUN_DB = 40;
export const RUN_MS = 22_000;

export function newBudget({ calls = RUN_CALLS, db = RUN_DB, ms = RUN_MS } = {}) {
  return prep({ left: calls, db, until: Date.now() + ms });
}
export function prep(budget) {
  if (budget.db === undefined) budget.db = RUN_DB;
  if (budget.until === undefined) budget.until = Date.now() + RUN_MS;
  if (!budget.ops) budget.ops = [];
  if (!budget.kinds) budget.kinds = new Map();
  return budget;
}
// Time to stop? (`keep`: Google calls to keep in hand for finishing off)
export function low(budget, keep = 2) {
  prep(budget);
  return budget.left <= keep || budget.db <= 4 || Date.now() > budget.until;
}
export const spendDb = (budget, n = 1) => void (prep(budget).db -= n);

// Every link of one kind, read once this run: { byNova: Map, byGoogle: Map }. `since`: only those
// synced since then (Gmail's seen-messages list grows; only the recent ones matter)
export async function links(env, budget, kind, { since = null } = {}) {
  prep(budget);
  const key = kind + (since ? "@" + since : "");
  if (!budget.kinds.has(key)) {
    spendDb(budget);
    const { results } = since
      ? await env.DB.prepare("SELECT * FROM google_links WHERE kind = ? AND synced_at >= ?").bind(kind, since).all()
      : await env.DB.prepare("SELECT * FROM google_links WHERE kind = ?").bind(kind).all();
    const byNova = new Map();
    const byGoogle = new Map();
    for (const l of results) {
      byNova.set(String(l.nova_id), l);
      byGoogle.set(String(l.google_id), l);
    }
    budget.kinds.set(key, { byNova, byGoogle });
  }
  return budget.kinds.get(key);
}
export async function linkOf(env, budget, kind, novaId) {
  return (await links(env, budget, kind)).byNova.get(String(novaId)) || null;
}
export async function linkFor(env, budget, kind, googleId) {
  return (await links(env, budget, kind)).byGoogle.get(String(googleId)) || null;
}
// Remember a link (written at the end of the run, with the others)
export function keepLink(env, budget, kind, novaId, googleId, { extra = null, hash = null } = {}) {
  prep(budget);
  const row = { kind, nova_id: String(novaId), google_id: String(googleId), extra, hash, synced_at: nowIso() };
  for (const [key, maps] of budget.kinds) {
    if (key !== kind && !key.startsWith(kind + "@")) continue;
    const old = maps.byNova.get(row.nova_id);
    if (old) maps.byGoogle.delete(String(old.google_id));
    maps.byNova.set(row.nova_id, row);
    maps.byGoogle.set(row.google_id, row);
  }
  budget.ops.push(putLink(env, kind, novaId, googleId, { extra, hash }));
}
export function forgetLink(env, budget, kind, novaId) {
  prep(budget);
  for (const [key, maps] of budget.kinds) {
    if (key !== kind && !key.startsWith(kind + "@")) continue;
    const old = maps.byNova.get(String(novaId));
    if (old) maps.byGoogle.delete(String(old.google_id));
    maps.byNova.delete(String(novaId));
  }
  budget.ops.push(dropLink(env, kind, novaId));
}
// A database write that can wait for the end of the run
export const later = (budget, statement) => void prep(budget).ops.push(statement);
// Write everything that waited (in batches: one trip each)
export async function flush(env, budget) {
  prep(budget);
  while (budget.ops.length) {
    const chunk = budget.ops.splice(0, 50);
    spendDb(budget);
    await env.DB.batch(chunk);
  }
}

// ===== HOW EACH PART LAST WENT =====

// { calendar: { at, ok, note }, ... }
export async function readStatus(env) {
  try {
    return JSON.parse((await readSetting(env, "google_status")) || "{}");
  } catch {
    return {};
  }
}

// Remember how a part went: ok with a short note ("12 events in step"), or what went wrong.
// `more`: it stopped part-way (within the run's limits) and carries on at the next free minute.
// `running`: started from Portal's "Sync now", not finished yet.
export async function noteStatus(env, part, ok, note, { more = false, running = false } = {}) {
  const status = await readStatus(env);
  status[part] = { at: new Date().toISOString(), ok: Boolean(ok), note: String(note || "").slice(0, 300), ...(more ? { more: true } : {}), ...(running ? { running: true } : {}) };
  await writeSetting(env, "google_status", JSON.stringify(status)).run();
}

// What a part's work returns: a note, or { note, more } when it stopped part-way
const noteOf = (out) => (out && typeof out === "object" ? out.note : out);
const moreOf = (out) => Boolean(out && typeof out === "object" && out.more);

// Run one part, noting how it went (never throws: one part failing doesn't stop the others).
// Google saying "slow down" or failing for a moment puts that part on hold for a while (longer
// each time, up to 2 hours); Google turning the connection down asks an admin, once a day, to
// connect again.
export async function runPart(env, part, work) {
  try {
    const out = await work();
    const note = noteOf(out);
    if (note !== undefined && note !== null) await noteStatus(env, part, true, note, { more: moreOf(out) });
    await clearTrouble(env, part).catch(() => {});
    return { ok: true, note, more: moreOf(out) };
  } catch (err) {
    console.log(`Google ${part}: ${err?.message ? String(err.message).slice(0, 200) : err}`);
    const problem = plainProblem(err);
    const hold = await noteTrouble(env, part, err).catch(() => null);
    await noteStatus(env, part, false, hold ? `${problem} Next try: ${ukTime(hold)}.` : problem).catch(() => {});
    return { ok: false, error: problem };
  }
}

const ukTime = (ms) => new Date(ms).toLocaleTimeString("en-GB", { timeZone: "Europe/London", hour: "2-digit", minute: "2-digit" });

// ===== WHEN GOOGLE SAYS "NOT NOW" =====

const BACKOFF_KEY = "google_backoff";
export const RECONNECT_KEY = "google_reconnect";
const RECONNECT_PING_KEY = "google_reconnect_pinged";

export async function readBackoff(env) {
  try {
    return JSON.parse((await readSetting(env, BACKOFF_KEY)) || "{}");
  } catch {
    return {};
  }
}
// Is this part on hold just now?
export async function onHold(env, part, at = Date.now()) {
  const b = (await readBackoff(env))[part];
  return Boolean(b && b.until > at);
}
// A failure that may pass (Google busy, slow, briefly down): hold the part 5, 10, 20… minutes (2 h
// at most). The connection turned down: say so (Portal shows "Connect again"), and ping the admins
// once a day. -> when it's tried next (ms), or null
async function noteTrouble(env, part, err) {
  if (err?.reconnect) {
    await markReconnect(env);
    return null;
  }
  const passing = err?.status === 429 || err?.status >= 500 || /timed? ?out|AbortError|fetch failed/i.test(String(err?.message || ""));
  if (!passing) return null;
  const all = await readBackoff(env);
  const n = Math.min((all[part]?.n || 0) + 1, 6);
  const until = Date.now() + Math.min(5 * 60_000 * 2 ** (n - 1), 2 * 3600_000);
  all[part] = { n, until };
  await writeSetting(env, BACKOFF_KEY, JSON.stringify(all)).run();
  return until;
}
async function clearTrouble(env, part) {
  const all = await readBackoff(env);
  if (!all[part]) return;
  delete all[part];
  await writeSetting(env, BACKOFF_KEY, JSON.stringify(all)).run();
}

// Google turned the saved connection down: Portal says "Connect again", and the admins' phones get
// one calm ping a day until someone does
export async function markReconnect(env) {
  const now = new Date().toISOString();
  const [already, pinged] = await Promise.all([readSetting(env, RECONNECT_KEY), readSetting(env, RECONNECT_PING_KEY)]);
  const statements = [];
  if (!already) statements.push(writeSetting(env, RECONNECT_KEY, now));
  const ping = !pinged || Date.now() - Date.parse(pinged) > 24 * 3600_000;
  if (ping) statements.push(writeSetting(env, RECONNECT_PING_KEY, now));
  if (statements.length) await env.DB.batch(statements);
  if (!ping) return;
  try {
    const { notifyPhones } = await import("../push.js");
    const { results } = await env.DB.prepare("SELECT id FROM staff WHERE role = 'admin' AND status = 'active'").all();
    if (!results.length) return;
    await notifyPhones(env, {
      title: "Google needs connecting again",
      body: "Google stopped Nova Agent's connection. Portal → Admin → Google → Connect again (a minute).",
      url: "/portal/?view=google",
      style: { source: "portal", kind: "google", tag: "google-reconnect", ttl: 24 * 3600, urgent: false },
      to: { staff: results.map((r) => r.id) },
    });
  } catch (e) {
    console.log("Google: the reconnect ping didn't go");
  }
}
export async function needsReconnect(env) {
  return Boolean(await readSetting(env, RECONNECT_KEY));
}

// A Google error in plain words
export function plainProblem(err) {
  const msg = String(err?.message || err || "Something went wrong.");
  if (err?.reconnect || /invalid_grant|turned down the saved connection/i.test(msg)) return "Google stopped the connection. Portal → Admin → Google → Connect again.";
  if (err?.status === 403 && /has not been used|is disabled|accessNotConfigured|API has not/i.test(msg)) return "That Google feature isn't switched on in Google Cloud yet: step 1 of the setup, then try again.";
  if (err?.status === 403) return "Google said no (no permission). Press Connect Google again and tick every box.";
  if (err?.status === 429) return "Google asked Nova to slow down; it tries again shortly.";
  if (/timed? ?out|AbortError/i.test(msg)) return "Google took too long to answer; it tries again shortly.";
  return msg.slice(0, 200);
}

// ===== LINKS: WHICH NOVA THING IS WHICH GOOGLE THING =====

const nowIso = () => new Date().toISOString();

export async function getLink(env, kind, novaId) {
  return env.DB.prepare("SELECT * FROM google_links WHERE kind = ? AND nova_id = ?").bind(kind, String(novaId)).first();
}
export async function linkByGoogle(env, kind, googleId) {
  return env.DB.prepare("SELECT * FROM google_links WHERE kind = ? AND google_id = ?").bind(kind, String(googleId)).first();
}
export function putLink(env, kind, novaId, googleId, { extra = null, hash = null } = {}) {
  return env.DB.prepare(
    `INSERT INTO google_links (kind, nova_id, google_id, extra, hash, synced_at) VALUES (?, ?, ?, ?, ?, ?)
     ON CONFLICT (kind, nova_id) DO UPDATE SET google_id = excluded.google_id, extra = excluded.extra, hash = excluded.hash, synced_at = excluded.synced_at`
  ).bind(kind, String(novaId), String(googleId), extra, hash, nowIso());
}
export function dropLink(env, kind, novaId) {
  return env.DB.prepare("DELETE FROM google_links WHERE kind = ? AND nova_id = ?").bind(kind, String(novaId));
}

export async function sha(text) {
  const bytes = new Uint8Array(await crypto.subtle.digest("SHA-256", new TextEncoder().encode(String(text))));
  return [...bytes].map((b) => b.toString(16).padStart(2, "0")).join("").slice(0, 32);
}

export { connectedAccount };

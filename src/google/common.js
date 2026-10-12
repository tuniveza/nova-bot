// Google, everywhere it helps: what the parts share (src/google/*.js; migrations/0032_google.sql).
//
// The options (each part can be switched off in Portal → Admin → Google), where each sync got to,
// how each part last went (for Portal's status: "Calendar · synced 2 min ago" or what's wrong, in
// plain words), and the links between Nova's things and Google's (google_links).
//
// Logs say kinds and counts only, never anyone's details or a key.

import { canUse, connectedAccount, googleReady, offline } from "../nova/google.js";

// ===== OPTIONS =====

// Every part, its default, and the permission it needs (FEATURE_SCOPES in nova/google.js)
export const OPTIONS = {
  calendar: { label: "Calendar", on: true, needs: "calendar", help: "Nova's Calendar and Google Calendar, both ways." },
  calendarPlan: { label: "Quests and music time in Google Calendar", on: false, needs: "calendar", help: "Also put Nova Agent's plan into the Novacane Studio calendar." },
  bookings: { label: "Bookings in Google Calendar", on: true, needs: "calendar", help: "Copies of Acuity's bookings (they're still booked in Acuity)." },
  send: { label: "Send approved emails from Gmail", on: true, needs: "send", help: "Replies, one-to-one emails, invoices and reminders go from the studio's Gmail, so they're in its Sent folder." },
  replies: { label: "Customers' replies into Enquiries", on: true, needs: "replies", help: "Replies to those emails land back in the right enquiry." },
  contacts: { label: "Clients in Google Contacts", on: true, needs: "contacts", help: "Under a \"Novacane clients\" label, both ways." },
  drive: { label: "Pictures, videos and receipts in Google Drive", on: true, needs: "drive", help: "In a \"Nova Agent\" folder, so posts go out even with the studio PC off." },
  backups: { label: "Nightly backups to Google Drive", on: true, needs: "drive", help: "Index and the PC's files, every night." },
  sheets: { label: "Money in Google Sheets", on: true, needs: "drive", help: "A live sheet of invoices, payments and expenses for the accountant." },
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

// ===== HOW EACH PART LAST WENT =====

// { calendar: { at, ok, note }, ... }
export async function readStatus(env) {
  try {
    return JSON.parse((await readSetting(env, "google_status")) || "{}");
  } catch {
    return {};
  }
}

// Remember how a part went: ok with a short note ("12 events in step"), or what went wrong
export async function noteStatus(env, part, ok, note) {
  const status = await readStatus(env);
  status[part] = { at: new Date().toISOString(), ok: Boolean(ok), note: String(note || "").slice(0, 300) };
  await writeSetting(env, "google_status", JSON.stringify(status)).run();
}

// Run one part, noting how it went (never throws: one part failing doesn't stop the others)
export async function runPart(env, part, work) {
  try {
    const note = await work();
    if (note !== undefined && note !== null) await noteStatus(env, part, true, note);
    return { ok: true, note };
  } catch (err) {
    console.log(`Google ${part}: ${err?.message ? String(err.message).slice(0, 200) : err}`);
    await noteStatus(env, part, false, plainProblem(err)).catch(() => {});
    return { ok: false, error: plainProblem(err) };
  }
}

// A Google error in plain words
export function plainProblem(err) {
  const msg = String(err?.message || err || "Something went wrong.");
  if (/invalid_grant|turned down the saved connection/i.test(msg)) return "Google stopped the connection. Press Connect Google again.";
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

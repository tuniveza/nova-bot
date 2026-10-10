// The client list (Quest 2): everyone who has booked or enquired, in one place
//
// The studio's Acuity plan has no API, so the list is built from what Nova Bot can read:
//   - Acuity's private calendar feed (booking-calendar.js): every booking in it, every 30
//     minutes (the cron, index.js) and when an admin presses "Sync with Acuity now"
//   - Acuity's webhook (referrals.js): each booking as it's made, moved or cancelled
//   - enquiries: each person who enquired becomes a client (with no sessions)
//   - the appointments and clients spreadsheets (CSV) an admin downloads from Acuity's
//     website and imports in Portal (for the history the feed no longer has)
//
// One person is one client: the same email (any case), else the same mobile number, else
// (with neither) the same exact name. Running a sync or an import twice changes nothing. A
// sync only fills in contact details that are missing: what staff typed always wins.
//
// Marketing consent (UK GDPR) is NO for everyone until staff record a yes with where it came
// from; every change is written to client_consent_log. Nothing here ever sets it from a sync
// or an import, and an enquiry's consent to be replied to isn't marketing consent.
//
// Logs say ids and counts only, never a client's details.

import { feedTimeToIso, listBookings } from "./booking-calendar.js";
import { dialNumber } from "./enquiries.js";
import { TEST_NAME } from "./acuity-test-booking.js";
import { isUkDate, ukWallToUtc } from "./acuity/api.js";

// The most clients one list returns (Portal), and one search for Nova Agent
const LIST_MAX = 500;
const FIND_MAX = 20;
// The cron syncs this often (it runs every minute)
const SYNC_EVERY_MINUTES = 30;
const SYNC_STAMP = "clients_synced_at";
// The biggest spreadsheet an import takes (characters)
const MAX_CSV = 5_000_000;
// Statements per database batch
const BATCH = 100;
// What an email address looks like
const EMAIL_PATTERN = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

// ===== TIDYING WHAT COMES IN =====

const nowIso = () => new Date().toISOString();

// An email, lower-case, or null
export function cleanEmail(value) {
  const email = typeof value === "string" ? value.trim().toLowerCase().slice(0, 200) : "";
  return email.includes("@") ? email : null;
}

// A phone number as typed, or null
function cleanPhone(value) {
  return typeof value === "string" && value.trim() ? value.trim().slice(0, 40) : null;
}

// The number for matching: the full international mobile ("+447700900123"), else its digits, or null
export function phoneKey(value) {
  const raw = cleanPhone(value);
  if (!raw) return null;
  return dialNumber(raw) || raw.replace(/\D/g, "") || null;
}

// A name on one line, or ""
function cleanName(value) {
  return typeof value === "string" ? value.replace(/\s+/g, " ").trim().slice(0, 100) : "";
}

// Money: whole pence -> "120.00"
export function pounds(pence) {
  const p = Math.round(Number(pence) || 0);
  const sign = p < 0 ? "-" : "";
  const abs = Math.abs(p);
  return `${sign}${Math.floor(abs / 100)}.${String(abs % 100).padStart(2, "0")}`;
}

// Money: "120.00", "£1,200.5" or 120.5 -> whole pence, or null if it isn't an amount
export function toPence(value) {
  const text = typeof value === "number" && Number.isFinite(value) ? value.toFixed(2) : typeof value === "string" ? value : "";
  const m = text.trim().replace(/^£\s*/, "").replace(/,/g, "").match(/^(\d{1,7})(?:\.(\d{0,2}))?$/);
  if (!m) return null;
  return Number(m[1]) * 100 + Number((m[2] || "").padEnd(2, "0"));
}

// A UK day ("2026-07-01") -> the UTC moment it starts in the UK
function ukDayStart(day) {
  return ukWallToUtc(day + "T00:00")?.toISOString() || null;
}

// ===== THE CLIENT BOOK: matching, in memory, then saved in a few batches =====
// Everything a sync needs is read once, matched here, and written back in batches, so a
// big feed or spreadsheet is a handful of database calls rather than thousands.

class ClientBook {
  constructor(by) {
    // Who a sync's changes are put down to ('acuity', 'enquiry' or 'import')
    this.by = by;
    this.byId = new Map();
    this.byEmail = new Map();
    this.byPhone = new Map();
    this.byName = new Map();
    this.byAcuity = new Map();
    this.byKey = new Map();
    this.newClients = [];
    this.changedClients = new Set();
    this.newSessions = [];
    this.changedSessions = new Set();
    this.nextTemp = -1;
  }

  // Everything (a sync or an import), or just what one booking could match (the webhook)
  static async load(env, by, scope) {
    const book = new ClientBook(by);
    const CLIENT_COLS = "SELECT id, name, email, phone, phone_key, notes FROM clients";
    const SESSION_COLS = "SELECT id, acuity_id, client_id, session, starts_at, ends_at, price, status FROM client_sessions";
    let clients;
    let sessions;
    if (scope) {
      clients = (
        await env.DB.prepare(`${CLIENT_COLS} WHERE email = ?1 OR phone_key = ?2 OR name = ?3 OR id IN (SELECT client_id FROM client_sessions WHERE acuity_id = ?4) ORDER BY id`)
          .bind(scope.email, scope.phoneKey, scope.name || null, scope.acuityId)
          .all()
      ).results;
      sessions = (
        await env.DB.prepare(`${SESSION_COLS} WHERE acuity_id = ?1 OR client_id IN (SELECT value FROM json_each(?2)) ORDER BY id`)
          .bind(scope.acuityId, JSON.stringify(clients.map((c) => c.id)))
          .all()
      ).results;
    } else {
      clients = (await env.DB.prepare(`${CLIENT_COLS} ORDER BY id`).all()).results;
      sessions = (await env.DB.prepare(`${SESSION_COLS} ORDER BY id`).all()).results;
    }
    for (const c of clients) book.index(c);
    for (const s of sessions) book.indexSession(s);
    return book;
  }

  // Remember a client by everything it can be matched on (the oldest wins a tie)
  index(c) {
    this.byId.set(c.id, c);
    if (c.email && !this.byEmail.has(c.email)) this.byEmail.set(c.email, c);
    if (c.phone_key && !this.byPhone.has(c.phone_key)) this.byPhone.set(c.phone_key, c);
    if (c.name && !this.byName.has(c.name)) this.byName.set(c.name, c);
  }

  indexSession(s) {
    if (s.acuity_id) this.byAcuity.set(Number(s.acuity_id), s);
    else this.byKey.set(sessionKey(s.client_id, s.starts_at, s.session), s);
  }

  // The client this person already is, or null
  find({ email, key, name }) {
    if (email && this.byEmail.has(email)) return this.byEmail.get(email);
    if (key && this.byPhone.has(key)) return this.byPhone.get(key);
    if (!email && !key && name) return this.byName.get(name) || null;
    return null;
  }

  // A person from a booking, an enquiry or a spreadsheet: their client (found or new), or null
  // if there's nothing to know them by. `client` skips the matching (a booking already stored).
  person(raw, source, client = null) {
    const email = cleanEmail(raw.email);
    const phone = cleanPhone(raw.phone);
    const key = phoneKey(phone);
    const name = cleanName(raw.name) || email || phone || "";
    const notes = typeof raw.notes === "string" ? raw.notes.trim().slice(0, 4000) : "";
    if (!name) return null;
    const found = client || this.find({ email, key, name });
    if (found) {
      // Fill in only what's missing (never overwrite what staff typed)
      let changed = false;
      if (!found.email && email && !this.byEmail.has(email)) {
        found.email = email;
        this.byEmail.set(email, found);
        changed = true;
      }
      if (!found.phone && phone) {
        found.phone = phone;
        found.phone_key = key;
        if (key && !this.byPhone.has(key)) this.byPhone.set(key, found);
        changed = true;
      }
      if (!found.notes && notes) {
        found.notes = notes;
        changed = true;
      }
      if (changed && !found._new) this.changedClients.add(found);
      return found;
    }
    const c = { id: this.nextTemp--, name, email, phone, phone_key: key, notes, source, _new: true };
    this.index(c);
    this.newClients.push(c);
    return c;
  }

  // A session of this client's: added, or what changed noted (cancelled stays cancelled: Acuity
  // never brings a cancelled booking back, it makes a new one)
  session(client, s, source) {
    const acuityId = Number(s.acuityId) || null;
    const row = { session: s.session || null, starts_at: s.start, ends_at: s.end || null, price: s.price || null, status: s.status };
    let found = acuityId ? this.byAcuity.get(acuityId) : null;
    // The same booking imported earlier without its number: give it the number
    const unnumbered = !found ? this.byKey.get(sessionKey(client.id, row.starts_at, row.session)) : null;
    if (!found && unnumbered) found = unnumbered;
    if (found) {
      let changed = false;
      if (acuityId && !found.acuity_id) {
        this.byKey.delete(sessionKey(found.client_id, found.starts_at, found.session));
        found.acuity_id = acuityId;
        this.byAcuity.set(acuityId, found);
        changed = true;
      }
      for (const field of ["session", "starts_at", "ends_at", "price"]) {
        if (row[field] != null && row[field] !== found[field]) {
          if (!found.acuity_id) this.byKey.delete(sessionKey(found.client_id, found.starts_at, found.session));
          found[field] = row[field];
          if (!found.acuity_id) this.byKey.set(sessionKey(found.client_id, found.starts_at, found.session), found);
          changed = true;
        }
      }
      if (row.status === "cancelled" && found.status !== "cancelled") {
        found.status = "cancelled";
        changed = true;
      }
      if (changed) {
        found._source = source;
        if (!found._new) this.changedSessions.add(found);
      }
      return found;
    }
    const added = { id: null, acuity_id: acuityId, client_id: client.id, ...row, _source: source, _new: true, _client: client };
    this.indexSession(added);
    this.newSessions.push(added);
    return added;
  }

  // Write it all down. -> { clients: { added, updated }, sessions: { added, updated } }
  async save(env) {
    const now = nowIso();
    const counts = { clients: { added: 0, updated: 0 }, sessions: { added: 0, updated: 0 } };
    // New clients first (their sessions need their ids)
    for (let i = 0; i < this.newClients.length; i += BATCH) {
      const chunk = this.newClients.slice(i, i + BATCH);
      const results = await env.DB.batch(
        chunk.map((c) =>
          env.DB.prepare(
            "INSERT INTO clients (name, email, phone, phone_key, notes, source, created_at, updated_at, updated_by) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?) ON CONFLICT DO NOTHING RETURNING id"
          ).bind(c.name, c.email, c.phone, c.phone_key, c.notes, c.source, now, now, this.by)
        )
      );
      for (const [j, c] of chunk.entries()) {
        const id = results[j].results?.[0]?.id;
        if (id) {
          c.id = id;
          counts.clients.added++;
        } else {
          // Someone else saved the same email a moment ago: that's them
          c.id = c.email ? await env.DB.prepare("SELECT id FROM clients WHERE email = ?").bind(c.email).first("id") : null;
        }
      }
    }
    // Missing details filled in (only if still missing: staff may have typed them meanwhile)
    const updates = [...this.changedClients].map((c) =>
      env.DB.prepare(
        `UPDATE OR IGNORE clients SET email = COALESCE(email, ?1), phone_key = CASE WHEN phone IS NULL THEN ?3 ELSE phone_key END, phone = COALESCE(phone, ?2),
           notes = CASE WHEN notes = '' THEN ?4 ELSE notes END, updated_at = ?5, updated_by = ?6 WHERE id = ?7`
      ).bind(c.email, c.phone, c.phone_key, c.notes || "", now, this.by, c.id)
    );
    counts.clients.updated = await runBatches(env, updates);
    // New sessions (a client that couldn't be saved takes its sessions with it)
    const inserts = this.newSessions
      .filter((s) => s._client.id > 0)
      .map((s) =>
        env.DB.prepare(
          "INSERT OR IGNORE INTO client_sessions (acuity_id, client_id, session, starts_at, ends_at, price, status, source, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)"
        ).bind(s.acuity_id, s._client.id, s.session, s.starts_at, s.ends_at, s.price, s.status, s._source, now)
      );
    counts.sessions.added = await runBatches(env, inserts);
    // Sessions that changed (cancelled stays cancelled, even if something read the feed a moment before)
    const changes = [...this.changedSessions].map((s) =>
      env.DB.prepare(
        `UPDATE OR IGNORE client_sessions SET acuity_id = ?, session = ?, starts_at = ?, ends_at = ?, price = ?,
           status = CASE WHEN status = 'cancelled' THEN 'cancelled' ELSE ? END, source = ?, updated_at = ? WHERE id = ?`
      ).bind(s.acuity_id, s.session, s.starts_at, s.ends_at, s.price, s.status, s._source, now, s.id)
    );
    counts.sessions.updated = await runBatches(env, changes);
    return counts;
  }
}

// Which unnumbered session this is: client, start and session type
const sessionKey = (clientId, start, session) => `${clientId}|${start}|${session || ""}`;

// Run statements in batches; -> how many rows they changed
async function runBatches(env, statements) {
  let changed = 0;
  for (let i = 0; i < statements.length; i += BATCH) {
    const results = await env.DB.batch(statements.slice(i, i + BATCH));
    for (const r of results) changed += r.meta?.changes || 0;
  }
  return changed;
}

// One booking from the feed (or the webhook's copy of it) into the book. -> true if it was used
function addBooking(book, booking, source, status) {
  // Portal's Acuity test bookings (acuity-test-booking.js) aren't clients
  if (!booking || booking.name === TEST_NAME) return false;
  const start = feedTimeToIso(booking.start);
  if (!start) return false;
  const acuityId = Number(booking.id) || null;
  // A booking already stored stays with its client (even if staff changed their email since)
  const known = acuityId ? book.byAcuity.get(acuityId) : null;
  const client = book.person(booking, "booking", known ? book.byId.get(known.client_id) : null);
  if (!client) return false;
  book.session(client, { acuityId, session: booking.session, start, end: feedTimeToIso(booking.end), price: booking.price, status }, source);
  return true;
}

// ===== SYNCS =====

// Every booking in Acuity's calendar feed -> clients and sessions. null if the feed isn't set up.
export async function syncClientsFromFeed(env) {
  const bookings = await listBookings(env);
  if (!bookings) return null;
  const book = await ClientBook.load(env, "acuity");
  for (const booking of bookings) addBooking(book, booking, "feed", "booked");
  return book.save(env);
}

// Each enquiry's person -> a client (no sessions; marketing consent stays NO)
export async function syncClientsFromEnquiries(env) {
  const book = await ClientBook.load(env, "enquiry");
  addEnquiries(book, await readEnquiries(env));
  return book.save(env);
}

const readEnquiries = async (env) => (await env.DB.prepare("SELECT name, email, phone FROM enquiries ORDER BY id").all()).results;
const addEnquiries = (book, enquiries) => enquiries.forEach((e) => book.person(e, "enquiry"));

// The feed (when it's set up) and the enquiries, together: Portal's "Sync now" and the cron.
// -> { clients, sessions, feed: true | false }. Throws if the feed couldn't be read.
export async function syncClients(env) {
  const bookings = await listBookings(env);
  const book = await ClientBook.load(env, "acuity");
  for (const booking of bookings || []) addBooking(book, booking, "feed", "booked");
  addEnquiries(book, await readEnquiries(env));
  return { ...(await book.save(env)), feed: Boolean(bookings) };
}

// Every minute (index.js): a sync, if the last one was 30 minutes ago or more
export async function syncClientsOnSchedule(env, at = Date.now()) {
  const last = await env.DB.prepare("SELECT value FROM settings WHERE key = ?").bind(SYNC_STAMP).first("value");
  if (last && at - Date.parse(last) < SYNC_EVERY_MINUTES * 60000) return null;
  // Stamp it first, so a slow sync isn't started again by the next minute's cron
  await env.DB.prepare("INSERT INTO settings (key, value) VALUES (?, ?) ON CONFLICT (key) DO UPDATE SET value = excluded.value").bind(SYNC_STAMP, new Date(at).toISOString()).run();
  try {
    const result = await syncClients(env);
    const { clients: c, sessions: s } = result;
    if (c.added || c.updated || s.added || s.updated) console.log(`Client list synced: clients +${c.added} ~${c.updated}, sessions +${s.added} ~${s.updated}.`);
    return result;
  } catch (err) {
    console.log("Client list sync failed:", String(err?.message || err).slice(0, 120));
    return null;
  }
}

// Acuity's webhook, after bookingChanged has read the feed (referrals.js): this booking ->
// its client and session. A cancellation marks the session cancelled. Never throws: the
// webhook must always answer Acuity.
export async function clientsAfterWebhook(env, action, id) {
  try {
    const acuityId = Number(id);
    const status = action === "canceled" ? "cancelled" : "booked";
    // What the feed said about it (booking-calendar.js saved it; kept after a cancellation)
    const raw = await env.DB.prepare("SELECT calendar_info FROM booking_details WHERE id = ?").bind(acuityId).first("calendar_info");
    const info = raw ? JSON.parse(raw) : null;
    if (info && info.name !== TEST_NAME && feedTimeToIso(info.start)) {
      const email = cleanEmail(info.email);
      const key = phoneKey(info.phone);
      const book = await ClientBook.load(env, "acuity", { email, phoneKey: key, name: cleanName(info.name) || email || cleanPhone(info.phone), acuityId });
      addBooking(book, { ...info, id: acuityId }, "webhook", status);
      await book.save(env);
    } else if (status === "cancelled") {
      await env.DB.prepare("UPDATE client_sessions SET status = 'cancelled', source = 'webhook', updated_at = ? WHERE acuity_id = ? AND status != 'cancelled'")
        .bind(nowIso(), acuityId)
        .run();
    }
  } catch (err) {
    console.log(`Client list: couldn't note booking #${id} from the webhook (${err?.name || "error"}).`);
  }
}

// ===== IMPORTING ACUITY'S SPREADSHEETS (CSV) =====

// CSV text -> rows of cells, each with the line it starts on. Handles quoted fields with
// commas, quotes ("") and new lines in them, Windows line endings and a byte-order mark.
export function parseCsv(text) {
  const s = String(text || "").replace(/^﻿/, "");
  const rows = [];
  let cells = [];
  let cell = "";
  let quoted = false;
  let line = 1;
  let rowLine = 1;
  for (let i = 0; i < s.length; i++) {
    const ch = s[i];
    if (quoted) {
      if (ch === '"') {
        if (s[i + 1] === '"') {
          cell += '"';
          i++;
        } else quoted = false;
      } else {
        if (ch === "\n") line++;
        cell += ch;
      }
      continue;
    }
    // A quote opens a quoted field only at its start (5" vinyl stays as it is)
    if (ch === '"' && cell === "") quoted = true;
    else if (ch === ",") {
      cells.push(cell);
      cell = "";
    } else if (ch === "\n" || ch === "\r") {
      if (ch === "\r" && s[i + 1] === "\n") i++;
      cells.push(cell);
      rows.push({ line: rowLine, cells });
      cells = [];
      cell = "";
      line++;
      rowLine = line;
    } else cell += ch;
  }
  if (cell !== "" || cells.length) {
    cells.push(cell);
    rows.push({ line: rowLine, cells });
  }
  return rows.map((r) => ({ line: r.line, cells: r.cells.map((c) => c.replace(/\r\n/g, "\n").trim()) })).filter((r) => r.cells.some((c) => c !== ""));
}

const MONTHS = ["jan", "feb", "mar", "apr", "may", "jun", "jul", "aug", "sep", "oct", "nov", "dec"];
const pad = (n) => String(n).padStart(2, "0");

// A UK time as Acuity's spreadsheets write it -> UTC ISO (with the right BST/GMT offset), or null.
// "October 22, 2026 2:15 pm", "2026-10-22 14:15", "22 October 2026 14:15", "22/10/2026 14:15"
export function ukLocalToUtc(text) {
  const t = String(text || "").trim().replace(/\s+/g, " ");
  let m;
  let y, mo, d, rest;
  if ((m = t.match(/^(\d{4})-(\d{1,2})-(\d{1,2})(?:[ T](.+))?$/))) [y, mo, d, rest] = [+m[1], +m[2], +m[3], m[4]];
  else if ((m = t.match(/^([A-Za-z]{3,})\.? (\d{1,2})(?:st|nd|rd|th)?,? (\d{4})(?:,? (?:at )?(.+))?$/))) [y, mo, d, rest] = [+m[3], MONTHS.indexOf(m[1].slice(0, 3).toLowerCase()) + 1, +m[2], m[4]];
  else if ((m = t.match(/^(?:[A-Za-z]+,? )?(\d{1,2})(?:st|nd|rd|th)? ([A-Za-z]{3,})\.?,? (\d{4})(?:,? (?:at )?(.+))?$/))) [y, mo, d, rest] = [+m[3], MONTHS.indexOf(m[2].slice(0, 3).toLowerCase()) + 1, +m[1], m[4]];
  else if ((m = t.match(/^(\d{1,2})\/(\d{1,2})\/(\d{4})(?:,? (.+))?$/))) [y, mo, d, rest] = [+m[3], +m[2], +m[1], m[4]];
  else return null;
  let h = 0;
  let mi = 0;
  if (rest) {
    const twelve = rest.match(/^(\d{1,2})(?::(\d{2}))?(?::\d{2})? ?([ap])\.?m\.?$/i);
    const clock = rest.match(/^(\d{1,2}):(\d{2})(?::\d{2})?$/);
    if (twelve) {
      [h, mi] = [+twelve[1], +(twelve[2] || 0)];
      if (h < 1 || h > 12) return null;
      h = (h % 12) + (twelve[3].toLowerCase() === "p" ? 12 : 0);
    } else if (clock) [h, mi] = [+clock[1], +clock[2]];
    else return null;
  }
  if (mo < 1 || mo > 12 || h > 23 || mi > 59 || d < 1 || new Date(Date.UTC(y, mo - 1, d)).getUTCDate() !== d) return null;
  return ukWallToUtc(`${y}-${pad(mo)}-${pad(d)}T${pad(h)}:${pad(mi)}`)?.toISOString() || null;
}

// A header, for matching any spelling: "Appointment ID" -> "appointmentid", "Paid?" -> "paid"
const headerKey = (h) => String(h).toLowerCase().replace(/[^a-z0-9]/g, "");

// Which spreadsheet this is: the header row and its kind, or null
function findHeader(rows) {
  for (const [i, row] of rows.slice(0, 5).entries()) {
    const keys = row.cells.map(headerKey);
    const has = (k) => keys.includes(k);
    const named = has("firstname") || has("lastname") || has("name");
    if (has("starttime") && (named || has("email"))) return { index: i, kind: "appointments", keys };
    if (named && (has("email") || has("phone"))) return { index: i, kind: "clients", keys };
  }
  return null;
}

// Import one of Acuity's spreadsheets (appointments or clients). Never sets marketing consent.
// -> { kind, clients: { added, updated }, sessions: { added, updated }, skipped, problems } or { error, status }
export async function importClientsCsv(env, csv) {
  if (typeof csv !== "string" || !csv.trim()) return { error: "Paste the spreadsheet (CSV) from Acuity, or choose its file.", status: 400 };
  if (csv.length > MAX_CSV) return { error: "That spreadsheet is too big to import in one go: download a shorter date range from Acuity.", status: 413 };
  const rows = parseCsv(csv);
  const header = findHeader(rows);
  if (!header) return { error: "That doesn't look like Acuity's appointments or clients spreadsheet (no Start Time, First Name, Email or Phone columns).", status: 400 };
  const { kind, keys } = header;
  const book = await ClientBook.load(env, "import");
  const problems = [];
  let skipped = 0;
  for (const { line, cells } of rows.slice(header.index + 1)) {
    // A column's value by any of its names ("" if there isn't one)
    const get = (...names) => {
      for (const name of names) {
        const i = keys.indexOf(name);
        if (i >= 0 && cells[i]) return cells[i];
      }
      return "";
    };
    const person = {
      name: [get("firstname"), get("lastname")].filter(Boolean).join(" ") || get("name", "clientname"),
      email: get("email", "emailaddress"),
      phone: get("phone", "phonenumber", "mobile"),
      notes: kind === "clients" ? get("notes") : "",
    };
    const skip = (why) => {
      skipped++;
      if (why) problems.push(`Line ${line}: ${why}`);
    };
    if (!cleanName(person.name) && !cleanEmail(person.email) && !cleanPhone(person.phone)) {
      skip("no name, email or phone, so it was left out.");
      continue;
    }
    if (cleanName(person.name) === TEST_NAME) {
      skip("");
      continue;
    }
    if (kind === "clients") {
      book.person(person, "import");
      continue;
    }
    const startText = get("starttime");
    const start = ukLocalToUtc(startText);
    if (!start) {
      skip(startText ? `the start time "${startText.slice(0, 40)}" isn't a UK date and time Nova Bot can read.` : "no start time, so it was left out.");
      continue;
    }
    const acuityId = /^\d{1,15}$/.test(get("appointmentid", "id")) ? Number(get("appointmentid", "id")) : null;
    const cancelled = /^(yes|y|true|1|canceled|cancelled)$/i.test(get("canceled", "cancelled"));
    const known = acuityId ? book.byAcuity.get(acuityId) : null;
    const client = book.person(person, "import", known ? book.byId.get(known.client_id) : null);
    book.session(
      client,
      { acuityId, session: get("type", "appointmenttype").slice(0, 200), start, end: ukLocalToUtc(get("endtime")), price: get("appointmentprice", "price").slice(0, 40), status: cancelled ? "cancelled" : "booked" },
      "import"
    );
  }
  const counts = await book.save(env);
  console.log(`Client list import (${kind}): clients +${counts.clients.added} ~${counts.clients.updated}, sessions +${counts.sessions.added} ~${counts.sessions.updated}, skipped ${skipped}.`);
  return { kind, ...counts, skipped, problems: problems.slice(0, 10) };
}

// ===== READING THE LIST =====

// A client as Portal and Nova Agent see it
function summary(row) {
  return {
    id: row.id,
    name: row.name,
    email: row.email,
    phone: row.phone,
    consent: { yes: row.marketing_consent === 1, at: row.consent_at, source: row.consent_source },
    lastBooked: row.last_booked || null,
    nextBooked: row.next_booked || null,
    sessionCount: row.session_count || 0,
    outstanding: pounds(row.outstanding_pence),
    depositsPaid: pounds(row.deposits_paid_pence),
    invoiced: pounds(row.invoiced_pence),
    notes: row.notes,
    source: row.source,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

// A session as Portal and Nova Agent see it
function sessionShape(row) {
  return { id: row.id, acuityId: row.acuity_id, session: row.session, start: row.starts_at, end: row.ends_at, price: row.price, status: row.status, source: row.source };
}

// Each client with their last and next booked session and how many they've had (?1 = now)
const SUMMARY = `SELECT c.*,
  (SELECT MAX(s.starts_at) FROM client_sessions s WHERE s.client_id = c.id AND s.status = 'booked' AND s.starts_at < ?1) AS last_booked,
  (SELECT MIN(s.starts_at) FROM client_sessions s WHERE s.client_id = c.id AND s.status = 'booked' AND s.starts_at >= ?1) AS next_booked,
  (SELECT COUNT(*) FROM client_sessions s WHERE s.client_id = c.id AND s.status = 'booked') AS session_count`;

// The list: { search, filter: all | owing | lapsed | enquiry, since: "YYYY-MM-DD", limit }
// -> { clients, total } or { error, status }
export async function listClients(env, { search = "", filter = "all", since = "", limit = LIST_MAX } = {}) {
  const params = [nowIso()];
  const p = (value) => "?" + params.push(value);
  const where = [];
  let order = "c.name COLLATE NOCASE, c.id";
  const words = typeof search === "string" ? search.trim().toLowerCase().slice(0, 100) : "";
  if (words) {
    const like = p("%" + words.replace(/[\\%_]/g, (c) => "\\" + c) + "%");
    const parts = [`LOWER(c.name) LIKE ${like} ESCAPE '\\'`, `c.email LIKE ${like} ESCAPE '\\'`, `LOWER(c.phone) LIKE ${like} ESCAPE '\\'`];
    // A phone number however it's written: its digits in the stored number (07… or +447…)
    const digits = words.replace(/\D/g, "");
    if (digits.length >= 4) parts.push(`c.phone_key LIKE ${p("%" + digits.replace(/^0/, "") + "%")}`);
    where.push(`(${parts.join(" OR ")})`);
  }
  if (filter === "owing") {
    where.push("c.outstanding_pence > 0");
    order = "c.outstanding_pence DESC, c.name COLLATE NOCASE, c.id";
  } else if (filter === "lapsed") {
    if (!isUkDate(since)) return { error: "since must be a day, YYYY-MM-DD.", status: 400 };
    const from = p(ukDayStart(since));
    where.push(
      `EXISTS (SELECT 1 FROM client_sessions s WHERE s.client_id = c.id AND s.status = 'booked' AND s.starts_at < ${from})`,
      `NOT EXISTS (SELECT 1 FROM client_sessions s WHERE s.client_id = c.id AND s.status = 'booked' AND s.starts_at >= ${from})`
    );
  } else if (filter === "enquiry") {
    // People who came in as an enquiry and haven't booked
    where.push("c.source = 'enquiry'", "NOT EXISTS (SELECT 1 FROM client_sessions s WHERE s.client_id = c.id AND s.status = 'booked')");
  } else if (filter !== "all" && filter) {
    return { error: "filter must be all, owing, lapsed or enquiry.", status: 400 };
  }
  const max = Math.min(Math.max(Number(limit) || LIST_MAX, 1), LIST_MAX);
  const { results } = await env.DB.prepare(`${SUMMARY}, COUNT(*) OVER () AS total FROM clients c ${where.length ? "WHERE " + where.join(" AND ") : ""} ORDER BY ${order} LIMIT ${max}`)
    .bind(...params)
    .all();
  return { clients: results.map(summary), total: results[0]?.total || 0 };
}

// One client's summary, or null
export async function getClient(env, id) {
  const row = await env.DB.prepare(`${SUMMARY} FROM clients c WHERE c.id = ?2`).bind(nowIso(), Number(id)).first();
  return row ? summary(row) : null;
}

// One client, their sessions (newest first) and their consent history (newest first), or null
export async function clientDetail(env, id) {
  const client = await getClient(env, id);
  if (!client) return null;
  const [sessions, log] = await env.DB.batch([
    env.DB.prepare("SELECT * FROM client_sessions WHERE client_id = ? ORDER BY starts_at DESC, id DESC").bind(client.id),
    env.DB.prepare('SELECT l.*, st.display_name AS by_name FROM client_consent_log l LEFT JOIN staff st ON st.id = l."by" WHERE l.client_id = ? ORDER BY l.id DESC').bind(client.id),
  ]);
  return {
    client,
    sessions: sessions.results.map(sessionShape),
    consentLog: log.results.map((r) => ({ id: r.id, consent: r.consent === 1, at: r.at, source: r.source, by: r.by, byName: r.by_name || null, recordedAt: r.recorded_at })),
  };
}

// ===== STAFF CHANGES =====

// Add a client by hand: { name, email?, phone?, notes? } -> { client } or { error, status, existingId }
export async function addClient(env, me, body) {
  const name = cleanName(body?.name);
  if (!name) return { error: "A name, please.", status: 400 };
  const contact = readContact(body);
  if (contact.error) return contact;
  const book = await ClientBook.load(env, "staff", { email: contact.email ?? null, phoneKey: contact.phone_key ?? null, name, acuityId: null });
  const same = book.find({ email: contact.email, key: contact.phone_key, name });
  if (same) return { error: `${same.name} is already on the list.`, status: 409, existingId: same.id, id: same.id };
  const notes = typeof body?.notes === "string" ? body.notes.trim().slice(0, 4000) : "";
  const now = nowIso();
  const { meta } = await env.DB.prepare(
    "INSERT INTO clients (name, email, phone, phone_key, notes, source, created_at, updated_at, updated_by) VALUES (?, ?, ?, ?, ?, 'staff', ?, ?, ?)"
  )
    .bind(name, contact.email ?? null, contact.phone ?? null, contact.phone_key ?? null, notes, now, now, me.id)
    .run();
  return { client: await getClient(env, meta.last_row_id) };
}

// Email and phone from a staff form (only what was sent; "" clears it). -> fields, or { error, status }
function readContact(body) {
  const out = {};
  if (body?.email !== undefined) {
    const raw = typeof body.email === "string" ? body.email.trim() : "";
    if (raw && !EMAIL_PATTERN.test(raw)) return { error: "That email address doesn't look right.", status: 400 };
    out.email = raw ? raw.toLowerCase().slice(0, 200) : null;
  }
  if (body?.phone !== undefined) {
    out.phone = cleanPhone(typeof body.phone === "string" ? body.phone : "");
    out.phone_key = phoneKey(out.phone);
  }
  return out;
}

// A staff edit: { name?, email?, phone?, notes?, depositsPaid?, invoiced?, outstanding?, consent?: { yes, source, at? } }
// -> { client } or { error, status }. Any signed-in staff; a consent change is logged with who.
export async function editClient(env, me, id, body) {
  const current = await env.DB.prepare("SELECT * FROM clients WHERE id = ?").bind(Number(id)).first();
  if (!current) return { error: "That client isn't on the list.", status: 404 };
  const set = {};
  if (body?.name !== undefined) {
    const name = cleanName(body.name);
    if (!name) return { error: "A name, please.", status: 400 };
    set.name = name;
  }
  const contact = readContact(body);
  if (contact.error) return contact;
  if (contact.email) {
    const other = await env.DB.prepare("SELECT id, name FROM clients WHERE email = ? AND id != ?").bind(contact.email, current.id).first();
    if (other) return { error: `${other.name} already has that email.`, status: 409, existingId: other.id };
  }
  Object.assign(set, contact);
  if (body?.notes !== undefined) set.notes = typeof body.notes === "string" ? body.notes.trim().slice(0, 4000) : "";
  for (const [field, column] of [["depositsPaid", "deposits_paid_pence"], ["invoiced", "invoiced_pence"], ["outstanding", "outstanding_pence"]]) {
    if (body?.[field] === undefined) continue;
    const pence = toPence(body[field]);
    if (pence === null) return { error: `${field} must be an amount in pounds, like "120.00".`, status: 400 };
    set[column] = pence;
  }
  const now = nowIso();
  const statements = [];
  if (body?.consent !== undefined) {
    const consent = body.consent;
    if (!consent || typeof consent.yes !== "boolean") return { error: "consent: { yes: true or false, source }", status: 400 };
    const source = typeof consent.source === "string" ? consent.source.trim().slice(0, 200) : "";
    if (consent.yes && !source) return { error: "Where did they say yes? (e.g. \"Ticked on the booking form\", \"Said yes in person\")", status: 400 };
    let at = now;
    if (consent.at !== undefined && consent.at !== null && consent.at !== "") {
      if (!isUkDate(consent.at)) return { error: "consent.at must be a day, YYYY-MM-DD.", status: 400 };
      at = ukDayStart(consent.at);
      if (!at || at > now) return { error: "consent.at can't be in the future.", status: 400 };
    }
    const yes = consent.yes ? 1 : 0;
    const finalSource = source || "Switched off in Portal";
    // Only a real change is recorded (the same yes, from the same place, on the same day, is nothing new)
    const same = current.marketing_consent === yes && (!yes || (current.consent_source === finalSource && String(current.consent_at || "").slice(0, 10) === at.slice(0, 10)));
    if (!same) {
      Object.assign(set, { marketing_consent: yes, consent_at: at, consent_source: finalSource, consent_by: me.id });
      statements.push(
        env.DB.prepare('INSERT INTO client_consent_log (client_id, consent, at, source, "by", recorded_at) VALUES (?, ?, ?, ?, ?, ?)').bind(current.id, yes, at, finalSource, me.id, now)
      );
    }
  }
  const columns = Object.keys(set);
  if (columns.length) {
    statements.unshift(
      env.DB.prepare(`UPDATE clients SET ${columns.map((c) => `${c} = ?`).join(", ")}, updated_at = ?, updated_by = ? WHERE id = ?`).bind(...columns.map((c) => set[c]), now, me.id, current.id)
    );
    await env.DB.batch(statements);
  }
  return { client: await getClient(env, current.id) };
}

// ===== ROUTES =====

// Portal's /app/api/clients… (src/app-page.js has already checked the sign-in). -> a Response, or null
export async function handleClientsForStaff(request, env, me, route) {
  const url = new URL(request.url);
  const admin = me.role === "admin";
  const onlyAdmins = () => json({ error: "Only an admin can do that." }, 403);
  if (route === "/clients" && request.method === "GET") {
    const q = url.searchParams;
    return answer(await listClients(env, { search: q.get("search") || "", filter: q.get("filter") || "all", since: q.get("since") || "" }));
  }
  if (route === "/clients" && request.method === "POST") return answer(await addClient(env, me, await readJson(request)));
  if (route === "/clients/import" && request.method === "POST") {
    if (!admin) return onlyAdmins();
    return answer(await importClientsCsv(env, (await readJson(request)).csv));
  }
  if (route === "/clients/sync" && request.method === "POST") {
    if (!admin) return onlyAdmins();
    try {
      return json(await syncClients(env));
    } catch (err) {
      console.log("Client list sync failed:", String(err?.message || err).slice(0, 120));
      return json({ error: "Acuity's calendar feed couldn't be read: " + String(err?.message || err).slice(0, 120), unreachable: true }, 503);
    }
  }
  const one = route.match(/^\/clients\/(\d{1,12})$/);
  if (one && request.method === "GET") {
    const detail = await clientDetail(env, one[1]);
    return detail ? json(detail) : json({ error: "That client isn't on the list." }, 404);
  }
  if (one && request.method === "POST") return answer(await editClient(env, me, one[1], await readJson(request)));
  return null;
}

// Nova Agent's /nova-agent/clients/… (src/agent-nova.js has already checked the key). Read-only.
export async function handleClientsForAgent(env, pathname, body) {
  if (pathname === "/nova-agent/clients/find") {
    const search = typeof body?.search === "string" ? body.search.trim() : "";
    if (search.length < 2) return json({ error: "search: at least 2 letters of a name, email or phone." }, 400);
    const { clients } = await listClients(env, { search, limit: FIND_MAX });
    return json({ clients });
  }
  if (pathname === "/nova-agent/clients/history") {
    const id = Number(body?.id);
    if (!Number.isInteger(id) || id <= 0) return json({ error: "id: which client (from client_find)?" }, 400);
    const detail = await clientDetail(env, id);
    return detail ? json({ client: detail.client, sessions: detail.sessions }) : json({ error: "That client isn't on the list." }, 404);
  }
  if (pathname === "/nova-agent/clients/owing") return json({ clients: (await listClients(env, { filter: "owing" })).clients });
  if (pathname === "/nova-agent/clients/lapsed") {
    const result = await listClients(env, { filter: "lapsed", since: body?.since });
    return result.error ? json({ error: result.error }, result.status) : json({ clients: result.clients });
  }
  return json({ error: "Not found" }, 404);
}

// ===== SHARED =====

// A result as a response: { error, status } is a refusal
function answer(result) {
  if (result?.error) {
    const { status, ...rest } = result;
    return json(rest, status || 400);
  }
  return json(result);
}

async function readJson(request) {
  try {
    return await request.json();
  } catch {
    return {};
  }
}

function json(data, status = 200) {
  return new Response(JSON.stringify(data), { status, headers: { "Content-Type": "application/json", "Cache-Control": "no-store" } });
}

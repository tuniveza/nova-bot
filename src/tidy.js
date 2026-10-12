// Portal → Test stuff (admins): things in Nova Bot that look like tests or copies, each with the
// reasons why, what goes with it, and Delete / Not a test (migrations/0031_tidy.sql).
//
// Finding them (findTestStuff: plain data in, items out, so it's easy to test):
//   - a staff member's own email, or a TV/film phone number (07700 900…), used as a customer
//   - test, rude or joke words, and the names seen in the studio's own tests (src/tidy-words.js)
//   - random letters (the inbox's spam check), the same first message in several chats minutes apart
//   - claude-test-… chats, chat bookings that never reached Acuity, Index pages whose chat is gone
//   - copies: the same Index page, shared note, draft post, email, invoice or expense twice
//   - the old "Welcome to Notes" note (Notes has a Welcome guide now)
// Each reason is "strong" or "weak": one strong reason, or two weak ones, makes it "Likely a test";
// one weak reason makes it "Maybe". Real clients (sessions, payments, consent, invoices) are never
// flagged unless a strong sign says so, and then only as "Maybe".
//
// Deleting is safe: Index pages go through Index's own 30-day bin, shared notes and expenses are
// deleted the way their apps do it (so every copy follows), and everything else is copied whole
// into tidy_bin first. "Recently deleted" puts any of it back for 30 days. "Not a test" is
// remembered (tidy_real) so it's never shown again. Every delete and restore is logged with ids
// and kinds only (tidy_log), never anyone's details.
//
// Admins only (role admin, signed in to Portal: the browser's cookie or the studio PC's own
// sign-in; app-page.js has already checked the Origin). Nova Agent's AI can only read the list
// (/nova-agent/tidy): there's no delete for its key.

import { binAndDeleteFile, getFile } from "./memory/store.js";
import { restoreRemoved } from "./memory/cleanup.js";
import { spamCheck } from "./inbox.js";
import { dramaPhone, isTestName, jokeWordsIn, testEmail, testWordsIn } from "./tidy-words.js";

const DAY = 86_400_000;
const BIN_DAYS = 30;
const BURST_MS = 15 * 60_000;

export const KINDS = {
  enquiry: "Enquiry",
  client: "Client",
  chat: "Website chat",
  booking: "Chat booking",
  index: "Index page",
  note: "Shared note",
  social: "Social post",
  outreach: "One-to-one email",
  invoice: "Invoice",
  expense: "Expense",
};

const nowIso = () => new Date().toISOString();
const norm = (s) => String(s || "").toLowerCase().replace(/[^\p{L}\p{N}]+/gu, " ").trim();
const short = (s, n = 80) => {
  const t = String(s || "").replace(/\s+/g, " ").trim();
  return t.length > n ? t.slice(0, n - 1) + "…" : t;
};
const ukDay = (iso) => {
  const d = new Date(iso);
  return Number.isNaN(d.getTime()) ? "" : d.toLocaleDateString("en-GB", { day: "numeric", month: "short", year: "numeric", timeZone: "Europe/London" });
};

// ===== FINDING =====

// Reasons for one thing: { text, strong }
function reasonsFor(fields, staff) {
  const out = [];
  const add = (text, strong) => out.some((r) => r.text === text) || out.push({ text, strong });
  if (fields.email) {
    const e = String(fields.email).trim().toLowerCase();
    const who = staff.byEmail.get(e);
    if (who) add(`Uses ${who}'s own email`, true);
    const made = testEmail(e);
    if (made) add(`Has ${made}`, true);
  }
  for (const p of fields.phones || []) if (dramaPhone(p)) add("Has a TV and film phone number (not a real one)", true);
  if (fields.name && isTestName(fields.name)) add("A name used in the studio's own tests", true);
  const headline = [fields.name, fields.title].filter(Boolean).join("\n");
  const body = fields.text || "";
  const joke = jokeWordsIn(`${headline}\n${body}`);
  if (joke.length) add(`Rude or joke words: ${joke.slice(0, 3).map((w) => `“${w}”`).join(", ")}`, true);
  const testy = testWordsIn(headline);
  if (testy.length) add(`Says “${testy[0]}”`, true);
  else {
    const inBody = testWordsIn(body);
    if (inBody.length) add(`Mentions “${inBody[0]}”`, false);
  }
  if (fields.spamText) {
    const check = spamCheck({ name: fields.name || "", email: fields.email || "", subject: fields.title || "", details: fields.spamText });
    const mash = check.reasons.find((r) => r.startsWith("random letters") || r.startsWith("mostly symbols"));
    if (mash) add(`Looks like keyboard mashing (${mash})`, false);
    else if (check.spam) add(`Looks like spam (${check.reasons.join("; ")})`, false);
  }
  return out;
}

const verdict = (reasons) => (reasons.some((r) => r.strong) || reasons.filter((r) => !r.strong).length >= 2 ? "likely" : reasons.length ? "maybe" : null);

// data: { staff, enquiries, clients, chats, chatMessages, bookings, jobs, index, notes, social,
// outreach, invoices, expenses, real } (rows as Nova Bot keeps them). -> items, likely first.
export function findTestStuff(data, { now = Date.now() } = {}) {
  const staff = { byEmail: new Map() };
  for (const s of data.staff || []) if (s.email) staff.byEmail.set(String(s.email).toLowerCase(), s.display_name || s.id);
  const real = new Set((data.real || []).map((r) => r.key));
  const items = new Map(); // key -> item
  const flagged = (key) => items.has(key) && items.get(key).confidence === "likely";

  function put(kind, id, title, extra, reasons) {
    const key = `${kind}:${id}`;
    if (real.has(key)) return null;
    const confidence = extra.confidence || verdict(reasons);
    if (!confidence) return null;
    const item = { key, kind, kindName: KINDS[kind], id: String(id), title: short(title) || `${KINDS[kind]} ${id}`, confidence, reasons, linked: [], side: "bot", ...extra };
    item.confidence = confidence;
    items.set(key, item);
    return item;
  }
  const link = (item, key, label) => item && key !== item.key && !item.linked.some((l) => l.key === key) && item.linked.push({ key, kind: key.split(":")[0], kindName: KINDS[key.split(":")[0]], label: short(label, 90) });

  // --- Website chats: their users' messages, first one first
  const msgs = new Map();
  for (const m of data.chatMessages || []) {
    if (!msgs.has(m.chat_id)) msgs.set(m.chat_id, []);
    msgs.get(m.chat_id).push(m);
  }
  const chats = new Map((data.chats || []).map((c) => [c.chat_id, c]));
  const firstText = (id) => norm(((msgs.get(id) || [])[0] || {}).content);

  // --- Bookings made through the chat that never reached Acuity, and the jobs that went with them
  const jobFor = (b) =>
    (data.jobs || []).find((j) => j.kind === "book" && !j.appointment_id && norm(j.client_name) === norm(b.name) && Math.abs(Date.parse(j.created_at) - Date.parse(b.created_at)) < 60_000);
  const bookingItems = new Map();
  for (const b of data.bookings || []) {
    const reasons = reasonsFor({ name: b.name, email: b.email, phones: [b.phone] }, staff);
    const old = now - Date.parse(b.created_at) > DAY;
    if (!b.appointment_id && old) reasons.push({ text: "Never reached Acuity (no booking was made there)", strong: false });
    if (b.chat_id && !chats.has(b.chat_id)) reasons.push({ text: "Its website chat is gone", strong: false });
    const job = jobFor(b);
    const item = put("booking", b.id, `${b.name || "Someone"}: ${b.starts_at || "no time"}`, { where: "Website bot bookings", open: b.chat_id && chats.has(b.chat_id) ? "/portal/?view=chats" : "/portal/?view=bot", created: b.created_at, by: "The website bot", job: job ? job.id : null }, reasons);
    if (item && job) item.note = "Its booking job goes with it.";
    bookingItems.set(b.id, { b, item });
  }

  // --- Enquiries
  const enquiryByEmail = new Map();
  for (const e of data.enquiries || []) {
    const reasons = reasonsFor({ name: e.name, email: e.email, phones: [e.phone], title: e.subject, text: e.details, spamText: `${e.subject || ""}\n${e.details || ""}` }, staff);
    if (e.status === "spam") reasons.push({ text: "In the Spam folder", strong: false });
    const item = put("enquiry", e.id, `${e.name || "Someone"}: ${e.subject || short(e.details, 50)}`, { where: "Enquiries", open: `/portal/?view=enquiries&enquiry=${e.id}`, created: e.created_at, by: e.email ? "From the website" : "", email: e.email || "" }, reasons);
    if (item && e.email) enquiryByEmail.set(String(e.email).toLowerCase(), item);
  }

  // --- Chats (needs enquiries and bookings first: a chat that made a test booking is a test)
  const firstSeen = new Map(); // first message -> [time…]
  for (const [id, c] of chats) {
    const t = firstText(id);
    if (!t) continue;
    if (!firstSeen.has(t)) firstSeen.set(t, []);
    firstSeen.get(t).push(Date.parse(c.first));
  }
  for (const [id, c] of chats) {
    const list = msgs.get(id) || [];
    const said = list.slice(0, 6).map((m) => m.content).join("\n");
    const emails = [...said.matchAll(/[\w.+-]+@[\w-]+(\.[\w-]+)+/g)].map((m) => m[0].toLowerCase());
    const phones = [...said.matchAll(/\+?\d[\d ()-]{8,}\d/g)].map((m) => m[0]);
    const reasons = reasonsFor({ text: said, phones, spamText: said }, staff);
    for (const e of emails) {
      const who = staff.byEmail.get(e);
      if (who) reasons.push({ text: `Gives ${who}'s own email`, strong: true });
    }
    if (id.startsWith("claude-test")) reasons.push({ text: "Made by Claude while testing", strong: true });
    const t = firstText(id);
    const near = t ? (firstSeen.get(t) || []).filter((at) => Math.abs(at - Date.parse(c.first)) < BURST_MS).length - 1 : 0;
    // Four or more chats opening with the same words minutes apart: something was trying the bot
    if (near >= 2) reasons.push({ text: `Starts the same way as ${near} other chats minutes apart`, strong: near >= 3 });
    const tests = [...bookingItems.values()].filter(({ b }) => b.chat_id === id);
    if (tests.some(({ item }) => item && item.confidence === "likely")) reasons.push({ text: "Made test bookings", strong: true });
    const enq = (data.enquiries || []).filter((e) => e.chat_id === id);
    if (enq.some((e) => flagged(`enquiry:${e.id}`))) reasons.push({ text: "Its enquiry looks like a test", strong: true });
    const first = list[0] ? short(list[0].content, 60) : "(no messages)";
    const item = put("chat", id, `“${first}”`, { where: "Conversations (website bot)", open: "/portal/?view=chats", created: c.first, by: `${c.n} message${c.n === 1 ? "" : "s"}` }, reasons);
    if (!item) continue;
    for (const { b } of tests) link(item, `booking:${b.id}`, `${b.name}: ${b.starts_at || ""}`);
    for (const e of enq) link(item, `enquiry:${e.id}`, `${e.name}: ${e.subject || ""}`);
  }

  // Enquiries link their chat; test bookings link their chat
  for (const e of data.enquiries || []) {
    const item = items.get(`enquiry:${e.id}`);
    if (item && e.chat_id && chats.has(e.chat_id)) link(item, `chat:${e.chat_id}`, `The chat it came from (“${short(((msgs.get(e.chat_id) || [])[0] || {}).content, 40)}”)`);
  }
  for (const { b, item } of bookingItems.values()) {
    if (!item || !b.chat_id || !chats.has(b.chat_id)) continue;
    link(item, `chat:${b.chat_id}`, "The chat it came from");
    if (flagged(`chat:${b.chat_id}`) && !item.reasons.some((r) => r.strong)) {
      item.reasons.push({ text: "From a chat that looks like a test", strong: true });
      item.confidence = verdict(item.reasons);
    }
  }

  // --- Clients: never ones with real sessions, money, consent or invoices unless a strong sign says so
  for (const c of data.clients || []) {
    const protectedClient = c.sessions > 0 || c.invoices > 0 || c.outreach > 0 || c.consent_log > 0 || c.marketing_consent === 1 || c.deposits_paid_pence > 0;
    const reasons = reasonsFor({ name: c.name, email: c.email, phones: [c.phone] }, staff);
    const enq = c.email ? enquiryByEmail.get(String(c.email).toLowerCase()) : null;
    if (enq && enq.confidence === "likely") reasons.push({ text: "Made from a test enquiry", strong: true });
    if (protectedClient) {
      const sure = reasons.filter((r) => r.strong && /own email|TV and film|studio's own tests/.test(r.text));
      if (!sure.length) continue;
      const item = put("client", c.id, c.name, { where: "Clients", open: `/portal/?view=clients&client=${c.id}`, created: c.created_at, by: c.source ? `From ${c.source === "booking" ? "a booking" : c.source === "enquiry" ? "an enquiry" : c.source}` : "", confidence: "maybe", locked: true }, [...sure, { text: "Has real sessions, money or consent: check before deleting", strong: false }]);
      if (item) item.note = "It has sessions, money or consent records, so it can't be deleted here.";
      continue;
    }
    const item = put("client", c.id, c.name, { where: "Clients", open: `/portal/?view=clients&client=${c.id}`, created: c.created_at, by: c.source ? `From ${c.source === "booking" ? "a booking" : c.source === "enquiry" ? "an enquiry" : c.source}` : "" }, reasons);
    if (item && enq) link(enq, item.key, `Client: ${c.name}`);
  }

  // --- Index pages
  const pages = data.index || [];
  for (const f of pages) {
    const reasons = [];
    const owner = String(f.owner_id || "");
    if (f.scope === "customer") {
      if (owner.startsWith("chat:")) {
        const chatId = owner.slice(5);
        if (!chats.has(chatId)) reasons.push({ text: "Its website chat is gone", strong: true });
        else if (flagged(`chat:${chatId}`)) reasons.push({ text: "From a chat that looks like a test", strong: true });
      } else if (owner.includes("@")) {
        const who = staff.byEmail.get(owner.toLowerCase());
        if (who) reasons.push({ text: `About ${who}'s own email (a test enquiry)`, strong: true });
        const enq = enquiryByEmail.get(owner.toLowerCase());
        if (enq && enq.confidence === "likely") reasons.push({ text: "About someone from a test enquiry", strong: true });
      }
    } else {
      // (A page's description talks about things, "a pilot test" included: only its name, and rude
      // or joke words anywhere, count)
      const name = String(f.path || "").startsWith("people/") ? String(f.name || "").replace(/-/g, " ") : "";
      if (name && isTestName(name)) reasons.push({ text: "A name used in the studio's own tests", strong: true });
      const joke = jokeWordsIn(`${f.name || ""} ${f.description || ""}`);
      if (joke.length) reasons.push({ text: `Rude or joke words: ${joke.slice(0, 3).map((w) => `“${w}”`).join(", ")}`, strong: true });
      const testy = testWordsIn(String(f.name || "").replace(/-/g, " "));
      if (testy.length) reasons.push({ text: `Says “${testy[0]}”`, strong: true });
      if (f.path === "people/unknown") reasons.push({ text: "Named “unknown”", strong: false });
    }
    // The same facts as another page of the same person (the newer one stays)
    const facts = new Set(String(f.body || "").split("\n").map(norm).filter(Boolean));
    if (facts.size) {
      for (const g of pages) {
        if (g === f || g.scope !== f.scope || g.owner_id !== f.owner_id) continue;
        const other = new Set(String(g.body || "").split("\n").map(norm).filter(Boolean));
        const all = [...facts].every((x) => other.has(x));
        if (!all) continue;
        if (other.size === facts.size && Number(g.updated_at) < Number(f.updated_at)) continue;
        reasons.push(other.size === facts.size ? { text: `The same facts as “${g.path}”`, strong: true } : { text: `Everything here is also in “${g.path}”`, strong: false });
        break;
      }
    }
    const item = put("index", f.id, `${f.scope === "customer" ? "Customer" : f.scope === "studio" ? "Studio" : "Staff"} page “${f.path}”${f.scope === "customer" ? ` (${owner.startsWith("chat:") ? "a website chat" : owner})` : ""}`, { where: "Index", open: "/agent/?open=%2Findex%2F", created: f.updated_at ? new Date(Number(f.updated_at)).toISOString() : "", by: f.source_app || "" }, reasons);
    if (item && owner.startsWith("chat:") && items.has(`chat:${owner.slice(5)}`)) link(items.get(`chat:${owner.slice(5)}`), item.key, `Index page “${f.path}”`);
  }

  // --- Shared notes (deleted ones are already gone)
  const notes = (data.notes || []).filter((n) => !n.deleted_at && n.size !== 0);
  for (const n of notes) {
    const reasons = reasonsFor({ title: n.title, spamText: n.title }, staff);
    if (/^welcome to notes$/i.test(String(n.title).trim())) reasons.push({ text: "The old Welcome note (Notes has a Welcome guide now)", strong: false });
    const twin = notes.find((m) => m !== n && m.title === n.title && m.size === n.size && m.head === n.head && m.updated_at > n.updated_at);
    if (twin) reasons.push({ text: "An exact copy of a newer note", strong: true });
    if ((n.size || 0) < 30) reasons.push({ text: "Almost empty", strong: false });
    put("note", n.id, n.title || "Untitled note", { where: "Notes (shared)", open: "/agent/?open=%2Fnotes%2F", created: n.created_at, by: n.created_by_name || "" }, reasons);
  }

  // --- Drafts that haven't gone anywhere: copies, test words, staff as the recipient
  const copies = (rows, keyOf) => {
    const seen = new Map();
    const older = new Set();
    for (const r of [...rows].sort((a, b) => String(b.created_at).localeCompare(String(a.created_at)))) {
      const k = keyOf(r);
      if (!k) continue;
      if (seen.has(k)) older.add(r.id);
      else seen.set(k, r);
    }
    return older;
  };
  const social = data.social || [];
  const socialCopies = copies(social, (p) => norm(p.caption));
  for (const p of social) {
    const reasons = reasonsFor({ title: p.caption, spamText: p.caption }, staff);
    if (socialCopies.has(p.id)) reasons.push({ text: "A copy of a newer draft", strong: true });
    put("social", p.id, short(p.caption, 60) || "A post", { where: "Social", open: `/portal/?view=social&post=${p.id}`, created: p.created_at, by: p.created_by === "agent" ? "Nova Agent" : p.created_by || "" }, reasons);
  }
  const outreach = data.outreach || [];
  const outCopies = copies(outreach, (o) => `${norm(o.to_email)}|${norm(o.subject)}|${norm(o.body)}`);
  for (const o of outreach) {
    const reasons = reasonsFor({ name: o.to_name, email: o.to_email, title: o.subject, spamText: `${o.subject}\n${o.body}` }, staff);
    if (outCopies.has(o.id)) reasons.push({ text: "A copy of a newer email", strong: true });
    put("outreach", o.id, `To ${o.to_name || o.to_email}: ${o.subject}`, { where: "Campaigns → One-to-one emails", open: `/portal/?view=campaigns&outreach=${o.id}`, created: o.created_at, by: o.created_by === "agent" ? "Nova Agent" : o.created_by || "" }, reasons);
  }
  const invoices = data.invoices || [];
  const invCopies = copies(invoices, (i) => `${norm(i.bill_email)}|${i.total_pence}|${norm(i.lines)}`);
  for (const i of invoices) {
    const reasons = reasonsFor({ name: i.bill_name, email: i.bill_email, title: i.notes }, staff);
    if (invCopies.has(i.id)) reasons.push({ text: "A copy of a newer invoice", strong: true });
    put("invoice", i.id, `NS-${String(i.seq || i.id).padStart(4, "0")} to ${i.bill_name || i.bill_email || "someone"} (not sent)`, { where: "Money → Invoices", open: `/portal/?view=money&invoice=${i.id}`, created: i.created_at, by: i.created_by === "agent" ? "Nova Agent" : i.created_by || "" }, reasons);
  }
  const expenses = data.expenses || [];
  const expCopies = copies(expenses, (e) => `${e.spent_on}|${e.amount_pence}|${norm(e.supplier)}`);
  for (const e of expenses) {
    const reasons = reasonsFor({ title: `${e.supplier || ""} ${e.note || ""}` }, staff);
    if (expCopies.has(e.id)) reasons.push({ text: "The same day, amount and supplier as another expense", strong: false });
    put("expense", e.id, `£${(Number(e.amount_pence || 0) / 100).toFixed(2)} ${e.supplier || e.category || ""} (${ukDay(e.spent_on)})`, { where: "Money → Expenses", open: "/portal/?view=money", created: e.created_at, by: e.created_by === "agent" ? "Nova Agent" : e.created_by || "" }, reasons);
  }

  const rank = { likely: 0, maybe: 1 };
  return [...items.values()].sort((a, b) => rank[a.confidence] - rank[b.confidence] || String(b.created || "").localeCompare(String(a.created || "")));
}

// ===== READING WHAT'S THERE =====

async function rows(env, sql, ...binds) {
  try {
    const { results } = await env.DB.prepare(sql).bind(...binds).all();
    return results;
  } catch (err) {
    console.log("Test stuff: a read failed:", err?.message);
    return [];
  }
}

export async function loadData(env) {
  const [staff, enquiries, clients, chats, chatMessages, bookings, jobs, index, notes, social, outreach, invoices, expenses, real] = await Promise.all([
    rows(env, "SELECT id, email, display_name FROM staff"),
    rows(env, "SELECT id, created_at, name, email, phone, subject, details, chat_id, status FROM enquiries"),
    rows(
      env,
      `SELECT c.id, c.name, c.email, c.phone, c.marketing_consent, c.source, c.created_at, c.deposits_paid_pence,
         (SELECT COUNT(*) FROM client_sessions s WHERE s.client_id = c.id) AS sessions,
         (SELECT COUNT(*) FROM invoices i WHERE i.client_id = c.id) AS invoices,
         (SELECT COUNT(*) FROM outreach_emails o WHERE o.client_id = c.id) AS outreach,
         (SELECT COUNT(*) FROM client_consent_log l WHERE l.client_id = c.id) AS consent_log
       FROM clients c`
    ),
    rows(env, "SELECT chat_id, COUNT(*) AS n, MIN(created_at) AS first, MAX(created_at) AS last FROM chat_messages GROUP BY chat_id"),
    rows(env, "SELECT chat_id, substr(content, 1, 400) AS content, created_at FROM chat_messages WHERE role = 'user' ORDER BY chat_id, id LIMIT 5000"),
    rows(env, "SELECT id, created_at, appointment_id, starts_at, name, email, phone, chat_id FROM chat_bookings"),
    rows(env, "SELECT id, created_at, kind, appointment_id, client_name, status FROM agent_jobs"),
    rows(env, "SELECT id, scope, owner_id, path, name, description, body, version, source_app, updated_at FROM memory_files"),
    rows(env, "SELECT id, title, length(html) AS size, substr(html, 1, 4000) AS head, created_at, updated_at, created_by_name, deleted_at FROM shared_notes WHERE deleted_at IS NULL"),
    rows(env, "SELECT id, caption, status, created_by, created_at FROM social_posts WHERE status IN ('draft', 'pending_approval', 'rejected', 'failed')"),
    rows(env, "SELECT id, to_name, to_email, subject, body, status, created_by, created_at FROM outreach_emails WHERE status IN ('draft', 'pending_approval', 'rejected', 'failed')"),
    rows(env, "SELECT id, seq, bill_name, bill_email, lines, total_pence, notes, status, created_by, created_at FROM invoices WHERE status IN ('draft', 'pending_approval', 'rejected', 'failed')"),
    rows(env, "SELECT id, spent_on, amount_pence, category, supplier, note, status, created_by, created_at FROM expenses WHERE deleted_at IS NULL"),
    rows(env, "SELECT key, kind, title, marked_by, marked_at FROM tidy_real ORDER BY marked_at DESC"),
  ]);
  return { staff, enquiries, clients, chats, chatMessages, bookings, jobs, index, notes, social, outreach, invoices, expenses, real };
}

// ===== DELETING AND PUTTING BACK =====

// The order rows are put back in (parents first); deleting goes the other way
const TABLES = ["clients", "enquiries", "enquiry_messages", "chat_messages", "chat_tickets", "memory_progress", "memory_pending", "agent_jobs", "chat_bookings", "social_posts", "social_post_log", "outreach_emails", "outreach_log", "invoices", "money_log"];
const KEYS = {
  clients: "id", enquiries: "id", enquiry_messages: "id", chat_messages: "id", chat_tickets: "chat_id", memory_progress: "chat_id", memory_pending: "id",
  agent_jobs: "id", chat_bookings: "id", social_posts: "id", social_post_log: "id", outreach_emails: "id", outreach_log: "id", invoices: "id", money_log: "id",
};
const fail = (status, error) => ({ status, error });

// What deleting one thing takes: { rows: { table: [row…] }, index: [file…], notes: [row…], expenses: [row…] } or { error }
async function gather(env, kind, id, plan) {
  const take = async (table, sql, ...binds) => {
    const found = await rows(env, sql, ...binds);
    if (found.length) (plan.rows[table] ||= []).push(...found.filter((r) => !(plan.rows[table] || []).some((x) => x[KEYS[table]] === r[KEYS[table]])));
    return found;
  };
  if (kind === "enquiry") {
    const e = await take("enquiries", "SELECT * FROM enquiries WHERE id = ?", Number(id));
    if (!e.length) return fail(404, "It's already gone.");
    await take("enquiry_messages", "SELECT * FROM enquiry_messages WHERE enquiry_id = ?", Number(id));
  } else if (kind === "client") {
    const [c] = await rows(
      env,
      `SELECT (SELECT COUNT(*) FROM client_sessions WHERE client_id = ?1) + (SELECT COUNT(*) FROM invoices WHERE client_id = ?1) + (SELECT COUNT(*) FROM outreach_emails WHERE client_id = ?1) + (SELECT COUNT(*) FROM client_consent_log WHERE client_id = ?1) AS n`,
      Number(id)
    );
    if (c && c.n > 0) return fail(409, "This client has sessions, invoices, emails or consent records, so it stays. Change it in Portal → Clients instead.");
    const found = await take("clients", "SELECT * FROM clients WHERE id = ?", Number(id));
    if (!found.length) return fail(404, "It's already gone.");
  } else if (kind === "chat") {
    const m = await take("chat_messages", "SELECT * FROM chat_messages WHERE chat_id = ?", String(id));
    if (!m.length) return fail(404, "It's already gone.");
    await take("chat_tickets", "SELECT * FROM chat_tickets WHERE chat_id = ?", String(id));
    await take("memory_progress", "SELECT * FROM memory_progress WHERE chat_id = ?", String(id));
    await take("memory_pending", "SELECT * FROM memory_pending WHERE owner_id = ?", `chat:${id}`);
  } else if (kind === "booking") {
    const [b] = await take("chat_bookings", "SELECT * FROM chat_bookings WHERE id = ?", Number(id));
    if (!b) return fail(404, "It's already gone.");
    const jobs = await rows(env, "SELECT * FROM agent_jobs WHERE kind = 'book' AND appointment_id IS NULL AND client_name = ?", b.name);
    const job = jobs.find((j) => Math.abs(Date.parse(j.created_at) - Date.parse(b.created_at)) < 60_000);
    if (job) (plan.rows.agent_jobs ||= []).some((x) => x.id === job.id) || plan.rows.agent_jobs.push(job);
  } else if (kind === "index") {
    const [f] = await rows(env, "SELECT * FROM memory_files WHERE id = ?", String(id));
    if (!f) return fail(404, "It's already gone.");
    plan.index.push(f);
  } else if (kind === "note") {
    const [n] = await rows(env, "SELECT * FROM shared_notes WHERE id = ? AND deleted_at IS NULL", String(id));
    if (!n) return fail(404, "It's already gone.");
    plan.notes.push(n);
  } else if (kind === "social") {
    const p = await take("social_posts", "SELECT * FROM social_posts WHERE id = ? AND status IN ('draft', 'pending_approval', 'rejected', 'failed')", Number(id));
    if (!p.length) return fail(409, "It's gone, or it's been approved or posted since.");
    await take("social_post_log", "SELECT * FROM social_post_log WHERE post_id = ?", Number(id));
  } else if (kind === "outreach") {
    const o = await take("outreach_emails", "SELECT * FROM outreach_emails WHERE id = ? AND status IN ('draft', 'pending_approval', 'rejected', 'failed')", Number(id));
    if (!o.length) return fail(409, "It's gone, or it's been approved or sent since.");
    await take("outreach_log", "SELECT * FROM outreach_log WHERE outreach_id = ?", Number(id));
  } else if (kind === "invoice") {
    const i = await take("invoices", "SELECT * FROM invoices WHERE id = ? AND status IN ('draft', 'pending_approval', 'rejected', 'failed')", Number(id));
    if (!i.length) return fail(409, "It's gone, or it's been approved or sent since.");
    const paid = await rows(env, "SELECT (SELECT COUNT(*) FROM invoice_payments WHERE invoice_id = ?1) + (SELECT COUNT(*) FROM invoice_reminders WHERE invoice_id = ?1) AS n", Number(id));
    if (paid[0] && paid[0].n > 0) return fail(409, "This invoice has payments or reminders, so it stays.");
    await take("money_log", "SELECT * FROM money_log WHERE invoice_id = ?", Number(id));
  } else if (kind === "expense") {
    const [e] = await rows(env, "SELECT * FROM expenses WHERE id = ? AND deleted_at IS NULL", Number(id));
    if (!e) return fail(404, "It's already gone.");
    plan.expenses.push(e);
  } else return fail(400, "Unknown kind.");
  return null;
}

const insert = (env, table, row) => {
  const cols = Object.keys(row);
  return env.DB.prepare(`INSERT OR IGNORE INTO ${table} (${cols.map((c) => `"${c}"`).join(", ")}) VALUES (${cols.map(() => "?").join(", ")})`).bind(...cols.map((c) => row[c]));
};
const log = (env, action, key, by) => env.DB.prepare("INSERT INTO tidy_log (at, action, item_key, by) VALUES (?, ?, ?, ?)").bind(nowIso(), action, key, String(by).slice(0, 80));

// Delete one thing (and, when `together`, the things that go with it). -> { binId } or { error }
export async function deleteItem(env, me, { key, title, together = true, linked = [] }) {
  const [kind, ...rest] = String(key || "").split(":");
  const id = rest.join(":");
  if (!KINDS[kind] || !id) return fail(400, "Which thing?");
  const plan = { rows: {}, index: [], notes: [], expenses: [] };
  const problem = await gather(env, kind, id, plan);
  if (problem) return problem;
  const skipped = [];
  if (together) {
    for (const l of linked.slice(0, 50)) {
      const [k, ...r] = String(l || "").split(":");
      if (!KINDS[k] || `${k}:${r.join(":")}` === key) continue;
      const p = await gather(env, k, r.join(":"), plan);
      if (p && p.status !== 404) skipped.push({ key: l, why: p.error });
    }
  }
  const binId = crypto.randomUUID();
  const by = me.display_name || me.id;
  const indexBins = [];
  for (const f of plan.index) {
    const res = await binAndDeleteFile(env, f, { reason: "Deleted in Portal → Test stuff", by, cleanup_id: null });
    if (res.ok) indexBins.push(res.bin_id);
  }
  const now = nowIso();
  const statements = [];
  for (const table of [...TABLES].reverse()) {
    for (const r of plan.rows[table] || []) statements.push(env.DB.prepare(`DELETE FROM ${table} WHERE "${KEYS[table]}" = ?`).bind(r[KEYS[table]]));
  }
  // Shared notes and expenses are deleted the way their own apps do it, so every copy follows
  for (const n of plan.notes) {
    statements.push(
      env.DB.prepare("UPDATE shared_notes SET html = '', deleted_at = ?2, size = 0, updated_by = ?3, updated_by_name = ?4, rev = (SELECT COALESCE(MAX(rev), 0) + 1 FROM shared_notes) WHERE id = ?1").bind(n.id, now, me.id, by)
    );
  }
  for (const e of plan.expenses) statements.push(env.DB.prepare("UPDATE expenses SET deleted_at = ?, deleted_by = ?, updated_at = ? WHERE id = ? AND deleted_at IS NULL").bind(now, me.id, now, e.id));
  const data = JSON.stringify({ rows: plan.rows, indexBins, notes: plan.notes, expenses: plan.expenses.map((e) => e.id) });
  statements.push(
    env.DB.prepare("INSERT INTO tidy_bin (id, item_key, kind, title, data, deleted_by, deleted_at) VALUES (?, ?, ?, ?, ?, ?, ?)").bind(binId, key, kind, short(title, 120) || KINDS[kind], data, by.slice(0, 80), now),
    log(env, "delete", key, me.id)
  );
  await env.DB.batch(statements);
  const count = Object.values(plan.rows).reduce((n, r) => n + r.length, 0) + plan.index.length + plan.notes.length + plan.expenses.length;
  console.log(`Test stuff: ${key} deleted (${count} records) by ${me.id}`);
  return { binId, count, skipped };
}

// Put a deleted thing back (within 30 days)
export async function restoreItem(env, me, { binId }) {
  const [b] = await rows(env, "SELECT * FROM tidy_bin WHERE id = ?", String(binId || ""));
  if (!b) return fail(404, "That isn't in the bin.");
  if (b.restored_at) return fail(409, "It's already been put back.");
  if (Date.parse(b.deleted_at) < Date.now() - BIN_DAYS * DAY) return fail(410, `It's been more than ${BIN_DAYS} days, so it can't come back.`);
  const data = JSON.parse(b.data || "{}");
  const statements = [];
  for (const table of TABLES) for (const r of (data.rows || {})[table] || []) statements.push(insert(env, table, r));
  for (const n of data.notes || []) {
    statements.push(
      env.DB.prepare("UPDATE shared_notes SET title = ?2, html = ?3, meta = ?4, size = ?5, deleted_at = NULL, updated_at = ?6, rev = (SELECT COALESCE(MAX(rev), 0) + 1 FROM shared_notes) WHERE id = ?1").bind(n.id, n.title, n.html, n.meta, n.size, nowIso())
    );
  }
  for (const id of data.expenses || []) statements.push(env.DB.prepare("UPDATE expenses SET deleted_at = NULL, deleted_by = NULL, updated_at = ? WHERE id = ?").bind(nowIso(), id));
  statements.push(env.DB.prepare("UPDATE tidy_bin SET restored_by = ?, restored_at = ? WHERE id = ? AND restored_at IS NULL").bind(me.display_name || me.id, nowIso(), b.id), log(env, "restore", b.item_key, me.id));
  await env.DB.batch(statements);
  for (const id of data.indexBins || []) await restoreRemoved(env, id, me.display_name || me.id);
  console.log(`Test stuff: ${b.item_key} put back by ${me.id}`);
  return { ok: true };
}

export async function markReal(env, me, { key, title }) {
  const [kind] = String(key || "").split(":");
  if (!KINDS[kind]) return fail(400, "Which thing?");
  await env.DB.batch([
    env.DB.prepare("INSERT INTO tidy_real (key, kind, title, marked_by, marked_at) VALUES (?, ?, ?, ?, ?) ON CONFLICT (key) DO UPDATE SET marked_at = excluded.marked_at").bind(key, kind, short(title, 120), me.display_name || me.id, nowIso()),
    log(env, "real", key, me.id),
  ]);
  return { ok: true };
}

export async function unmarkReal(env, me, { key }) {
  await env.DB.batch([env.DB.prepare("DELETE FROM tidy_real WHERE key = ?").bind(String(key || "")), log(env, "unreal", String(key || ""), me.id)]);
  return { ok: true };
}

export async function recentlyDeleted(env) {
  return (await rows(env, "SELECT id, item_key, kind, title, deleted_by, deleted_at, restored_by, restored_at FROM tidy_bin WHERE deleted_at >= ? ORDER BY deleted_at DESC LIMIT 200", new Date(Date.now() - BIN_DAYS * DAY).toISOString())).map((r) => ({
    binId: r.id,
    key: r.item_key,
    kind: r.kind,
    kindName: KINDS[r.kind] || r.kind,
    title: r.title,
    deletedBy: r.deleted_by,
    deletedAt: r.deleted_at,
    restoredBy: r.restored_by || null,
    restoredAt: r.restored_at || null,
  }));
}

// ===== ROUTES =====

// Admins (role admin), signed in to Portal: a browser's cookie or the studio PC's own sign-in
const isAdmin = (me) => me && me.role === "admin";

export async function testStuff(env) {
  const data = await loadData(env);
  const items = findTestStuff(data);
  return {
    items,
    real: data.real.map((r) => ({ key: r.key, kind: r.kind, kindName: KINDS[r.kind] || r.kind, title: r.title, markedBy: r.marked_by, markedAt: r.marked_at })),
    recent: await recentlyDeleted(env),
    counts: { likely: items.filter((i) => i.confidence === "likely").length, maybe: items.filter((i) => i.confidence === "maybe").length },
  };
}

// Portal's /app/api/tidy… -> a Response, or null
export async function handleTidyForStaff(request, env, me, route) {
  if (route !== "/tidy" && !route.startsWith("/tidy/")) return null;
  if (!isAdmin(me)) return json({ error: "Test stuff is for admins." }, 403);
  if (route === "/tidy" && request.method === "GET") return json(await testStuff(env));
  if (request.method !== "POST") return null;
  const body = await readJson(request);
  if (route === "/tidy/delete") {
    const keys = Array.isArray(body.items) ? body.items.slice(0, 200) : [];
    if (!keys.length) return json({ error: "Nothing to delete." }, 400);
    const done = [];
    const failed = [];
    for (const it of keys) {
      const res = await deleteItem(env, me, { key: it.key, title: it.title, together: it.together !== false, linked: Array.isArray(it.linked) ? it.linked : [] });
      if (res.error) failed.push({ key: it.key, error: res.error });
      else done.push({ key: it.key, binId: res.binId, count: res.count, skipped: res.skipped });
    }
    return json({ ok: true, done, failed });
  }
  if (route === "/tidy/restore") return answer(await restoreItem(env, me, body));
  if (route === "/tidy/real") return answer(await markReal(env, me, body));
  if (route === "/tidy/unreal") return answer(await unmarkReal(env, me, body));
  return null;
}

// Nova Agent's /nova-agent/tidy: read only (what looks like a test, and why). No deleting.
export async function tidyForAgent(env) {
  const { items, counts } = await testStuff(env);
  return json({
    counts,
    items: items.slice(0, 60).map((i) => ({ kind: i.kindName, title: i.title, confidence: i.confidence, reasons: i.reasons.map((r) => r.text), goesWith: i.linked.length })),
    where: "Portal → Test stuff (admins delete there)",
  });
}

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

// (for tests)
export const _internal = { reasonsFor, verdict, getFile };

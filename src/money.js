// Money: invoices to clients, payments against them, and the studio's expenses
// (migrations/0029_money.sql)
//
// Who can do what is decided here and in the routes, whatever any AI says:
//
//   - Nova Agent's AI (AGENT_NOVA_KEY, src/agent-nova.js) can read the money summary and the
//     invoices, write an invoice and edit one that hasn't gone, and log an expense, which comes in
//     'unconfirmed' (it counts in no total until someone in the team confirms it). Nothing the
//     agent's key reaches approves or emails an invoice or a reminder, records or removes a
//     payment, voids an invoice, or changes the bank details.
//   - Any staff signed in to Portal can write and edit invoices, ask for a reminder, record a
//     payment, and add, change, confirm or remove expenses.
//   - Only an admin signed in to Portal in a browser (role 'admin' and the session cookie) can
//     Approve or Reject an invoice or a reminder, send themselves a test, void an invoice, take
//     back a payment, change the invoice settings (studio details, bank details, VAT) and export.
//
// Emailing an invoice or a reminder works like a campaign (src/campaigns.js): approving is one
// guarded UPDATE (… WHERE status = <what the admin saw> AND updated_at = <when it last changed>),
// it stores a hash of exactly what was approved, the sender only sends from 'approved' with a
// matching hash, and any edit puts it back to 'pending_approval' with the approval cleared.
//
// The client gets a link to their invoice's own page (/invoice/<token>: a random secret, nothing
// else in the address) to see it, print it or save it as a PDF, and pay: by card through Stripe's
// own checkout page when Stripe is set up (its webhook records the payment), with Monzo (the studio's
// Monzo link, the amount filled in) or by bank transfer with the studio's bank details from the
// invoice settings.
//
// Clients on the client list (src/clients.js) keep their money fields in step: sending an
// invoice adds its total to what they've been invoiced and what they owe; a payment takes it off
// what they owe (never below nothing); taking a payment back or voiding an invoice undoes that.
//
// Money is whole pence. Days are UK days (YYYY-MM-DD); moments are UTC. Logs say ids and counts
// only, never anyone's details or a key.

import { notifyPhones } from "./push.js";
import { publicUrl } from "./nova/booking.js";
import { emailRecipients, mailReady, sendEmail } from "./enquiries.js";
import { sendStudioEmail } from "./google/gmail.js";
import { pounds as poundsText, toPence } from "./clients.js";
import { createInvoiceCheckout, stripeOffline } from "./nova/stripe.js";
import { invoiceEmailParts } from "./invoice-email.js";
import { BILLINGS, INVOICE_MODES, INVOICE_PAPERS, INVOICE_THEMES, STAGES, afterSession, themeId, catalogue, invoiceDocument, stageEmail, stageMessage, stageOf, stageSums } from "./invoicer.js";

export const CATEGORIES = [
  "Equipment",
  "Software and subscriptions",
  "Studio rent and bills",
  "Marketing and ads",
  "Musicians and freelancers",
  "Travel",
  "Repairs and upkeep",
  "Food and hospitality",
  "Bank and payment fees",
  "Other",
];
export const METHODS = ["bank", "card", "cash", "stripe", "other"];
const METHOD_NAMES = { bank: "Bank transfer", card: "Card", cash: "Cash", stripe: "Card (Stripe)", other: "Other" };

const PREFIX = "NS-";
const MAX_LINES = 30;
const MAX_LINE_TEXT = 300;
const MAX_NOTES = 2000;
const MAX_ADDRESS = 400;
// Invoices waiting for approval at once, at most (stops a runaway AI filling the list)
const MAX_WAITING = 30;
// Unconfirmed expenses from the AI at once, at most
const MAX_UNCONFIRMED = 50;
// One invoice, at most £100,000 (a typo guard)
const MAX_TOTAL_PENCE = 10_000_000;
// An invoice still 'approved' (sending) after this long was cut off part-way
const STUCK_MS = 10 * 60 * 1000;
// One test email per person per this long
const TEST_GAP_MS = 30 * 1000;
const SETTINGS_KEY = "money_settings";
const EMAIL_PATTERN = /^[^\s@<>"]+@[^\s@<>"]+\.[^\s@<>"]{2,}$/;
const RECEIPT_PATTERN = /^r-[a-z0-9-]{6,60}$/;
const WAITING = ["draft", "pending_approval"];
const OPEN = ["sent", "part_paid"];

const nowIso = () => new Date().toISOString();
const fail = (status, error) => ({ status, error });
const hex = (bytes) => [...bytes].map((b) => b.toString(16).padStart(2, "0")).join("");

// ===== SMALL THINGS =====

function cleanText(value, max) {
  return typeof value === "string" ? value.replace(/\r\n?/g, "\n").replace(/[ \t]+\n/g, "\n").trim().slice(0, max) : "";
}
const oneLine = (value, max) => cleanText(value, max).replace(/\s*\n\s*/g, " ");

function positiveId(value) {
  const n = typeof value === "string" && /^\d{1,12}$/.test(value.trim()) ? Number(value) : value;
  return Number.isInteger(n) && n > 0 ? n : null;
}

// Today in the UK, YYYY-MM-DD
export function ukToday(now = new Date()) {
  return new Intl.DateTimeFormat("en-CA", { timeZone: "Europe/London" }).format(now);
}
export function isDay(value) {
  if (typeof value !== "string" || !/^\d{4}-\d{2}-\d{2}$/.test(value)) return false;
  const d = new Date(value + "T00:00:00Z");
  return !Number.isNaN(d.getTime()) && d.toISOString().slice(0, 10) === value;
}
export function addDays(day, n) {
  const d = new Date(day + "T00:00:00Z");
  d.setUTCDate(d.getUTCDate() + n);
  return d.toISOString().slice(0, 10);
}
// The UK tax year a day is in: 6 April to 5 April -> { from, to, name: "2026–27" }
export function taxYear(day) {
  const y = Number(day.slice(0, 4));
  const start = day >= `${y}-04-06` ? y : y - 1;
  return { from: `${start}-04-06`, to: `${start + 1}-04-05`, name: `${start}–${String(start + 1).slice(2)}` };
}
const monthOf = (day) => ({ from: day.slice(0, 8) + "01", to: addDays(addDays(day.slice(0, 8) + "28", 4).slice(0, 8) + "01", -1) });

// "£1,234.50"
export function money(pence) {
  const p = Math.round(Number(pence) || 0);
  const [whole, part] = poundsText(Math.abs(p)).split(".");
  return `${p < 0 ? "-" : ""}£${Number(whole).toLocaleString("en-GB")}.${part}`;
}
// "12 Oct 2026"
export function dayText(day) {
  return isDay(day) ? new Date(day + "T12:00:00Z").toLocaleDateString("en-GB", { day: "numeric", month: "short", year: "numeric", timeZone: "UTC" }) : "";
}

const esc = (s) => String(s ?? "").replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c]);

async function sha256Hex(text) {
  return hex(new Uint8Array(await crypto.subtle.digest("SHA-256", new TextEncoder().encode(text))));
}

// (A test invoice, after Start the numbers again: TEST-0001… its seq is below zero)
export const invoiceNumber = (seq) => (seq < 0 ? "TEST-" + String(-seq).padStart(4, "0") : PREFIX + String(seq).padStart(4, "0"));

// ===== THE SETTINGS (studio details, bank details, VAT, payment terms) =====

const DEFAULT_SETTINGS = {
  business: { name: "Novacane Studios", address: "", email: "", vatNumber: "", phone: "", website: "" },
  bank: { accountName: "", sortCode: "", accountNumber: "", note: "" },
  // Monzo (17 October 2026): the studio's monzo.me name or Monzo payment link (src/invoicer.js's monzoLink)
  monzo: { link: "" },
  vatRate: 0,
  dueDays: 14,
  invoiceTheme: "night",
  invoiceMode: "bright",
  invoicePaper: "moonstone",
};

export async function readSettings(env) {
  let saved = {};
  try {
    saved = JSON.parse((await env.DB.prepare("SELECT value FROM settings WHERE key = ?").bind(SETTINGS_KEY).first("value")) || "{}") || {};
  } catch {}
  return {
    business: { ...DEFAULT_SETTINGS.business, ...(saved.business || {}) },
    bank: { ...DEFAULT_SETTINGS.bank, ...(saved.bank || {}) },
    monzo: { ...DEFAULT_SETTINGS.monzo, ...(saved.monzo || {}) },
    vatRate: Number.isFinite(saved.vatRate) ? saved.vatRate : DEFAULT_SETTINGS.vatRate,
    dueDays: Number.isInteger(saved.dueDays) ? saved.dueDays : DEFAULT_SETTINGS.dueDays,
    invoiceTheme: themeId(saved.invoiceTheme) || DEFAULT_SETTINGS.invoiceTheme,
    invoiceMode: INVOICE_MODES.includes(saved.invoiceMode) ? saved.invoiceMode : DEFAULT_SETTINGS.invoiceMode,
    invoicePaper: INVOICE_PAPERS.some((x) => x.id === saved.invoicePaper) ? saved.invoicePaper : DEFAULT_SETTINGS.invoicePaper,
  };
}
export const bankReady = (s) => Boolean(s.bank.accountName && s.bank.sortCode && s.bank.accountNumber);
// A Monzo link as typed ("monzo.me/novacane", "https://monzo.me/novacane/", "@novacane", "novacane")
// -> "https://monzo.me/novacane"; a Monzo payment link is kept as it is
const MONZO_LINK = /^https:\/\/((www\.)?monzo\.me\/[A-Za-z0-9._-]+|([a-z0-9-]+\.)*monzo\.com\/\S+)$/i;
function monzoClean(value) {
  const v = oneLine(value, 300).replace(/\s/g, "");
  if (!v) return "";
  const name = v.match(/^@?([A-Za-z0-9._-]+)$/);
  if (name && !/\./.test(name[1])) return `https://monzo.me/${name[1]}`;
  const link = /^https?:\/\//i.test(v) ? v.replace(/^http:/i, "https:") : `https://${v}`;
  return link.replace(/^(https:\/\/(?:www\.)?monzo\.me\/[A-Za-z0-9._-]+)\/?$/i, "$1");
}

export async function saveSettings(env, me, input) {
  const s = await readSettings(env);
  const b = input?.business || {};
  const k = input?.bank || {};
  const mz = input?.monzo || {};
  const next = {
    business: {
      name: b.name !== undefined ? oneLine(b.name, 120) || DEFAULT_SETTINGS.business.name : s.business.name,
      address: b.address !== undefined ? cleanText(b.address, MAX_ADDRESS) : s.business.address,
      email: b.email !== undefined ? oneLine(b.email, 200).toLowerCase() : s.business.email,
      vatNumber: b.vatNumber !== undefined ? oneLine(b.vatNumber, 30) : s.business.vatNumber,
      phone: b.phone !== undefined ? oneLine(b.phone, 40) : s.business.phone,
      website: b.website !== undefined ? oneLine(b.website, 120) : s.business.website,
    },
    bank: {
      accountName: k.accountName !== undefined ? oneLine(k.accountName, 120) : s.bank.accountName,
      sortCode: k.sortCode !== undefined ? oneLine(k.sortCode, 20) : s.bank.sortCode,
      accountNumber: k.accountNumber !== undefined ? oneLine(k.accountNumber, 34) : s.bank.accountNumber,
      note: k.note !== undefined ? oneLine(k.note, 200) : s.bank.note,
    },
    monzo: { link: mz.link !== undefined ? monzoClean(mz.link) : s.monzo.link },
    vatRate: s.vatRate,
    dueDays: s.dueDays,
    invoiceTheme: s.invoiceTheme,
    invoiceMode: s.invoiceMode,
    invoicePaper: s.invoicePaper,
  };
  if (input?.invoicePaper !== undefined) {
    if (!INVOICE_PAPERS.some((x) => x.id === input.invoicePaper)) return fail(400, "invoicePaper: one of " + INVOICE_PAPERS.map((x) => x.id).join(", ") + ".");
    next.invoicePaper = input.invoicePaper;
  }
  if (input?.invoiceMode !== undefined) {
    if (!INVOICE_MODES.includes(input.invoiceMode)) return fail(400, "invoiceMode: bright or dark.");
    next.invoiceMode = input.invoiceMode;
  }
  if (input?.invoiceTheme !== undefined) {
    if (!themeId(input.invoiceTheme)) return fail(400, "invoiceTheme: one of " + INVOICE_THEMES.map((t) => t.id).join(", ") + ".");
    next.invoiceTheme = themeId(input.invoiceTheme);
  }
  if (next.business.email && !EMAIL_PATTERN.test(next.business.email)) return fail(400, "The studio's email address doesn't look right.");
  if (next.bank.sortCode && !/^\d{2}-?\d{2}-?\d{2}$/.test(next.bank.sortCode.replace(/\s/g, ""))) return fail(400, "A sort code is six numbers, like 12-34-56.");
  if (next.bank.accountNumber && !/^(\d{8}|[A-Z]{2}\d{2}[A-Z0-9]{10,30})$/.test(next.bank.accountNumber.replace(/\s/g, "").toUpperCase())) return fail(400, "An account number is eight numbers (or an IBAN).");
  if (next.monzo.link && !MONZO_LINK.test(next.monzo.link)) return fail(400, "A Monzo link is your monzo.me name (like monzo.me/novacane) or a Monzo payment link.");
  if (input?.vatRate !== undefined) {
    const v = Number(input.vatRate);
    if (!Number.isFinite(v) || v < 0 || v > 100) return fail(400, "VAT is a percent from 0 to 100 (0 if the studio isn't VAT registered).");
    next.vatRate = Math.round(v * 100) / 100;
  }
  if (input?.dueDays !== undefined) {
    const d = Number(input.dueDays);
    if (!Number.isInteger(d) || d < 0 || d > 120) return fail(400, "Payment terms are 0 to 120 days.");
    next.dueDays = d;
  }
  await env.DB.batch([
    env.DB.prepare("INSERT INTO settings (key, value) VALUES (?, ?) ON CONFLICT (key) DO UPDATE SET value = excluded.value").bind(SETTINGS_KEY, JSON.stringify(next)),
    logEntry(env, { event: "settings", by: me.id, detail: "Invoice settings changed" }),
  ]);
  return { settings: next };
}

// ===== THE SUMS =====

// Lines as typed -> [{ description, qty, unit_pence }] or { problem }. A line's unit price can come
// as whole pence (unitPence) or pounds ("150", "£1,200.50": unit).
export function readLines(value) {
  if (!Array.isArray(value) || !value.length) return { problem: "lines: at least one line (what it's for, how many, the price of one)." };
  if (value.length > MAX_LINES) return { problem: `lines: ${MAX_LINES} at most.` };
  const lines = [];
  for (const [i, raw] of value.entries()) {
    const n = i + 1;
    const description = oneLine(raw?.description, MAX_LINE_TEXT);
    if (!description) return { problem: `Line ${n}: what is it for?` };
    const qty = raw?.qty === undefined || raw?.qty === "" ? 1 : Number(raw.qty);
    if (!Number.isFinite(qty) || qty <= 0 || qty > 10000 || Math.round(qty * 100) !== qty * 100) return { problem: `Line ${n}: how many (more than 0, up to two decimal places).` };
    let unit = null;
    if (raw?.unitPence !== undefined || raw?.unit_pence !== undefined) {
      const p = Number(raw.unitPence ?? raw.unit_pence);
      unit = Number.isInteger(p) && p >= 0 ? p : null;
    } else unit = toPence(raw?.unit);
    if (unit === null) return { problem: `Line ${n}: the price of one, in pounds (like 150 or 150.00).` };
    lines.push({ description, qty, unit_pence: unit });
  }
  return { lines };
}

export const lineTotal = (line) => Math.round(line.qty * line.unit_pence);

// Subtotal, VAT and total in whole pence (VAT rounded once, on the subtotal)
export function totals(lines, vatRate) {
  const subtotal = lines.reduce((sum, l) => sum + lineTotal(l), 0);
  const vat = Math.round((subtotal * (Number(vatRate) || 0)) / 100);
  return { subtotal_pence: subtotal, vat_pence: vat, total_pence: subtotal + vat };
}

// The hash of exactly what an admin approves
export function invoiceHash(row) {
  return sha256Hex(
    JSON.stringify(["nova-invoice-v1", row.client_id ?? null, row.bill_name, row.bill_email || null, row.bill_address || "", row.lines, Number(row.vat_rate) || 0, row.total_pence, row.issue_date, row.due_date, row.notes || "", ...(row.billing === "full" ? ["full"] : [])])
  );
}
const reminderHash = (row, invoice) => sha256Hex(JSON.stringify(["nova-invoice-reminder-v2", row.kind || "reminder", row.invoice_id, row.body, invoice.bill_email || null, invoice.total_pence - invoice.paid_pence]));

// An invoice's own look ({ theme, mode, paper }, each optional), from what's saved or what's sent:
// only the known ones kept; nothing chosen: null (the studio's look)
export function invoiceLook(input) {
  let v = input;
  if (typeof v === "string") {
    try {
      v = JSON.parse(v);
    } catch {
      return null;
    }
  }
  if (!v || typeof v !== "object") return null;
  const look = {};
  if (themeId(v.theme)) look.theme = themeId(v.theme);
  if (INVOICE_MODES.includes(v.mode)) look.mode = v.mode;
  if (INVOICE_PAPERS.some((x) => x.id === v.paper)) look.paper = v.paper;
  return Object.keys(look).length ? look : null;
}
const lookText = (input) => {
  const look = invoiceLook(input);
  return look ? JSON.stringify(look) : null;
};

// ===== READING =====

const SELECT = "SELECT i.*, s.display_name AS decided_by_name FROM invoices i LEFT JOIN staff s ON s.id = i.decided_by";
const isStuck = (row) => row.status === "approved" && Date.now() - Date.parse(row.updated_at) > STUCK_MS;
const parseLines = (text) => {
  try {
    const lines = JSON.parse(text);
    return Array.isArray(lines) ? lines : [];
  } catch {
    return [];
  }
};
export const isOverdue = (row, today = ukToday()) => OPEN.includes(row.status) && row.due_date < today;

// An invoice as Portal and Nova Agent see it
export function publicInvoice(env, row, today = ukToday()) {
  if (!row) return null;
  const stuck = isStuck(row);
  const lines = parseLines(row.lines);
  const sent = ["sent", "part_paid", "paid", "void"].includes(row.status);
  return {
    id: row.id,
    number: invoiceNumber(row.seq),
    clientId: row.client_id ?? null,
    billTo: { name: row.bill_name, email: row.bill_email || null, address: row.bill_address || "" },
    billing: row.billing === "full" ? "full" : "deposit",
    lines: lines.map((l) => ({ description: l.description, qty: l.qty, unitPence: l.unit_pence, totalPence: lineTotal(l) })),
    vatRate: Number(row.vat_rate) || 0,
    subtotalPence: row.subtotal_pence,
    vatPence: row.vat_pence,
    totalPence: row.total_pence,
    paidPence: row.paid_pence,
    balancePence: Math.max(0, row.total_pence - row.paid_pence),
    issueDate: row.issue_date,
    dueDate: row.due_date,
    notes: row.notes || "",
    look: invoiceLook(row.look),
    status: stuck ? "failed" : row.status,
    overdue: isOverdue(row, today),
    createdBy: row.created_by,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
    decidedBy: row.decided_by || null,
    decidedByName: row.decided_by_name || null,
    decidedAt: row.decided_at || null,
    note: row.decision_note || null,
    sentAt: row.sent_at || null,
    paidAt: row.paid_at || null,
    voidedAt: row.voided_at || null,
    error: stuck ? "It didn't finish sending (Nova Bot stopped part-way). Check the inbox it went to before sending it again." : row.error || null,
    pageUrl: sent ? `${publicUrl(env)}/invoice/${row.token}` : null,
    portalUrl: `${publicUrl(env)}/portal/?view=money&invoice=${row.id}`,
  };
}

const readRow = (env, id) => env.DB.prepare(`${SELECT} WHERE i.id = ?`).bind(id).first();

export async function getInvoice(env, id) {
  return publicInvoice(env, await readRow(env, id));
}

// status: "waiting", "open" (sent or part paid), "overdue", one status, or "all"
export async function listInvoices(env, { status = "all", limit = 200 } = {}) {
  const today = ukToday();
  const order = "ORDER BY CASE WHEN i.status IN ('draft', 'pending_approval') THEN 0 ELSE 1 END, i.id DESC LIMIT ?";
  let query;
  if (status === "waiting") query = env.DB.prepare(`${SELECT} WHERE i.status IN ('draft', 'pending_approval') ${order}`).bind(limit);
  else if (status === "open") query = env.DB.prepare(`${SELECT} WHERE i.status IN ('sent', 'part_paid') ${order}`).bind(limit);
  else if (status === "overdue") query = env.DB.prepare(`${SELECT} WHERE i.status IN ('sent', 'part_paid') AND i.due_date < ? ${order}`).bind(today, limit);
  else if (["draft", "pending_approval", "approved", "rejected", "failed", "sent", "part_paid", "paid", "void"].includes(status)) query = env.DB.prepare(`${SELECT} WHERE i.status = ? ${order}`).bind(status, limit);
  else query = env.DB.prepare(`${SELECT} ${order}`).bind(limit);
  const { results } = await query.all();
  return results.map((row) => publicInvoice(env, row, today));
}

function paymentShape(r) {
  return { id: r.id, invoiceId: r.invoice_id, amountPence: r.amount_pence, paidOn: r.paid_on, method: r.method, methodName: METHOD_NAMES[r.method] || r.method, note: r.note || "", by: r.by, byName: r.by_name || null, createdAt: r.created_at, removed: Boolean(r.removed_at) };
}
export async function invoicePayments(env, id) {
  const { results } = await env.DB.prepare('SELECT p.*, s.display_name AS by_name FROM invoice_payments p LEFT JOIN staff s ON s.id = p."by" WHERE p.invoice_id = ? ORDER BY p.paid_on, p.id').bind(id).all();
  return results.map(paymentShape);
}

function reminderShape(r) {
  return { id: r.id, invoiceId: r.invoice_id, kind: r.kind || "reminder", body: r.body, status: r.status, createdBy: r.created_by, createdAt: r.created_at, updatedAt: r.updated_at, decidedByName: r.decided_by_name || null, decidedAt: r.decided_at || null, sentAt: r.sent_at || null, error: r.error || null };
}
const REMINDER_SELECT = "SELECT r.*, s.display_name AS decided_by_name FROM invoice_reminders r LEFT JOIN staff s ON s.id = r.decided_by";

export async function moneyLog(env, id) {
  const { results } = await env.DB.prepare('SELECT l.*, s.display_name AS by_name FROM money_log l LEFT JOIN staff s ON s.id = l."by" WHERE l.invoice_id = ? ORDER BY l.id').bind(id).all();
  return results.map((r) => ({ id: r.id, at: r.at, event: r.event, by: r.by, byName: r.by_name || null, detail: r.detail || null }));
}

function logEntry(env, { invoice = null, expense = null, event, by, detail = null }) {
  return env.DB.prepare('INSERT INTO money_log (invoice_id, expense_id, at, event, "by", detail) VALUES (?, ?, ?, ?, ?, ?)').bind(invoice, expense, nowIso(), event, by == null ? null : String(by), detail);
}

// ===== WRITING AND EDITING AN INVOICE (the AI, or any staff) =====

// Check an invoice's fields. `base` is what's saved (for an edit: only what's given changes).
async function checkFields(env, input, base = null, settings = null) {
  const has = (key) => input && Object.hasOwn(input, key) && input[key] !== undefined;
  settings = settings || (await readSettings(env));
  let clientId = base ? base.client_id ?? null : null;
  let client = null;
  if (has("clientId")) {
    if (input.clientId === null || input.clientId === "") clientId = null;
    else {
      clientId = positiveId(input.clientId);
      if (!clientId) return fail(400, "clientId: which client (their number on the client list)?");
      client = await env.DB.prepare("SELECT id, name, email FROM clients WHERE id = ?").bind(clientId).first();
      if (!client) return fail(404, "That client isn't on the client list.");
    }
  }
  // A client picked (and no name or email typed): theirs
  const bill_name = has("billName") ? oneLine(input.billName, 120) : client ? client.name : base ? base.bill_name : "";
  const bill_email = has("billEmail") ? oneLine(input.billEmail, 200).toLowerCase() || null : client ? client.email || null : base ? base.bill_email : null;
  const bill_address = has("billAddress") ? cleanText(input.billAddress, MAX_ADDRESS) : base ? base.bill_address : "";
  const name = bill_name || client?.name || "";
  if (!name) return fail(400, "billName: who is the invoice to?");
  if (bill_email && !EMAIL_PATTERN.test(bill_email)) return fail(400, "billEmail: that email address doesn't look right.");
  let lines = base ? parseLines(base.lines) : null;
  if (has("lines")) {
    const read = readLines(input.lines);
    if (read.problem) return fail(400, read.problem);
    lines = read.lines;
  }
  if (!lines || !lines.length) return fail(400, "lines: at least one line (what it's for, how many, the price of one).");
  let vat_rate = base ? Number(base.vat_rate) || 0 : settings.vatRate;
  if (has("vatRate")) {
    const v = Number(input.vatRate);
    if (!Number.isFinite(v) || v < 0 || v > 100) return fail(400, "vatRate: a percent from 0 to 100.");
    vat_rate = Math.round(v * 100) / 100;
  }
  const today = ukToday();
  const issue_date = has("issueDate") ? input.issueDate : base ? base.issue_date : today;
  if (!isDay(issue_date)) return fail(400, "issueDate: a day, YYYY-MM-DD.");
  let due_date = has("dueDate") ? input.dueDate : base ? base.due_date : addDays(issue_date, settings.dueDays);
  if (!due_date) due_date = addDays(issue_date, settings.dueDays);
  if (!isDay(due_date)) return fail(400, "dueDate: a day, YYYY-MM-DD.");
  if (due_date < issue_date) return fail(400, "dueDate is before the issue date.");
  const notes = has("notes") ? cleanText(input.notes, MAX_NOTES) : base ? base.notes : "";
  // Before the session (a deposit secures the date) or after it (the full amount)
  const billing = has("billing") ? input.billing : base?.billing === "full" ? "full" : "deposit";
  if (!BILLINGS.includes(billing)) return fail(400, 'billing: "deposit" (before the session: a deposit secures the date) or "full" (after the session: the full amount).');
  const sums = totals(lines, vat_rate);
  if (sums.total_pence <= 0) return fail(400, "The invoice comes to nothing: check the prices.");
  if (sums.total_pence > MAX_TOTAL_PENCE) return fail(400, "That's more than £100,000: check the prices.");
  return { client_id: clientId, bill_name: name, bill_email, bill_address, lines: JSON.stringify(lines), vat_rate, ...sums, issue_date, due_date, notes, billing };
}

const WRITERS = { agent: "Agent", "staff-chat": "Portal's staff chat", nova: "Nova Bot" };

// A quiet ping to the admins' phones (they're the ones who can approve). Not to the person who
// wrote it, if that's an admin.
async function pingAdmins(env, { title, body, url, tag, by }) {
  try {
    const { results } = await env.DB.prepare("SELECT id FROM staff WHERE role = 'admin' AND status = 'active' AND id != ?").bind(String(by)).all();
    if (!results.length) return;
    await notifyPhones(env, { title, body, url, style: { source: "portal", kind: "money", tag, ttl: 12 * 3600, urgent: false }, to: { staff: results.map((r) => r.id) } });
  } catch (err) {
    console.log(`Money: the ping failed (${err?.message})`);
  }
}
const whoWrote = (by) => WRITERS[by] || "A colleague";

// A new invoice, waiting for approval. by: 'agent' or a staff id.
export async function createInvoice(env, input, by) {
  const fields = await checkFields(env, input || {});
  if (fields.error) return fields;
  const { count } = await env.DB.prepare("SELECT COUNT(*) AS count FROM invoices WHERE status IN ('draft', 'pending_approval')").first();
  if (count >= MAX_WAITING) return fail(429, "There are already many invoices waiting for approval. Ask an admin to go through them in Portal → Money first.");
  const now = nowIso();
  const token = hex(crypto.getRandomValues(new Uint8Array(16)));
  // The next number, in the same statement (two at once can't get the same one: seq is UNIQUE)
  const row = await env.DB.prepare(
    `INSERT INTO invoices (seq, token, client_id, bill_name, bill_email, bill_address, lines, vat_rate, subtotal_pence, vat_pence, total_pence,
       issue_date, due_date, notes, billing, look, status, created_by, created_at, updated_at, submitted_at)
     SELECT COALESCE(MAX(CASE WHEN seq > 0 THEN seq END), 0) + 1, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'pending_approval', ?, ?, ?, ? FROM invoices RETURNING id, seq`
  )
    .bind(token, fields.client_id, fields.bill_name, fields.bill_email, fields.bill_address, fields.lines, fields.vat_rate, fields.subtotal_pence, fields.vat_pence, fields.total_pence, fields.issue_date, fields.due_date, fields.notes, fields.billing, lookText(input?.look), String(by), now, now, now)
    .first();
  await env.DB.batch([
    logEntry(env, { invoice: row.id, event: "created", by, detail: `${invoiceNumber(row.seq)} for ${money(fields.total_pence)}` }),
    logEntry(env, { invoice: row.id, event: "submitted", by }),
  ]);
  const invoice = await getInvoice(env, row.id);
  console.log(`Invoice ${row.id} written by ${by === "agent" ? "agent" : "staff"}; waiting for approval`);
  await pingAdmins(env, {
    title: "Invoice to approve",
    body: `${whoWrote(by)} wrote invoice ${invoice.number} to ${invoice.billTo.name} for ${money(invoice.totalPence)}. Nothing is emailed until an admin approves it in Portal → Money.`,
    url: `/portal/?view=money&invoice=${row.id}`,
    tag: `invoice-${row.id}`,
    by,
  });
  return { invoice };
}

// Change an invoice that hasn't gone: back to 'pending_approval', approval cleared
export async function editInvoice(env, by, id, input) {
  id = positiveId(id);
  if (!id) return fail(400, "Which invoice?");
  const row = await readRow(env, id);
  if (!row) return fail(404, "That invoice doesn't exist.");
  if (row.status === "paid") return fail(409, `${invoiceNumber(row.seq)} is paid in full, so it can't change.`);
  if (row.status === "void") return fail(409, `${invoiceNumber(row.seq)} was removed, so it can't change.`);
  if (row.status === "approved" && !isStuck(row)) return fail(409, "It's being sent right now.");
  const fields = await checkFields(env, input || {}, row);
  if (fields.error) return fields;
  // (a sent one can change too: it goes for approval again, then the client gets the updated invoice;
  // never below what's already been paid)
  const wasSent = OPEN.includes(row.status);
  if (wasSent && fields.total_pence < row.paid_pence) return fail(409, `${money(row.paid_pence)} has already been paid, so the total can't go below that.`);
  const keys = ["client_id", "bill_name", "bill_email", "bill_address", "lines", "vat_rate", "total_pence", "issue_date", "due_date", "notes", "billing"];
  const changed = keys.filter((k) => (fields[k] ?? null) !== ((k === "billing" ? (row.billing === "full" ? "full" : "deposit") : row[k]) ?? null));
  if (!changed.length && WAITING.includes(row.status)) return { invoice: publicInvoice(env, row), unchanged: true };
  const now = nowIso();
  const { meta } = await env.DB.prepare(
    `UPDATE invoices SET client_id = ?, bill_name = ?, bill_email = ?, bill_address = ?, lines = ?, vat_rate = ?, subtotal_pence = ?, vat_pence = ?, total_pence = ?,
       issue_date = ?, due_date = ?, notes = ?, billing = ?, status = 'pending_approval', approved_hash = NULL, decided_by = NULL, decided_at = NULL, error = NULL,
       updated_at = ?, submitted_at = ?
     WHERE id = ? AND status = ? AND updated_at = ?`
  )
    .bind(fields.client_id, fields.bill_name, fields.bill_email, fields.bill_address, fields.lines, fields.vat_rate, fields.subtotal_pence, fields.vat_pence, fields.total_pence, fields.issue_date, fields.due_date, fields.notes, fields.billing, now, now, id, row.status, row.updated_at)
    .run();
  if (!meta.changes) return fail(409, "Someone else changed it at the same moment. Look at it again.");
  if (input?.look !== undefined) await env.DB.prepare("UPDATE invoices SET look = ? WHERE id = ?").bind(lookText(input.look), id).run();
  if (wasSent && row.client_id) await env.DB.batch(clientDelta(env, row.client_id, { invoiced: -row.total_pence, owed: -(row.total_pence - row.paid_pence) }, by));
  const names = { client_id: "client", bill_name: "name", bill_email: "email", bill_address: "address", lines: "lines", vat_rate: "VAT", total_pence: "total", issue_date: "issue date", due_date: "due date", notes: "notes", billing: "before or after the session" };
  await env.DB.batch([
    logEntry(env, { invoice: id, event: "edited", by, detail: `${wasSent ? "Changed after it was sent (the client gets the updated invoice once it's approved). " : ""}${changed.length ? `Changed: ${changed.map((k) => names[k]).join(", ")}` : "Sent for approval again"}` }),
    logEntry(env, { invoice: id, event: "submitted", by }),
  ]);
  const invoice = await getInvoice(env, id);
  await pingAdmins(env, {
    title: "Invoice changed: approve it again",
    body: `${whoWrote(by)} changed invoice ${invoice.number} to ${invoice.billTo.name} (${money(invoice.totalPence)}). Nothing is emailed until an admin approves it in Portal → Money.`,
    url: `/portal/?view=money&invoice=${id}`,
    tag: `invoice-${id}`,
    by,
  });
  return { invoice };
}

// ===== AN ADMIN DECIDES (a person pressed a button in Portal; handleMoneyForStaff checks who) =====

export function invoiceFrom(env) {
  return String(env.INVOICE_FROM || env.ENQUIRY_REPLY_FROM || env.ENQUIRY_EMAIL_FROM || "").trim();
}
export const emailReady = (env) => Boolean(mailReady(env) && invoiceFrom(env));
const NOT_READY = "Emails aren't set up: Nova Bot needs the studio's mail server (MAIL_API_URL, MAIL_KEY) and a from address (INVOICE_FROM, or the enquiry replies' ENQUIRY_REPLY_FROM).";
function replyTo(env, settings) {
  return settings.business.email || env.ENQUIRY_REPLY_TO || emailRecipients(env)[0] || undefined;
}

// Approve, then email it straight away. Only from 'pending_approval' (or 'draft').
// byHand: approved to be shared by the admin themselves (WhatsApp, a message, its link), not emailed:
// it counts as sent, and its page opens for whoever has the link
export async function approveInvoice(env, me, { id, byHand = false }) {
  id = positiveId(id);
  if (!id) return fail(400, "Which invoice?");
  const row = await readRow(env, id);
  if (!row) return fail(404, "That invoice doesn't exist.");
  if (["approved", "sent", "part_paid", "paid"].includes(row.status)) return { invoice: publicInvoice(env, row), repeated: true };
  if (row.status === "void") return fail(409, "That invoice was voided.");
  if (row.status === "rejected" || row.status === "failed") return fail(409, `That invoice ${row.status === "rejected" ? "was rejected" : "didn't send"}. Edit it (or just save it again) to send it for approval again.`);
  if (!byHand && !row.bill_email) return fail(409, "It has no email address to go to. Edit it and add one, or approve it to share by hand.");
  if (!byHand && !emailReady(env)) return fail(409, NOT_READY);
  const hash = await invoiceHash(row);
  const now = nowIso();
  const { meta } = await env.DB.prepare(
    `UPDATE invoices SET status = 'approved', approved_hash = ?, decided_by = ?, decided_at = ?, decision_note = NULL, error = NULL, updated_at = ?
     WHERE id = ? AND status = ? AND updated_at = ?`
  )
    .bind(hash, me.id, now, now, id, row.status, row.updated_at)
    .run();
  if (!meta.changes) {
    const latest = await readRow(env, id);
    if (latest && ["approved", "sent", "part_paid", "paid"].includes(latest.status)) return { invoice: publicInvoice(env, latest), repeated: true };
    return fail(409, "It changed while you were looking at it. Check it again, then approve.");
  }
  await logEntry(env, { invoice: id, event: "approved", by: me.id, detail: `${money(row.total_pence)}, ${byHand ? "to share by hand (no email)" : "emailed now"}` }).run();
  console.log(`Invoice ${id} approved by ${me.id}`);
  return { invoice: await sendApprovedInvoice(env, id, { byHand }) };
}

export async function rejectInvoice(env, me, { id, note }) {
  id = positiveId(id);
  if (!id) return fail(400, "Which invoice?");
  const text = cleanText(note, 500) || null;
  const now = nowIso();
  const { meta } = await env.DB.prepare(
    `UPDATE invoices SET status = 'rejected', approved_hash = NULL, decided_by = ?, decided_at = ?, decision_note = ?, updated_at = ?
     WHERE id = ? AND status IN ('draft', 'pending_approval')`
  )
    .bind(me.id, now, text, now, id)
    .run();
  if (!meta.changes) {
    const row = await readRow(env, id);
    if (!row) return fail(404, "That invoice doesn't exist.");
    return { ...fail(409, `That invoice is already ${row.status.replace("_", " ")}.`), invoice: publicInvoice(env, row) };
  }
  await logEntry(env, { invoice: id, event: "rejected", by: me.id, detail: text }).run();
  return { invoice: await getInvoice(env, id) };
}

// Void: an invoice that was wrong or isn't wanted. One that's been paid (any of it) can't be voided
// here: take the payments back first (and refund the client).
export async function voidInvoice(env, me, { id, note }) {
  id = positiveId(id);
  if (!id) return fail(400, "Which invoice?");
  const row = await readRow(env, id);
  if (!row) return fail(404, "That invoice doesn't exist.");
  if (row.status === "void") return { invoice: publicInvoice(env, row), repeated: true };
  if (row.status === "approved" && !isStuck(row)) return fail(409, "It's being sent right now.");
  if (row.paid_pence > 0) return fail(409, `${money(row.paid_pence)} has been paid against it. Take the payments back first (and refund the client), then void it.`);
  const wasSent = OPEN.includes(row.status);
  const now = nowIso();
  const { meta } = await env.DB.prepare(
    "UPDATE invoices SET status = 'void', voided_at = ?, approved_hash = NULL, decision_note = COALESCE(?, decision_note), updated_at = ? WHERE id = ? AND status = ? AND updated_at = ?"
  )
    .bind(now, cleanText(note, 500) || null, now, id, row.status, row.updated_at)
    .run();
  if (!meta.changes) return fail(409, "It changed while you were looking at it. Check it again.");
  const after = [logEntry(env, { invoice: id, event: "voided", by: me.id, detail: cleanText(note, 500) || null })];
  if (wasSent && row.client_id) after.push(...clientDelta(env, row.client_id, { invoiced: -row.total_pence, owed: -row.total_pence }, me.id));
  await env.DB.batch(after);
  return { invoice: await getInvoice(env, id) };
}

// A client's money fields, moved by an amount (never below nothing)
function clientDelta(env, clientId, { invoiced = 0, owed = 0 }, by) {
  return [
    env.DB.prepare(
      "UPDATE clients SET invoiced_pence = MAX(0, invoiced_pence + ?), outstanding_pence = MAX(0, outstanding_pence + ?), updated_at = ?, updated_by = ? WHERE id = ?"
    ).bind(invoiced, owed, nowIso(), String(by), clientId),
  ];
}

// ===== THE INVOICER'S LIVE PREVIEW =====
// Start the numbers again (an admin, while testing): every invoice so far becomes a test invoice,
// TEST-0001, TEST-0002… (nothing is deleted: each keeps its page, payments and history, and its log
// says what it was), and the next invoice is NS-0001. Again later: the new ones follow on after the
// old tests (TEST-0007…), so no two ever share a number.
export async function renumberAsTests(env, by) {
  const { n } = await env.DB.prepare("SELECT COUNT(*) AS n FROM invoices WHERE seq > 0").first();
  if (!n) return { renumbered: 0 };
  const { base } = await env.DB.prepare("SELECT COALESCE(MAX(-seq), 0) AS base FROM invoices WHERE seq < 0").first();
  const { results } = await env.DB.prepare("SELECT id, seq FROM invoices WHERE seq > 0 ORDER BY seq").all();
  await env.DB.batch([
    env.DB.prepare("UPDATE invoices SET seq = -(? + seq) WHERE seq > 0").bind(base),
    ...results.map((r) => logEntry(env, { invoice: r.id, event: "renumbered", by, detail: `${invoiceNumber(r.seq)} is now the test invoice ${invoiceNumber(-(base + r.seq))} (numbers started again at ${PREFIX}0001)` })),
  ]);
  console.log(`Money: ${results.length} invoices made test invoices; numbers start again`);
  return { renumbered: results.length };
}

// An invoice's look (colour, Bright or Dark, paper) changed: only how it looks, not what it says, so
// it needs no approval again. Its page shows it straight away; emails from now on use it (one already
// sent stays as it went). look: null = the studio's look again.
export async function setInvoiceLook(env, by, id, look) {
  id = positiveId(id);
  if (!id) return fail(400, "Which invoice?");
  const row = await readRow(env, id);
  if (!row) return fail(404, "That invoice doesn't exist.");
  if (row.status === "void") return fail(409, `${invoiceNumber(row.seq)} was removed, so it can't change.`);
  if (look !== null && look !== undefined && !invoiceLook(look)) return fail(400, "look: { theme, mode, paper } (one of the Invoicer's).");
  await env.DB.prepare("UPDATE invoices SET look = ? WHERE id = ?").bind(lookText(look), id).run();
  return { invoice: await getInvoice(env, id) };
}

// What's typed so far, drawn as the invoice will look: never saved, never numbered (it says "Draft"),
// lenient with what isn't there yet (no name: "Artist name"; a line still missing its price: £0)
export async function previewDocument(env, input = {}) {
  const settings = await readSettings(env);
  const lines = [];
  for (const raw of Array.isArray(input.lines) ? input.lines.slice(0, MAX_LINES) : []) {
    const description = oneLine(raw?.description, MAX_LINE_TEXT) || "Something else";
    const qty = Number(raw?.qty);
    const unit = toPence(raw?.unit);
    lines.push({ description, qty: Number.isFinite(qty) && qty > 0 && qty <= 10000 ? qty : 1, unit_pence: unit === null || unit < 0 ? 0 : unit });
  }
  const vatRate = settings.vatRate;
  const sums = totals(lines, vatRate);
  const today = ukToday();
  const issue = isDay(input.issueDate) ? input.issueDate : today;
  const due = isDay(input.dueDate) && input.dueDate >= issue ? input.dueDate : addDays(issue, settings.dueDays);
  const invoice = {
    id: 0,
    number: "Draft",
    status: "draft",
    billTo: { name: oneLine(input.billName, 120) || "Artist name", email: oneLine(input.billEmail, 200).toLowerCase() || null, address: cleanText(input.billAddress, MAX_ADDRESS) },
    billing: input.billing === "full" ? "full" : "deposit",
    lines: lines.map((l) => ({ description: l.description, qty: l.qty, unitPence: l.unit_pence, totalPence: lineTotal(l) })),
    vatRate,
    subtotalPence: sums.subtotal_pence,
    vatPence: sums.vat_pence,
    totalPence: sums.total_pence,
    paidPence: 0,
    issueDate: issue,
    dueDate: due,
    notes: cleanText(input.notes, MAX_NOTES),
    pageUrl: null,
  };
  const stage = STAGES.includes(input.stage) ? input.stage : invoice.billing === "full" ? "balance" : "deposit";
  const options = { theme: themeId(input.theme), mode: INVOICE_MODES.includes(input.mode) ? input.mode : null, paper: INVOICE_PAPERS.some((x) => x.id === input.paper) ? input.paper : null };
  return invoiceDocument(invoice, [], stage, settings, today, options);
}

// ===== THE EMAILS =====

// The invoice emails: the Nova invoice itself (src/invoice-email.js: the Invoicer's design, built for
// email apps, with a plain-text twin), with a short message above it
function invoiceMail(env, settings, row, payments, stage, { greeting, paragraphs }) {
  const today = ukToday();
  return invoiceEmailParts({ invoice: publicInvoice(env, row, today), payments, stage, settings, today, base: publicUrl(env), link: `${publicUrl(env)}/invoice/${row.token}`, greeting, paragraphs });
}
const firstName = (row) => `Hi ${String(row.bill_name || "").trim().split(/\s+/)[0] || "there"},`;

// The invoice email, in the words of its stage (src/invoicer.js's stageMessage): before the session it
// asks for the deposit that secures the date (the rest due on the day); after the session, it thanks
// them and asks for the full amount; one already part paid asks for what's left
export function invoiceEmail(env, settings, row) {
  const today = ukToday();
  const invoice = publicInvoice(env, row, today);
  const stage = stageOf(invoice, today);
  const sums = stageSums(invoice, [], stage, today);
  const { subject, paragraphs } = stageMessage(invoice, sums, stage, settings, today);
  // (the invoice under the message has the button to its page, Monzo and the bank details)
  paragraphs.splice(-1, 0, "You can pay, and save the invoice as a PDF, on its page.");
  const parts = invoiceMail(env, settings, row, [], stage, { greeting: firstName(row), paragraphs });
  return { subject, ...parts };
}
// The subject for an email at a stage: after the session, the thank-you; otherwise as it always was
function stageSubject(env, settings, row, stage, today = ukToday()) {
  const number = invoiceNumber(row.seq);
  if (stage === "paid") return `Receipt for invoice ${number} from ${settings.business.name}: paid in full, thank you`;
  if (stage === "overdue") return `Reminder: invoice ${number} from ${settings.business.name} is past due`;
  const invoice = publicInvoice(env, row, today);
  if (stage === "balance" && afterSession(invoice, today)) return stageMessage(invoice, stageSums(invoice, [], stage, today), stage, settings, today).subject;
  return `Reminder: invoice ${number} from ${settings.business.name}`;
}
// A message that still has a gap to fill in ("[Client Name]", "[Your Name]"): never emailed like that
const PLACEHOLDER = /\[[^\]\n]{1,40}\]/;

// Email an approved invoice. Only status 'approved' with an approval hash that still matches goes.
export async function sendApprovedInvoice(env, id, { byHand = false } = {}) {
  const row = await readRow(env, id);
  if (!row || row.status !== "approved") return publicInvoice(env, row);
  const failWith = async (error) => {
    await env.DB.batch([
      env.DB.prepare("UPDATE invoices SET status = 'failed', error = ?, updated_at = ? WHERE id = ? AND status = 'approved'").bind(error, nowIso(), id),
      logEntry(env, { invoice: id, event: "failed", by: "nova", detail: error }),
    ]);
    console.log(`Invoice ${id}: didn't send`);
    return getInvoice(env, id);
  };
  if (!row.approved_hash || (await invoiceHash(row)) !== row.approved_hash) {
    await env.DB.batch([
      env.DB.prepare("UPDATE invoices SET status = 'pending_approval', approved_hash = NULL, decided_by = NULL, decided_at = NULL, error = ?, updated_at = ? WHERE id = ? AND status = 'approved'").bind(
        "It changed after it was approved, so it wasn't sent. Check it and approve it again.",
        nowIso(),
        id
      ),
      logEntry(env, { invoice: id, event: "failed", by: "nova", detail: "Not sent: it changed after it was approved" }),
    ]);
    return getInvoice(env, id);
  }
  const updated = Boolean(row.sent_at);
  // (shared by hand: no email; it's sent the moment it's approved, its page open to its link)
  const result = byHand ? { ok: true, id: null } : await emailApproved(env, id, row, updated);
  if (!result.ok) return failWith(result.message);
  const now = nowIso();
  const statements = [
    env.DB.prepare("UPDATE invoices SET status = 'sent', sent_at = ?, email_id = ?, error = NULL, updated_at = ? WHERE id = ? AND status = 'approved'").bind(now, result.id || null, now, id),
    logEntry(env, { invoice: id, event: "sent", by: "nova", detail: byHand ? `Approved to share by hand (WhatsApp, a message or its link; no email) (${money(row.total_pence)}, due ${dayText(row.due_date)})` : `${updated ? "The updated invoice emailed" : "Emailed"} to the client (${money(row.total_pence)}, due ${dayText(row.due_date)})` }),
  ];
  if (row.client_id) statements.push(...clientDelta(env, row.client_id, { invoiced: row.total_pence, owed: row.total_pence - row.paid_pence }, "nova"));
  await env.DB.batch(statements);
  // (an updated invoice with payments already on it: part paid, not just sent)
  if (row.paid_pence > 0) await settle(env, id);
  console.log(`Invoice ${id}: sent`);
  return getInvoice(env, id);
}
async function emailApproved(env, id, row, updated) {
  if (!emailReady(env)) return { ok: false, message: NOT_READY };
  const settings = await readSettings(env);
  const email = invoiceEmail(env, settings, row);
  if (updated) email.subject = `Updated invoice ${invoiceNumber(row.seq)} from ${settings.business.name}`;
  // (the studio's own mail server, with Gmail as the backup: src/google/gmail.js)
  const result = await sendStudioEmail(env, {
    to: [row.bill_email],
    from: invoiceFrom(env),
    replyTo: replyTo(env, settings),
    subject: email.subject,
    text: email.text,
    html: email.html,
    idempotencyKey: `invoice-${id}-${row.approved_hash.slice(0, 24)}`,
  }, { kind: "invoice", id });
  return result;
}

// "Send me a test": the email, once, to the admin who pressed it, marked [TEST], with a link to the
// invoice's preview in Portal (the client's page only opens once it's really been sent)
// stage and body (from the Invoicer): the email at that stage with that message, as the client would get it
export async function testSendInvoice(env, me, { id, stage = null, body = "" }) {
  id = positiveId(id);
  if (!id) return fail(400, "Which invoice?");
  const row = await readRow(env, id);
  if (!row) return fail(404, "That invoice doesn't exist.");
  if (!emailReady(env)) return fail(409, NOT_READY);
  const to = String(me.email || "").trim().toLowerCase();
  if (!to || !to.includes("@")) return fail(409, "Your account has no email address.");
  const key = "money_test_" + me.id;
  const last = await env.DB.prepare("SELECT value FROM settings WHERE key = ?").bind(key).first("value");
  if (last && Date.now() - Date.parse(last) < TEST_GAP_MS) return fail(429, "One just went. Wait half a minute before sending another.");
  await env.DB.prepare("INSERT INTO settings (key, value) VALUES (?, ?) ON CONFLICT (key) DO UPDATE SET value = excluded.value").bind(key, nowIso()).run();
  const settings = await readSettings(env);
  let email = invoiceEmail(env, settings, row);
  if (STAGES.includes(stage) && (stage !== "deposit" || String(body || "").trim())) {
    const paragraphs = String(body || "").slice(0, 4000).split(/\n\s*\n/).map((p) => p.trim()).filter(Boolean);
    const greeting = paragraphs.length > 1 && /^(hi|hello|dear)\b/i.test(paragraphs[0]) ? paragraphs.shift() : firstName(row);
    const mail = invoiceMail(env, settings, row, await invoicePayments(env, id), stage, { greeting, paragraphs });
    email = { ...mail, subject: stage === "deposit" ? email.subject : stageSubject(env, settings, row, stage) };
  }
  const preview = `${publicUrl(env)}/app/api/money/invoices/${id}/preview`;
  const result = await sendEmail(env, {
    to: [to],
    from: invoiceFrom(env),
    replyTo: replyTo(env, settings),
    subject: `[TEST] ${email.subject}`,
    text: `This is a test of invoice ${invoiceNumber(row.seq)}, sent only to you. The client's link opens once it's approved and sent; the preview (signed in) is at ${preview}\n\n---\n\n${email.text}`,
    html: email.html.replace(/(<body[^>]*>)/, `$1<div style="font-family:system-ui,sans-serif;font-size:13px;color:#6b6270;text-align:center;padding:10px 12px;">This is a test, sent only to you. <a href="${esc(preview)}" style="color:#6b6270;">See the invoice's preview</a> (signed in); the client's link opens once it's approved and sent.</div>`),
  });
  return result.ok ? { ok: true, to, message: `Test sent to ${to}. Check the inbox (and spam).` } : fail(502, result.message);
}

// ===== PAYMENTS =====

// Work out an invoice's paid total and status from its payments (sent / part paid / paid)
async function settle(env, id) {
  const row = await readRow(env, id);
  const { paid } = await env.DB.prepare("SELECT COALESCE(SUM(amount_pence), 0) AS paid FROM invoice_payments WHERE invoice_id = ? AND removed_at IS NULL").bind(id).first();
  const status = paid >= row.total_pence ? "paid" : paid > 0 ? "part_paid" : "sent";
  const now = nowIso();
  await env.DB.prepare("UPDATE invoices SET paid_pence = ?, status = ?, paid_at = ?, updated_at = ? WHERE id = ? AND status IN ('sent', 'part_paid', 'paid')")
    .bind(paid, status, status === "paid" ? row.paid_at || now : null, now, id)
    .run();
  return { before: row.status, status, paid };
}

// Record a payment against a sent invoice (staff in Portal, or Stripe's webhook)
export async function recordPayment(env, by, { invoiceId, amount, amountPence, paidOn, method, note, stripeId = null }) {
  const id = positiveId(invoiceId);
  if (!id) return fail(400, "Which invoice?");
  const row = await readRow(env, id);
  if (!row) return fail(404, "That invoice doesn't exist.");
  if (!["sent", "part_paid", "paid"].includes(row.status)) return fail(409, "Payments can only be recorded against an invoice that's been sent.");
  const pence = amountPence !== undefined ? (Number.isInteger(amountPence) ? amountPence : null) : toPence(amount);
  if (!pence || pence <= 0) return fail(400, 'amount: how much was paid, in pounds (like "150.00").');
  const balance = row.total_pence - row.paid_pence;
  if (!stripeId && pence > balance) return fail(409, balance > 0 ? `That's more than what's left to pay (${money(balance)}).` : "It's already paid in full.");
  const day = paidOn || ukToday();
  if (!isDay(day)) return fail(400, "paidOn: a day, YYYY-MM-DD.");
  if (day > ukToday()) return fail(400, "paidOn can't be in the future.");
  const how = stripeId ? "stripe" : method || "bank";
  if (!METHODS.includes(how)) return fail(400, `method must be one of: ${METHODS.join(", ")}.`);
  const now = nowIso();
  const { meta } = await env.DB.prepare(
    'INSERT INTO invoice_payments (invoice_id, amount_pence, paid_on, method, note, stripe_id, "by", created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?) ON CONFLICT (stripe_id) DO NOTHING'
  )
    .bind(id, pence, day, how, oneLine(note, 300), stripeId, String(by), now)
    .run();
  if (!meta.changes) return { invoice: await getInvoice(env, id), repeated: true };
  const result = await settle(env, id);
  const statements = [logEntry(env, { invoice: id, event: "payment", by, detail: `${money(pence)} (${METHOD_NAMES[how]}) on ${dayText(day)}` })];
  if (result.status === "paid" && result.before !== "paid") statements.push(logEntry(env, { invoice: id, event: "paid", by: "nova", detail: "Paid in full" }));
  if (row.client_id) statements.push(...clientDelta(env, row.client_id, { owed: -pence }, by));
  await env.DB.batch(statements);
  console.log(`Invoice ${id}: payment recorded (${how})`);
  // Paid in full: its receipt is written now, and waits for an admin's Approve like every email
  if (result.status === "paid" && result.before !== "paid" && row.bill_email) {
    const r = await draftReminder(env, "nova", { invoiceId: id, kind: "receipt" }).catch((err) => ({ error: String(err?.message || err) }));
    if (r?.error) console.log(`Invoice ${id}: its receipt couldn't be written (${r.status || "error"})`);
  }
  return { invoice: await getInvoice(env, id) };
}

// An admin takes back a payment recorded by mistake (kept for the record, marked removed)
export async function removePayment(env, me, { paymentId }) {
  const pid = positiveId(paymentId);
  if (!pid) return fail(400, "Which payment?");
  const p = await env.DB.prepare("SELECT * FROM invoice_payments WHERE id = ?").bind(pid).first();
  if (!p || p.removed_at) return fail(404, "That payment isn't there.");
  if (p.stripe_id) return fail(409, "That payment came through Stripe. Refund it in Stripe's dashboard; it can't be taken back here.");
  const now = nowIso();
  const { meta } = await env.DB.prepare("UPDATE invoice_payments SET removed_at = ?, removed_by = ? WHERE id = ? AND removed_at IS NULL").bind(now, me.id, pid).run();
  if (!meta.changes) return fail(409, "It was already taken back.");
  await settle(env, p.invoice_id);
  const row = await readRow(env, p.invoice_id);
  const statements = [logEntry(env, { invoice: p.invoice_id, event: "payment_removed", by: me.id, detail: `${money(p.amount_pence)} on ${dayText(p.paid_on)} taken back` })];
  if (row.client_id) statements.push(...clientDelta(env, row.client_id, { owed: p.amount_pence }, me.id));
  await env.DB.batch(statements);
  return { invoice: await getInvoice(env, p.invoice_id) };
}

// Stripe says an invoice's checkout was paid (src/nova/book-page.js's webhook)
export async function invoicePaidByStripe(env, { invoiceId, amountPence, stripeId }) {
  const result = await recordPayment(env, "stripe", { invoiceId, amountPence, stripeId });
  if (result.error) console.log(`Invoice ${invoiceId}: a Stripe payment couldn't be recorded (${result.status})`);
  return result;
}

// ===== REMINDERS =====

function reminderText(env, settings, invoice, kind = "reminder") {
  const number = invoiceNumber(invoice.seq);
  if (kind === "receipt") return `${firstName(invoice)}\n\nThank you! We've received your payment and invoice ${number} (${money(invoice.total_pence)}) is paid in full. Your receipt is below.\n\nIt was a pleasure working on your music. We'd love to have you back in the studio for the next one.`;
  // (after the session, not yet past due: the thank-you, with the full amount and its due date)
  const today = ukToday();
  const shown = publicInvoice(env, invoice, today);
  if (stageOf(shown, today) === "balance" && afterSession(shown, today)) return [firstName(invoice), ...stageMessage(shown, stageSums(shown, [], "balance", today), "balance", settings, today).paragraphs].join("\n\n");
  const balance = invoice.total_pence - invoice.paid_pence;
  return `${firstName(invoice)}\n\nJust a friendly reminder that invoice ${number} for ${money(balance)}${invoice.paid_pence ? " (what's left of it)" : ""} was due on ${dayText(invoice.due_date)}. If you've already paid, thank you, and please ignore this.`;
}

// An email for a sent invoice, waiting for an admin's Approve: a reminder (unpaid: the balance due, or
// overdue) or a receipt (paid in full; written by itself when it's paid, see recordPayment)
export async function draftReminder(env, by, { invoiceId, body, kind = "reminder" }) {
  const id = positiveId(invoiceId);
  if (!id) return fail(400, "Which invoice?");
  if (!["reminder", "receipt"].includes(kind)) return fail(400, "kind: reminder or receipt.");
  const invoice = await readRow(env, id);
  if (!invoice) return fail(404, "That invoice doesn't exist.");
  if (kind === "receipt" && invoice.status !== "paid") return fail(409, "A receipt is for an invoice that's paid in full.");
  if (kind === "reminder" && !OPEN.includes(invoice.status)) return fail(409, "Reminders are only for invoices that have been sent and aren't paid.");
  if (!invoice.bill_email) return fail(409, "That invoice has no email address.");
  const waiting = await env.DB.prepare("SELECT id FROM invoice_reminders WHERE invoice_id = ? AND kind = ? AND status = 'pending_approval'").bind(id, kind).first();
  if (waiting) return fail(409, `A ${kind} for it is already waiting for approval.`);
  if (kind === "receipt" && (await env.DB.prepare("SELECT id FROM invoice_reminders WHERE invoice_id = ? AND kind = 'receipt' AND status = 'sent'").bind(id).first()))
    return fail(409, "Its receipt has already been sent.");
  const settings = await readSettings(env);
  const text = cleanText(body, 4000) || reminderText(env, settings, invoice, kind);
  if (text.length < 10) return fail(400, "body: write the reminder (at least a sentence).");
  if (PLACEHOLDER.test(text)) return fail(400, `Fill in ${text.match(PLACEHOLDER)[0]} first: the message still has a gap in square brackets.`);
  const now = nowIso();
  const row = await env.DB.prepare("INSERT INTO invoice_reminders (invoice_id, kind, body, status, created_by, created_at, updated_at) VALUES (?, ?, ?, 'pending_approval', ?, ?, ?) RETURNING id")
    .bind(id, kind, text, String(by), now, now)
    .first();
  await logEntry(env, { invoice: id, event: "reminder", by, detail: kind === "receipt" ? "A receipt is waiting for approval" : "A reminder is waiting for approval" }).run();
  await pingAdmins(env, {
    title: kind === "receipt" ? "Receipt to approve" : "Payment reminder to approve",
    body: `${kind === "receipt" ? `Invoice ${invoiceNumber(invoice.seq)} (${invoice.bill_name}) is paid in full: its receipt is ready` : `${whoWrote(by)} wrote a reminder for invoice ${invoiceNumber(invoice.seq)} (${invoice.bill_name})`}. Nothing is emailed until an admin approves it in the Invoicer or Portal → Money.`,
    url: `/portal/?view=money&invoice=${id}`,
    tag: `invoice-${id}-reminder`,
    by,
  });
  return { reminder: reminderShape(await env.DB.prepare(`${REMINDER_SELECT} WHERE r.id = ?`).bind(row.id).first()) };
}

export async function decideReminder(env, me, { id, approve }) {
  const rid = positiveId(id);
  if (!rid) return fail(400, "Which reminder?");
  const r = await env.DB.prepare("SELECT * FROM invoice_reminders WHERE id = ?").bind(rid).first();
  if (!r) return fail(404, "That reminder doesn't exist.");
  if (r.status !== "pending_approval") return { reminder: reminderShape(r), repeated: true };
  const invoice = await readRow(env, r.invoice_id);
  const now = nowIso();
  if (!approve) {
    await env.DB.prepare("UPDATE invoice_reminders SET status = 'rejected', decided_by = ?, decided_at = ?, updated_at = ? WHERE id = ? AND status = 'pending_approval'").bind(me.id, now, now, rid).run();
    await logEntry(env, { invoice: r.invoice_id, event: "reminder", by: me.id, detail: r.kind === "receipt" ? "Receipt rejected" : "Reminder rejected" }).run();
    return { reminder: reminderShape(await env.DB.prepare(`${REMINDER_SELECT} WHERE r.id = ?`).bind(rid).first()) };
  }
  const receipt = r.kind === "receipt";
  if (receipt && invoice.status !== "paid") return fail(409, "It isn't paid in full any more (a payment was taken back), so the receipt can't go. Reject this one.");
  if (!receipt && !OPEN.includes(invoice.status)) return fail(409, invoice.status === "paid" ? "It's been paid since, so no reminder is needed. Reject this one." : "That invoice isn't waiting for payment.");
  if (!emailReady(env)) return fail(409, NOT_READY);
  const hash = await reminderHash(r, invoice);
  const { meta } = await env.DB.prepare("UPDATE invoice_reminders SET status = 'approved', approved_hash = ?, decided_by = ?, decided_at = ?, updated_at = ? WHERE id = ? AND status = 'pending_approval' AND updated_at = ?")
    .bind(hash, me.id, now, now, rid, r.updated_at)
    .run();
  if (!meta.changes) return fail(409, "It changed while you were looking at it. Check it again.");
  // Only exactly what was approved goes
  const approved = await env.DB.prepare("SELECT * FROM invoice_reminders WHERE id = ?").bind(rid).first();
  if (approved.approved_hash !== (await reminderHash(approved, invoice))) return fail(409, "It changed after it was approved, so it wasn't sent.");
  const settings = await readSettings(env);
  const paragraphs = approved.body.split(/\n\s*\n/).map((p) => p.trim()).filter(Boolean);
  const greeting = paragraphs.length > 1 && /^(hi|hello|dear)\b/i.test(paragraphs[0]) ? paragraphs.shift() : "Hello,";
  // The invoice itself under the message, at its stage now (a receipt: paid in full)
  const today = ukToday();
  const stage = receipt ? "paid" : stageOf(publicInvoice(env, invoice, today), today);
  const email = invoiceMail(env, settings, invoice, await invoicePayments(env, invoice.id), stage, { greeting, paragraphs });
  const subject = stageSubject(env, settings, invoice, stage, today);
  const result = await sendStudioEmail(env, {
    to: [invoice.bill_email],
    from: invoiceFrom(env),
    replyTo: replyTo(env, settings),
    subject,
    text: email.text,
    html: email.html,
    idempotencyKey: `invoice-reminder-${rid}`,
  }, { kind: "invoice", id: invoice.id });
  const done = nowIso();
  if (!result.ok) {
    await env.DB.batch([
      env.DB.prepare("UPDATE invoice_reminders SET status = 'failed', error = ?, updated_at = ? WHERE id = ?").bind(result.message, done, rid),
      logEntry(env, { invoice: r.invoice_id, event: "failed", by: "nova", detail: `${receipt ? "Receipt" : "Reminder"} didn't send: ` + result.message }),
    ]);
    return fail(502, result.message);
  }
  await env.DB.batch([
    env.DB.prepare("UPDATE invoice_reminders SET status = 'sent', sent_at = ?, updated_at = ? WHERE id = ?").bind(done, done, rid),
    logEntry(env, { invoice: r.invoice_id, event: "reminder", by: "nova", detail: receipt ? "Receipt emailed to the client" : "Reminder emailed to the client" }),
  ]);
  return { reminder: reminderShape(await env.DB.prepare(`${REMINDER_SELECT} WHERE r.id = ?`).bind(rid).first()) };
}

// ===== EXPENSES =====

function expenseShape(r) {
  return {
    id: r.id,
    spentOn: r.spent_on,
    amountPence: r.amount_pence,
    category: r.category,
    supplier: r.supplier || "",
    note: r.note || "",
    receiptId: r.receipt_id || null,
    status: r.status,
    createdBy: r.created_by,
    createdByName: r.created_by_name || null,
    createdAt: r.created_at,
    updatedAt: r.updated_at,
  };
}
const EXPENSE_SELECT = "SELECT e.*, s.display_name AS created_by_name FROM expenses e LEFT JOIN staff s ON s.id = e.created_by";

function checkExpense(input, base = null) {
  const has = (key) => input && Object.hasOwn(input, key) && input[key] !== undefined;
  const spent_on = has("spentOn") ? input.spentOn : base ? base.spent_on : ukToday();
  if (!isDay(spent_on)) return fail(400, "spentOn: a day, YYYY-MM-DD.");
  if (spent_on > ukToday()) return fail(400, "spentOn can't be in the future.");
  let amount = base ? base.amount_pence : null;
  if (has("amountPence")) amount = Number.isInteger(input.amountPence) ? input.amountPence : null;
  else if (has("amount")) amount = toPence(input.amount);
  if (!amount || amount <= 0) return fail(400, 'amount: how much, in pounds (like "49.99").');
  if (amount > MAX_TOTAL_PENCE) return fail(400, "That's more than £100,000: check the amount.");
  const category = has("category") ? input.category : base ? base.category : "Other";
  if (!CATEGORIES.includes(category)) return fail(400, `category must be one of: ${CATEGORIES.join(", ")}.`);
  const supplier = has("supplier") ? oneLine(input.supplier, 120) : base ? base.supplier : "";
  const note = has("note") ? oneLine(input.note, 500) : base ? base.note : "";
  let receipt_id = base ? base.receipt_id : null;
  if (has("receiptId")) {
    if (input.receiptId === null || input.receiptId === "") receipt_id = null;
    else if (typeof input.receiptId === "string" && RECEIPT_PATTERN.test(input.receiptId)) receipt_id = input.receiptId;
    else return fail(400, "receiptId isn't a receipt's name.");
  }
  return { spent_on, amount_pence: amount, category, supplier, note, receipt_id };
}

export async function addExpense(env, by, input, { unconfirmed = false } = {}) {
  const f = checkExpense(input || {});
  if (f.error) return f;
  if (unconfirmed) {
    const { n } = await env.DB.prepare("SELECT COUNT(*) AS n FROM expenses WHERE status = 'unconfirmed' AND deleted_at IS NULL").first();
    if (n >= MAX_UNCONFIRMED) return fail(429, "There are already many unconfirmed expenses. Ask the team to confirm them in Portal → Money first.");
  }
  const now = nowIso();
  const row = await env.DB.prepare(
    "INSERT INTO expenses (spent_on, amount_pence, category, supplier, note, receipt_id, status, created_by, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?) RETURNING id"
  )
    .bind(f.spent_on, f.amount_pence, f.category, f.supplier, f.note, f.receipt_id, unconfirmed ? "unconfirmed" : "confirmed", String(by), now, now)
    .first();
  await logEntry(env, { expense: row.id, event: "expense", by, detail: `${money(f.amount_pence)} · ${f.category}${unconfirmed ? " (unconfirmed)" : ""}` }).run();
  return { expense: expenseShape(await env.DB.prepare(`${EXPENSE_SELECT} WHERE e.id = ?`).bind(row.id).first()) };
}

export async function editExpense(env, me, id, input, { confirm = false } = {}) {
  const eid = positiveId(id);
  if (!eid) return fail(400, "Which expense?");
  const row = await env.DB.prepare("SELECT * FROM expenses WHERE id = ? AND deleted_at IS NULL").bind(eid).first();
  if (!row) return fail(404, "That expense isn't there.");
  const f = checkExpense(input || {}, row);
  if (f.error) return f;
  const status = confirm ? "confirmed" : row.status;
  const now = nowIso();
  await env.DB.batch([
    env.DB.prepare("UPDATE expenses SET spent_on = ?, amount_pence = ?, category = ?, supplier = ?, note = ?, receipt_id = ?, status = ?, updated_at = ? WHERE id = ?").bind(
      f.spent_on,
      f.amount_pence,
      f.category,
      f.supplier,
      f.note,
      f.receipt_id,
      status,
      now,
      eid
    ),
    logEntry(env, { expense: eid, event: "expense", by: me.id, detail: confirm && row.status !== "confirmed" ? "Confirmed" : "Changed" }),
  ]);
  return { expense: expenseShape(await env.DB.prepare(`${EXPENSE_SELECT} WHERE e.id = ?`).bind(eid).first()) };
}

export async function deleteExpense(env, me, id) {
  const eid = positiveId(id);
  if (!eid) return fail(400, "Which expense?");
  const now = nowIso();
  const { meta } = await env.DB.prepare("UPDATE expenses SET deleted_at = ?, deleted_by = ?, updated_at = ? WHERE id = ? AND deleted_at IS NULL").bind(now, me.id, now, eid).run();
  if (!meta.changes) return fail(404, "That expense isn't there.");
  await logEntry(env, { expense: eid, event: "expense", by: me.id, detail: "Removed" }).run();
  return { removed: eid };
}

export async function listExpenses(env, { from = null, to = null, limit = 200 } = {}) {
  const where = ["e.deleted_at IS NULL"];
  const binds = [];
  if (from) {
    where.push("e.spent_on >= ?");
    binds.push(from);
  }
  if (to) {
    where.push("e.spent_on <= ?");
    binds.push(to);
  }
  const { results } = await env.DB.prepare(`${EXPENSE_SELECT} WHERE ${where.join(" AND ")} ORDER BY CASE WHEN e.status = 'unconfirmed' THEN 0 ELSE 1 END, e.spent_on DESC, e.id DESC LIMIT ?`)
    .bind(...binds, limit)
    .all();
  return results.map(expenseShape);
}

// ===== THE SUMMARY =====

// Money in (payments) and out (confirmed expenses) this month and this tax year, what's owed,
// what's overdue, and what's waiting for someone
export async function moneySummary(env, today = ukToday()) {
  const month = monthOf(today);
  const year = taxYear(today);
  const sumIn = (r) => env.DB.prepare("SELECT COALESCE(SUM(amount_pence), 0) AS n FROM invoice_payments WHERE removed_at IS NULL AND paid_on BETWEEN ? AND ?").bind(r.from, r.to);
  const sumOut = (r) => env.DB.prepare("SELECT COALESCE(SUM(amount_pence), 0) AS n FROM expenses WHERE deleted_at IS NULL AND status = 'confirmed' AND spent_on BETWEEN ? AND ?").bind(r.from, r.to);
  const [mIn, mOut, yIn, yOut, owed, overdue, waiting, reminders, unconfirmed, byCategory] = await env.DB.batch([
    sumIn(month),
    sumOut(month),
    sumIn(year),
    sumOut(year),
    env.DB.prepare("SELECT COUNT(*) AS c, COALESCE(SUM(total_pence - paid_pence), 0) AS n FROM invoices WHERE status IN ('sent', 'part_paid')"),
    env.DB.prepare("SELECT COUNT(*) AS c, COALESCE(SUM(total_pence - paid_pence), 0) AS n FROM invoices WHERE status IN ('sent', 'part_paid') AND due_date < ?").bind(today),
    env.DB.prepare("SELECT COUNT(*) AS c FROM invoices WHERE status IN ('draft', 'pending_approval')"),
    env.DB.prepare("SELECT COUNT(*) AS c FROM invoice_reminders WHERE status = 'pending_approval'"),
    env.DB.prepare("SELECT COUNT(*) AS c FROM expenses WHERE status = 'unconfirmed' AND deleted_at IS NULL"),
    env.DB.prepare("SELECT category, SUM(amount_pence) AS n FROM expenses WHERE deleted_at IS NULL AND status = 'confirmed' AND spent_on BETWEEN ? AND ? GROUP BY category ORDER BY n DESC").bind(year.from, year.to),
  ]);
  const first = (r, k = "n") => r.results[0]?.[k] || 0;
  return {
    today,
    month: { ...month, inPence: first(mIn), outPence: first(mOut) },
    taxYear: { ...year, inPence: first(yIn), outPence: first(yOut), outByCategory: byCategory.results.map((r) => ({ category: r.category, pence: r.n })) },
    owed: { count: first(owed, "c"), pence: first(owed) },
    overdue: { count: first(overdue, "c"), pence: first(overdue) },
    waitingApproval: first(waiting, "c") + first(reminders, "c"),
    invoicesWaiting: first(waiting, "c"),
    remindersWaiting: first(reminders, "c"),
    unconfirmedExpenses: first(unconfirmed, "c"),
  };
}

// ===== FOR THE ACCOUNTANT: CSV =====

// A cell that a spreadsheet won't run as a formula
function cell(value) {
  let s = value === null || value === undefined ? "" : String(value);
  if (/^[=+\-@\t\r]/.test(s)) s = "'" + s;
  return /[",\n\r]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
}
const csv = (rows) => rows.map((r) => r.map(cell).join(",")).join("\r\n") + "\r\n";
const pnd = (p) => poundsText(p);

// The accountant's rows (a header row first): for the CSV, and for the Google Sheet (src/google/sheets.js)
export async function exportRows(env, { what, from, to }) {
  if (!isDay(from) || !isDay(to) || to < from) return fail(400, "from and to: days, YYYY-MM-DD, from first.");
  if (what === "invoices") {
    const { results } = await env.DB.prepare("SELECT * FROM invoices WHERE issue_date BETWEEN ? AND ? AND status IN ('sent', 'part_paid', 'paid', 'void') ORDER BY seq").bind(from, to).all();
    return {
      name: `invoices-${from}-to-${to}.csv`,
      rows: [
        ["Number", "Issued", "Due", "Client", "Subtotal (£)", "VAT %", "VAT (£)", "Total (£)", "Paid (£)", "Balance (£)", "Status", "Sent"],
        ...results.map((r) => [invoiceNumber(r.seq), r.issue_date, r.due_date, r.bill_name, pnd(r.subtotal_pence), r.vat_rate, pnd(r.vat_pence), pnd(r.total_pence), pnd(r.paid_pence), pnd(Math.max(0, r.total_pence - r.paid_pence)), r.status, r.sent_at ? r.sent_at.slice(0, 10) : ""]),
      ],
    };
  }
  if (what === "payments") {
    const { results } = await env.DB.prepare("SELECT p.*, i.seq, i.bill_name FROM invoice_payments p JOIN invoices i ON i.id = p.invoice_id WHERE p.removed_at IS NULL AND p.paid_on BETWEEN ? AND ? ORDER BY p.paid_on, p.id").bind(from, to).all();
    return {
      name: `payments-${from}-to-${to}.csv`,
      rows: [["Paid on", "Amount (£)", "Method", "Invoice", "Client", "Note"], ...results.map((r) => [r.paid_on, pnd(r.amount_pence), METHOD_NAMES[r.method] || r.method, invoiceNumber(r.seq), r.bill_name, r.note || ""])],
    };
  }
  if (what === "expenses") {
    const { results } = await env.DB.prepare("SELECT * FROM expenses WHERE deleted_at IS NULL AND status = 'confirmed' AND spent_on BETWEEN ? AND ? ORDER BY spent_on, id").bind(from, to).all();
    return {
      name: `expenses-${from}-to-${to}.csv`,
      rows: [["Date", "Amount (£)", "Category", "Supplier", "Note", "Receipt kept"], ...results.map((r) => [r.spent_on, pnd(r.amount_pence), r.category, r.supplier || "", r.note || "", r.receipt_id ? "Yes" : "No"])],
    };
  }
  return fail(400, "what: invoices, payments or expenses.");
}

export async function exportCsv(env, query) {
  const out = await exportRows(env, query);
  return out.error ? out : { name: out.name, body: csv(out.rows) };
}

// ===== THE CLIENT'S INVOICE PAGE (/invoice/<token>) =====

const PAGE_STATUSES = ["sent", "part_paid", "paid", "void"];
// Card payments go through Stripe's own checkout page, when Stripe is really set up
export const cardReady = (env) => Boolean(env.STRIPE_SECRET_KEY && env.STRIPE_WEBHOOK_SECRET && !stripeOffline(env));

// The invoice as a page: for the client (/invoice/<token>) and Portal's preview (preview: true)
export function invoicePage(env, row, settings, { preview = false, paid = false, nonce = "" } = {}) {
  const inv = publicInvoice(env, row);
  const s = settings.business;
  const balance = inv.balancePence;
  const statusText =
    inv.status === "void" ? "Cancelled" : inv.status === "paid" ? "Paid" : inv.overdue ? `Overdue · was due ${dayText(inv.dueDate)}` : inv.status === "part_paid" ? `Part paid · rest due ${dayText(inv.dueDate)}` : PAGE_STATUSES.includes(inv.status) ? `Due ${dayText(inv.dueDate)}` : "Not sent yet";
  const statusClass = inv.status === "paid" ? "ok" : inv.status === "void" ? "off" : inv.overdue ? "warn" : "";
  const qty = (q) => (Number.isInteger(q) ? String(q) : q.toFixed(2));
  const rows = inv.lines.map((l) => `<tr><td>${esc(l.description)}</td><td class="n">${esc(qty(l.qty))}</td><td class="n">${esc(money(l.unitPence))}</td><td class="n">${esc(money(l.totalPence))}</td></tr>`).join("");
  const bank = settings.bank;
  const canPay = !preview && balance > 0 && ["sent", "part_paid"].includes(inv.status);
  const payCard = canPay && cardReady(env) ? `<form method="post" action="/invoice/${esc(row.token)}/pay"><button type="submit">Pay ${esc(money(balance))} by card</button></form>` : "";
  const payBank = bankReady(settings)
    ? `<dl class="bank"><dt>Account name</dt><dd>${esc(bank.accountName)}</dd><dt>Sort code</dt><dd>${esc(bank.sortCode)}</dd><dt>Account number</dt><dd>${esc(bank.accountNumber)}</dd><dt>Reference</dt><dd>${esc(inv.number)}</dd></dl>${bank.note ? `<p class="small">${esc(bank.note)}</p>` : ""}`
    : "";
  const howToPay =
    balance > 0 && inv.status !== "void" && (payCard || payBank || preview)
      ? `<section class="pay"><h2>How to pay</h2>${payCard}${payCard && payBank ? '<p class="small">Or by bank transfer:</p>' : ""}${payBank}${preview && !payBank && !cardReady(env) ? '<p class="small">No way to pay is set up yet: add the bank details in Portal → Money → Invoice settings.</p>' : ""}</section>`
      : "";
  const html = `<!doctype html><html lang="en-GB"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1"><meta name="robots" content="noindex">
<title>Invoice ${esc(inv.number)} · ${esc(s.name)}</title>
<style>
:root { color-scheme: light dark; --bg: #f7f5f8; --card: #fff; --ink: #1d1820; --muted: #6b6270; --accent: #c2337a; --line: #e4dfe7; --ok: #1f7a4d; --warn: #a3313a; }
@media (prefers-color-scheme: dark) { :root { --bg: #141016; --card: #1f1922; --ink: #f2edf4; --muted: #a79dac; --accent: #ff7ab8; --line: #3a313e; --ok: #6fd3a0; --warn: #ff8f97; } }
* { box-sizing: border-box; }
body { margin: 0; background: var(--bg); color: var(--ink); font: 16px/1.5 system-ui, -apple-system, "Segoe UI", sans-serif; }
main { max-width: 760px; margin: 5vh auto; padding: 32px 28px; background: var(--card); border-radius: 18px; }
@media (max-width: 800px) { main { margin: 12px; padding: 22px 16px; } }
.banner { margin: 0 0 18px; padding: 10px 14px; border-radius: 12px; border: 1px dashed var(--line); color: var(--muted); font-size: 14px; }
.thanks { border-style: solid; border-color: var(--ok); color: var(--ok); }
header { display: flex; flex-wrap: wrap; justify-content: space-between; gap: 18px; align-items: flex-start; }
.brand { font-size: 0.8rem; letter-spacing: 0.14em; text-transform: uppercase; color: var(--accent); font-weight: 600; margin: 0 0 6px; }
h1 { font-size: 1.6rem; margin: 0; } h2 { font-size: 1rem; margin: 0 0 8px; }
.from, .to { color: var(--muted); font-size: 14.5px; white-space: pre-line; overflow-wrap: anywhere; }
.chip { display: inline-block; margin-top: 8px; padding: 3px 12px; border-radius: 999px; border: 1px solid var(--line); font-size: 14px; }
.chip.ok { color: var(--ok); border-color: currentColor; } .chip.warn { color: var(--warn); border-color: currentColor; } .chip.off { color: var(--muted); text-decoration: line-through; }
.meta { display: grid; grid-template-columns: repeat(auto-fit, minmax(150px, 1fr)); gap: 14px; margin: 24px 0; }
.meta dt { font-size: 12px; letter-spacing: 0.06em; text-transform: uppercase; color: var(--muted); } .meta dd { margin: 2px 0 0; overflow-wrap: anywhere; }
.wrap { overflow-x: auto; }
table { width: 100%; border-collapse: collapse; font-size: 15px; }
th { text-align: left; font-size: 12px; letter-spacing: 0.06em; text-transform: uppercase; color: var(--muted); font-weight: 600; padding: 8px 6px; border-bottom: 1px solid var(--line); }
td { padding: 10px 6px; border-bottom: 1px solid var(--line); vertical-align: top; overflow-wrap: anywhere; }
.n { text-align: right; white-space: nowrap; }
.sums { margin: 14px 0 0 auto; max-width: 320px; display: grid; grid-template-columns: 1fr auto; gap: 6px 18px; }
.sums dt { color: var(--muted); } .sums dd { margin: 0; text-align: right; } .sums .big { font-weight: 700; font-size: 1.1rem; color: var(--ink); }
.notes { margin: 22px 0 0; white-space: pre-line; color: var(--muted); }
.pay { margin: 26px 0 0; padding: 18px; border-radius: 14px; border: 1px solid var(--line); }
.bank { display: grid; grid-template-columns: auto 1fr; gap: 6px 16px; margin: 6px 0 0; } .bank dt { color: var(--muted); } .bank dd { margin: 0; font-variant-numeric: tabular-nums; }
button { font: inherit; padding: 11px 22px; border: 0; border-radius: 999px; background: var(--accent); color: #fff; cursor: pointer; }
.ghost { background: transparent; color: var(--accent); border: 1px solid currentColor; }
.small { font-size: 14px; color: var(--muted); }
.tools { margin: 24px 0 0; display: flex; flex-wrap: wrap; gap: 10px; align-items: center; }
footer { margin-top: 24px; font-size: 13px; color: var(--muted); } footer a { color: inherit; }
@media print {
  :root { --bg: #fff; --card: #fff; --ink: #000; --muted: #444; --line: #bbb; color-scheme: light; }
  body { font-size: 12pt; } main { margin: 0; padding: 0; max-width: none; border-radius: 0; }
  .tools, .banner, form, footer a { display: none !important; }
  .pay { break-inside: avoid; } tr { break-inside: avoid; }
}
</style></head><body><main>
${preview ? `<p class="banner">Preview in Portal: this is how the client will see it once it's approved and sent.</p>` : ""}${paid ? `<p class="banner thanks">Thank you: your payment is being confirmed. This page shows it as paid once Stripe tells us (usually within a minute).</p>` : ""}
<header><div><p class="brand">${esc(s.name)}</p><h1>Invoice ${esc(inv.number)}</h1><span class="chip ${statusClass}">${esc(statusText)}</span></div>
<div class="from">${esc(s.name)}${s.address ? "\n" + esc(s.address) : ""}${s.email ? "\n" + esc(s.email) : ""}${s.vatNumber ? "\nVAT number " + esc(s.vatNumber) : ""}</div></header>
<dl class="meta"><div><dt>Billed to</dt><dd class="to">${esc(inv.billTo.name)}${inv.billTo.address ? "\n" + esc(inv.billTo.address) : ""}</dd></div>
<div><dt>Issued</dt><dd>${esc(dayText(inv.issueDate))}</dd></div><div><dt>Due</dt><dd>${esc(dayText(inv.dueDate))}</dd></div><div><dt>Reference</dt><dd>${esc(inv.number)}</dd></div></dl>
<div class="wrap"><table><thead><tr><th>Description</th><th class="n">Qty</th><th class="n">Price</th><th class="n">Amount</th></tr></thead><tbody>${rows}</tbody></table></div>
<dl class="sums"><dt>Subtotal</dt><dd>${esc(money(inv.subtotalPence))}</dd>${inv.vatRate ? `<dt>VAT (${esc(inv.vatRate)}%)</dt><dd>${esc(money(inv.vatPence))}</dd>` : ""}<dt class="big">Total</dt><dd class="big">${esc(money(inv.totalPence))}</dd>${inv.paidPence ? `<dt>Paid</dt><dd>${esc(money(inv.paidPence))}</dd><dt class="big">Left to pay</dt><dd class="big">${esc(money(balance))}</dd>` : ""}</dl>
${inv.notes ? `<p class="notes">${esc(inv.notes)}</p>` : ""}${howToPay}
<div class="tools"><button class="ghost" type="button" id="print">Print or save as PDF</button></div>
<footer>${esc(s.name)} · <a href="/privacy">Privacy</a></footer>
</main><script nonce="${esc(nonce)}">document.getElementById("print").addEventListener("click", function () { window.print(); });</script></body></html>`;
  return html;
}

function pageResponse(html, nonce, status = 200, frame = false) {
  return new Response(html, {
    status,
    headers: {
      "Content-Type": "text/html; charset=utf-8",
      "Cache-Control": "no-store",
      "Referrer-Policy": "no-referrer",
      "X-Content-Type-Options": "nosniff",
      "Content-Security-Policy": `default-src 'none'; style-src 'unsafe-inline'; img-src data: 'self'; font-src data:; script-src 'nonce-${nonce}'; form-action 'self' https://checkout.stripe.com; frame-ancestors ${frame ? "'self'" : "'none'"}; base-uri 'none'`,
    },
  });
}
const newNonce = () => hex(crypto.getRandomValues(new Uint8Array(12)));

function notFoundPage() {
  const html = `<!doctype html><html lang="en-GB"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1"><meta name="robots" content="noindex"><title>Invoice not found</title>
<style>body{margin:0;font:16px/1.5 system-ui,sans-serif;background:#f7f5f8;color:#1d1820}main{max-width:460px;margin:10vh auto;padding:28px 24px;background:#fff;border-radius:18px}@media (prefers-color-scheme:dark){body{background:#141016;color:#f2edf4}main{background:#1f1922}}</style></head>
<body><main><h1>Invoice not found</h1><p>This link doesn't lead to an invoice. If you were sent it, ask the studio for a new one.</p></main></body></html>`;
  return new Response(html, { status: 404, headers: { "Content-Type": "text/html; charset=utf-8", "Cache-Control": "no-store", "Referrer-Policy": "no-referrer", "Content-Security-Policy": "default-src 'none'; style-src 'unsafe-inline'" } });
}

// GET /invoice/<token>, POST /invoice/<token>/pay
// The client's page for an invoice: the invoice itself (the Invoicer's design, at the stage it's at
// now, in the studio's theme) with the ways to pay that are set up: a card button (Stripe) for the
// amount due now (the deposit, at the deposit stage), the bank details, or how to get in touch
export async function clientPage(env, row, settings, { preview = false, paid = false, nonce = "", failed = false } = {}) {
  const today = ukToday();
  const invoice = publicInvoice(env, row, today);
  const payments = await invoicePayments(env, row.id);
  const stage = stageOf(invoice, today);
  const due = stageSums(invoice, payments, stage, today).dueNowPence;
  const updating = !preview && row.sent_at && !PAGE_STATUSES.includes(row.status);
  const canCard = !preview && !updating && due > 0 && OPEN.includes(row.status) && cardReady(env);
  const cardForm = canCard ? `<form method="post" action="/invoice/${esc(row.token)}/pay"><button type="submit">Pay ${esc(money(due))} by card</button></form>` : "";
  const banner = updating
    ? "This invoice is being updated. You'll get the new one by email shortly."
    : preview
    ? "Preview: this is how the client sees it once it's approved and sent."
    : failed
      ? "Card payment isn't available just now. Please try again in a minute, or pay by bank transfer."
      : paid
        ? "Thank you: your payment is being confirmed. This page shows it as paid within a minute or two."
        : "";
  return invoiceDocument(invoice, payments, stage, settings, today, { page: { cardForm, banner: banner ? esc(banner) : "", cancelled: row.status === "void", nonce } });
}

export async function handleInvoicePage(request, env, pathname) {
  const m = pathname.match(/^\/invoice\/([0-9a-f]{32})(\/pay)?$/);
  if (!m) return notFoundPage();
  const row = await env.DB.prepare(`${SELECT} WHERE i.token = ?`).bind(m[1]).first();
  // (one already sent and now changed, waiting to be approved again: its page says it's being updated)
  const updating = row && row.sent_at && ["pending_approval", "approved", "rejected", "failed", "draft"].includes(row.status);
  if (!row || (!PAGE_STATUSES.includes(row.status) && !updating)) return notFoundPage();
  const settings = await readSettings(env);
  if (m[2]) {
    if (updating) return Response.redirect(`${publicUrl(env)}/invoice/${row.token}`, 303);
    if (request.method !== "POST") return new Response("Method not allowed", { status: 405 });
    // What's due now: the deposit at the deposit stage, else what's left (the same as the page's button)
    const today = ukToday();
    const invoice = publicInvoice(env, row, today);
    const due = stageSums(invoice, await invoicePayments(env, row.id), stageOf(invoice, today), today).dueNowPence;
    if (!OPEN.includes(row.status) || due <= 0 || !cardReady(env)) return Response.redirect(`${publicUrl(env)}/invoice/${row.token}`, 303);
    try {
      const checkout = await createInvoiceCheckout(env, {
        invoice: { id: row.id, number: invoiceNumber(row.seq), email: row.bill_email, business: settings.business.name },
        amountPence: due,
        successUrl: `${publicUrl(env)}/invoice/${row.token}?paid=1`,
        cancelUrl: `${publicUrl(env)}/invoice/${row.token}`,
      });
      return Response.redirect(checkout.url, 303);
    } catch (err) {
      console.log(`Invoice ${row.id}: checkout failed (${err?.status || err?.name})`);
      const nonce = newNonce();
      return pageResponse(await clientPage(env, row, settings, { nonce, failed: true }), nonce, 502);
    }
  }
  if (request.method !== "GET" && request.method !== "HEAD") return new Response("Method not allowed", { status: 405 });
  const nonce = newNonce();
  const paid = new URL(request.url).searchParams.get("paid") === "1" && row.status !== "paid";
  return pageResponse(await clientPage(env, row, settings, { nonce, paid }), nonce);
}

// ===== FOR NOVA AGENT =====

export async function moneyContext(env) {
  const [summary, settings, recent] = await Promise.all([moneySummary(env), readSettings(env), listInvoices(env, { limit: 10 })]);
  return {
    summary,
    vatRate: settings.vatRate,
    dueDays: settings.dueDays,
    categories: CATEGORIES,
    recentInvoices: recent.map((i) => ({ id: i.id, number: i.number, to: i.billTo.name, totalPence: i.totalPence, balancePence: i.balancePence, status: i.status, overdue: i.overdue, dueDate: i.dueDate })),
    today: ukToday(),
  };
}

// ===== ROUTES =====

// Approving, rejecting, test-sending, voiding, taking back payments, settings and the export: an
// admin with Portal open in a browser (the cookie), never an app's token, other staff, or the agent
const canDecide = (me) => me.role === "admin" && me.session_kind === "cookie";

// Portal's /app/api/money… (src/app-page.js has already checked the sign-in and the Origin).
// -> a Response, or null
export async function handleMoneyForStaff(request, env, me, route) {
  const url = new URL(request.url);
  const get = request.method === "GET";
  if (route === "/money" && get) {
    const settings = await readSettings(env);
    const [summary, invoices, expenses, reminders] = await Promise.all([
      moneySummary(env),
      listInvoices(env, { status: url.searchParams.get("status") || "all" }),
      listExpenses(env, { limit: 200 }),
      env.DB.prepare(`${REMINDER_SELECT} WHERE r.status IN ('pending_approval', 'failed') OR r.updated_at > ? ORDER BY r.id DESC LIMIT 50`).bind(new Date(Date.now() - 30 * 86400000).toISOString()).all(),
    ]);
    return json({
      summary,
      invoices,
      expenses,
      reminders: reminders.results.map(reminderShape),
      settings: { business: settings.business, bank: settings.bank, monzo: settings.monzo, vatRate: settings.vatRate, dueDays: settings.dueDays, bankReady: bankReady(settings), monzoReady: Boolean(settings.monzo.link) },
      categories: CATEGORIES,
      methods: METHODS.filter((m) => m !== "stripe").map((m) => ({ id: m, name: METHOD_NAMES[m] })),
      canDecide: canDecide(me),
      emailReady: emailReady(env),
      cardReady: cardReady(env),
    });
  }
  const preview = route.match(/^\/money\/invoices\/(\d{1,12})\/preview$/);
  if (preview && get) {
    const row = await readRow(env, Number(preview[1]));
    if (!row) return json({ error: "That invoice doesn't exist." }, 404);
    const nonce = newNonce();
    return pageResponse(await clientPage(env, row, await readSettings(env), { preview: true, nonce }), nonce, 200, true);
  }
  // The Invoicer (src/invoicer.js): the price list, and an invoice at one of its stages (read-only)
  if (route === "/money/catalogue" && get) return json({ ...catalogue(), themes: INVOICE_THEMES.map(({ id, name, band, accent }) => ({ id, name, band, accent })), modes: INVOICE_MODES, papers: INVOICE_PAPERS.map(({ id, name, light, dark, tone }) => ({ id, name, light, dark, tone: tone || null })), ...(({ invoiceTheme, invoiceMode, invoicePaper }) => ({ theme: invoiceTheme, mode: invoiceMode, paper: invoicePaper }))(await readSettings(env)) });
  const staged = route.match(/^\/money\/invoices\/(\d{1,12})\/(stage|document|email)$/);
  if (staged && get) {
    const row = await readRow(env, Number(staged[1]));
    if (!row) return json({ error: "That invoice doesn't exist." }, 404);
    const today = ukToday();
    const [settings, payments] = await Promise.all([readSettings(env), invoicePayments(env, row.id)]);
    const invoice = publicInvoice(env, row, today);
    const autoStage = stageOf(invoice, today);
    const asked = url.searchParams.get("stage");
    const stage = STAGES.includes(asked) ? asked : autoStage;
    // The email as the client gets it, at this stage (the message typed in the Invoicer above the invoice)
    if (staged[2] === "email") {
      const text = String(url.searchParams.get("body") || "").slice(0, 4000);
      const paragraphs = text.split(/\n\s*\n/).map((p) => p.trim()).filter(Boolean);
      const greeting = paragraphs.length > 1 && /^(hi|hello|dear)\b/i.test(paragraphs[0]) ? paragraphs.shift() : firstName(row);
      const mail = stage === "deposit" && !text ? invoiceEmail(env, settings, row) : invoiceMail(env, settings, row, payments, stage, { greeting, paragraphs });
      const nonce = newNonce();
      return pageResponse(mail.html, nonce, 200, true);
    }
    if (staged[2] === "document") {
      const nonce = newNonce();
      // ?theme= one of the invoice's themes and ?mode=bright|dark (else the studio's chosen ones); ?note= the Notes box's words for this copy
      const theme = url.searchParams.get("theme");
      const note = url.searchParams.get("note");
      const mode = url.searchParams.get("mode");
      const paper = url.searchParams.get("paper");
      const options = { theme: themeId(theme), mode: INVOICE_MODES.includes(mode) ? mode : null, paper: INVOICE_PAPERS.some((x) => x.id === paper) ? paper : null, note: note === null ? null : cleanText(note, 800) };
      return pageResponse(invoiceDocument(invoice, payments, stage, settings, today, options), nonce, 200, true);
    }
    const sums = stageSums(invoice, payments, stage, today);
    return json({ stage, autoStage, sums, email: stageEmail(invoice, sums, stage, settings, today), invoice, payments });
  }
  const one = route.match(/^\/money\/invoices\/(\d{1,12})$/);
  if (one && get) {
    const row = await readRow(env, Number(one[1]));
    if (!row) return json({ error: "That invoice doesn't exist." }, 404);
    const { results } = await env.DB.prepare(`${REMINDER_SELECT} WHERE r.invoice_id = ? ORDER BY r.id`).bind(row.id).all();
    return json({ invoice: publicInvoice(env, row), payments: await invoicePayments(env, row.id), reminders: results.map(reminderShape), log: await moneyLog(env, row.id) });
  }
  if (route === "/money/export.csv" && get) {
    if (!canDecide(me)) return json({ error: "Only an admin, signed in to Portal in a browser, can export." }, 403);
    const year = taxYear(ukToday());
    const out = await exportCsv(env, { what: url.searchParams.get("what"), from: url.searchParams.get("from") || year.from, to: url.searchParams.get("to") || year.to });
    if (out.error) return answer(out);
    return new Response(out.body, { headers: { "Content-Type": "text/csv; charset=utf-8", "Content-Disposition": `attachment; filename="${out.name}"`, "Cache-Control": "no-store" } });
  }
  if (request.method !== "POST") return null;
  const body = await readJson(request);

  // Anyone signed in
  if (route === "/money/invoices") return answer(await createInvoice(env, body, me.id));
  // The Invoicer's live preview: an invoice not made yet, drawn as it will look (nothing is saved)
  if (route === "/money/invoices/preview") return json({ html: await previewDocument(env, body) });
  const edit = route.match(/^\/money\/invoices\/(\d{1,12})\/edit$/);
  if (edit) return answer(await editInvoice(env, me.id, Number(edit[1]), body));
  const lookOf = route.match(/^\/money\/invoices\/(\d{1,12})\/look$/);
  if (lookOf) return answer(await setInvoiceLook(env, me.id, Number(lookOf[1]), body.look ?? null));
  const pay = route.match(/^\/money\/invoices\/(\d{1,12})\/payments$/);
  if (pay) return answer(await recordPayment(env, me.id, { invoiceId: Number(pay[1]), amount: body.amount, paidOn: body.paidOn, method: body.method === "stripe" ? "other" : body.method, note: body.note }));
  const remind = route.match(/^\/money\/invoices\/(\d{1,12})\/reminder$/);
  if (remind) return answer(await draftReminder(env, me.id, { invoiceId: Number(remind[1]), body: body.body, kind: body.kind === "receipt" ? "receipt" : "reminder" }));
  if (route === "/money/expenses") return answer(await addExpense(env, me.id, body));
  const exp = route.match(/^\/money\/expenses\/(\d{1,12})\/(edit|confirm|delete)$/);
  if (exp) {
    if (exp[2] === "delete") return answer(await deleteExpense(env, me, Number(exp[1])));
    return answer(await editExpense(env, me, Number(exp[1]), body, { confirm: exp[2] === "confirm" }));
  }

  // An admin in a browser
  const decide = route.match(/^\/money\/invoices\/(\d{1,12})\/(approve|reject|void)$/);
  const reminder = route.match(/^\/money\/reminders\/(\d{1,12})\/(approve|reject)$/);
  const takeBack = route.match(/^\/money\/payments\/(\d{1,12})\/remove$/);
  const adminOnly = decide || reminder || takeBack || route === "/money/invoices/test-send" || route === "/money/settings" || route === "/money/invoices/renumber";
  if (!adminOnly) return null;
  if (!canDecide(me)) return json({ error: "Only an admin, with Portal open in a browser and signed in, can do that.", onlineUrl: `${publicUrl(env)}/portal/?view=money` }, 403);
  if (route === "/money/settings") return answer(await saveSettings(env, me, body));
  if (route === "/money/invoices/renumber") {
    if (body.confirm !== "start again") return json({ error: "Say confirm: \"start again\"." }, 400);
    return answer(await renumberAsTests(env, me.id));
  }
  if (route === "/money/invoices/test-send") return answer(await testSendInvoice(env, me, { id: body.id, stage: body.stage, body: body.body }));
  if (takeBack) return answer(await removePayment(env, me, { paymentId: Number(takeBack[1]) }));
  if (reminder) return answer(await decideReminder(env, me, { id: Number(reminder[1]), approve: reminder[2] === "approve" }));
  if (decide[2] === "approve") return answer(await approveInvoice(env, me, { id: Number(decide[1]), byHand: body.byHand === true }));
  if (decide[2] === "reject") return answer(await rejectInvoice(env, me, { id: Number(decide[1]), note: body.note }));
  return answer(await voidInvoice(env, me, { id: Number(decide[1]), note: body.note }));
}

// Nova Agent's /nova-agent/money… (src/agent-nova.js has already checked the key). Read, write
// and edit invoices (they wait for an admin), and log expenses as unconfirmed. There is no approve,
// send, remind, void, payment or settings route for the agent's key.
export async function handleMoneyForAgent(env, pathname, body) {
  if (pathname === "/nova-agent/money/context") return json(await moneyContext(env));
  if (pathname === "/nova-agent/money/invoices") return json({ invoices: await listInvoices(env, { status: typeof body?.status === "string" ? body.status : "all", limit: 50 }) });
  if (pathname === "/nova-agent/money/invoices/draft") {
    // Only these fields are read: a status, hash, number or approver sent along is ignored
    const input = {};
    for (const key of ["clientId", "billName", "billEmail", "billAddress", "lines", "vatRate", "issueDate", "dueDate", "notes", "billing"]) if (body && Object.hasOwn(body, key)) input[key] = body[key];
    return answer(await createInvoice(env, input, "agent"));
  }
  const one = pathname.match(/^\/nova-agent\/money\/invoices\/(\d{1,12})$/);
  if (one) {
    const invoice = await getInvoice(env, Number(one[1]));
    return invoice ? json({ invoice, payments: await invoicePayments(env, invoice.id) }) : json({ error: "That invoice doesn't exist." }, 404);
  }
  const edit = pathname.match(/^\/nova-agent\/money\/invoices\/(\d{1,12})\/edit$/);
  if (edit) {
    const changes = {};
    for (const key of ["clientId", "billName", "billEmail", "billAddress", "lines", "vatRate", "issueDate", "dueDate", "notes", "billing"]) if (body && Object.hasOwn(body, key)) changes[key] = body[key];
    return answer(await editInvoice(env, "agent", Number(edit[1]), changes));
  }
  if (pathname === "/nova-agent/money/expenses") {
    const input = {};
    for (const key of ["spentOn", "amount", "category", "supplier", "note"]) if (body && Object.hasOwn(body, key)) input[key] = body[key];
    return answer(await addExpense(env, "agent", input, { unconfirmed: true }));
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

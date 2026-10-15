// The Invoicer (Nova Agent's Invoicer panel): one invoice, seen at each of its four stages, as a
// branded page to print or save as a PDF, with a short email to go with it.
//
//   deposit  Deposit due: the booking is held once 50% is paid (studio.js's DEPOSIT_PERCENT)
//   balance  Balance due: the total, less what's been paid
//   overdue  Past its due date with money still owed
//   paid     Paid in full: a receipt
//
// The stage is worked out from the invoice's payments and due date (stageOf), and can be chosen
// by hand. Every sum is worked out here in whole pence, never by an AI. Nothing here sends
// anything: sending still goes through Money's admin Approve (src/money.js).
//
// Routes (src/money.js's handleMoneyForStaff, anyone signed in to the team):
//   GET /app/api/money/catalogue                      -> { services, depositPercent }
//   GET /app/api/money/invoices/:id/stage?stage=      -> { stage, autoStage, sums, email, invoice, payments }
//   GET /app/api/money/invoices/:id/document?stage=   -> the branded invoice, a page

import { FONT_DATA_URL, LOGO_DATA_URL, LOGO_WHITE_DATA_URL } from "./invoicer-logo.js";
import { SESSION_TYPES, DEPOSIT_PERCENT, CANCEL_NOTICE_HOURS, depositFor } from "./nova/studio.js";

export const STAGES = ["deposit", "balance", "overdue", "paid"];
export const STAGE_NAMES = { deposit: "Deposit due", balance: "Balance due", overdue: "Overdue", paid: "Paid receipt" };

// The studio's details on every invoice: Money's settings where they're filled in, these otherwise
const STUDIO_CARD = {
  name: "Novacane Studios",
  address: "10 Clyde Terrace, London, England, SE23 3BA",
  phone: "+44 20 8291 3028",
  email: "info@novacane.co.uk",
  website: "www.novacane.co.uk",
};
// (Money's old default address, before anyone set one: not a real address to print)
const OLD_DEFAULT_ADDRESS = "Forest Hill, London";

export function studioCard(settings) {
  const b = settings?.business || {};
  return {
    name: b.name || STUDIO_CARD.name,
    address: b.address && b.address !== OLD_DEFAULT_ADDRESS ? b.address : STUDIO_CARD.address,
    phone: b.phone || STUDIO_CARD.phone,
    email: b.email || STUDIO_CARD.email,
    website: b.website || STUDIO_CARD.website,
    vatNumber: b.vatNumber || "",
  };
}

// ===== THE PRICE LIST =====
// The sessions come from studio.js (the booking page's own list), so a price changed there changes
// here too. The work done after a session (mixing, mastering, production) is added here.
const EXTRAS = [
  { id: "mix-stereo", group: "Mixing", name: "Mixing: stereo WAV/MP3 mix, per song", pricePence: 10000 },
  { id: "mix-stems", group: "Mixing", name: "Mixing: stem mix with FX, per song", pricePence: 20000 },
  { id: "master-1", group: "Mastering", name: "Mastering, per song (1 or 2 songs)", pricePence: 5000 },
  { id: "master-3", group: "Mastering", name: "Mastering, per song (3 to 10 songs)", pricePence: 3000, note: "For orders of 3 to 10 songs" },
  { id: "production", group: "Production", name: "Custom music production, per song", pricePence: 25000, from: true, note: "From £250: type the agreed price" },
];
function groupOf(name) {
  if (/^Rap/i.test(name)) return "Rap packages";
  if (/^Singer/i.test(name)) return "Singer packages";
  if (/^Voiceover/i.test(name)) return "Voiceover";
  if (/^Studio Rental/i.test(name)) return "Studio rental (no engineer)";
  if (/Production/i.test(name)) return "Production";
  return "Sessions";
}
export function catalogue() {
  const sessions = SESSION_TYPES.filter((t) => !/Production/i.test(t.name)).map((t) => ({ id: `s-${t.id}`, group: groupOf(t.name), name: t.name, pricePence: Math.round(t.price * 100) }));
  return { services: [...sessions, ...EXTRAS], depositPercent: DEPOSIT_PERCENT };
}

// ===== THE STAGE AND THE SUMS =====

const OPEN = ["sent", "part_paid"];
// Days from one UK day to another
const daysBetween = (from, to) => Math.round((Date.parse(to + "T12:00:00Z") - Date.parse(from + "T12:00:00Z")) / 86400000);

// invoice: money.js's publicInvoice shape
export function stageOf(invoice, today) {
  if (!invoice) return null;
  if (invoice.paidPence >= invoice.totalPence || invoice.status === "paid") return "paid";
  if (OPEN.includes(invoice.status) && invoice.dueDate < today) return "overdue";
  if (invoice.paidPence > 0) return "balance";
  return "deposit";
}

export function stageSums(invoice, payments, stage, today) {
  const total = invoice.totalPence;
  const kept = (payments || []).filter((p) => !p.removed);
  const paid = kept.length ? kept.reduce((s, p) => s + p.amountPence, 0) : invoice.paidPence || 0;
  const deposit = depositFor(total);
  const base = { totalPence: total, paidPence: paid, depositPercent: DEPOSIT_PERCENT, depositPence: deposit, payments: kept.map((p) => ({ amountPence: p.amountPence, paidOn: p.paidOn, method: p.methodName || p.method })) };
  if (stage === "deposit") return { ...base, dueNowPence: Math.max(0, deposit - paid), dueBy: invoice.issueDate, laterPence: total - Math.max(deposit, paid), laterBy: invoice.dueDate };
  if (stage === "paid") return { ...base, dueNowPence: 0, dueBy: null };
  const owed = Math.max(0, total - paid);
  const late = stage === "overdue" ? Math.max(0, daysBetween(invoice.dueDate, today)) : 0;
  return { ...base, dueNowPence: owed, dueBy: invoice.dueDate, daysOverdue: late };
}

// ===== WORDS =====

export function pounds(pence) {
  const p = Math.round(Number(pence) || 0);
  const s = (Math.abs(p) / 100).toLocaleString("en-GB", { minimumFractionDigits: 2, maximumFractionDigits: 2 });
  return `${p < 0 ? "−" : ""}£${s}`;
}
// "14 October 2026"
export function longDay(day) {
  return /^\d{4}-\d{2}-\d{2}$/.test(String(day || "")) ? new Date(day + "T12:00:00Z").toLocaleDateString("en-GB", { day: "numeric", month: "long", year: "numeric", timeZone: "UTC" }) : "";
}
const firstName = (name) => String(name || "").trim().split(/\s+/)[0] || "there";
const esc = (s) => String(s ?? "").replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c]);
const bankReady = (bank) => Boolean(bank && bank.accountName && bank.sortCode && bank.accountNumber);

// How to pay, in plain words (the invoice's own page when it has gone out, then bank transfer)
function howToPay(invoice, settings) {
  const out = [];
  if (invoice.pageUrl) out.push(`See and pay it online: ${invoice.pageUrl}`);
  if (bankReady(settings?.bank)) out.push(`Or by bank transfer to ${settings.bank.accountName}, sort code ${settings.bank.sortCode}, account ${settings.bank.accountNumber}, with ${invoice.number} as the reference.`);
  return out;
}

// The short email for a stage: { subject, body } (plain text, to copy or to send through Money)
export function stageEmail(invoice, sums, stage, settings) {
  const card = studioCard(settings);
  const hi = `Hi ${firstName(invoice.billTo?.name)},`;
  const pay = howToPay(invoice, settings);
  const sign = `Best wishes,\nThe ${card.name} team`;
  const para = (...p) => p.filter(Boolean).join("\n\n");
  if (stage === "deposit")
    return {
      subject: `Your booking with ${card.name}: ${sums.depositPercent}% deposit to confirm (${invoice.number})`,
      body: para(
        hi,
        `Thank you for booking with ${card.name}. We can't wait to get you in the studio.`,
        `Your booking comes to ${pounds(sums.totalPence)}. To secure your session, please pay the ${sums.depositPercent}% deposit of ${pounds(sums.dueNowPence)} today. Your date is held as soon as it arrives. The remaining ${pounds(sums.laterPence)} is due by ${longDay(sums.laterBy)}.`,
        pay.join("\n"),
        `Any questions, just reply to this email.`,
        sign
      ),
    };
  if (stage === "balance")
    return {
      subject: `Balance due for invoice ${invoice.number}: ${pounds(sums.dueNowPence)}`,
      body: para(
        hi,
        `Thank you${sums.paidPence ? ` for your payment of ${pounds(sums.paidPence)}` : ""}. Here's the balance for your session.`,
        `Invoice ${invoice.number} comes to ${pounds(sums.totalPence)}, so ${pounds(sums.dueNowPence)} is left to pay, due by ${longDay(sums.dueBy)}.`,
        pay.join("\n"),
        `If anything doesn't look right, reply and we'll sort it out.`,
        sign
      ),
    };
  if (stage === "overdue")
    return {
      subject: `Overdue: invoice ${invoice.number} (${pounds(sums.dueNowPence)})`,
      body: para(
        hi,
        `Our records show that invoice ${invoice.number} for ${pounds(sums.dueNowPence)} was due on ${longDay(sums.dueBy)} and is now ${sums.daysOverdue} day${sums.daysOverdue === 1 ? "" : "s"} overdue.`,
        `Please pay the outstanding balance as soon as you can.`,
        pay.join("\n"),
        `If you've already paid, thank you, and please ignore this. If something is stopping you from paying, just reply and we'll work it out together.`,
        sign
      ),
    };
  return {
    subject: `Receipt for invoice ${invoice.number}: paid in full, thank you`,
    body: para(
      hi,
      `Thank you! We've received your payment and invoice ${invoice.number} (${pounds(sums.totalPence)}) is paid in full. Here's your receipt for your records.`,
      `It was a pleasure working on your music. We'd love to have you back in the studio for the next one.`,
      sign
    ),
  };
}

// ===== THE PAGE: the invoice itself, to print or save as a PDF =====
// ===== THE PAGE: the invoice itself, to print or save as a PDF =====
// Novacane's look (novacane.co.uk): a near-black band with the white ring logo and spaced-out capitals
// in a Futura-like type (Jost), then a calm white page that's easy to read. Each stage is one quiet
// line and one word in the amount box, never a loud banner. One A4 page.

// The themes: the same invoice, the colours a shade apart (the band, the accent, the paper's warmth).
// Each comes Bright (a white page) or Dark (a near-black page, like the website): accentDark is the
// accent a touch lighter, so it reads on the dark page.
export const INVOICE_THEMES = [
  { id: "night", name: "Night", band: "#100806", accent: "#B0367E", accentDark: "#E0629F", wash: "#FBF8F7" },
  { id: "violet", name: "Violet", band: "#0F0812", accent: "#7B2CBF", accentDark: "#A774E0", wash: "#F9F7FC" },
  { id: "plum", name: "Plum", band: "#140A12", accent: "#962F86", accentDark: "#CF67BE", wash: "#FBF7FA" },
  { id: "ink", name: "Ink", band: "#0B0B10", accent: "#4F46B8", accentDark: "#8D86F0", wash: "#F7F7FA" },
  { id: "ember", name: "Ember", band: "#140806", accent: "#B8405F", accentDark: "#E57590", wash: "#FCF7F6" },
  { id: "rose", name: "Rose", band: "#12080B", accent: "#C0457C", accentDark: "#EC7FAE", wash: "#FCF6F8" },
  { id: "dusk", name: "Dusk", band: "#0D0A14", accent: "#6A4BC9", accentDark: "#9D86F2", wash: "#F8F7FC" },
  { id: "paper", name: "Paper", band: "#F4F1EF", accent: "#9A3381", accentDark: "#D06BBA", wash: "#FAF8F7", light: true },
];
export const INVOICE_MODES = ["bright", "dark"];
export const themeOf = (id) => INVOICE_THEMES.find((t) => t.id === id) || INVOICE_THEMES[0];

// A stage, in a few calm words, and its colour (the theme's accent, or a muted red or green)
const STAGE_LINES = {
  deposit: { colour: "accent", text: (s) => `Deposit due to secure your booking: ${s.depositPercent}% now, the rest by the session` },
  balance: { colour: "ink", text: () => "Balance due: the remaining amount for your session" },
  overdue: { colour: "#A3233A", text: (s) => `Past due: this invoice was due on ${longDay(s.dueBy)}` },
  paid: { colour: "#1F7A55", text: () => "Paid in full. Thank you for recording with us" },
};
// The note when the invoice has none of its own
const DEFAULT_NOTE = "Thank you for choosing Novacane Studios. Any questions about this invoice, just get in touch.";

// options: { theme, mode ("bright" or "dark"), note (words for the Notes box instead of the invoice's own) }
export function invoiceDocument(invoice, payments, stage, settings, today, options = {}) {
  const s = stageSums(invoice, payments, stage, today);
  const card = studioCard(settings);
  const t = themeOf(options.theme || settings?.invoiceTheme);
  const dark = (options.mode || settings?.invoiceMode) === "dark";
  const receipt = stage === "paid";
  const line = STAGE_LINES[stage];
  const accent = dark ? t.accentDark : t.accent;
  const red = dark ? "#EE6A80" : "#A3233A";
  const green = dark ? "#5CC795" : "#1F7A55";
  const lineColour = line.colour === "accent" ? accent : line.colour === "ink" ? (dark ? "#E9E2E3" : "#2A2326") : line.colour === "#A3233A" ? red : green;
  const note = String(options.note ?? invoice.notes ?? "").trim() || DEFAULT_NOTE;

  const rows = invoice.lines
    .map((l) => `<tr><td>${esc(l.description)}</td><td class="n">${esc(l.qty)}</td><td class="n">${pounds(l.unitPence)}</td><td class="n">${pounds(l.totalPence)}</td></tr>`)
    .join("");
  const row = (label, value, cls = "") => `<div class="r ${cls}"><span>${label}</span><b>${value}</b></div>`;
  const paidRows = s.payments.map((p) => row(`Paid ${esc(longDay(p.paidOn))}${p.method ? ` <small>${esc(p.method)}</small>` : ""}`, pounds(-p.amountPence), "soft")).join("");
  const sums = [];
  if (invoice.vatPence) sums.push(row("Subtotal", pounds(invoice.subtotalPence)), row(`VAT ${esc(invoice.vatRate)}%`, pounds(invoice.vatPence)));
  sums.push(row(stage === "deposit" ? "Total booking value" : "Total", pounds(s.totalPence), "strong"));
  if (stage === "deposit") {
    sums.push(paidRows);
    sums.push(row(`Deposit due now (${s.depositPercent}%)`, pounds(s.dueNowPence), "due"));
    sums.push(row(`Balance due by ${esc(longDay(s.laterBy))}`, pounds(s.laterPence), "soft"));
  } else {
    sums.push(paidRows || (receipt ? "" : row("Paid so far", pounds(0), "soft")));
    sums.push(row(receipt ? "Amount due" : "Remaining balance", receipt ? "£0.00" : pounds(s.dueNowPence), "due"));
  }

  // The amount box (top right): what to pay, by when
  const dueWord = receipt ? "Paid in full" : stage === "overdue" ? `${s.daysOverdue} day${s.daysOverdue === 1 ? "" : "s"} overdue` : `Due ${esc(longDay(s.dueBy))}`;
  const amount = `<div class="amount${stage === "overdue" ? " late" : ""}${receipt ? " done" : ""}">
    <span class="lbl">${receipt ? "Amount paid" : stage === "deposit" ? "Deposit due" : "Amount due"}</span>
    <b>${pounds(receipt ? s.paidPence || s.totalPence : s.dueNowPence)}</b>
    <span class="when">${dueWord}</span>
    ${receipt ? '<span class="stamp" aria-hidden="true">Paid</span>' : ""}</div>`;

  // How to pay (or, paid, how it was paid)
  const bank = bankReady(settings?.bank) && !receipt
    ? `<p><span class="k">Bank transfer</span>${esc(settings.bank.accountName)}<br>Sort code ${esc(settings.bank.sortCode)}<br>Account ${esc(settings.bank.accountNumber)}${settings.bank.note ? `<br>${esc(settings.bank.note)}` : ""}</p>`
    : "";
  const online = invoice.pageUrl && !receipt ? `<p><span class="k">Pay online</span><a href="${esc(invoice.pageUrl)}">${esc(invoice.pageUrl.replace(/^https?:\/\//, ""))}</a></p>` : "";
  const ref = receipt ? "" : `<p><span class="k">Reference</span>${esc(invoice.number)}</p>`;
  const pay = receipt ? `<p>Received with thanks${s.payments.length ? `, last payment ${esc(longDay(s.payments[s.payments.length - 1].paidOn))}` : ""}. Nothing more to pay.</p>` : bank || online ? `${online}${bank}${ref}` : `<p>Payment details are in your email.</p>${ref}`;

  const billTo = [invoice.billTo?.name ? `<b>${esc(invoice.billTo.name)}</b>` : "", invoice.billTo?.address ? esc(invoice.billTo.address).replace(/\n/g, "<br>") : "", invoice.billTo?.email ? esc(invoice.billTo.email) : ""].filter(Boolean).join("<br>");
  const facts = [
    ["Number", esc(invoice.number)],
    ["Issued", esc(longDay(invoice.issueDate))],
    ...(receipt ? [] : [["Due", `<span${stage === "overdue" ? ' class="late"' : ""}>${esc(longDay(stage === "deposit" ? s.dueBy : invoice.dueDate))}</span>`]]),
    ...(card.vatNumber ? [["VAT number", esc(card.vatNumber)]] : []),
  ].map(([k, v]) => `<dt>${k}</dt><dd>${v}</dd>`).join("");
  const title = `${receipt ? "Receipt" : "Invoice"} ${invoice.number}`;
  const lightBand = t.light && !dark;
  const logo = lightBand ? LOGO_DATA_URL : LOGO_WHITE_DATA_URL;
  // The page's colours: Bright (white paper, dark ink) or Dark (the website's near-black, light ink)
  const page = dark
    ? { band: t.light ? "#0C0908" : t.band, paper: "#17110F", wash: "#211A18", ink: "#F1EBEA", soft: "#A99FA0", hair: "#352C2B", outside: "#0B0807", rule: "#F1EBEA" }
    : { band: t.band, paper: "#FFFFFF", wash: t.wash, ink: "#1C1618", soft: "#6B6266", hair: "#E7E2E2", outside: "#EDEAEA", rule: "#1C1618" };

  return `<!doctype html>
<html lang="en-GB"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1"><meta name="robots" content="noindex">
<title>${esc(title)} · ${esc(card.name)}</title>
<style>
@font-face{font-family:"Jost";src:url(${FONT_DATA_URL}) format("woff2");font-weight:400 600;font-display:block}
:root{--band:${page.band};--accent:${accent};--paper:${page.paper};--wash:${page.wash};--ink:${page.ink};--soft:${page.soft};--hair:${page.hair};--rule:${page.rule};--red:${red};--green:${green};--line:${lineColour};--band-ink:${lightBand ? "#1C1618" : "#FFFFFF"};color-scheme:${dark ? "dark" : "light"}}
*{box-sizing:border-box}
html{background:${page.outside}}
body{margin:0;padding:28px 12px;font:15px/1.55 "Jost",Futura,"Century Gothic","Avenir Next",system-ui,sans-serif;color:var(--ink);letter-spacing:.01em;-webkit-print-color-adjust:exact;print-color-adjust:exact}
.sheet{max-width:820px;margin:0 auto;background:var(--paper);box-shadow:0 10px 40px rgb(0 0 0 / .08)}
.band{display:flex;align-items:center;justify-content:space-between;gap:20px;padding:22px 40px;background:var(--band);color:var(--band-ink);border-bottom:2px solid var(--accent)}
.brand{display:flex;align-items:center;gap:16px}
.brand img{width:46px;height:46px;display:block}
.brand b{display:block;font-weight:500;font-size:19px;letter-spacing:.32em}
.brand small{display:block;margin-top:3px;font-size:10.5px;letter-spacing:.42em;opacity:.75}
.doc{font-weight:400;font-size:13px;letter-spacing:.42em;text-transform:uppercase;opacity:.9}
.in{padding:30px 40px 34px}
.stage{display:flex;align-items:center;gap:10px;margin:0 0 26px;font-size:13.5px;color:var(--line)}
.stage::before{content:"";width:8px;height:8px;border-radius:50%;background:var(--line);flex:none}
.top{display:grid;grid-template-columns:1.1fr 1fr auto;gap:28px;align-items:start}
.k,.top h2,.notes h2,.pay h2{display:block;margin:0 0 6px;font-size:10.5px;font-weight:500;letter-spacing:.24em;text-transform:uppercase;color:var(--soft)}
.to{font-size:14px;line-height:1.6}.to b{font-weight:600}
dl{margin:0;display:grid;grid-template-columns:auto 1fr;gap:3px 14px;font-size:13.5px}
dt{color:var(--soft)}dd{margin:0;font-variant-numeric:tabular-nums}
.late{color:var(--red);font-weight:500}
.amount{position:relative;min-width:200px;padding:16px 18px;background:var(--wash);border-left:2px solid var(--accent);text-align:right}
.amount .lbl{display:block;font-size:10.5px;letter-spacing:.24em;text-transform:uppercase;color:var(--soft)}
.amount b{display:block;margin:4px 0 2px;font-size:28px;font-weight:500;letter-spacing:.01em;font-variant-numeric:tabular-nums}
.amount .when{font-size:13px;color:var(--soft)}
.amount.late{border-left-color:var(--red)}.amount.late .when{color:var(--red);font-weight:500}
.amount.done{border-left-color:var(--green);padding-top:24px}.amount.done .when{color:var(--green);font-weight:500}
.stamp{position:absolute;right:12px;top:-13px;transform:rotate(-6deg);padding:1px 10px;background:var(--paper);border:2px solid var(--green);border-radius:6px;color:var(--green);font-size:14px;font-weight:600;letter-spacing:.3em;text-transform:uppercase;opacity:.75}
table{width:100%;margin-top:30px;border-collapse:collapse;font-size:14px}
th{padding:0 0 9px;text-align:left;font-size:10.5px;font-weight:500;letter-spacing:.24em;text-transform:uppercase;color:var(--soft);border-bottom:1px solid var(--rule)}
td{padding:12px 0;border-bottom:1px solid var(--hair);vertical-align:top}
th.n,td.n{text-align:right;white-space:nowrap;padding-left:18px;font-variant-numeric:tabular-nums}
tr{break-inside:avoid}
.sums{margin:14px 0 0 auto;max-width:340px;break-inside:avoid}
.r{display:flex;justify-content:space-between;gap:18px;padding:6px 0;font-size:14px}
.r b{font-weight:500;font-variant-numeric:tabular-nums;white-space:nowrap}
.r.soft{color:var(--soft)}.r small{font-size:12px}
.r.strong{border-top:1px solid var(--hair);margin-top:4px;padding-top:10px}
.r.due{margin-top:6px;padding:10px 0 4px;border-top:1px solid var(--rule);font-size:16px;font-weight:600}.r.due b{font-weight:600}
.bottom{display:grid;grid-template-columns:1.2fr 1fr;gap:28px;align-items:start;margin-top:30px;break-inside:avoid}
.notes{padding:14px 16px;background:var(--wash);border-radius:4px;font-size:13.5px;line-height:1.6;white-space:pre-line}
.pay{font-size:13.5px;line-height:1.6}.pay p{margin:0 0 10px}
.pay a{color:var(--accent);text-decoration:none;border-bottom:1px solid currentColor}
footer{display:flex;flex-wrap:wrap;justify-content:space-between;gap:6px 18px;margin-top:30px;padding-top:14px;border-top:1px solid var(--hair);font-size:11.5px;color:var(--soft);letter-spacing:.02em}
footer .thanks{width:100%;font-size:12.5px;color:var(--ink)}
@media (max-width:640px){
  body{padding:0}.band{padding:18px 20px}.brand b{font-size:15px;letter-spacing:.24em}.doc{display:none}.in{padding:22px 20px}
  .top{grid-template-columns:1fr}.amount{text-align:left}.bottom{grid-template-columns:1fr}
  th:nth-child(2),td:nth-child(2),th:nth-child(3),td:nth-child(3){display:none}
}
@page{size:A4;margin:12mm}
@media print{html{background:${dark ? "var(--paper)" : "none"}}body{padding:0;font-size:13.5px}.sheet{box-shadow:none;max-width:none}.in{padding:26px 34px 10px}.band{padding:18px 34px}}
</style></head>
<body><main class="sheet">
<header class="band"><div class="brand"><img src="${logo}" alt="Novacane Studios logo" width="46" height="46"><div><b>NOVACANE</b><small>STUDIOS</small></div></div><div class="doc">${receipt ? "Receipt" : "Invoice"}</div></header>
<div class="in">
<p class="stage" role="note">${esc(line.text(s))}</p>
<section class="top">
  <div class="to"><h2>Billed to</h2>${billTo}</div>
  <dl>${facts}</dl>
  ${amount}
</section>
<table><thead><tr><th>Description</th><th class="n">Qty</th><th class="n">Price</th><th class="n">Amount</th></tr></thead><tbody>${rows}</tbody></table>
<section class="sums" aria-label="Totals">${sums.join("")}</section>
<div class="bottom">
  <section class="notes" aria-label="Notes"><h2>Notes</h2>${esc(note)}</section>
  <section class="pay"><h2>${receipt ? "Payment" : "How to pay"}</h2>${pay}</section>
</div>
<footer><span class="thanks">Thank you for recording with ${esc(card.name)}.</span><span>${esc(card.address)}</span><span>${esc(card.phone)} · ${esc(card.email)} · ${esc(card.website)}</span><span>Deposits are non-refundable with less than ${CANCEL_NOTICE_HOURS} hours' notice of cancellation.</span></footer>
</div></main></body></html>`;
}

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

import { LOGO_DATA_URL } from "./invoicer-logo.js";
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

// The studio's logo (from novacane.co.uk), in the page so it prints and goes into the PDF
const LOGO = `<img class="sigil" src="${LOGO_DATA_URL}" alt="Novacane Studios logo" width="68" height="68">`;

const BANNERS = {
  deposit: { colour: "#7B2CBF", text: (s) => `Action required: ${s.depositPercent}% deposit due to secure your booking` },
  balance: { colour: "#1A1A1A", text: () => "Invoice due: balance payment notice" },
  overdue: { colour: "#B00020", text: () => "Urgent notice: this invoice is past due" },
  paid: { colour: "#0F7B4A", text: () => "Thank you for recording with us! Payment received" },
};

export function invoiceDocument(invoice, payments, stage, settings, today) {
  const s = stageSums(invoice, payments, stage, today);
  const card = studioCard(settings);
  const banner = BANNERS[stage];
  const receipt = stage === "paid";
  const rows = invoice.lines
    .map(
      (l) => `<tr><td data-label="Description">${esc(l.description)}</td><td class="n" data-label="Qty">${esc(l.qty)}</td><td class="n" data-label="Unit price">${pounds(l.unitPence)}</td><td class="n" data-label="Amount">${pounds(l.totalPence)}</td></tr>`
    )
    .join("");
  const vat = invoice.vatPence ? `<div class="t"><span>Subtotal</span><b>${pounds(invoice.subtotalPence)}</b></div><div class="t"><span>VAT (${esc(invoice.vatRate)}%)</span><b>${pounds(invoice.vatPence)}</b></div>` : "";
  const paidRows = s.payments.map((p) => `<div class="t"><span>Paid ${esc(longDay(p.paidOn))}${p.method ? ` · ${esc(p.method)}` : ""}</span><b>${pounds(-p.amountPence)}</b></div>`).join("");
  let totalsBox;
  if (stage === "deposit")
    totalsBox = `${vat}<div class="t"><span>Total booking value</span><b>${pounds(s.totalPence)}</b></div>
      ${paidRows}
      <div class="t due"><span>Deposit due now to confirm (${s.depositPercent}%)<small>Due ${esc(longDay(s.dueBy))}</small></span><b>${pounds(s.dueNowPence)}</b></div>
      <div class="t later"><span>Balance due later<small>By ${esc(longDay(s.laterBy))}</small></span><b>${pounds(s.laterPence)}</b></div>`;
  else if (receipt)
    totalsBox = `${vat}<div class="t"><span>Total</span><b>${pounds(s.totalPence)}</b></div>${paidRows}
      <div class="t due paid"><span>Amount due</span><b>£0.00 <small class="inl">(paid in full)</small></b></div>`;
  else
    totalsBox = `${vat}<div class="t"><span>Total amount</span><b>${pounds(s.totalPence)}</b></div>${paidRows || `<div class="t"><span>Paid so far</span><b>${pounds(0)}</b></div>`}
      <div class="t due"><span>Remaining balance outstanding<small${stage === "overdue" ? ' class="late"' : ""}>Due ${esc(longDay(s.dueBy))}${stage === "overdue" ? ` · ${s.daysOverdue} day${s.daysOverdue === 1 ? "" : "s"} overdue` : ""}</small></span><b>${pounds(s.dueNowPence)}</b></div>`;
  const bank = bankReady(settings?.bank) && !receipt
    ? `<p><b>Bank transfer</b><br>${esc(settings.bank.accountName)}<br>Sort code ${esc(settings.bank.sortCode)} · Account ${esc(settings.bank.accountNumber)}<br>Reference: ${esc(invoice.number)}${settings.bank.note ? `<br>${esc(settings.bank.note)}` : ""}</p>`
    : "";
  const online = invoice.pageUrl && !receipt ? `<p><b>Pay online</b><br><a href="${esc(invoice.pageUrl)}">${esc(invoice.pageUrl.replace(/^https?:\/\//, ""))}</a></p>` : "";
  const payBox = receipt ? `<p>Thank you: nothing more to pay.</p>` : bank || online ? `${online}${bank}` : `<p>Payment details: see your email.</p>`;
  const billTo = [invoice.billTo?.name, invoice.billTo?.address].filter(Boolean).map(esc).join("<br>").replace(/\n/g, "<br>");
  const title = `${receipt ? "Receipt" : "Invoice"} ${invoice.number}`;
  return `<!doctype html>
<html lang="en-GB"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1"><meta name="robots" content="noindex">
<title>${esc(title)} · ${esc(card.name)}</title>
<style>
*{box-sizing:border-box}
html{background:#ECEBEF}
body{margin:0;padding:24px 12px;font:15px/1.5 system-ui,-apple-system,"Segoe UI",Roboto,Helvetica,Arial,sans-serif;color:#1A1A1A;-webkit-print-color-adjust:exact;print-color-adjust:exact}
.sheet{position:relative;max-width:820px;margin:0 auto;background:#fff;border:1px solid #1A1A1A;overflow:hidden}
.banner{padding:12px 28px;color:#fff;font-weight:700;letter-spacing:.04em;text-transform:uppercase;font-size:13px;background:${banner.colour}}
.in{padding:28px}
header{display:flex;justify-content:space-between;gap:24px;flex-wrap:wrap;align-items:flex-start;border-bottom:2px solid #1A1A1A;padding-bottom:20px}
.brand{display:flex;align-items:center;gap:16px}
.sigil{width:68px;height:68px;flex:none;display:block}
.mark{line-height:1}
.mark b{display:block;font-size:30px;font-weight:900;letter-spacing:.14em;color:#1A1A1A}
.mark span{display:inline-block;margin-top:6px;padding-bottom:4px;font-size:12px;font-weight:700;letter-spacing:.55em;color:#7B2CBF;border-bottom:2px solid #7B2CBF}
.studio{margin-top:14px;font-size:12.5px;color:#4A4A4A}
.meta{text-align:right}
.meta h1{margin:0 0 6px;font-size:28px;letter-spacing:.12em;font-weight:900}
.meta dl{margin:0;display:grid;grid-template-columns:auto auto;gap:2px 14px;justify-content:end;font-size:13px}
.meta dt{color:#6A6A6A}.meta dd{margin:0;font-weight:600;font-variant-numeric:tabular-nums}
.late{color:#B00020!important;font-weight:800}
.badge{display:inline-block;margin-bottom:8px;padding:4px 10px;border:2px solid #B00020;color:#B00020;font-weight:900;font-size:12px;letter-spacing:.14em;text-transform:uppercase}
.to{margin:22px 0 18px;font-size:14px}.to h2,.pay h2{margin:0 0 4px;font-size:11px;letter-spacing:.16em;text-transform:uppercase;color:#7B2CBF}
table{width:100%;border-collapse:collapse;font-size:14px}
th{text-align:left;font-size:11px;letter-spacing:.12em;text-transform:uppercase;background:#1A1A1A;color:#fff;padding:9px 10px}
td{padding:11px 10px;border-bottom:1px solid #D8D6DD;vertical-align:top}
.n{text-align:right;white-space:nowrap;font-variant-numeric:tabular-nums}
tr{break-inside:avoid}
.bottom{display:flex;gap:24px;flex-wrap:wrap;justify-content:space-between;margin-top:20px}
.pay{flex:1 1 260px;font-size:13.5px}.pay p{margin:0 0 10px}
.totals{position:relative;flex:0 1 360px;border:1px solid #1A1A1A;break-inside:avoid}
.t{display:flex;justify-content:space-between;gap:16px;padding:9px 14px;border-bottom:1px solid #D8D6DD;font-size:14px}
.t:last-child{border-bottom:0}
.t b{font-variant-numeric:tabular-nums;white-space:nowrap}
.t small{display:block;font-size:12px;color:#6A6A6A;font-weight:500}
.t small.inl{display:inline;font-size:12px}
.t.due{background:#F3ECFA;border-top:2px solid #7B2CBF;font-weight:800;font-size:16px}
.t.due.paid{background:#E7F5EE;border-top-color:#0F7B4A}
.t.later{color:#4A4A4A}
.stamp{position:absolute;top:44%;left:50%;transform:translate(-50%,-50%) rotate(-20deg);font-size:150px;font-weight:900;letter-spacing:.08em;color:#0F7B4A;opacity:.15;border:12px solid #0F7B4A;padding:0 30px;border-radius:18px;pointer-events:none;line-height:1.1}
footer{margin-top:26px;padding-top:14px;border-top:1px solid #D8D6DD;font-size:12px;color:#6A6A6A;display:flex;flex-wrap:wrap;gap:4px 14px;justify-content:space-between}
a{color:#7B2CBF}
@media (max-width:600px){
  body{padding:0}.sheet{border:0}.in{padding:18px}.meta{text-align:left}.meta dl{justify-content:start}
  thead{display:none}table,tbody,tr,td{display:block;width:100%}
  tr{border:1px solid #D8D6DD;margin-bottom:10px;padding:4px 0}
  td{border:0;padding:4px 12px;display:flex;justify-content:space-between;gap:12px}
  td::before{content:attr(data-label);color:#6A6A6A;font-size:12px}
  td.n{text-align:right}.stamp{font-size:80px;border-width:8px}.sigil{width:54px;height:54px}.brand{gap:12px}
}
@page{size:A4;margin:14mm}
@media print{html{background:#fff}body{padding:0}.sheet{border:0;max-width:none}}
</style></head>
<body><main class="sheet">
<div class="banner" role="note">${esc(banner.text(s))}</div>
${receipt ? '<div class="stamp" aria-hidden="true">PAID</div>' : ""}
<div class="in">
<header>
  <div><div class="brand">${LOGO}<div class="mark" aria-label="${esc(card.name)}"><b>NOVACANE</b><span>STUDIOS</span></div></div>
  <div class="studio">${esc(card.address)}<br>${esc(card.phone)} · ${esc(card.email)}<br>${esc(card.website)}${card.vatNumber ? `<br>VAT number ${esc(card.vatNumber)}` : ""}</div></div>
  <div class="meta">${stage === "overdue" ? '<div class="badge">Overdue notice</div>' : ""}${receipt ? '<div class="badge" style="border-color:#0F7B4A;color:#0F7B4A">Paid in full</div>' : ""}
    <h1>${receipt ? "RECEIPT" : "INVOICE"}</h1>
    <dl><dt>Number</dt><dd>${esc(invoice.number)}</dd><dt>Issued</dt><dd>${esc(longDay(invoice.issueDate))}</dd>
    ${receipt ? "" : `<dt>Due</dt><dd${stage === "overdue" ? ' class="late"' : ""}>${esc(longDay(stage === "deposit" ? s.dueBy : invoice.dueDate))}</dd>`}</dl></div>
</header>
<section class="to"><h2>Billed to</h2>${billTo}</section>
<table><thead><tr><th>Description</th><th class="n">Qty</th><th class="n">Unit price</th><th class="n">Amount</th></tr></thead><tbody>${rows}</tbody></table>
<div class="bottom">
  <section class="pay"><h2>${receipt ? "Payment" : "How to pay"}</h2>${payBox}${invoice.notes ? `<p>${esc(invoice.notes).replace(/\n/g, "<br>")}</p>` : ""}</section>
  <section class="totals" aria-label="Totals">${totalsBox}</section>
</div>
<footer><span>${esc(card.name)} · ${esc(card.website)}</span><span>Deposits are non-refundable with less than ${CANCEL_NOTICE_HOURS} hours' notice of cancellation.</span></footer>
</div></main></body></html>`;
}

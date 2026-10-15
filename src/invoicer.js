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

import { FONT_DATA_URL, LOGO_PATH, LOGO_TRANSFORM } from "./invoicer-logo.js";
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
  // accent2: the second colour of each theme's blend (the website logo's pink into violet, and kin);
  // mono: no colour at all, black and white (the white logo)
  { id: "night", name: "Night", band: "#100806", accent: "#B82E84", accent2: "#7A27CF", accentDark: "#EF60A9", accent2Dark: "#AC78F0", wash: "#FBF8F7" },
  { id: "violet", name: "Violet", band: "#0F0812", accent: "#7A27CF", accent2: "#B82E84", accentDark: "#AC78F0", accent2Dark: "#EF60A9", wash: "#F9F7FC" },
  { id: "plum", name: "Plum", band: "#140A12", accent: "#9F2A90", accent2: "#5A39CF", accentDark: "#DB66CA", accent2Dark: "#9A8BF8", wash: "#FBF7FA" },
  { id: "ink", name: "Ink", band: "#0B0B10", accent: "#4940CC", accent2: "#2394C6", accentDark: "#8C84F8", accent2Dark: "#5DCAF2", wash: "#F7F7FA" },
  { id: "ember", name: "Ember", band: "#140806", accent: "#C4375C", accent2: "#E07A20", accentDark: "#F27290", accent2Dark: "#F8A95A", wash: "#FCF7F6" },
  { id: "rose", name: "Rose", band: "#12080B", accent: "#D03B76", accent2: "#EF6D9C", accentDark: "#F67CAE", accent2Dark: "#FBA9C4", wash: "#FCF6F8" },
  { id: "dusk", name: "Dusk", band: "#0D0A14", accent: "#6A3FD8", accent2: "#D03B76", accentDark: "#A08AF6", accent2Dark: "#F67CAE", wash: "#F8F7FC" },
  { id: "paper", name: "Paper", band: "#F4F1EF", accent: "#A52B88", accent2: "#6A36D0", accentDark: "#DE69C4", accent2Dark: "#A38CF8", wash: "#FAF8F7", light: true },
  { id: "mono", name: "Black & white", band: "#111111", accent: "#1C1618", accent2: "#1C1618", accentDark: "#EDE8E8", accent2Dark: "#EDE8E8", wash: "#F6F5F5", mono: true },
];
export const INVOICE_MODES = ["bright", "dark"];
export const themeOf = (id) => INVOICE_THEMES.find((t) => t.id === id) || INVOICE_THEMES[0];

// The band's sky: Novacane's night (the website, Nova Agent's sigil) drawn as shapes, faint enough to
// read over. The same stars on every invoice (a fixed seed), in an 820×100 box the band covers.
const STARS = (() => {
  let seed = 20261015;
  const rnd = () => ((seed = (seed * 1664525 + 1013904223) >>> 0) / 4294967296);
  const out = [];
  for (let i = 0; i < 58; i++) {
    const x = rnd() * 820, y = rnd() * 100, big = rnd();
    // (fewer behind the logo and the name on the left, so they stay clean)
    if (x < 300 && y > 18 && y < 82 && rnd() < 0.75) continue;
    out.push([Math.round(x * 10) / 10, Math.round(y * 10) / 10, big > 0.93 ? 1.3 : big > 0.7 ? 0.85 : 0.55, Math.round((0.25 + rnd() * 0.5) * 100) / 100]);
  }
  return out;
})();
// A colour at full saturation and a chosen lightness (the logo's and the sky's vivid colours)
export function vivid(hex, lightness, saturation = 0.72) {
  const [r, g, b] = [0, 2, 4].map((i) => parseInt(hex.slice(1 + i, 3 + i), 16) / 255);
  const max = Math.max(r, g, b), min = Math.min(r, g, b), d = max - min;
  let h = 0;
  if (d) h = max === r ? ((g - b) / d) % 6 : max === g ? (b - r) / d + 2 : (r - g) / d + 4;
  h = (h * 60 + 360) % 360;
  const l = lightness, c = (1 - Math.abs(2 * l - 1)) * saturation, x = c * (1 - Math.abs(((h / 60) % 2) - 1)), m = l - c / 2;
  const [r2, g2, b2] = h < 60 ? [c, x, 0] : h < 120 ? [x, c, 0] : h < 180 ? [0, c, x] : h < 240 ? [0, x, c] : h < 300 ? [x, 0, c] : [c, 0, x];
  return "#" + [r2, g2, b2].map((v) => Math.round((v + m) * 255).toString(16).padStart(2, "0")).join("").toUpperCase();
}

// A four-pointed sparkle (Nova's), at x, y, size r
const sparkle = (x, y, r, fill, o) => `<path d="M${x} ${y - r}L${x + r * 0.22} ${y - r * 0.22}L${x + r} ${y}L${x + r * 0.22} ${y + r * 0.22}L${x} ${y + r}L${x - r * 0.22} ${y + r * 0.22}L${x - r} ${y}L${x - r * 0.22} ${y - r * 0.22}Z" fill="${fill}" opacity="${o}"/>`;
function bandSky(t, lightBand, from, to) {
  const star = lightBand ? "#5B3F6E" : "#FFFFFF";
  const k = lightBand ? 0.5 : 1; // (on a light band, everything quieter)
  const nebula = t.mono
    ? ""
    : `<radialGradient id="nv-neb1" cx="88%" cy="20%" r="55%"><stop offset="0" stop-color="${to}" stop-opacity="${0.46 * k}"/><stop offset="1" stop-color="${to}" stop-opacity="0"/></radialGradient>
<radialGradient id="nv-neb2" cx="22%" cy="110%" r="50%"><stop offset="0" stop-color="${from}" stop-opacity="${0.38 * k}"/><stop offset="1" stop-color="${from}" stop-opacity="0"/></radialGradient>
<radialGradient id="nv-neb3" cx="62%" cy="70%" r="30%"><stop offset="0" stop-color="${from}" stop-opacity="${0.14 * k}"/><stop offset="1" stop-color="${from}" stop-opacity="0"/></radialGradient>`;
  const fills = t.mono ? "" : `<rect width="820" height="100" fill="url(#nv-neb1)"/><rect width="820" height="100" fill="url(#nv-neb2)"/><rect width="820" height="100" fill="url(#nv-neb3)"/>`;
  const orbit = `<ellipse cx="700" cy="96" rx="190" ry="62" fill="none" stroke="${t.mono ? star : to}" stroke-opacity="${(t.mono ? 0.16 : 0.32) * k}" stroke-width=".8" stroke-dasharray="1.2 4.2" transform="rotate(-9 700 96)"/>`;
  const stars = STARS.map(([x, y, r, o]) => `<circle cx="${x}" cy="${y}" r="${r}" fill="${star}" opacity="${Math.round(o * k * 100) / 100}"/>`).join("");
  const glints = sparkle(612, 24, 4.2, star, 0.55 * k) + sparkle(778, 70, 2.8, star, 0.4 * k) + (t.mono ? "" : `<circle cx="${700 + 190 * Math.cos(-0.55)}" cy="${96 + 62 * Math.sin(-0.55)}" r="2.2" fill="${to}" opacity="${0.8 * k}"/>`);
  return `<svg class="sky" viewBox="0 0 820 100" preserveAspectRatio="xMidYMid slice" aria-hidden="true">${nebula ? `<defs>${nebula}</defs>` : ""}${fills}${orbit}${stars}${glints}</svg>`;
}

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
  const accent2 = dark ? t.accent2Dark : t.accent2;
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
  // The website's logo, drawn as a shape (sharp at any size, and in print) in the theme's two colours,
  // lighter on a dark band; black and white: plain, the band's own ink
  // (vivid: the theme's two colours at full saturation, bright on a dark band, deeper on a light one)
  const [from, to] = t.mono ? [t.accentDark, t.accent2Dark] : [vivid(t.accent, lightBand ? 0.46 : 0.64), vivid(t.accent2, lightBand ? 0.46 : 0.66)];
  // The logo in Novacane's sky: a soft glow of the theme's colours behind it (a nebula, no disc or
  // border: it's a logo, not a button) and a faint dotted orbit with a small planet crossing behind it
  const emblemInk = lightBand ? "#2A1F2E" : "#FFFFFF";
  const bandColour = dark && t.light ? "#0C0908" : t.band; // (the same as the page's band below)
  const logo = `<svg class="mark" viewBox="0 0 200 200" role="img" aria-label="Novacane Studios logo"><defs>
${t.mono ? "" : `<linearGradient id="nv-mark" x1="0" y1="0" x2="1" y2="1"><stop offset="0" stop-color="${from}"/><stop offset="1" stop-color="${to}"/></linearGradient>`}
<radialGradient id="nv-glow" cx="50%" cy="50%" r="50%"><stop offset=".2" stop-color="${t.mono ? emblemInk : to}" stop-opacity="${t.mono ? 0.08 : lightBand ? 0.18 : 0.32}"/><stop offset="1" stop-color="${t.mono ? emblemInk : to}" stop-opacity="0"/></radialGradient></defs>
<circle cx="100" cy="100" r="99" fill="url(#nv-glow)"/>
<ellipse cx="100" cy="100" rx="97" ry="30" fill="none" stroke="${t.mono ? emblemInk : from}" stroke-opacity="${lightBand ? 0.4 : 0.55}" stroke-width="1.3" stroke-dasharray="1.8 4" transform="rotate(-24 100 100)"/>
<circle cx="${(100 + 97 * Math.cos(Math.PI * 0.86) * Math.cos(-24 * Math.PI / 180) - 30 * Math.sin(Math.PI * 0.86) * Math.sin(-24 * Math.PI / 180)).toFixed(1)}" cy="${(100 + 97 * Math.cos(Math.PI * 0.86) * Math.sin(-24 * Math.PI / 180) + 30 * Math.sin(Math.PI * 0.86) * Math.cos(-24 * Math.PI / 180)).toFixed(1)}" r="3.4" fill="${t.mono ? emblemInk : to}" opacity="${lightBand ? 0.6 : 0.85}"/>
<g transform="translate(100 100) scale(0.074) translate(-1000 -1000)"><path transform="${LOGO_TRANSFORM}" fill="${t.mono ? "currentColor" : "url(#nv-mark)"}" d="${LOGO_PATH}"/></g></svg>`;
  // A breath of each theme's colour on the page (none for black and white)
  // Textures: paper made of moon dust and stardust, barely there. Each part its own mix, in the
  // theme's colours (light on a dark page): soft cloudy mottling (moon dust), a fine grain (the paper's
  // fibre) and stardust scattered at random (sizes and brightness all different, no pattern), with a
  // rare tiny glint. Big tiles, so nothing is seen to repeat. Drawn (SVG), so it prints.
  const hex = (c) => c.replace("#", "");
  const rgb = (c) => [0, 2, 4].map((i) => parseInt(hex(c).slice(i, i + 2), 16) / 255);
  const tile = (svg) => `url("data:image/svg+xml,${encodeURIComponent(svg)}")`;
  const tone = dark ? "#FFFFFF" : t.mono ? "#000000" : accent2;
  const dustTone = dark ? "#FFFFFF" : t.mono ? "#000000" : accent;
  const noise = (id, freq, octaves, c, a, seed) => {
    const [r, g, b] = rgb(c);
    return `<filter id="${id}" x="0" y="0" width="100%" height="100%"><feTurbulence type="fractalNoise" baseFrequency="${freq}" numOctaves="${octaves}" seed="${seed}" stitchTiles="stitch"/><feColorMatrix values="0 0 0 0 ${r.toFixed(3)} 0 0 0 0 ${g.toFixed(3)} 0 0 0 0 ${b.toFixed(3)} ${a} 0 0 0 ${(-a * 0.35).toFixed(3)}"/></filter>`;
  };
  const stardust = ({ size, seed, cloud, grain, specks, glints = 0 }) => {
    let x = seed >>> 0;
    const rnd = () => ((x = (x * 1664525 + 1013904223) >>> 0) / 4294967296);
    const k = dark ? 0.75 : 1;
    let dots = "";
    for (let i = 0; i < specks; i++) {
      const r = rnd() < 0.85 ? 0.3 + rnd() * 0.35 : 0.7 + rnd() * 0.5;
      dots += `<circle cx="${(rnd() * size).toFixed(1)}" cy="${(rnd() * size).toFixed(1)}" r="${r.toFixed(2)}" fill-opacity="${((0.08 + rnd() * 0.22) * k).toFixed(2)}"/>`;
    }
    for (let i = 0; i < glints; i++) {
      const gx = rnd() * size, gy = rnd() * size, gr = 1.4 + rnd() * 0.8;
      dots += `<path d="M${gx.toFixed(1)} ${(gy - gr).toFixed(1)}l${(gr * 0.2).toFixed(2)} ${(gr * 0.8).toFixed(2)} ${(gr * 0.8).toFixed(2)} ${(gr * 0.2).toFixed(2)} ${(-gr * 0.8).toFixed(2)} ${(gr * 0.2).toFixed(2)} ${(-gr * 0.2).toFixed(2)} ${(gr * 0.8).toFixed(2)} ${(-gr * 0.2).toFixed(2)} ${(-gr * 0.8).toFixed(2)} ${(-gr * 0.8).toFixed(2)} ${(-gr * 0.2).toFixed(2)} ${(gr * 0.8).toFixed(2)} ${(-gr * 0.2).toFixed(2)}z" fill-opacity="${(0.22 * k).toFixed(2)}"/>`;
    }
    return tile(`<svg xmlns="http://www.w3.org/2000/svg" width="${size}" height="${size}">${cloud ? noise("c", 0.009, 3, tone, cloud * k, seed % 97) : ""}${grain ? noise("g", 0.95, 2, dark ? "#FFFFFF" : "#000000", grain * k, seed % 89) : ""}${cloud ? `<rect width="${size}" height="${size}" filter="url(#c)"/>` : ""}${grain ? `<rect width="${size}" height="${size}" filter="url(#g)"/>` : ""}<g fill="${dustTone}">${dots}</g></svg>`);
  };
  const tex = {
    page: stardust({ size: 460, seed: 11, cloud: 0.09, grain: 0.035, specks: 46, glints: 1 }),
    // (behind the invoice: a deeper grain and more stardust, the surface it lies on)
    backdrop: stardust({ size: 520, seed: 67, cloud: t.mono ? 0.07 : 0.14, grain: 0.05, specks: 70, glints: 2 }),
    amount: stardust({ size: 300, seed: 23, cloud: 0.12, grain: 0.03, specks: 22, glints: 1 }),
    notes: stardust({ size: 320, seed: 37, cloud: 0.1, grain: 0.03, specks: 16 }),
    sums: stardust({ size: 300, seed: 41, cloud: 0, grain: 0.03, specks: 10 }),
    footer: stardust({ size: 380, seed: 53, cloud: 0.05, grain: 0, specks: 34, glints: 1 }),
  };
  const tint = (pct) => (t.mono ? "var(--wash)" : `color-mix(in srgb, var(--accent) ${pct}%, var(--paper))`);
  // The page's colours: Bright (white paper, dark ink) or Dark (the website's near-black, light ink)
  const page = dark
    ? { band: t.light ? "#0C0908" : t.band, paper: "#17110F", wash: "#211A18", ink: "#F1EBEA", soft: "#A99FA0", hair: "#352C2B", outside: "#0A0708", rule: "#F1EBEA" }
    : { band: t.band, paper: "#FFFFFF", wash: t.wash, ink: "#1C1618", soft: "#6B6266", hair: "#E7E2E2", outside: t.mono ? "#E6E6E6" : "#E9E4E7", rule: "#1C1618" };

  return `<!doctype html>
<html lang="en-GB"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1"><meta name="robots" content="noindex">
<title>${esc(title)} · ${esc(card.name)}</title>
<style>
@font-face{font-family:"Jost";src:url(${FONT_DATA_URL}) format("woff2");font-weight:400 600;font-display:block}
:root{--band:${page.band};--accent:${accent};--accent2:${accent2};--blend:linear-gradient(90deg,var(--accent),var(--accent2));--tint:${tint(dark ? 15 : 8)};--tint2:${tint(dark ? 10 : 5)};--paper:${page.paper};--wash:${page.wash};--ink:${page.ink};--soft:${page.soft};--hair:${page.hair};--rule:${page.rule};--red:${red};--green:${green};--line:${lineColour};--band-ink:${lightBand ? "#1C1618" : "#FFFFFF"};color-scheme:${dark ? "dark" : "light"}}
*{box-sizing:border-box}
/* Behind the invoice: a soft surface under Novacane's sky (screen only: printed, it's just the paper):
   faint nebulae of the theme's colours in two corners, the edges a shade darker, grain and stardust */
html{min-height:100%;background:${tex.backdrop},${t.mono ? "" : `radial-gradient(70% 55% at 0% 0%,color-mix(in srgb,${accent2} ${dark ? 22 : 16}%,transparent),transparent 70%),radial-gradient(65% 50% at 100% 100%,color-mix(in srgb,${accent} ${dark ? 20 : 14}%,transparent),transparent 70%),`}radial-gradient(120% 90% at 50% 40%,transparent 55%,${dark ? "rgb(0 0 0 / .45)" : "rgb(60 40 70 / .10)"}),${page.outside};background-attachment:fixed}
body{margin:0;padding:28px 12px;font:15px/1.55 "Jost",Futura,"Century Gothic","Avenir Next",system-ui,sans-serif;color:var(--ink);letter-spacing:.01em;-webkit-print-color-adjust:exact;print-color-adjust:exact}
.sheet{max-width:820px;margin:0 auto;background:${tex.page},var(--paper);box-shadow:0 0 0 1px ${dark ? "rgb(255 255 255 / .05)" : "rgb(40 20 50 / .06)"},0 2px 4px rgb(0 0 0 / ${dark ? ".35" : ".06"}),0 18px 50px ${dark ? "rgb(0 0 0 / .55)" : "rgb(60 30 80 / .16)"}}
.band{position:relative;overflow:hidden;display:flex;align-items:center;justify-content:space-between;gap:20px;padding:22px 40px;color:var(--band-ink);background:var(--band)}
.band .sky{position:absolute;inset:0;width:100%;height:100%;display:block}
.band>:not(.sky){position:relative}
.band::after{content:"";position:absolute;left:0;right:0;bottom:0;height:3px;background:var(--blend)}
.brand{display:flex;align-items:center;gap:16px}
.brand .mark{width:86px;height:86px;display:block;flex:none;margin:-18px -2px -18px -16px;overflow:visible}
.brand b{display:block;font-weight:500;font-size:21px;letter-spacing:.32em}
.brand small{display:block;margin-top:3px;font-size:10.5px;letter-spacing:.42em;${t.mono ? "opacity:.75" : lightBand ? "color:var(--accent)" : "color:color-mix(in srgb,var(--accent) 45%,#fff)"}}
.doc{font-weight:400;font-size:13px;letter-spacing:.42em;text-transform:uppercase;opacity:.9}
.in{padding:30px 40px 34px}
.stage{display:flex;align-items:center;gap:10px;margin:0 0 26px;font-size:13.5px;color:var(--line)}
.stage::before{content:"";width:8px;height:8px;border-radius:50%;background:var(--line);flex:none}
.top{display:grid;grid-template-columns:1.1fr 1fr auto;gap:28px;align-items:start}
.k,.top h2,.notes h2,.pay h2{display:block;margin:0 0 6px;font-size:10.5px;font-weight:500;letter-spacing:.24em;text-transform:uppercase;color:${t.mono ? "var(--soft)" : "var(--accent)"}}
.to{font-size:14px;line-height:1.6}.to b{font-weight:600}
dl{margin:0;display:grid;grid-template-columns:auto 1fr;gap:3px 14px;font-size:13.5px}
dt{color:var(--soft)}dd{margin:0;font-variant-numeric:tabular-nums}
.late{color:var(--red);font-weight:500}
.amount{position:relative;min-width:200px;padding:16px 18px;background:${tex.amount},var(--tint);border-left:3px solid var(--accent);border-image:linear-gradient(180deg,var(--accent),var(--accent2)) 1;text-align:right}
.amount .lbl{display:block;font-size:10.5px;letter-spacing:.24em;text-transform:uppercase;color:var(--soft)}
.amount b{display:block;margin:4px 0 2px;font-size:28px;font-weight:500;letter-spacing:.01em;font-variant-numeric:tabular-nums;color:var(--accent)}
.amount .when{font-size:13px;color:var(--soft)}
.amount.late{border-image:none;border-left-color:var(--red)}.amount.late .when,.amount.late b{color:var(--red);font-weight:500}
.amount.done{border-image:none;border-left-color:var(--green);padding-top:24px}.amount.done .when,.amount.done b{color:var(--green);font-weight:500}
.stamp{position:absolute;right:12px;top:-13px;transform:rotate(-6deg);padding:1px 10px;background:var(--paper);border:2px solid var(--green);border-radius:6px;color:var(--green);font-size:14px;font-weight:600;letter-spacing:.3em;text-transform:uppercase;opacity:.75}
table{width:100%;margin-top:30px;border-collapse:collapse;font-size:14px}
th{padding:0 0 9px;text-align:left;font-size:10.5px;font-weight:500;letter-spacing:.24em;text-transform:uppercase;color:${t.mono ? "var(--soft)" : "var(--accent)"};border-bottom:2px solid var(--rule);border-image:${t.mono ? "none" : "var(--blend) 1"}}
td{padding:12px 0;border-bottom:1px solid var(--hair);vertical-align:top}
th.n,td.n{text-align:right;white-space:nowrap;padding-left:18px;font-variant-numeric:tabular-nums}
tr{break-inside:avoid}
.sums{margin:12px 0 0 auto;max-width:340px;padding:0 10px;border-radius:4px;background:${tex.sums};break-inside:avoid}
.r{display:flex;justify-content:space-between;gap:18px;padding:6px 0;font-size:14px}
.r b{font-weight:500;font-variant-numeric:tabular-nums;white-space:nowrap}
.r.soft{color:var(--soft)}.r small{font-size:12px}
.r.strong{border-top:1px solid var(--hair);margin-top:4px;padding-top:10px}
.r.due{margin-top:6px;padding:10px 0 4px;border-top:2px solid var(--rule);border-image:${t.mono ? "none" : "var(--blend) 1"};font-size:16px;font-weight:600}.r.due b{font-weight:600;color:var(--accent)}
.bottom{display:grid;grid-template-columns:1.2fr 1fr;gap:28px;align-items:start;margin-top:30px;break-inside:avoid}
.notes{padding:14px 16px;background:${tex.notes},var(--tint2);border-left:3px solid var(--accent2);border-radius:4px;font-size:13.5px;line-height:1.6;white-space:pre-line}
.pay{font-size:13.5px;line-height:1.6}.pay p{margin:0 0 10px}
.pay a{color:var(--accent);text-decoration:none;border-bottom:1px solid currentColor}
footer{background:${tex.footer};display:flex;flex-wrap:wrap;justify-content:space-between;gap:6px 18px;margin-top:30px;padding-top:14px;border-top:1px solid var(--hair);font-size:11.5px;color:var(--soft);letter-spacing:.02em}
footer .thanks{width:100%;font-size:12.5px;color:var(--accent)}
@media (max-width:640px){
  body{padding:0}.band{padding:18px 20px}.brand b{font-size:15px;letter-spacing:.24em}.brand .mark{width:58px;height:58px;margin:-10px -4px -10px -8px}.doc{display:none}.in{padding:22px 20px}
  .top{grid-template-columns:1fr}.amount{text-align:left}.bottom{grid-template-columns:1fr}
  th:nth-child(2),td:nth-child(2),th:nth-child(3),td:nth-child(3){display:none}
}
@page{size:A4;margin:12mm}
@media print{html{background:${dark ? "var(--paper)" : "none"}}body{padding:0;font-size:13.5px}.sheet{box-shadow:none;max-width:none}.in{padding:26px 34px 10px}.band{padding:18px 34px}}
</style></head>
<body><main class="sheet">
<header class="band">${bandSky(t, lightBand, from, to)}<div class="brand">${logo}<div><b>NOVACANE</b><small>STUDIOS</small></div></div><div class="doc">${receipt ? "Receipt" : "Invoice"}</div></header>
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

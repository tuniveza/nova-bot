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

import { LOGO_PATH, LOGO_TRANSFORM, SAIRA_DATA_URL } from "./invoicer-logo.js";
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

// Monzo (17 October 2026): the studio's Monzo link (Money's settings: a monzo.me name, or a Monzo
// payment link) -> the address a client taps to pay. A monzo.me name gets the amount due now and the
// invoice number as the reference (monzo.me/<name>/<pounds>?d=<number>), so it opens in Monzo ready
// to send; any other Monzo link opens as it is. "" when there's no link.
export function monzoLink(monzo, pence, reference) {
  const link = String(monzo?.link || "").trim();
  if (!link) return "";
  const me = link.match(/^(?:https?:\/\/)?(?:www\.)?monzo\.me\/([A-Za-z0-9._-]+)\/?$/i);
  if (!me) return /^https:\/\//i.test(link) ? link : `https://${link}`;
  const amount = pence > 0 ? `/${(pence / 100).toFixed(2)}` : "";
  return `https://monzo.me/${me[1]}${amount}${reference ? `?d=${encodeURIComponent(reference)}` : ""}`;
}
// Monzo's M (its own mark, one colour: Simple Icons, CC0): small and repeated, a quiet pattern behind
// the words of the Pay with Monzo button
const MONZO_MARK = "M4.244 1.174a.443.443 0 00-.271.13l-3.97 3.97-.001.001c3.884 3.882 8.093 8.092 11.748 11.748v-8.57L4.602 1.305a.443.443 0 00-.358-.131zm15.483 0a.443.443 0 00-.329.13L12.25 8.456v8.568L24 5.275c-1.316-1.322-2.647-2.648-3.97-3.97a.443.443 0 00-.301-.131zM0 5.979l.002 10.955c0 .294.118.577.326.785l4.973 4.976c.28.282.76.083.758-.314V12.037zm23.998.003l-6.06 6.061v10.338c-.004.399.48.6.76.314l4.974-4.976c.208-.208.326-.49.326-.785z";
export const monzoReady = (monzo) => Boolean(String(monzo?.link || "").trim());
// The link as it reads on paper: "monzo.me/novacane"
export const monzoShort = (monzo) => String(monzo?.link || "").trim().replace(/^https?:\/\/(www\.)?/i, "").replace(/\/$/, "");

// How to pay, in plain words (the invoice's own page when it has gone out, then Monzo, then bank transfer)
function howToPay(invoice, settings, pence) {
  const out = [];
  if (invoice.pageUrl) out.push(`See and pay it online: ${invoice.pageUrl}`);
  if (monzoReady(settings?.monzo)) out.push(`Or pay with Monzo: ${monzoLink(settings.monzo, pence, invoice.number)}`);
  if (bankReady(settings?.bank)) out.push(`Or by bank transfer to ${settings.bank.accountName}, sort code ${settings.bank.sortCode}, account ${settings.bank.accountNumber}, with ${invoice.number} as the reference.`);
  return out;
}

// The short email for a stage: { subject, body } (plain text, to copy or to send through Money)
export function stageEmail(invoice, sums, stage, settings) {
  const card = studioCard(settings);
  const hi = `Hi ${firstName(invoice.billTo?.name)},`;
  const pay = howToPay(invoice, settings, sums.dueNowPence);
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
  // A spectrum, red round to the website's pink-magenta (Night): each theme one hue, its accent dark
  // enough to read on white (4.9:1 or more), accent2 a neighbouring hue for its blend, accentDark and
  // accent2Dark the same lighter for a dark page. Then Paper (a light band) and Black & white.
  // mono: no colour at all, black and white (the white logo)
{ id: "ruby", name: "Ruby", band: "#110608", accent: "#B62B3D", accent2: "#BE532D", accentDark: "#EF6C7E", accent2Dark: "#F09675", wash: "#FBF6F7" },
  { id: "amber", name: "Amber", band: "#110B06", accent: "#A55E27", accent2: "#AE3F29", accentDark: "#EFA56C", accent2Dark: "#F08A75", wash: "#FBF8F6" },
  { id: "gold", name: "Gold", band: "#110E06", accent: "#886C20", accent2: "#915622", accentDark: "#EFCC6C", accent2Dark: "#F0AE75", wash: "#FBFAF6" },
  { id: "jade", name: "Jade", band: "#06110B", accent: "#1E804F", accent2: "#208885", accentDark: "#6CEFAD", accent2Dark: "#75F0EC", wash: "#F6FBF9" },
  { id: "teal", name: "Teal", band: "#061011", accent: "#1F7D84", accent2: "#21578C", accentDark: "#6CE6EF", accent2Dark: "#75B2F0", wash: "#F6FBFB" },
  { id: "sapphire", name: "Sapphire", band: "#060911", accent: "#2B54B6", accent2: "#3B2DBE", accentDark: "#6C93EF", accent2Dark: "#8275F0", wash: "#F6F7FB" },
  { id: "violet", name: "Violet", band: "#0C0611", accent: "#752BB6", accent2: "#BE2DB4", accentDark: "#B26CEF", accent2Dark: "#F075E8", wash: "#F9F6FB" },
  { id: "night", name: "Night", band: "#11060D", accent: "#B62B83", accent2: "#842DBE", accentDark: "#EF6CBF", accent2Dark: "#BF75F0", wash: "#FBF6F9" },
  { id: "paper", name: "Paper", band: "#F4F1EF", accent: "#A52B88", accent2: "#6A36D0", accentDark: "#DE69C4", accent2Dark: "#A38CF8", wash: "#FAF8F7", light: true },
  { id: "mono", name: "Black & white", band: "#111111", accent: "#1C1618", accent2: "#1C1618", accentDark: "#EDE8E8", accent2Dark: "#EDE8E8", wash: "#F6F5F5", mono: true },
];
export const INVOICE_MODES = ["bright", "dark"];
// The paper: named after minerals, each a light and a dark sheet with its own tone in the texture.
// Moonstone is the paper as it was (white, or the website's near-black, tinted by the theme). Pearl
// has a soft shimmer, Marble faint veins; the rest their stone's colour: in the sheet itself, its lines and
// boxes, a soft glow of it in two corners and its colour in the texture (subtle, but you can tell them
// apart: made stronger 15 October 2026).
export const INVOICE_PAPERS = [
  { id: "moonstone", name: "Moonstone", light: "#FFFFFF", dark: "#17110F" },
  { id: "pearl", name: "Pearl", light: "#FAF9FA", dark: "#211D22", tone: "#C9B9C9", sheen: true },
  { id: "marble", name: "Marble", light: "#F7F7F7", dark: "#18161A", tone: "#8C8A8E", veins: true },
  { id: "sapphire", name: "Sapphire", light: "#EDF0FA", dark: "#15192F", tone: "#3557C9" },
  { id: "ruby", name: "Ruby", light: "#FAEFF1", dark: "#291219", tone: "#C2334E" },
  { id: "emerald", name: "Emerald", light: "#EBF4F0", dark: "#11201C", tone: "#1E8A5A" },
  { id: "amethyst", name: "Amethyst", light: "#F4EFFA", dark: "#22182F", tone: "#8350C8" },
  { id: "rosequartz", name: "Rose quartz", light: "#FAF1F3", dark: "#261B21", tone: "#D98A9A" },
  { id: "citrine", name: "Citrine", light: "#F9F3E8", dark: "#281F14", tone: "#C9952A" },
  { id: "onyx", name: "Onyx", light: "#EEEEEF", dark: "#161318", tone: "#5A5560" },
];
export const paperOf = (id) => INVOICE_PAPERS.find((x) => x.id === id) || INVOICE_PAPERS[0];
// The themes before the spectrum (15 October 2026), each now the nearest colour in it
const OLD_THEMES = { plum: "violet", ink: "sapphire", ember: "amber", rose: "ruby", dusk: "violet" };
// A theme's id as it is now (an old one moved to its nearest), or null if there's no such theme
export const themeId = (id) => (INVOICE_THEMES.some((t) => t.id === id) ? id : OLD_THEMES[id] || null);
export const themeOf = (id) => INVOICE_THEMES.find((t) => t.id === themeId(id)) || INVOICE_THEMES.find((t) => t.id === "night");

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

// Two colours mixed: a share of a over b ("#rrggbb")
export function mixHex(a, b, share) {
  const p = (c) => [1, 3, 5].map((i) => parseInt(c.slice(i, i + 2), 16));
  const [x, y] = [p(a), p(b)];
  return "#" + x.map((v, i) => Math.round(v * share + y[i] * (1 - share)).toString(16).padStart(2, "0")).join("").toUpperCase();
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
export const STAGE_LINES = {
  deposit: { colour: "accent", text: (s) => `Deposit due to secure your booking: ${s.depositPercent}% now, the rest by the session` },
  balance: { colour: "ink", text: () => "Balance due: the remaining amount for your session" },
  overdue: { colour: "#A3233A", text: (s) => `Past due: this invoice was due on ${longDay(s.dueBy)}` },
  paid: { colour: "#1F7A55", text: () => "Paid in full. Thank you for recording with us" },
};
// Each sentence on a line of its own (16 October 2026): a line breaks after a full stop (or ! or ?),
// never carrying the first words of the next sentence with it. On escaped text: "\n" (the Notes box
// keeps line breaks) or "<br>".
export const sentenceLines = (text, br = "\n") => String(text).replace(/([.!?])[ \t]+(?=["“'‘(£$€0-9A-Z])/g, `$1${br}`);
// The note when the invoice has none of its own
const DEFAULT_NOTE = "Thank you for choosing Novacane Studios. Any questions about this invoice, just get in touch.";

// options: { theme, mode ("bright" or "dark"), note (words for the Notes box instead of the invoice's own),
//   page: the client's own page (/invoice/<token>): { cardForm (the Pay by card button's form), banner
//   (a note above the invoice), cancelled, nonce (for the Print button's script), contact (when there's no
//   way to pay set up yet: how to get in touch) } }
export function invoiceDocument(invoice, payments, stage, settings, today, options = {}) {
  const s = stageSums(invoice, payments, stage, today);
  const card = studioCard(settings);
  // (what's asked for this copy, else the invoice's own look, else the studio's)
  const look = invoice?.look || {};
  const t = themeOf(options.theme || look.theme || settings?.invoiceTheme);
  const dark = (options.mode || look.mode || settings?.invoiceMode) === "dark";
  const paper = paperOf(options.paper || look.paper || settings?.invoicePaper);
  const receipt = stage === "paid";
  const client = options.page || null;
  const cancelled = Boolean(client?.cancelled);
  const line = cancelled ? { colour: "ink", text: () => "This invoice was cancelled: there's nothing to pay" } : STAGE_LINES[stage];
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
  // (on the client's page, a Copy button by each thing to type into a banking app: shown by the page's
  // script only where the browser can copy)
  const copy = (value, what) => (client ? ` <button type="button" class="copy" data-copy="${esc(value)}" aria-label="Copy ${what}" hidden>Copy</button>` : "");
  const bank = bankReady(settings?.bank) && !receipt
    ? `<p id="bank"><span class="k">Bank transfer</span>${esc(settings.bank.accountName)}<br>Sort code ${esc(settings.bank.sortCode)}${copy(settings.bank.sortCode.replace(/\D/g, ""), "sort code")}<br>Account ${esc(settings.bank.accountNumber)}${copy(settings.bank.accountNumber.replace(/\s/g, ""), "account number")}${settings.bank.note ? `<br>${esc(settings.bank.note)}` : ""}</p>`
    : "";
  // Monzo: on the client's page a button (the theme's blend, or its outline under the card button)
  // that opens Monzo with the amount and reference filled in; on paper, the link to type
  const monzoHref = monzoReady(settings?.monzo) && !receipt && !cancelled && s.dueNowPence > 0 ? monzoLink(settings.monzo, s.dueNowPence, invoice.number) : "";
  const monzoButton = client && monzoHref ? `<a class="monzo${client.cardForm ? " second" : ""}" href="${esc(monzoHref)}" rel="noopener"><span class="mzring" aria-hidden="true"></span><span class="mzglass" aria-hidden="true"></span><span class="nvsky" aria-hidden="true"></span>Pay ${pounds(s.dueNowPence)} with Monzo</a>` : "";
  // The pattern: Monzo's M, small, in staggered rows, in a lighter shade of the theme's own colours (on the
  // outline button, a whisper of its accent on the paper)
  // (each tile whole inside the button: "space" lays only whole tiles, spread evenly, none cut at an edge,
  // and each M sits a little in from its tile's edges, clear of the border)
  // (eight M's a tile, each turned its own way, up to 25 degrees, so the pattern looks scattered, not stamped)
  const M_SPOTS = [[8, 7.5, -18], [21, 17.5, 12], [36, 7.5, 24], [49, 17.5, -8], [8, 31.5, 6], [21, 41.5, -24], [36, 31.5, 16], [49, 41.5, -12]];
  // (and each its own shade: along the theme's two colours, at different lightnesses, so they're told
  // apart yet stay quiet; light on the button, deeper on the outline button's paper)
  const mShades = (light) => [[0, 0.1], [0.66, 0.2], [1, 0.12], [0.33, 0.26], [0, 0.24], [1, 0.02], [0.5, 0.16], [0.85, 0.3]].map(([towards2, lift]) => vivid(mixHex(accent2, accent, towards2), light ? 0.66 + lift : 0.5 - lift));
  // Novacane's night sky over it all (the band's): a scatter of small stars and two of Nova's sparkles, in
  // white and the sky's own colours, laid over the button's height; drawn when the styles are (from, to)
  const nvSky = () => {
    let x = 20261018;
    const rnd = () => ((x = (x * 1664525 + 1013904223) >>> 0) / 4294967296);
    let stars = "";
    for (let i = 0; i < 16; i++) stars += `<circle cx="${(4 + rnd() * 152).toFixed(1)}" cy="${(4 + rnd() * 48).toFixed(1)}" r="${(0.35 + rnd() * 0.6).toFixed(2)}" fill="#FFFFFF" fill-opacity="${(0.35 + rnd() * 0.5).toFixed(2)}"/>`;
    return tile(`<svg xmlns="http://www.w3.org/2000/svg" width="160" height="56">${stars}${sparkle(34, 15, 3.4, "#FFFFFF", 0.75)}${sparkle(118, 40, 2.6, to, 0.9)}${sparkle(82, 9, 1.8, from, 0.8)}</svg>`);
  };
  const mTile = (shades, opacity) => tile(`<svg xmlns="http://www.w3.org/2000/svg" width="56" height="48"><g fill-opacity="${opacity}">${M_SPOTS.map(([x, y, turn], i) => `<path fill="${shades[i]}" transform="translate(${x} ${y}) rotate(${turn}) scale(.4) translate(-12 -12)" d="${MONZO_MARK}"/>`).join("")}</g></svg>`);
  const monzo = monzoHref ? `<p class="monzo-line"><span class="k">Monzo</span><a href="${esc(monzoHref)}">${esc(monzoShort(settings.monzo))}</a>${monzoHref.includes("monzo.me/") ? `<br><small>Opens Monzo with ${pounds(s.dueNowPence)} and the reference filled in</small>` : ""}</p>` : "";
  // (on the client's own page: its card button instead of a link to itself)
  const buttons = client && !receipt && !cancelled && (client.cardForm || monzoButton) ? `<div class="paynow">${client.cardForm || ""}${monzoButton}</div>` : "";
  const online = client ? buttons : invoice.pageUrl && !receipt ? `<p><span class="k">Pay online</span><a href="${esc(invoice.pageUrl)}">${esc(invoice.pageUrl.replace(/^https?:\/\//, ""))}</a></p>` : "";
  const ref = receipt ? "" : `<p><span class="k">Reference</span>${esc(invoice.number)}${copy(invoice.number, "reference")}</p>`;
  // Pay now (18 October 2026), on the client's page: the same buttons straight under the amount, so
  // paying is one tap without scrolling (a phone shows the amount first), with a line saying what the
  // Monzo button does and where the bank details are
  const monzoHelp = monzoButton
    ? `${monzoHref.includes("monzo.me/") ? `Opens Monzo with ${pounds(s.dueNowPence)} and ${esc(invoice.number)} filled in.` : "Opens Monzo to pay."}${bank ? '<br>No Monzo? <a href="#bank">Pay by bank transfer</a>.' : ""}`
    : "";
  const quickpay = buttons
    ? `<section class="quickpay" aria-label="Pay now"><div class="paynow">${client.cardForm || ""}${monzoButton.replace("<a ", '<a aria-describedby="quickpay-help" ')}</div>${monzoHelp ? `<p id="quickpay-help">${monzoHelp}</p>` : ""}</section>`
    : "";
  const pay = receipt ? `<p>Received with thanks${s.payments.length ? `, last payment ${esc(longDay(s.payments[s.payments.length - 1].paidOn))}` : ""}.<br>Nothing more to pay.</p>` : cancelled ? "<p>Nothing to pay.</p>" : bank || online || monzo ? `${online}${monzo}${bank}${ref}` : client ? `<p>To pay, get in touch: ${esc(card.email)} or ${esc(card.phone)}.</p>${ref}` : `<p>Payment details are in your email.</p>${ref}`;

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
  // The logo in Novacane's sky: just a soft glow of the theme's colours behind it (a nebula; no disc,
  // border or orbit over it: it's a logo, not a button)
  const emblemInk = lightBand ? "#2A1F2E" : "#FFFFFF";
  const bandColour = dark && t.light ? "#0C0908" : t.band; // (the same as the page's band below)
  const logo = `<svg class="mark" viewBox="0 0 200 200" role="img" aria-label="Novacane Studios logo"><defs>
${t.mono ? "" : `<linearGradient id="nv-mark" x1="0" y1="0" x2="1" y2="1"><stop offset="0" stop-color="${from}"/><stop offset="1" stop-color="${to}"/></linearGradient>`}
<radialGradient id="nv-glow" cx="50%" cy="50%" r="50%"><stop offset=".2" stop-color="${t.mono ? emblemInk : to}" stop-opacity="${t.mono ? 0.08 : lightBand ? 0.18 : 0.32}"/><stop offset="1" stop-color="${t.mono ? emblemInk : to}" stop-opacity="0"/></radialGradient></defs>
<circle cx="100" cy="100" r="99" fill="url(#nv-glow)"/>
<g transform="translate(100 100) scale(0.074) translate(-1000 -1000)"><path transform="${LOGO_TRANSFORM}" fill="${t.mono ? "currentColor" : "url(#nv-mark)"}" d="${LOGO_PATH}"/></g></svg>`;
  // A breath of each theme's colour on the page (none for black and white)
  // Textures: paper made of moon dust and stardust, barely there. Each part its own mix, in the
  // theme's colours (light on a dark page): soft cloudy mottling (moon dust), a fine grain (the paper's
  // fibre) and stardust scattered at random (sizes and brightness all different, no pattern), with a
  // rare tiny glint. Big tiles, so nothing is seen to repeat. Drawn (SVG), so it prints.
  const hex = (c) => c.replace("#", "");
  const rgb = (c) => [0, 2, 4].map((i) => parseInt(hex(c).slice(i, i + 2), 16) / 255);
  const tile = (svg) => `url("data:image/svg+xml,${encodeURIComponent(svg)}")`;
  const tone = paper.tone ? (dark ? mixHex(paper.tone, "#FFFFFF", 0.55) : paper.tone) : dark ? "#FFFFFF" : t.mono ? "#000000" : accent2;
  const dustTone = dark ? "#FFFFFF" : t.mono ? "#000000" : accent;
  const noise = (id, freq, octaves, c, a, seed) => {
    const [r, g, b] = rgb(c);
    return `<filter id="${id}" x="0" y="0" width="100%" height="100%"><feTurbulence type="fractalNoise" baseFrequency="${freq}" numOctaves="${octaves}" seed="${seed}" stitchTiles="stitch"/><feColorMatrix values="0 0 0 0 ${r.toFixed(3)} 0 0 0 0 ${g.toFixed(3)} 0 0 0 0 ${b.toFixed(3)} ${a} 0 0 0 ${(-a * 0.35).toFixed(3)}"/></filter>`;
  };
  const stardust = ({ size, seed, cloud, grain, specks, glints = 0, cloudTone = tone, speckTone = dustTone, grainTone = dark ? "#FFFFFF" : "#000000", strength = dark ? 0.75 : 1 }) => {
    let x = seed >>> 0;
    const rnd = () => ((x = (x * 1664525 + 1013904223) >>> 0) / 4294967296);
    const k = strength;
    let dots = "";
    for (let i = 0; i < specks; i++) {
      const r = rnd() < 0.85 ? 0.3 + rnd() * 0.35 : 0.7 + rnd() * 0.5;
      dots += `<circle cx="${(rnd() * size).toFixed(1)}" cy="${(rnd() * size).toFixed(1)}" r="${r.toFixed(2)}" fill-opacity="${((0.08 + rnd() * 0.22) * k).toFixed(2)}"/>`;
    }
    for (let i = 0; i < glints; i++) {
      const gx = rnd() * size, gy = rnd() * size, gr = 1.4 + rnd() * 0.8;
      dots += `<path d="M${gx.toFixed(1)} ${(gy - gr).toFixed(1)}l${(gr * 0.2).toFixed(2)} ${(gr * 0.8).toFixed(2)} ${(gr * 0.8).toFixed(2)} ${(gr * 0.2).toFixed(2)} ${(-gr * 0.8).toFixed(2)} ${(gr * 0.2).toFixed(2)} ${(-gr * 0.2).toFixed(2)} ${(gr * 0.8).toFixed(2)} ${(-gr * 0.2).toFixed(2)} ${(-gr * 0.8).toFixed(2)} ${(-gr * 0.8).toFixed(2)} ${(-gr * 0.2).toFixed(2)} ${(gr * 0.8).toFixed(2)} ${(-gr * 0.2).toFixed(2)}z" fill-opacity="${(0.22 * k).toFixed(2)}"/>`;
    }
    return tile(`<svg xmlns="http://www.w3.org/2000/svg" width="${size}" height="${size}">${cloud ? noise("c", 0.009, 3, cloudTone, cloud * k, seed % 97) : ""}${grain ? noise("g", 0.95, 2, grainTone, grain * k, seed % 89) : ""}${cloud ? `<rect width="${size}" height="${size}" filter="url(#c)"/>` : ""}${grain ? `<rect width="${size}" height="${size}" filter="url(#g)"/>` : ""}<g fill="${speckTone}">${dots}</g></svg>`);
  };
  const tex = {
    // (made a little easier to see, 16 October 2026: still subtle, but there on any screen)
    page: stardust({ size: 460, seed: 11, cloud: paper.tone ? 0.27 : 0.15, grain: 0.06, specks: 72, glints: 2 }),
    // (the band: wisps of the theme's colour, a fine velvet grain and faint star dust, under its sky;
    // on the light Paper band, quieter and dark)
    band: stardust({ size: 400, seed: 79, cloud: t.mono ? 0.06 : lightBand ? 0.1 : 0.2, grain: lightBand ? 0.04 : 0.07, specks: 52, glints: 1, cloudTone: t.mono ? (lightBand ? "#000000" : "#FFFFFF") : vivid(t.accent2, lightBand ? 0.5 : 0.62), speckTone: lightBand ? "#3A2A44" : "#FFFFFF", grainTone: lightBand ? "#000000" : "#FFFFFF", strength: lightBand ? 0.6 : 1 }),
    // (behind the invoice: a deeper grain and more stardust, the surface it lies on)
    backdrop: stardust({ size: 520, seed: 67, cloud: t.mono ? 0.07 : 0.14, grain: 0.05, specks: 70, glints: 2 }),
    amount: stardust({ size: 300, seed: 23, cloud: 0.16, grain: 0.05, specks: 30, glints: 1 }),
    notes: stardust({ size: 320, seed: 37, cloud: 0.14, grain: 0.05, specks: 24 }),
    sums: stardust({ size: 300, seed: 41, cloud: 0, grain: 0.045, specks: 14 }),
    footer: stardust({ size: 380, seed: 53, cloud: 0.07, grain: 0.02, specks: 40, glints: 1 }),
  };
  // The moving sky behind the invoice (screen only): two layers of stars that drift past very slowly
  // and twinkle, in the theme's colours on a dark page or soft and dark on a light one
  const skyStars = (size, n, seed, fill, big) => {
    let x = seed >>> 0;
    const rnd = () => ((x = (x * 1664525 + 1013904223) >>> 0) / 4294967296);
    let dots = "";
    for (let i = 0; i < n; i++) dots += `<circle cx="${(rnd() * size).toFixed(1)}" cy="${(rnd() * size).toFixed(1)}" r="${(big ? 0.8 + rnd() * 0.9 : 0.4 + rnd() * 0.5).toFixed(2)}" fill-opacity="${(0.25 + rnd() * 0.55).toFixed(2)}"/>`;
    return tile(`<svg xmlns="http://www.w3.org/2000/svg" width="${size}" height="${size}"><g fill="${fill}">${dots}</g></svg>`);
  };
  const starInk = dark ? "#FFFFFF" : t.mono ? "#3A3A3A" : mixHex(accent, "#3A2A44", 0.5);
  const skyNear = skyStars(560, 26, 101, starInk, true);
  const skyFar = skyStars(380, 60, 211, dark ? "#FFFFFF" : t.mono ? "#555555" : accent2, false);
  const tint = (pct) => (t.mono ? "var(--wash)" : `color-mix(in srgb, var(--accent) ${pct}%, var(--paper))`);
  // The page's colours: Bright (white paper, dark ink) or Dark (the website's near-black, light ink)
  const sheet = dark ? paper.dark : paper.light;
  // (the band takes a little of the stone's colour too: more on the light Paper band, a hint on the dark ones)
  const bandOf = (c) => (paper.tone && !t.mono ? mixHex(paper.tone, c, lightBand ? 0.16 : 0.12) : c);
  const page = dark
    ? { band: bandOf(t.light ? "#0C0908" : t.band), paper: sheet, wash: paper.tone ? mixHex(tone, sheet, 0.09) : mixHex("#FFFFFF", sheet, 0.05), ink: "#F1EBEA", soft: "#A99FA0", hair: paper.tone ? mixHex(tone, sheet, 0.2) : mixHex("#FFFFFF", sheet, 0.12), outside: paper.tone ? mixHex(paper.tone, mixHex("#000000", sheet, 0.45), 0.1) : mixHex("#000000", sheet, 0.45), rule: "#F1EBEA" }
    : { band: bandOf(t.band), paper: sheet, wash: paper.tone ? mixHex(paper.tone, sheet, 0.1) : t.wash, ink: "#1C1618", soft: "#6B6266", hair: paper.tone ? mixHex(paper.tone, "#E7E2E2", 0.24) : "#E7E2E2", outside: t.mono ? "#E6E6E6" : paper.tone ? mixHex(paper.tone, "#E9E4E7", 0.26) : "#E9E4E7", rule: "#1C1618" };
  // Pearl's shimmer and Marble's veins, over the paper's own texture
  const marbleVeins = paper.veins ? tile(`<svg xmlns="http://www.w3.org/2000/svg" width="700" height="700"><filter id="v"><feTurbulence type="turbulence" baseFrequency="0.0035 0.012" numOctaves="3" seed="7" stitchTiles="stitch"/><feColorMatrix values="0 0 0 0 ${dark ? 1 : 0.35} 0 0 0 0 ${dark ? 1 : 0.34} 0 0 0 0 ${dark ? 1 : 0.38} -${dark ? 0.6 : 0.9} 0 0 0 ${dark ? 0.12 : 0.16}"/></filter><rect width="700" height="700" filter="url(#v)"/></svg>`) : "";
  const pearlSheen = paper.sheen ? `linear-gradient(125deg, ${dark ? "rgb(255 200 230 / .05)" : "rgb(255 214 236 / .35)"}, ${dark ? "rgb(190 220 255 / .04)" : "rgb(208 230 255 / .28)"} 45%, ${dark ? "rgb(200 255 225 / .04)" : "rgb(214 245 226 / .3)"} 75%, ${dark ? "rgb(255 236 210 / .04)" : "rgb(255 240 220 / .3)"})` : "";
  // (the stone's own glow, soft, in the top right and bottom left corners)
  const [tr, tg, tb] = paper.tone ? rgb(paper.tone).map((v) => Math.round(v * 255)) : [0, 0, 0];
  const stoneGlow = paper.tone ? `radial-gradient(ellipse 70% 45% at 100% 0%, rgb(${tr} ${tg} ${tb} / ${dark ? 0.16 : 0.13}), transparent 70%), radial-gradient(ellipse 65% 40% at 0% 100%, rgb(${tr} ${tg} ${tb} / ${dark ? 0.12 : 0.1}), transparent 70%)` : "";
  const sheetLayers = [tex.page, marbleVeins, pearlSheen, stoneGlow].filter(Boolean).join(",");
  // (and its glow in the band, behind the word INVOICE)
  const bandGlow = paper.tone && !t.mono ? `radial-gradient(ellipse 45% 120% at 85% 40%, rgb(${tr} ${tg} ${tb} / ${lightBand ? 0.26 : 0.3}), transparent 75%)` : "";

  return `<!doctype html>
<html lang="en-GB"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1"><meta name="robots" content="noindex">
<title>${esc(title)} · ${esc(card.name)}</title>
<style>
@font-face{font-family:"Saira";src:url(${SAIRA_DATA_URL}) format("woff2");font-weight:300 600;font-stretch:100% 125%;font-display:block}
:root{--band:${page.band};--accent:${accent};--accent2:${accent2};--blend:linear-gradient(90deg,var(--accent),var(--accent2));--tint:${tint(dark ? 15 : 8)};--tint2:${tint(dark ? 10 : 5)};--paper:${page.paper};--wash:${page.wash};--ink:${page.ink};--soft:${page.soft};--hair:${page.hair};--rule:${page.rule};--red:${red};--green:${green};--line:${lineColour};--band-ink:${lightBand ? "#1C1618" : "#FFFFFF"};--on-blend:${dark ? "#120D0C" : "#FFFFFF"};color-scheme:${dark ? "dark" : "light"}}
*{box-sizing:border-box}
/* Behind the invoice: a soft surface under Novacane's sky (screen only: printed, it's just the paper):
   faint nebulae of the theme's colours in two corners, the edges a shade darker, grain and stardust */
html{min-height:100%;background:${tex.backdrop},${t.mono ? "" : `radial-gradient(70% 55% at 0% 0%,color-mix(in srgb,${accent2} ${dark ? 22 : 16}%,transparent),transparent 70%),radial-gradient(65% 50% at 100% 100%,color-mix(in srgb,${accent} ${dark ? 20 : 14}%,transparent),transparent 70%),`}radial-gradient(120% 90% at 50% 40%,transparent 55%,${dark ? "rgb(0 0 0 / .45)" : "rgb(60 40 70 / .10)"}),${page.outside};background-attachment:fixed}
body{margin:0;padding:28px 12px;font:300 15px/1.6 "Saira",Futura,"Century Gothic","Avenir Next",system-ui,sans-serif;color:var(--ink);letter-spacing:.015em;-webkit-print-color-adjust:exact;print-color-adjust:exact}
b,strong,.to b{font-weight:500}
/* The sky behind it moves (16 October 2026): Novacane's night, in the invoice's own colours, drifting
   very slowly (a nebula breathing, two layers of stars passing and twinkling); still for anyone who
   asks for less motion, and gone in print */
body::before,body::after{content:"";position:fixed;inset:-25%;z-index:-1;pointer-events:none}
body::before{background:${t.mono ? "" : `radial-gradient(38% 30% at 30% 35%,color-mix(in srgb,${accent2} ${dark ? 26 : 18}%,transparent),transparent 70%),radial-gradient(34% 28% at 72% 68%,color-mix(in srgb,${accent} ${dark ? 24 : 16}%,transparent),transparent 70%),`}${skyFar};background-size:auto,auto,380px 380px;animation:nv-drift 90s ease-in-out infinite alternate}
body::after{background:${skyNear};background-size:560px 560px;animation:nv-pass 160s linear infinite,nv-twinkle 7s ease-in-out infinite alternate}
@keyframes nv-drift{from{transform:translate3d(-3%,-2%,0) rotate(-2deg)}to{transform:translate3d(3%,2%,0) rotate(2deg)}}
@keyframes nv-pass{from{background-position:0 0}to{background-position:560px 280px}}
@keyframes nv-twinkle{from{opacity:.45}to{opacity:1}}
@media (prefers-reduced-motion:reduce){body::before,body::after{animation:none}}
.sheet{position:relative}
.sheet{max-width:820px;margin:0 auto;background:${sheetLayers},var(--paper);box-shadow:0 0 0 1px ${dark ? "rgb(255 255 255 / .05)" : "rgb(40 20 50 / .06)"},0 2px 4px rgb(0 0 0 / ${dark ? ".35" : ".06"}),0 18px 50px ${dark ? "rgb(0 0 0 / .55)" : "rgb(60 30 80 / .16)"}}
.band{position:relative;overflow:hidden;display:flex;align-items:center;justify-content:space-between;gap:20px;padding:22px 40px;color:var(--band-ink);background:${bandGlow ? `${bandGlow},` : ""}${tex.band},var(--band)}
.band .sky{position:absolute;inset:0;width:100%;height:100%;display:block}
.band>:not(.sky){position:relative}
.band::after{content:"";position:absolute;left:0;right:0;bottom:0;height:3px;background:var(--blend)}
.brand{display:flex;align-items:center;gap:16px}
.brand .mark{width:86px;height:86px;display:block;flex:none;margin:-18px -2px -18px -16px;overflow:visible}
.brand b{display:block;font-weight:400;font-stretch:125%;font-size:21px;letter-spacing:.3em}
.brand small{display:block;margin-top:3px;font-size:10.5px;letter-spacing:.42em;${t.mono ? "opacity:.75" : lightBand ? "color:var(--accent)" : "color:color-mix(in srgb,var(--accent) 45%,#fff)"}}
.doc{font-weight:400;font-stretch:125%;font-size:12px;letter-spacing:.5em;text-transform:uppercase;opacity:.9}
.in{padding:30px 40px 34px}
.stage{display:flex;align-items:center;gap:10px;margin:0 0 26px;font-size:13.5px;color:var(--line)}
.stage::before{content:"";width:8px;height:8px;border-radius:50%;background:var(--line);flex:none}
.top{display:grid;grid-template-columns:1.1fr 1fr auto;gap:28px;align-items:start}
.k,.top h2,.notes h2,.pay h2{display:block;margin:0 0 6px;font-size:10.5px;font-weight:500;font-stretch:115%;letter-spacing:.24em;text-transform:uppercase;color:${t.mono ? "var(--soft)" : "var(--accent)"}}
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
.pagenote{margin:0 0 18px;padding:10px 14px;border-radius:4px;background:var(--tint);border-left:3px solid var(--accent);font-size:14px}
.paynow{margin:0 0 14px}.paynow button{font:inherit;font-size:15px;font-weight:600;letter-spacing:.02em;color:var(--on-blend);background:var(--blend);border:0;border-radius:6px;padding:12px 22px;cursor:pointer}
.paynow button:hover{filter:brightness(1.08)}
.paynow{display:flex;flex-wrap:wrap;gap:10px;align-items:center}.paynow form{margin:0}
.pay .paynow a.monzo{display:inline-block;font-size:15px;font-weight:600;letter-spacing:.02em;color:var(--on-blend);background:var(--blend);border:0;border-radius:6px;padding:12px 22px;text-decoration:none}
.pay .paynow a.monzo.second{color:var(--accent);background:var(--paper);box-shadow:inset 0 0 0 1.5px var(--accent);padding:12px 20px}
.pay .paynow a.monzo:hover{filter:brightness(1.08)}.pay .paynow a.monzo.second:hover{background:var(--tint)}
.paynow~.monzo-line{display:none}.monzo-line small{color:var(--soft);font-size:12px}
.paynow a.monzo{align-items:center;gap:10px}.pay .paynow a.monzo{display:inline-flex}
/* Monzo's M (18 Oct 2026): small and repeated across the button, a quiet pattern a shade lighter than it */
.paynow a.monzo{position:relative;overflow:hidden;isolation:isolate;white-space:nowrap}
/* Its border: thick and white, solid on the left and fading towards the right, with a soft glow inside */
.paynow a.monzo::after{content:"";position:absolute;inset:0;border-radius:inherit;padding:3px;background:linear-gradient(90deg,currentColor 0%,color-mix(in srgb,currentColor 70%,transparent) 30%,color-mix(in srgb,currentColor 12%,transparent) 100%);-webkit-mask:linear-gradient(#000 0 0) content-box,linear-gradient(#000 0 0);-webkit-mask-composite:xor;mask:linear-gradient(#000 0 0) content-box exclude,linear-gradient(#000 0 0);pointer-events:none}
.paynow a.monzo{box-shadow:inset 10px 0 14px -6px color-mix(in srgb,currentColor 35%,transparent),inset 0 0 10px color-mix(in srgb,currentColor 14%,transparent)}
.quickpay .paynow a.monzo::after{inset:-2px}
/* A second, inner border: a fine line all the way round with its corners shaved off at an angle, like
   the cut ends of Monzo's M; faint, a whisper of the white border outside it */
.paynow a.monzo::before{content:"";position:absolute;inset:6px;background:linear-gradient(90deg,color-mix(in srgb,currentColor 38%,transparent),color-mix(in srgb,currentColor 18%,transparent));clip-path:polygon(evenodd,7px 0,calc(100% - 7px) 0,100% 7px,100% calc(100% - 7px),calc(100% - 7px) 100%,7px 100%,0 calc(100% - 7px),0 7px,7px 0,7px 1.5px,calc(100% - 7px) 1.5px,calc(100% - 1.5px) 7px,calc(100% - 1.5px) calc(100% - 7px),calc(100% - 7px) calc(100% - 1.5px),7px calc(100% - 1.5px),1.5px calc(100% - 7px),1.5px 7px,7px 1.5px);pointer-events:none}
.monzo.second::before{background:linear-gradient(90deg,color-mix(in srgb,var(--accent) 35%,transparent),color-mix(in srgb,var(--accent2) 15%,transparent))}
/* Between the two borders: fine slanted stripes (the slant of the M's cut ends) in Monzo's own colours,
   coral, amber, mint and blue, faint and blended into the button's colour */
.mzring,.mzglass{position:absolute;inset:0;z-index:-1;clip-path:polygon(evenodd,0 0,100% 0,100% 100%,0 100%,0 0,7px 6px,calc(100% - 7px) 6px,calc(100% - 6px) 7px,calc(100% - 6px) calc(100% - 7px),calc(100% - 7px) calc(100% - 6px),7px calc(100% - 6px),6px calc(100% - 7px),6px 7px,7px 6px);pointer-events:none}
.mzring{background:repeating-linear-gradient(135deg,#FF6E5A 0 1.5px,transparent 1.5px 4px,#FFC453 4px 5.5px,transparent 5.5px 8px,#5BD0B8 8px 9.5px,transparent 9.5px 12px,#4AA3DF 12px 13.5px,transparent 13.5px 16px);opacity:.7;mix-blend-mode:overlay;}
/* ...and over them a sheen, like resin or glass: a bright gloss along the top, a faint reflection at the
   bottom, two soft diagonal glints and a fine bright edge; on hover or focus the glints drift slowly across */
.mzglass{background:linear-gradient(180deg,rgba(255,255,255,.62) 0,rgba(255,255,255,.24) 14%,rgba(255,255,255,0) 42%,rgba(255,255,255,0) 76%,rgba(255,255,255,.2) 100%),linear-gradient(105deg,transparent 0 30%,rgba(255,255,255,.42) 36%,transparent 41% 58%,rgba(255,255,255,.3) 61%,transparent 65%);background-size:100% 100%,250% 100%;background-position:0 0,85% 0;background-repeat:no-repeat;box-shadow:inset 0 1px 0 rgba(255,255,255,.55),inset 0 -1px 0 rgba(0,0,0,.14);transition:background-position 1.6s ease}
a.monzo:hover .mzglass,a.monzo:focus-visible .mzglass{background-position:0 0,15% 0}
.monzo.second .mzglass{opacity:.7}
@media (prefers-reduced-motion:reduce){.mzglass{transition:none}}
.monzo.second .mzring{opacity:.4;mix-blend-mode:multiply}
/* Novacane over it all, merged in: its night sky's nebula glow in the theme's colours, stars and Nova's
   sparkles, lightening what's under them (screen) so the stripes, glass and M's show through; still */
.nvsky{position:absolute;inset:0;z-index:-1;background:${nvSky()} 0 50%/auto 100% repeat-x,radial-gradient(ellipse 45% 90% at 16% 20%,color-mix(in srgb,${to} 45%,transparent),transparent 70%),radial-gradient(ellipse 40% 80% at 86% 85%,color-mix(in srgb,${from} 40%,transparent),transparent 70%);mix-blend-mode:screen;opacity:.75;pointer-events:none}
.monzo.second .nvsky{mix-blend-mode:multiply;opacity:.35}
@media (forced-colors:active){.mzring,.mzglass,.nvsky{display:none}}
/* A subtle highlight: soft light across the top of the button, like light on glass */
.paynow a.monzo:not(.second){background:linear-gradient(180deg,rgba(255,255,255,.2) 0%,rgba(255,255,255,.06) 45%,rgba(255,255,255,0) 55%),${mTile(mShades(true), 0.24)} 0 0/56px 48px space,var(--blend)}
.monzo.second{background-image:linear-gradient(180deg,color-mix(in srgb,var(--accent) 8%,transparent),transparent 55%),${mTile(mShades(false), 0.1)};background-size:auto,56px 48px;background-repeat:no-repeat,space}
.monzo.second::after{background:linear-gradient(90deg,var(--accent) 0%,color-mix(in srgb,var(--accent2) 60%,transparent) 35%,color-mix(in srgb,var(--accent2) 15%,transparent) 100%)}
@media (forced-colors:active){.paynow a.monzo::after,.paynow a.monzo::before{display:none}}
.quickpay{display:flex;flex-direction:column;align-items:flex-end;margin:16px 0 26px;text-align:right}
.quickpay .paynow{margin:0;justify-content:flex-end}
.quickpay a.monzo,.quickpay .paynow button{display:inline-flex;align-items:center;justify-content:center;min-height:52px;font:inherit;font-size:17px;font-weight:600;letter-spacing:.02em;color:var(--on-blend);background:var(--blend);border:2px solid transparent;border-radius:8px;padding:12px 26px;text-decoration:none;cursor:pointer}
.quickpay a.monzo.second{color:var(--accent);background:var(--paper);border-color:var(--accent)}
.quickpay a.monzo:hover,.quickpay .paynow button:hover{filter:brightness(1.08)}.quickpay a.monzo.second:hover{background:var(--tint)}
.quickpay p{margin:10px 0 0;max-width:420px;font-size:14px;line-height:1.5;color:var(--soft)}.quickpay p a{color:var(--accent)}
.paynow a.monzo:focus-visible,.paynow button:focus-visible,.copy:focus-visible,.quickpay p a:focus-visible{outline:3px solid var(--accent);outline-offset:3px}
.copy{margin-left:8px;padding:3px 12px;min-height:30px;font:inherit;font-size:12.5px;color:var(--accent);background:var(--paper);border:1px solid var(--accent);border-radius:999px;cursor:pointer;vertical-align:baseline}.copy:hover{background:var(--tint)}
.sr{position:absolute;width:1px;height:1px;overflow:hidden;clip:rect(0 0 0 0);white-space:nowrap}
@media (max-width:640px){.quickpay{align-items:stretch;text-align:left;margin-top:14px}.quickpay .paynow{flex-direction:column;align-items:stretch}.quickpay .paynow form,.quickpay .paynow button{width:100%}.quickpay .paynow a.monzo{padding-right:20px}.copy{min-height:36px;padding:6px 14px}}
@media (prefers-reduced-motion:reduce){html{scroll-behavior:auto}}
html{scroll-behavior:smooth}
.tools{max-width:820px;margin:18px auto 0;display:flex;gap:18px;align-items:center;justify-content:center;font-size:13.5px}
.tools button{font:inherit;color:var(--ink);background:var(--paper);border:1px solid var(--hair);border-radius:6px;padding:9px 18px;cursor:pointer}
.tools a{color:${dark ? "#cfc6c7" : "#5b5256"}}
@page{size:A4;margin:12mm}
@media print{.tools,.paynow,.pagenote,.quickpay,.copy{display:none!important}.paynow~.monzo-line{display:block}body::before,body::after{display:none}html{background:${dark ? "var(--paper)" : "none"}}body{padding:0;font-size:13.5px}.sheet{box-shadow:none;max-width:none}.in{padding:26px 34px 10px}.band{padding:18px 34px}}
</style></head>
<body><main class="sheet">
<header class="band">${bandSky(t, lightBand, from, to)}<div class="brand">${logo}<div><b>NOVACANE</b><small>STUDIOS</small></div></div><div class="doc">${receipt ? "Receipt" : "Invoice"}</div></header>
<div class="in">
${client?.banner ? `<p class="pagenote" role="status">${client.banner}</p>` : ""}
<p class="stage" role="note">${sentenceLines(esc(line.text(s)), "<br>")}</p>
<section class="top">
  <div class="to"><h2>Billed to</h2>${billTo}</div>
  <dl>${facts}</dl>
  ${amount}
</section>
${quickpay}
<table><thead><tr><th>Description</th><th class="n">Qty</th><th class="n">Price</th><th class="n">Amount</th></tr></thead><tbody>${rows}</tbody></table>
<section class="sums" aria-label="Totals">${sums.join("")}</section>
<div class="bottom">
  <section class="notes" aria-label="Notes"><h2>Notes</h2>${sentenceLines(esc(note))}</section>
  <section class="pay"><h2>${receipt ? "Payment" : "How to pay"}</h2>${pay}</section>
</div>
<footer><span class="thanks">Thank you for recording with ${esc(card.name)}.</span><span>${esc(card.address)}</span><span>${esc(card.phone)} · ${esc(card.email)} · ${esc(card.website)}</span><span>Deposits are non-refundable with less than ${CANCEL_NOTICE_HOURS} hours' notice of cancellation.</span></footer>
</div></main>${client ? `<p class="tools"><button type="button" id="print">Print or save as PDF</button><a href="/privacy">Privacy</a></p><p class="sr" id="copied" role="status" aria-live="polite"></p><script nonce="${esc(client.nonce || "")}">document.getElementById("print").addEventListener("click",function(){window.print()});
if(navigator.clipboard&&window.isSecureContext)document.querySelectorAll(".copy").forEach(function(b){b.hidden=false;b.addEventListener("click",function(){var label=b.getAttribute("aria-label").replace("Copy ","");navigator.clipboard.writeText(b.dataset.copy).then(function(){b.textContent="Copied ✓";document.getElementById("copied").textContent=label.charAt(0).toUpperCase()+label.slice(1)+" copied";setTimeout(function(){b.textContent="Copy"},2500)})})})</script>` : ""}</body></html>`;
}

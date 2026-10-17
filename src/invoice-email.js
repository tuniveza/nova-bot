// The Nova invoice, as an email: the same invoice as the Invoicer's page (src/invoicer.js), built the
// way email apps can show it. Every invoice email uses it: the invoice itself (asking for the deposit),
// reminders (balance due, overdue) and receipts (paid in full).
//
// Email apps don't run what the page uses (drawn SVG, embedded fonts, texture images, colour mixing,
// most CSS), so this is the same design in plain tables with every colour worked out here: the band
// (night sky, logo, NOVACANE STUDIOS, INVOICE or RECEIPT) is a picture made from the page itself
// (public/invoice-email/, scripts/invoice-email-bands.mjs: each theme, bright and dark, sharp on
// phones), and everything below it is real text, so it reads, searches and copies like an email.
// The band's picture has words as its alt text, on the band's own colour, for inboxes that hold
// pictures back.
//
// Each email is HTML with a plain-text twin (multipart/alternative: the mail server sends both), so an
// email app that can't show HTML shows the whole invoice as text instead.

import { STAGE_LINES, longDay, monzoLink, monzoReady, monzoShort, paperOf, pounds, sentenceLines, stageSums, studioCard, themeOf } from "./invoicer.js";

const esc = (s) => String(s ?? "").replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c]);
// Two colours mixed (email apps can't mix them themselves): a share of a over b
function mix(a, b, share) {
  const p = (c) => [1, 3, 5].map((i) => parseInt(c.slice(i, i + 2), 16));
  const [x, y] = [p(a), p(b)];
  return "#" + x.map((v, i) => Math.round(v * share + y[i] * (1 - share)).toString(16).padStart(2, "0")).join("").toUpperCase();
}
const bankReady = (bank) => Boolean(bank && bank.accountName && bank.sortCode && bank.accountNumber);
const FONT = "Futura,'Century Gothic','Avenir Next','Segoe UI',Helvetica,Arial,sans-serif";

// The band's picture: one per theme, mode and word (scripts/invoice-email-bands.mjs makes them all)
// (Moonstone, the plain paper: band-<theme>-<mode>-<word>.jpg; another paper tints the band too:
// band-<theme>-<mode>-<word>-<paper>.jpg)
export const bandPicture = (base, theme, mode, receipt, paper = "moonstone") => `${base}/invoice-email/band-${theme}-${mode}-${receipt ? "receipt" : "invoice"}${paper && paper !== "moonstone" ? `-${paper}` : ""}.jpg`;

// { invoice (publicInvoice's shape), payments, stage, settings, today, base (the site's address),
//   link (the invoice's own page), greeting, paragraphs (the message above the invoice), mode }
//   -> { html, text }
export function invoiceEmailParts({ invoice, payments = [], stage, settings, today, base, link, greeting, paragraphs = [], mode = null, paper: paperId = null }) {
  // (the invoice's own look, else the studio's)
  const look = invoice?.look || {};
  const t = themeOf(look.theme || settings?.invoiceTheme);
  const dark = (mode || look.mode || settings?.invoiceMode) === "dark";
  const paper = paperOf(paperId || look.paper || settings?.invoicePaper);
  const sheet = dark ? paper.dark : paper.light;
  const s = stageSums(invoice, payments, stage, today);
  const card = studioCard(settings);
  const receipt = stage === "paid";
  const accent = dark ? t.accentDark : t.accent;
  const accent2 = dark ? t.accent2Dark : t.accent2;
  const red = dark ? "#EE6A80" : "#A3233A";
  const green = dark ? "#5CC795" : "#1F7A55";
  const P = dark
    ? { paper: sheet, ink: "#F1EBEA", soft: "#A99FA0", hair: paper.tone ? mix(mix(paper.tone, "#FFFFFF", 0.45), sheet, 0.2) : mix("#FFFFFF", sheet, 0.12), outside: mix("#000000", sheet, 0.45), rule: "#F1EBEA", band: t.light ? "#0C0908" : t.band }
    : { paper: sheet, ink: "#1C1618", soft: "#6B6266", hair: paper.tone ? mix(paper.tone, "#E7E2E2", 0.24) : "#E7E2E2", outside: t.mono ? "#E9E9E9" : mix(paper.tone || accent2, "#ECE9EA", paper.tone ? 0.24 : 0.12), rule: "#1C1618", band: t.band };
  const tint = t.mono ? (dark ? "#211A18" : "#F6F5F5") : mix(accent, P.paper, dark ? 0.15 : 0.08);
  const tint2 = t.mono ? (dark ? "#1E1816" : "#F8F7F7") : mix(accent2, P.paper, dark ? 0.1 : 0.05);
  const heading = t.mono ? P.soft : accent;
  const line = STAGE_LINES[stage];
  const lineColour = line.colour === "accent" ? accent : line.colour === "ink" ? P.ink : line.colour === "#A3233A" ? red : green;
  const boxEdge = stage === "overdue" ? red : receipt ? green : accent;
  const word = receipt ? "RECEIPT" : "INVOICE";
  const td = (style, inner, attrs = "") => `<td ${attrs} style="font-family:${FONT};${style}">${inner}</td>`;
  const label = (text) => `<div style="font-family:${FONT};font-size:10px;letter-spacing:2.4px;text-transform:uppercase;color:${heading};margin:0 0 6px;">${esc(text)}</div>`;

  // The message above the invoice (each sentence on a line of its own, as on the invoice)
  const message = [greeting, ...paragraphs].filter(Boolean).map((p) => `<p style="margin:0 0 12px;">${sentenceLines(esc(p)).replace(/\n/g, "<br>")}</p>`).join("");

  // Who, when, and the amount box
  const billTo = [invoice.billTo?.name ? `<b>${esc(invoice.billTo.name)}</b>` : "", invoice.billTo?.address ? esc(invoice.billTo.address).replace(/\n/g, "<br>") : "", invoice.billTo?.email ? esc(invoice.billTo.email) : ""].filter(Boolean).join("<br>");
  const facts = [
    ["Number", invoice.number],
    ["Issued", longDay(invoice.issueDate)],
    ...(receipt ? [] : [["Due", longDay(stage === "deposit" ? s.dueBy : invoice.dueDate)]]),
    ...(card.vatNumber ? [["VAT number", card.vatNumber]] : []),
  ]
    .map(([k, v]) => `<tr>${td(`font-size:13px;color:${P.soft};padding:0 12px 3px 0;`, esc(k))}${td(`font-size:13px;white-space:nowrap;color:${k === "Due" && stage === "overdue" ? red : P.ink};padding:0 0 3px;${k === "Due" && stage === "overdue" ? "font-weight:600;" : ""}`, esc(v))}</tr>`)
    .join("");
  const dueWord = receipt ? "Paid in full" : stage === "overdue" ? `${s.daysOverdue} day${s.daysOverdue === 1 ? "" : "s"} overdue` : `Due ${longDay(s.dueBy)}`;
  const amountBox = `<table role="presentation" cellpadding="0" cellspacing="0" width="100%" style="border-collapse:collapse;"><tr>
${td(`width:3px;background:${boxEdge};`, "", `bgcolor="${boxEdge}"`)}
${td(`background:${tint};padding:14px 16px;text-align:right;`, `<div style="font-size:10px;letter-spacing:2.4px;text-transform:uppercase;color:${P.soft};">${receipt ? "Amount paid" : stage === "deposit" ? "Deposit due" : "Amount due"}</div>
<div style="font-size:26px;line-height:1.25;font-weight:600;color:${stage === "overdue" ? red : receipt ? green : accent};margin:4px 0 2px;">${esc(pounds(receipt ? s.paidPence || s.totalPence : s.dueNowPence))}</div>
<div style="font-size:12.5px;color:${stage === "overdue" ? red : receipt ? green : P.soft};">${esc(dueWord)}</div>`, `bgcolor="${tint}"`)}
</tr></table>`;

  // What's on it
  const rows = invoice.lines
    .map((l) => `<tr>${td(`font-size:14px;color:${P.ink};padding:11px 8px 11px 0;border-bottom:1px solid ${P.hair};`, esc(l.description))}${td(`font-size:14px;color:${P.ink};padding:11px 0 11px 12px;border-bottom:1px solid ${P.hair};text-align:right;white-space:nowrap;`, `${esc(l.qty)} × ${esc(pounds(l.unitPence))}`)}${td(`font-size:14px;color:${P.ink};padding:11px 0 11px 12px;border-bottom:1px solid ${P.hair};text-align:right;white-space:nowrap;`, esc(pounds(l.totalPence)))}</tr>`)
    .join("");
  const sum = (k, v, kind = "") => {
    const big = kind === "due";
    const soft = kind === "soft";
    const top = kind === "due" ? `border-top:2px solid ${t.mono ? P.rule : accent};` : kind === "strong" ? `border-top:1px solid ${P.hair};` : "";
    return `<tr>${td(`font-size:${big ? 16 : 14}px;${big ? "font-weight:600;" : ""}color:${soft ? P.soft : P.ink};padding:${big ? "10px" : "6px"} 12px 4px 0;${top}`, k)}${td(`font-size:${big ? 16 : 14}px;font-weight:${big ? 600 : 500};color:${big && !receipt ? accent : soft ? P.soft : P.ink};padding:${big ? "10px" : "6px"} 0 4px;text-align:right;white-space:nowrap;${top}`, esc(v))}</tr>`;
  };
  const sums = [];
  if (invoice.vatPence) sums.push(sum("Subtotal", pounds(invoice.subtotalPence)), sum(`VAT ${esc(invoice.vatRate)}%`, pounds(invoice.vatPence)));
  sums.push(sum(stage === "deposit" ? "Total booking value" : "Total", pounds(s.totalPence), "strong"));
  for (const p of s.payments) sums.push(sum(`Paid ${esc(longDay(p.paidOn))}${p.method ? ` · ${esc(p.method)}` : ""}`, pounds(-p.amountPence), "soft"));
  if (stage === "deposit") {
    sums.push(sum(`Deposit due now (${s.depositPercent}%)`, pounds(s.dueNowPence), "due"));
    sums.push(sum(`Balance due by ${esc(longDay(s.laterBy))}`, pounds(s.laterPence), "soft"));
  } else {
    if (!s.payments.length && !receipt) sums.push(sum("Paid so far", pounds(0), "soft"));
    sums.push(sum(receipt ? "Amount due" : "Remaining balance", receipt ? "£0.00 (paid in full)" : pounds(s.dueNowPence), "due"));
  }

  // How to pay: the button to the invoice's page (pay there, see it, save it), then the bank
  const bank = bankReady(settings?.bank) && !receipt ? settings.bank : null;
  const button = link
    ? `<table role="presentation" cellpadding="0" cellspacing="0" style="border-collapse:collapse;margin:0 0 14px;"><tr>${td(`background:${accent};border-radius:6px;`, `<a href="${esc(link)}" style="display:inline-block;padding:12px 24px;font-family:${FONT};font-size:15px;font-weight:600;letter-spacing:.3px;color:#ffffff;text-decoration:none;">${receipt ? "See your receipt" : `Pay ${esc(pounds(s.dueNowPence))} or see the invoice`}</a>`, `bgcolor="${accent}"`)}</tr></table>`
    : "";
  // Monzo: a second button, the theme's accent as an outline (opens Monzo with the amount and the
  // reference filled in), and the link as words under it
  const monzoHref = monzoReady(settings?.monzo) && !receipt && s.dueNowPence > 0 ? monzoLink(settings.monzo, s.dueNowPence, invoice.number) : "";
  const monzoButton = monzoHref
    ? `<table role="presentation" cellpadding="0" cellspacing="0" style="border-collapse:collapse;margin:0 0 14px;"><tr>${td(`background:${P.paper};border:1.5px solid ${accent};border-radius:6px;`, `<a href="${esc(monzoHref)}" style="display:inline-block;padding:11px 22px;font-family:${FONT};font-size:15px;font-weight:600;letter-spacing:.3px;color:${accent};text-decoration:none;">Pay ${esc(pounds(s.dueNowPence))} with Monzo</a>`, `bgcolor="${P.paper}"`)}</tr></table>`
    : "";
  const payText = receipt
    ? `<p style="margin:0 0 10px;">Received with thanks. Nothing more to pay.</p>`
    : `${monzoHref ? `<p style="margin:0 0 10px;"><span style="font-size:10px;letter-spacing:2.4px;text-transform:uppercase;color:${heading};">Monzo</span><br><a href="${esc(monzoHref)}" style="color:${accent};">${esc(monzoShort(settings.monzo))}</a></p>` : ""}${bank ? `<p style="margin:0 0 10px;"><span style="font-size:10px;letter-spacing:2.4px;text-transform:uppercase;color:${heading};">Bank transfer</span><br>${esc(bank.accountName)}<br>Sort code ${esc(bank.sortCode)} · Account ${esc(bank.accountNumber)}</p>` : ""}<p style="margin:0 0 10px;"><span style="font-size:10px;letter-spacing:2.4px;text-transform:uppercase;color:${heading};">Reference</span><br>${esc(invoice.number)}</p>`;
  const note = String(invoice.notes || "").trim();

  const html = `<!doctype html><html lang="en-GB"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1"><meta name="color-scheme" content="${dark ? "dark" : "light"}"><meta name="supported-color-schemes" content="${dark ? "dark" : "light"}"><title>${esc(word)} ${esc(invoice.number)}</title>
<style>@media (max-width:620px){.nv-col{display:block!important;width:100%!important;padding:0 0 16px!important}.nv-pad{padding-left:18px!important;padding-right:18px!important}}</style></head>
<body style="margin:0;padding:0;background:${P.outside};">
<table role="presentation" width="100%" cellpadding="0" cellspacing="0" bgcolor="${P.outside}" style="background:${P.outside};border-collapse:collapse;"><tr><td align="center" style="padding:24px 8px;">
<table role="presentation" width="600" cellpadding="0" cellspacing="0" bgcolor="${P.paper}" style="width:100%;max-width:600px;background:${P.paper};border-collapse:collapse;">
<tr>${td(`background:${P.band};padding:0;line-height:0;`, `<img src="${esc(bandPicture(base, t.id, dark ? "dark" : "bright", receipt, paper.id))}" width="600" alt="NOVACANE STUDIOS · ${word}" style="display:block;width:100%;max-width:600px;height:auto;border:0;color:#ffffff;font-family:${FONT};font-size:16px;letter-spacing:4px;line-height:1.6;padding:0;">`, `bgcolor="${P.band}"`)}</tr>
${message ? `<tr>${td(`padding:26px 32px 6px;font-size:15.5px;line-height:1.6;color:${P.ink};`, message, `class="nv-pad"`)}</tr><tr>${td(`padding:6px 32px 0;`, `<div style="height:1px;line-height:1px;font-size:0;background:${P.hair};">&nbsp;</div>`, `class="nv-pad"`)}</tr>` : ""}
<tr>${td(`padding:22px 32px 0;font-size:13.5px;color:${lineColour};`, `<span style="color:${lineColour};font-size:16px;">&#9679;</span>&nbsp; ${sentenceLines(esc(line.text(s)), "<br>")}`, `class="nv-pad"`)}</tr>
<tr>${td(`padding:18px 32px 0;`, `<table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="border-collapse:collapse;"><tr>
${td(`width:38%;vertical-align:top;font-size:14px;line-height:1.6;color:${P.ink};padding-right:12px;`, `${label("Billed to")}${billTo}`, `class="nv-col"`)}
${td(`width:30%;vertical-align:top;padding-right:12px;`, `<table role="presentation" cellpadding="0" cellspacing="0" style="border-collapse:collapse;">${facts}</table>`, `class="nv-col"`)}
${td(`width:32%;vertical-align:top;`, amountBox, `class="nv-col"`)}
</tr></table>`, `class="nv-pad"`)}</tr>
<tr>${td(`padding:24px 32px 0;`, `<table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="border-collapse:collapse;">
<tr>${td(`font-size:10px;letter-spacing:2.4px;text-transform:uppercase;color:${heading};padding:0 0 8px;border-bottom:2px solid ${t.mono ? P.rule : accent};`, "Description")}${td(`font-size:10px;letter-spacing:2.4px;text-transform:uppercase;color:${heading};padding:0 0 8px 12px;border-bottom:2px solid ${t.mono ? P.rule : accent2};text-align:right;`, "Qty × Price")}${td(`font-size:10px;letter-spacing:2.4px;text-transform:uppercase;color:${heading};padding:0 0 8px 12px;border-bottom:2px solid ${t.mono ? P.rule : accent2};text-align:right;`, "Amount")}</tr>
${rows}</table>`, `class="nv-pad"`)}</tr>
<tr>${td(`padding:12px 32px 0;`, `<table role="presentation" cellpadding="0" cellspacing="0" align="right" style="border-collapse:collapse;min-width:300px;">${sums.join("")}</table>`, `class="nv-pad"`)}</tr>
<tr>${td(`padding:26px 32px 0;`, `<table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="border-collapse:collapse;"><tr>
${note ? td(`width:52%;vertical-align:top;padding-right:16px;`, `<table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="border-collapse:collapse;"><tr>${td(`width:3px;background:${accent2};`, "", `bgcolor="${accent2}"`)}${td(`background:${tint2};padding:12px 14px;font-size:13.5px;line-height:1.6;color:${P.ink};`, `${label("Notes")}${sentenceLines(esc(note)).replace(/\n/g, "<br>")}`, `bgcolor="${tint2}"`)}</tr></table>`, `class="nv-col"`) : ""}
${td(`vertical-align:top;font-size:13.5px;line-height:1.6;color:${P.ink};`, `${label(receipt ? "Payment" : "How to pay")}${button}${monzoButton}${payText}`, `class="nv-col"`)}
</tr></table>`, `class="nv-pad"`)}</tr>
<tr>${td(`padding:22px 32px 26px;`, `<div style="border-top:1px solid ${P.hair};padding-top:14px;font-size:12.5px;color:${heading};">Thank you for recording with ${esc(card.name)}.</div>
<div style="font-size:11.5px;line-height:1.7;color:${P.soft};margin-top:4px;">${esc(card.address)}<br>${esc(card.phone)} · <a href="mailto:${esc(card.email)}" style="color:${P.soft};">${esc(card.email)}</a> · <a href="https://${esc(card.website.replace(/^https?:\/\//, ""))}" style="color:${P.soft};">${esc(card.website)}</a></div>`, `class="nv-pad"`)}</tr>
</table></td></tr></table></body></html>`;

  // The same, as text (for email apps that don't show HTML)
  const pad = (k, v, w = 34) => `  ${k}${" ".repeat(Math.max(2, w - k.length))}${v}`;
  const text = [
    ...[greeting, ...paragraphs].filter(Boolean).map((p) => sentenceLines(p)),
    "",
    `${word} ${invoice.number} · ${card.name}`,
    line.text(s),
    "",
    `Billed to: ${invoice.billTo?.name || ""}`,
    `Issued: ${longDay(invoice.issueDate)}${receipt ? "" : `    Due: ${longDay(stage === "deposit" ? s.dueBy : invoice.dueDate)}`}`,
    "",
    ...invoice.lines.map((l) => `  ${l.description}\n${pad(`${l.qty} × ${pounds(l.unitPence)}`, pounds(l.totalPence))}`),
    "",
    ...(invoice.vatPence ? [pad("Subtotal", pounds(invoice.subtotalPence)), pad(`VAT ${invoice.vatRate}%`, pounds(invoice.vatPence))] : []),
    pad(stage === "deposit" ? "Total booking value" : "Total", pounds(s.totalPence)),
    ...s.payments.map((p) => pad(`Paid ${longDay(p.paidOn)}`, pounds(-p.amountPence))),
    ...(stage === "deposit"
      ? [pad(`Deposit due now (${s.depositPercent}%)`, pounds(s.dueNowPence)), pad(`Balance due by ${longDay(s.laterBy)}`, pounds(s.laterPence))]
      : [pad(receipt ? "Amount due" : "Remaining balance", receipt ? "£0.00 (paid in full)" : pounds(s.dueNowPence))]),
    ...(note ? ["", `Notes: ${sentenceLines(note)}`] : []),
    "",
    receipt ? "Payment: received with thanks. Nothing more to pay." : "How to pay:",
    ...(receipt ? [] : [...(link ? [`  Pay or see the invoice online: ${link}`] : []), ...(monzoHref ? [`  Pay with Monzo: ${monzoHref}`] : []), ...(bank ? [`  Bank transfer: ${bank.accountName}, sort code ${bank.sortCode}, account ${bank.accountNumber}`] : []), `  Reference: ${invoice.number}`]),
    ...(receipt && link ? [`See your receipt: ${link}`] : []),
    "",
    `Thank you for recording with ${card.name}.`,
    `${card.address} · ${card.phone} · ${card.email} · ${card.website}`,
  ].join("\n");
  return { html, text };
}

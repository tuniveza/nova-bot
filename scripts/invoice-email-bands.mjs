// The invoice email's band pictures (src/invoice-email.js): the band of the Invoicer's own page (night
// sky, logo, NOVACANE STUDIOS, INVOICE or RECEIPT, the line under it) for every theme, bright and dark,
// 600px wide at twice the pixels (sharp on phones), into public/invoice-email/. Run it again after the
// band's look changes:  node scripts/invoice-email-bands.mjs
// (It uses Nova Agent's Playwright, next door: ../na.)
import { mkdirSync, statSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { INVOICE_THEMES, INVOICE_MODES, invoiceDocument } from "../src/invoicer.js";

const here = dirname(fileURLToPath(import.meta.url));
const out = join(here, "..", "public", "invoice-email");
mkdirSync(out, { recursive: true });
const { chromium } = await import(process.env.PLAYWRIGHT || join(here, "..", "..", "..", "na", "node_modules", "playwright", "index.mjs"));

const today = "2026-10-15";
const invoice = { id: 0, number: "NS-0000", status: "sent", billTo: { name: "x" }, lines: [{ description: "x", qty: 1, unitPence: 100, totalPence: 100 }], vatRate: 0, subtotalPence: 100, vatPence: 0, totalPence: 100, paidPence: 0, issueDate: today, dueDate: today, notes: "", pageUrl: null };
const browser = await chromium.launch();
const page = await browser.newPage({ viewport: { width: 1000, height: 400 }, deviceScaleFactor: 2 });
let n = 0, bytes = 0;
for (const t of INVOICE_THEMES) for (const mode of INVOICE_MODES) for (const receipt of [false, true]) {
  const html = invoiceDocument(receipt ? { ...invoice, paidPence: 100, status: "paid" } : invoice, receipt ? [{ amountPence: 100, paidOn: today }] : [], receipt ? "paid" : "deposit", { invoiceTheme: t.id }, today, { theme: t.id, mode });
  // (the band at the email's width: 600px, its padding a little tighter)
  await page.setContent(html.replace("</style>", ".sheet{max-width:600px!important;box-shadow:none!important}body{padding:0!important}.band{padding:20px 28px!important}</style>"));
  await page.waitForTimeout(150);
  const file = join(out, `band-${t.id}-${mode}-${receipt ? "receipt" : "invoice"}.jpg`);
  await page.locator(".band").screenshot({ path: file, type: "jpeg", quality: 90 });
  n++;
  bytes += statSync(file).size;
}
await browser.close();
console.log(`${n} band pictures, ${Math.round(bytes / 1024)} KB → public/invoice-email/`);

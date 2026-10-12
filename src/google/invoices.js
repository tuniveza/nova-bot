// Invoices in Google Drive: each sent invoice as a Google Doc in "Nova Agent/Invoices" (Portal →
// Admin → Google → "Files and invoices in Drive"), the same page the client sees, kept up to date
// when it's paid, part paid or cancelled. Download it as a PDF from Drive whenever it's needed.
// google_links 'invoice': invoice id ⇄ the Doc, with a hash of what was last saved.

import { googleFetch, GoogleError } from "../nova/google.js";
import { invoiceNumber, invoicePage, readSettings } from "../money.js";
import { folder } from "./drive.js";
import { flush, keepLink, links, low, prep, sha, spendDb } from "./common.js";

const UPLOAD = "https://www.googleapis.com/upload/drive/v3";
const DOC_TYPE = "application/vnd.google-apps.document";
const PER_RUN = 5;

async function saveDoc(env, { existing, name, html }) {
  if (existing) {
    const res = await googleFetch(env, "PATCH", `${UPLOAD}/files/${encodeURIComponent(existing)}?uploadType=media&fields=id`, { body: html, headers: { "Content-Type": "text/html; charset=UTF-8" }, timeout: 30_000 });
    if (res.ok) return existing;
    if (res.status !== 404) throw new GoogleError(`Google Drive didn't update the invoice (${res.status}).`, res.status);
  }
  const parent = await folder(env, "invoice");
  const boundary = "nova-inv-" + crypto.randomUUID();
  const meta = JSON.stringify({ name, mimeType: DOC_TYPE, parents: [parent] });
  const body = `--${boundary}\r\nContent-Type: application/json; charset=UTF-8\r\n\r\n${meta}\r\n--${boundary}\r\nContent-Type: text/html; charset=UTF-8\r\n\r\n${html}\r\n--${boundary}--`;
  const res = await googleFetch(env, "POST", `${UPLOAD}/files?uploadType=multipart&fields=id`, { body, headers: { "Content-Type": `multipart/related; boundary=${boundary}` }, timeout: 60_000 });
  const data = await res.json().catch(() => ({}));
  if (!res.ok || !data.id) throw new GoogleError(`Google Drive didn't take the invoice (${data?.error?.message || res.status}).`, res.status || 502);
  return data.id;
}

// Sent invoices not in Drive yet, or changed since: a few each run. -> { done, more }
export async function keepInvoices(env, budget) {
  prep(budget);
  spendDb(budget);
  const { results } = await env.DB.prepare("SELECT * FROM invoices WHERE status IN ('sent', 'part_paid', 'paid', 'void') ORDER BY updated_at DESC LIMIT 60").all();
  if (!results.length) return { done: 0, more: false, total: 0 };
  const L = await links(env, budget, "invoice");
  spendDb(budget);
  const settings = await readSettings(env);
  let done = 0;
  let more = false;
  for (const row of results) {
    const hash = await sha(JSON.stringify([row.status, row.updated_at]));
    const link = L.byNova.get(String(row.id)) || null;
    if (link && link.hash === hash) continue;
    if (done >= PER_RUN || low(budget, 3)) {
      more = true;
      break;
    }
    budget.left -= 2;
    const html = invoicePage(env, row, settings, { preview: true });
    const number = invoiceNumber(row.seq);
    const id = await saveDoc(env, { existing: link?.google_id, name: `Invoice ${number}${row.bill_name ? ` · ${row.bill_name}` : ""}`.slice(0, 200), html });
    keepLink(env, budget, "invoice", row.id, id, { extra: number, hash });
    done++;
  }
  await flush(env, budget);
  return { done, more, total: (await links(env, budget, "invoice")).byNova.size };
}

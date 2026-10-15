// Nova Bot's health, for the Fixer's hourly check (Nova Agent's src/fixer/probes.ts asks for it):
//   POST /nova-agent/fixer-health   (Authorization: Bearer <AGENT_NOVA_KEY>)  -> { at, checks }
// Each check is plain code (no AI): { group, name, ok, severity, area, detail }.
//   area "checks": code is at fault (an invoice page or email that doesn't draw), so the Fixer may
//                  prepare a fix; "server": a setting, an outside service or a person's to-do
//                  (no way to pay set up, an approval waiting), so it only tells the admins.
// It only reads: it never sends, changes or approves anything. Its words say numbers and counts,
// never a client's name or email address.

import { bankReady, cardReady, clientPage, emailReady, invoiceEmail, invoiceNumber, readSettings, ukToday } from "./money.js";
import { mailReady } from "./enquiries.js";
import { STAGES, invoiceDocument } from "./invoicer.js";

const HOUR = 3600_000;
// Something waiting for a person longer than this is worth a nudge
const WAITING_HOURS = 48;
// An invoice still "sending" after this long was cut off part-way
const STUCK_MINUTES = 10;

const ago = (iso, now) => (iso ? (now - Date.parse(iso)) / HOUR : 0);
const plural = (n, one, many = `${one}s`) => `${n} ${n === 1 ? one : many}`;
// Words in a drawn page or email that mean something didn't fill in
const BROKEN = /\bundefined\b|\bNaN\b|\[object Object\]|£-?NaN|Invalid Date/;

// A made-up invoice, for drawing every stage even before there are real ones (nothing about anyone)
function sampleRow(today) {
  return {
    id: 0, seq: 9999, token: "0".repeat(32), client_id: null, bill_name: "Sample Artist", bill_email: "sample@example.invalid", bill_address: "",
    lines: JSON.stringify([{ description: "Rap Package - 1 song", qty: 1, unit_pence: 10000 }, { description: "Mastering, per song", qty: 1, unit_pence: 5000 }]),
    vat_rate: 0, subtotal_pence: 15000, vat_pence: 0, total_pence: 15000, paid_pence: 0, issue_date: today, due_date: today, notes: "", status: "sent",
    created_by: "fixer", created_at: new Date().toISOString(), updated_at: new Date().toISOString(),
  };
}

async function check(group, name, area, severity, fn) {
  try {
    const r = await fn();
    if (r && typeof r === "object" && "fail" in r) return { group, name, area, severity: r.severity || severity, ok: false, detail: String(r.fail) };
    return { group, name, area, severity, ok: true, detail: String(r ?? "fine") };
  } catch (err) {
    return { group, name, area, severity, ok: false, detail: `couldn't check: ${String(err?.message || err).slice(0, 200)}` };
  }
}
const fail = (text, severity) => ({ fail: text, severity });
const rows = async (env, sql, ...binds) => (await env.DB.prepare(sql).bind(...binds).all()).results || [];

export async function fixerHealth(env, now = Date.now()) {
  const today = ukToday(new Date(now));
  const settings = await readSettings(env);
  const iso = (hoursAgo) => new Date(now - hoursAgo * HOUR).toISOString();
  const checks = [];
  const add = async (...a) => checks.push(await check(...a));

  // ===== Invoices and their emails =====
  await add("Invoices", "Emails can go out", "server", "serious", () =>
    emailReady(env) ? "the mail server and a from address are set up" : fail("Invoices can't be emailed: Nova Bot needs the mail server (MAIL_API_URL, MAIL_KEY) and a from address (INVOICE_FROM or ENQUIRY_EMAIL_FROM)"),
  );
  await add("Invoices", "A way to pay", "server", "serious", async () => {
    const ways = [bankReady(settings) && "bank transfer", cardReady(env) && "card"].filter(Boolean);
    if (ways.length) return `clients can pay by ${ways.join(" and ")}`;
    const open = (await rows(env, "SELECT COUNT(*) AS n FROM invoices WHERE status IN ('sent', 'part_paid')"))[0]?.n || 0;
    return fail(
      `Clients have no way to pay on the invoice: add the studio's bank details in Portal → Money → Settings (or set up card payments).${open ? ` ${plural(open, "invoice is", "invoices are")} waiting to be paid.` : ""}`,
      open ? "serious" : "minor",
    );
  });
  await add("Invoices", "The invoice draws at every stage", "checks", "serious", async () => {
    const sample = sampleRow(today);
    const inv = { id: 0, number: invoiceNumber(sample.seq), status: "sent", billTo: { name: sample.bill_name, email: null, address: "" }, lines: JSON.parse(sample.lines).map((l) => ({ description: l.description, qty: l.qty, unitPence: l.unit_pence, totalPence: l.unit_pence * l.qty })), vatRate: 0, subtotalPence: 15000, vatPence: 0, totalPence: 15000, paidPence: 0, issueDate: today, dueDate: today, notes: "", pageUrl: null };
    const bad = [];
    for (const stage of STAGES) for (const mode of ["bright", "dark"]) {
      const html = invoiceDocument(stage === "paid" ? { ...inv, paidPence: 15000, status: "paid" } : inv, stage === "paid" ? [{ amountPence: 15000, paidOn: today, methodName: "Bank transfer" }] : [], stage, settings, today, { mode });
      if (!/NOVACANE/.test(html) || !/£150\.00/.test(html)) bad.push(`${stage} (${mode}): its amounts are missing`);
      else if (BROKEN.test(html)) bad.push(`${stage} (${mode}): "${html.match(BROKEN)[0]}" shows on it`);
    }
    return bad.length ? fail(`The invoice doesn't draw right: ${bad.join("; ")}`) : `all ${STAGES.length} stages, bright and dark`;
  });
  await add("Invoices", "The client's invoice page", "checks", "serious", async () => {
    // The newest real one the client can see (its page as they'd see it), else the sample
    const real = (await rows(env, "SELECT i.*, NULL AS decided_by_name FROM invoices i WHERE status IN ('sent', 'part_paid', 'paid') ORDER BY id DESC LIMIT 1"))[0];
    const row = real || sampleRow(today);
    const html = await clientPage(env, row, settings, { nonce: "x" });
    if (!/NOVACANE/.test(html)) return fail(`${real ? invoiceNumber(row.seq) : "The sample invoice"}'s page doesn't show the invoice`);
    if (BROKEN.test(html)) return fail(`${real ? invoiceNumber(row.seq) : "The sample invoice"}'s page shows "${html.match(BROKEN)[0]}"`);
    return real ? `${invoiceNumber(row.seq)}'s page draws` : "the sample invoice's page draws";
  });
  await add("Invoices", "The invoice email", "checks", "serious", async () => {
    const email = invoiceEmail(env, settings, sampleRow(today));
    if (!email.subject || !email.text.includes("/invoice/") || !email.html.includes("/invoice/")) return fail("The invoice email has no link to the invoice's page");
    if (BROKEN.test(email.subject + email.text + email.html)) return fail(`The invoice email shows "${(email.subject + email.text + email.html).match(BROKEN)[0]}"`);
    return "it builds, with the link and the amounts";
  });
  await add("Invoices", "Nothing stuck sending", "server", "serious", async () => {
    const stuck = await rows(env, "SELECT seq FROM invoices WHERE (status = 'approved' AND updated_at < ?) OR status = 'failed'", iso(STUCK_MINUTES / 60));
    const rem = await rows(env, "SELECT r.id, i.seq FROM invoice_reminders r JOIN invoices i ON i.id = r.invoice_id WHERE (r.status = 'approved' AND r.updated_at < ?) OR r.status = 'failed'", iso(STUCK_MINUTES / 60));
    const parts = [...stuck.map((r) => `invoice ${invoiceNumber(r.seq)}`), ...rem.map((r) => `a reminder for ${invoiceNumber(r.seq)}`)];
    return parts.length ? fail(`Didn't send: ${parts.join(", ")}. Open it in the Invoicer or Portal → Money to see why and send it again.`) : "every approved email went";
  });
  await add("Invoices", "Paid amounts add up", "checks", "serious", async () => {
    const bad = await rows(
      env,
      `SELECT i.seq FROM invoices i LEFT JOIN (SELECT invoice_id, SUM(amount_pence) AS s FROM invoice_payments WHERE removed_at IS NULL GROUP BY invoice_id) p ON p.invoice_id = i.id
       WHERE i.status != 'void' AND (COALESCE(p.s, 0) != i.paid_pence OR (i.paid_pence >= i.total_pence AND i.total_pence > 0 AND i.status NOT IN ('paid')) OR (i.status = 'paid' AND i.paid_pence < i.total_pence))`,
    );
    return bad.length ? fail(`The paid amount doesn't match the payments on ${bad.map((r) => invoiceNumber(r.seq)).join(", ")}`) : "every invoice's payments add up";
  });
  await add("Invoices", "Overdue invoices", "server", "minor", async () => {
    const due = await rows(
      env,
      `SELECT i.seq, i.due_date FROM invoices i WHERE i.status IN ('sent', 'part_paid') AND i.due_date < ?
       AND NOT EXISTS (SELECT 1 FROM invoice_reminders r WHERE r.invoice_id = i.id AND r.created_at > ?)`,
      today,
      iso(7 * 24),
    );
    if (!due.length) return "none without a recent reminder";
    const days = (d) => Math.round((Date.parse(today) - Date.parse(d)) / (24 * HOUR));
    return fail(`Overdue with no reminder this week: ${due.map((r) => `${invoiceNumber(r.seq)} (${plural(days(r.due_date), "day")})`).join(", ")}. Open it in the Invoicer, choose Overdue and press Send for approval.`);
  });
  await add("Invoices", "Waiting for an admin", "server", "minor", async () => {
    const inv = await rows(env, "SELECT seq FROM invoices WHERE status = 'pending_approval' AND COALESCE(submitted_at, created_at) < ?", iso(WAITING_HOURS));
    const rem = (await rows(env, "SELECT COUNT(*) AS n FROM invoice_reminders WHERE status = 'pending_approval' AND created_at < ?", iso(WAITING_HOURS)))[0]?.n || 0;
    const parts = [...(inv.length ? [`invoice${inv.length === 1 ? "" : "s"} ${inv.map((r) => invoiceNumber(r.seq)).join(", ")}`] : []), ...(rem ? [plural(rem, "reminder")] : [])];
    return parts.length ? fail(`Waiting more than ${WAITING_HOURS} hours for an admin's Approve: ${parts.join(" and ")}`) : "nothing waiting long";
  });

  // ===== The rest of Nova Bot =====
  await add("Nova Bot", "Database", "server", "serious", async () => {
    const n = (await rows(env, "SELECT COUNT(*) AS n FROM sqlite_master WHERE type = 'table'"))[0]?.n || 0;
    return n > 10 ? `${n} tables` : fail(`the database looks empty (${n} tables)`);
  });
  await add("Nova Bot", "Enquiry emails", "server", "serious", () =>
    mailReady(env) && String(env.ENQUIRY_EMAIL_TO || "").trim() ? "set up" : fail("New enquiries can't be emailed to the studio (the mail server or ENQUIRY_EMAIL_TO isn't set up)"),
  );
  await add("Nova Bot", "Phone alerts", "server", "minor", () => (env.VAPID_PUBLIC_KEY && env.VAPID_PRIVATE_KEY ? "set up" : fail("Phone alerts can't be sent (VAPID keys missing)")));
  await add("Nova Bot", "Google", "server", "minor", async () => {
    const raw = (await rows(env, "SELECT value FROM settings WHERE key = 'google_status'"))[0]?.value;
    if (!raw) return "not connected";
    let status = {};
    try {
      status = JSON.parse(raw) || {};
    } catch {}
    const down = Object.entries(status).filter(([, v]) => v && typeof v === "object" && v.ok === false).map(([k]) => k);
    const late = Object.entries(status).filter(([, v]) => v && typeof v === "object" && v.ok && v.at && ago(v.at, now) > 6).map(([k, v]) => `${k} (${Math.round(ago(v.at, now))} h ago)`);
    if (down.length) return fail(`Google's ${down.join(", ")} ${down.length === 1 ? "isn't" : "aren't"} working (Portal → Admin → Google says why)`);
    if (late.length) return fail(`Google's ${late.join(", ")} haven't synced lately`);
    return `${Object.keys(status).length} parts working`;
  });
  await add("Nova Bot", "Other emails and posts", "server", "minor", async () => {
    const since = iso(24);
    const count = async (sql) => (await rows(env, sql, since))[0]?.n || 0;
    const failed = {
      "campaign email": await count("SELECT COUNT(*) AS n FROM email_campaigns WHERE status = 'failed' AND created_at > ?"),
      "outreach email": await count("SELECT COUNT(*) AS n FROM outreach_emails WHERE status = 'failed' AND updated_at > ?"),
      "enquiry reply": await count("SELECT COUNT(*) AS n FROM enquiry_messages WHERE status = 'failed' AND updated_at > ?"),
      "social post": await count("SELECT COUNT(*) AS n FROM social_posts WHERE status = 'failed' AND updated_at > ?"),
    };
    const bad = Object.entries(failed).filter(([, n]) => n).map(([k, n]) => plural(n, k));
    return bad.length ? fail(`Didn't go in the last day: ${bad.join(", ")} (Portal shows why)`) : "nothing failed in the last day";
  });
  await add("Nova Bot", "Approvals waiting", "server", "minor", async () => {
    const before = iso(WAITING_HOURS);
    const count = async (sql) => (await rows(env, sql, before))[0]?.n || 0;
    const waiting = {
      "social post": await count("SELECT COUNT(*) AS n FROM social_posts WHERE status = 'pending_approval' AND COALESCE(submitted_at, created_at) < ?"),
      "outreach email": await count("SELECT COUNT(*) AS n FROM outreach_emails WHERE status = 'pending_approval' AND COALESCE(submitted_at, created_at) < ?"),
      "email campaign": await count("SELECT COUNT(*) AS n FROM email_campaigns WHERE status = 'pending_approval' AND created_at < ?"),
      "booking change": await count("SELECT COUNT(*) AS n FROM booking_actions WHERE status = 'pending' AND updated_at < ?"),
    };
    const parts = Object.entries(waiting).filter(([, n]) => n).map(([k, n]) => plural(n, k));
    return parts.length ? fail(`Waiting more than ${WAITING_HOURS} hours for an admin: ${parts.join(", ")} (Portal → Approvals)`) : "nothing waiting long";
  });

  return { at: new Date(now).toISOString(), checks };
}

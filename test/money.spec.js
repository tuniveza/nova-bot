// Money (src/money.js): invoices that are only emailed after an admin's Approve in Portal, payments
// (staff, and Stripe's webhook), reminders that wait for an Approve too, expenses (the AI's come in
// unconfirmed), the client's invoice page, the totals and the accountant's CSV.
import { createExecutionContext, env, waitOnExecutionContext } from "cloudflare:test";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import worker from "../src";
import { invoiceHash, readLines, taxYear, totals } from "../src/money.js";
import { STAGES, stageEmail, stageOf, stageSums } from "../src/invoicer.js";
import { sha256 } from "../src/portal/auth.js";
import { makeStripe, stripeWebhook } from "./fakes.js";
import { STAFF_COOKIE } from "./sign-in.js";

const BASE = "https://novacane-worker.test";
const KEY = "agent-nova-test-key";
const EMAIL_ENV = { MAIL_KEY: "re_test_send_123", INVOICE_FROM: "Novacane Studios <studio@novacane.co.uk>" };

let emails; // bodies POSTed to the mail server's /emails
let stripe;
let emailFails;

beforeEach(async () => {
	await env.DB.batch([
		env.DB.prepare("DELETE FROM money_log"),
		env.DB.prepare("DELETE FROM invoice_reminders"),
		env.DB.prepare("DELETE FROM invoice_payments"),
		env.DB.prepare("DELETE FROM invoices"),
		env.DB.prepare("DELETE FROM expenses"),
		env.DB.prepare("DELETE FROM client_consent_log"),
		env.DB.prepare("DELETE FROM client_sessions"),
		env.DB.prepare("DELETE FROM clients"),
		env.DB.prepare("DELETE FROM settings"),
	]);
	emails = [];
	emailFails = false;
	stripe = makeStripe();
	vi.spyOn(globalThis, "fetch").mockImplementation(async (url, init = {}) => {
		const u = new URL(String(url));
		if (u.origin === "http://mail.test" && u.pathname === "/emails") {
			if (emailFails) return Response.json({ message: "domain not verified" }, { status: 422 });
			emails.push({ ...JSON.parse(init.body), key: init.headers["Idempotency-Key"] });
			return Response.json({ id: `email-${emails.length}` });
		}
		const s = await stripe.handle(String(url), init);
		if (s) return s;
		// Push services: accept
		if (/push\.apple\.com|fcm\.googleapis\.com/.test(String(url))) return new Response(null, { status: 201 });
		throw new Error("Unexpected fetch in test: " + url);
	});
});

afterEach(() => vi.restoreAllMocks());

async function call(request, extraEnv = EMAIL_ENV) {
	const ctx = createExecutionContext();
	const res = await worker.fetch(request, { ...env, AGENT_NOVA_KEY: KEY, ...extraEnv }, ctx);
	await waitOnExecutionContext(ctx);
	const text = await res.text();
	let data = null;
	try {
		data = JSON.parse(text);
	} catch {}
	return { status: res.status, data, text, headers: res.headers };
}

const agent = (path, body = {}) => call(new Request(BASE + path, { method: "POST", headers: { "Content-Type": "application/json", Authorization: `Bearer ${KEY}` }, body: JSON.stringify(body) }));

function portal(route, { body, headers = { Cookie: STAFF_COOKIE }, extraEnv } = {}) {
	const init = body === undefined ? { headers } : { method: "POST", headers: { "Content-Type": "application/json", Origin: BASE, ...headers }, body: JSON.stringify(body) };
	return call(new Request(`${BASE}/app/api/${route}`, init), extraEnv);
}

const row = (id) => env.DB.prepare("SELECT * FROM invoices WHERE id = ?").bind(id).first();
const LINES = [
	{ description: "Mixing, per song", qty: 2, unit: "150" },
	{ description: "Mastering", qty: 1, unit: "49.99" },
];

async function otherSignIns() {
	const now = new Date().toISOString();
	const until = new Date(Date.now() + 86_400_000).toISOString();
	await env.DB.batch([
		env.DB.prepare(
			"INSERT OR IGNORE INTO staff (id, email, password_hash, display_name, role, status, created_at, planet_seed, index_partition) VALUES ('test-staff', 'test-staff@novacane.test', NULL, 'Test Staff', 'staff', 'active', ?, 'test-staff', 'staff:test-staff')"
		).bind(now),
		env.DB.prepare("INSERT OR REPLACE INTO sessions (id, staff_id, kind, created_at, expires_at, last_seen_at) VALUES (?, 'test-staff', 'cookie', ?, ?, ?)").bind(await sha256("test-staff-session"), now, until, now),
		env.DB.prepare("INSERT OR REPLACE INTO sessions (id, staff_id, kind, created_at, expires_at, last_seen_at) VALUES (?, 'test-admin', 'token', ?, ?, ?)").bind(await sha256("nsess_test-admin-app"), now, until, now),
	]);
	return { staff: { Cookie: "nova_session=test-staff-session" }, adminToken: { Authorization: "Bearer nsess_test-admin-app" } };
}

async function addClient(name = "Ada Client", email = "ada@example.com") {
	const at = "2026-10-03T09:00:00.000Z";
	const { id } = await env.DB.prepare("INSERT INTO clients (name, email, source, created_at, updated_at) VALUES (?, ?, 'staff', ?, ?) RETURNING id").bind(name, email, at, at).first();
	return id;
}

async function write(fields = {}) {
	const { status, data } = await portal("money/invoices", { body: { billName: "Ada Client", billEmail: "ada@example.com", lines: LINES, ...fields } });
	expect(status).toBe(200);
	return data.invoice;
}

async function writeAndSend(fields = {}) {
	const inv = await write(fields);
	const sent = await portal(`money/invoices/${inv.id}/approve`, { body: {} });
	expect(sent.status).toBe(200);
	expect(sent.data.invoice.status).toBe("sent");
	return sent.data.invoice;
}

// ===== THE SUMS =====

describe("sums", () => {
	it("adds lines in whole pence and rounds VAT once, on the subtotal", () => {
		const { lines } = readLines([
			{ description: "Studio time", qty: 1.5, unit: "33.33" },
			{ description: "Tea", qty: 3, unitPence: 1 },
		]);
		// 1.5 × 3333 = 4999.5 -> 5000; + 3
		expect(totals(lines, 0)).toEqual({ subtotal_pence: 5003, vat_pence: 0, total_pence: 5003 });
		// 20% of 5003 = 1000.6 -> 1001
		expect(totals(lines, 20)).toEqual({ subtotal_pence: 5003, vat_pence: 1001, total_pence: 6004 });
		expect(readLines([]).problem).toMatch(/at least one line/);
		expect(readLines([{ description: "x", qty: 1, unit: "abc" }]).problem).toMatch(/price/);
		expect(readLines([{ description: "x", qty: 0.001, unit: "1" }]).problem).toMatch(/how many/);
	});

	it("knows the UK tax year (6 April to 5 April)", () => {
		expect(taxYear("2026-04-05")).toEqual({ from: "2025-04-06", to: "2026-04-05", name: "2025–26" });
		expect(taxYear("2026-04-06")).toEqual({ from: "2026-04-06", to: "2027-04-05", name: "2026–27" });
	});

	it("numbers invoices NS-0001, NS-0002… and totals them", async () => {
		const a = await write();
		const b = await write({ vatRate: 20 });
		expect(a.number).toBe("NS-0001");
		expect(b.number).toBe("NS-0002");
		expect(a).toMatchObject({ subtotalPence: 34999, vatPence: 0, totalPence: 34999, status: "pending_approval", pageUrl: null });
		expect(b).toMatchObject({ subtotalPence: 34999, vatPence: 7000, totalPence: 41999 });
	});
});

// ===== APPROVAL IS ENFORCED =====

describe("approval", () => {
	it("the AI's invoice waits; no agent-key route approves, sends, reminds, pays or voids", async () => {
		const { status, data } = await agent("/nova-agent/money/invoices/draft", { billName: "Ada Client", billEmail: "ada@example.com", lines: LINES, status: "sent", approved_hash: "x", paid_pence: 99999 });
		expect(status).toBe(200);
		const inv = data.invoice;
		expect(inv).toMatchObject({ status: "pending_approval", createdBy: "agent", paidPence: 0, decidedBy: null });
		for (const path of [
			`/nova-agent/money/invoices/${inv.id}/approve`,
			`/nova-agent/money/invoices/${inv.id}/send`,
			`/nova-agent/money/invoices/${inv.id}/payments`,
			`/nova-agent/money/invoices/${inv.id}/reminder`,
			`/nova-agent/money/invoices/${inv.id}/void`,
			"/nova-agent/money/invoices/test-send",
			"/nova-agent/money/settings",
			"/nova-agent/money/payments/1/remove",
		]) {
			expect((await agent(path, { id: inv.id, amount: "10" })).status).toBe(404);
		}
		// The agent's key on Portal's routes: not signed in
		const viaKey = await call(new Request(`${BASE}/app/api/money/invoices/${inv.id}/approve`, { method: "POST", headers: { Origin: BASE, Authorization: `Bearer ${KEY}` }, body: "{}" }));
		expect(viaKey.status).toBe(401);
		expect((await row(inv.id)).status).toBe("pending_approval");
		expect(emails).toEqual([]);
		// The agent can read and edit (it stays waiting)
		const edited = await agent(`/nova-agent/money/invoices/${inv.id}/edit`, { notes: "Thanks for the session!", status: "paid" });
		expect(edited.data.invoice).toMatchObject({ status: "pending_approval", notes: "Thanks for the session!" });
		expect((await agent("/nova-agent/money/context")).data.summary.invoicesWaiting).toBe(1);
	});

	it("only an admin with the browser cookie can approve, reject, void, test-send, take back payments or change settings", async () => {
		const inv = await write();
		const { staff, adminToken } = await otherSignIns();
		expect((await portal("money", { headers: staff })).data.canDecide).toBe(false);
		expect((await portal("money", { headers: adminToken })).data.canDecide).toBe(false);
		expect((await portal("money")).data.canDecide).toBe(true);
		for (const headers of [staff, adminToken]) {
			for (const route of [`money/invoices/${inv.id}/approve`, `money/invoices/${inv.id}/reject`, `money/invoices/${inv.id}/void`, "money/invoices/test-send", "money/settings", "money/payments/1/remove", "money/reminders/1/approve"]) {
				expect((await portal(route, { body: { id: inv.id }, headers })).status).toBe(403);
			}
			expect((await portal("money/export.csv?what=invoices", { headers })).status).toBe(403);
		}
		expect((await portal(`money/invoices/${inv.id}/approve`, { body: {}, headers: { Cookie: STAFF_COOKIE, Origin: "https://evil.example" } })).status).toBe(403);
		expect((await row(inv.id)).status).toBe("pending_approval");
		expect(emails).toEqual([]);
		// Staff can still write, edit and add expenses
		expect((await portal(`money/invoices/${inv.id}/edit`, { body: { dueDate: "2027-01-31" }, headers: staff })).status).toBe(200);
		expect((await portal("money/expenses", { body: { amount: "12.50", category: "Equipment" }, headers: staff })).status).toBe(200);
	});

	it("approving stores the hash, emails the client a link to the page, once; a second press does nothing", async () => {
		const inv = await write();
		const first = await portal(`money/invoices/${inv.id}/approve`, { body: {} });
		expect(first.data.invoice.status).toBe("sent");
		const saved = await row(inv.id);
		expect(saved.approved_hash).toBe(await invoiceHash(saved));
		expect(saved.decided_by).toBe("test-admin");
		expect(emails).toHaveLength(1);
		expect(emails[0].to).toEqual(["ada@example.com"]);
		expect(emails[0].subject).toBe("Invoice NS-0001 from Novacane Studios");
		expect(emails[0].text).toContain(`${BASE}/invoice/${saved.token}`);
		expect(emails[0].text).toContain("£349.99");
		expect(emails[0].key).toMatch(/^invoice-\d+-/);
		const again = await portal(`money/invoices/${inv.id}/approve`, { body: {} });
		expect(again.data.repeated).toBe(true);
		expect(emails).toHaveLength(1);
		// Sent ones can't change
		expect((await portal(`money/invoices/${inv.id}/edit`, { body: { notes: "x" } })).status).toBe(409);
	});

	it("won't send what changed after approval (the hash) and needs an email address", async () => {
		const inv = await write();
		// Approved, then changed behind its back
		await env.DB.prepare("UPDATE invoices SET status = 'approved', approved_hash = 'stale', updated_at = ? WHERE id = ?").bind(new Date().toISOString(), inv.id).run();
		const { sendApprovedInvoice } = await import("../src/money.js");
		const after = await sendApprovedInvoice({ ...env, ...EMAIL_ENV }, inv.id);
		expect(after.status).toBe("pending_approval");
		expect(emails).toEqual([]);
		const noEmail = await write({ billEmail: "" });
		expect((await portal(`money/invoices/${noEmail.id}/approve`, { body: {} })).status).toBe(409);
	});

	it("a mail server failure leaves it 'failed' with the reason; saving it again sends it for approval again", async () => {
		const inv = await write();
		emailFails = true;
		const res = await portal(`money/invoices/${inv.id}/approve`, { body: {} });
		expect(res.data.invoice.status).toBe("failed");
		expect(res.data.invoice.error).toMatch(/domain not verified/);
		const resaved = await portal(`money/invoices/${inv.id}/edit`, { body: {} });
		expect(resaved.data.invoice.status).toBe("pending_approval");
	});

	it("reject keeps the why; a rejected one can be edited back to waiting", async () => {
		const inv = await write();
		const r = await portal(`money/invoices/${inv.id}/reject`, { body: { note: "Wrong price" } });
		expect(r.data.invoice).toMatchObject({ status: "rejected", note: "Wrong price" });
		expect((await portal(`money/invoices/${inv.id}/approve`, { body: {} })).status).toBe(409);
		const e = await portal(`money/invoices/${inv.id}/edit`, { body: { lines: [{ description: "Mixing", qty: 1, unit: "120" }] } });
		expect(e.data.invoice).toMatchObject({ status: "pending_approval", totalPence: 12000 });
	});

	it("test-send goes only to the admin who pressed it, marked [TEST]", async () => {
		const inv = await write();
		const t = await portal("money/invoices/test-send", { body: { id: inv.id } });
		expect(t.status).toBe(200);
		expect(emails).toHaveLength(1);
		expect(emails[0].to).toEqual(["test-admin@novacane.test"]);
		expect(emails[0].subject).toMatch(/^\[TEST\]/);
		expect((await row(inv.id)).status).toBe("pending_approval");
	});
});

// ===== PAYMENTS AND THE CLIENT LIST =====

describe("payments", () => {
	it("part paid, then paid; the client's money fields follow; an admin can take a payment back", async () => {
		const clientId = await addClient();
		const inv = await writeAndSend({ clientId, billName: undefined, billEmail: undefined });
		expect(inv.billTo).toMatchObject({ name: "Ada Client", email: "ada@example.com" });
		let c = await env.DB.prepare("SELECT invoiced_pence, outstanding_pence FROM clients WHERE id = ?").bind(clientId).first();
		expect(c).toEqual({ invoiced_pence: 34999, outstanding_pence: 34999 });

		const part = await portal(`money/invoices/${inv.id}/payments`, { body: { amount: "100", method: "bank", paidOn: "2026-10-01" } });
		expect(part.data.invoice).toMatchObject({ status: "part_paid", paidPence: 10000, balancePence: 24999 });
		expect((await portal(`money/invoices/${inv.id}/payments`, { body: { amount: "300", method: "cash" } })).status).toBe(409); // more than what's left
		const rest = await portal(`money/invoices/${inv.id}/payments`, { body: { amount: "249.99", method: "cash" } });
		expect(rest.data.invoice).toMatchObject({ status: "paid", balancePence: 0 });
		c = await env.DB.prepare("SELECT outstanding_pence FROM clients WHERE id = ?").bind(clientId).first();
		expect(c.outstanding_pence).toBe(0);

		const detail = await portal(`money/invoices/${inv.id}`);
		const cash = detail.data.payments.find((p) => p.method === "cash");
		const back = await portal(`money/payments/${cash.id}/remove`, { body: {} });
		expect(back.data.invoice).toMatchObject({ status: "part_paid", paidPence: 10000 });
		c = await env.DB.prepare("SELECT outstanding_pence FROM clients WHERE id = ?").bind(clientId).first();
		expect(c.outstanding_pence).toBe(24999);
		// A paid one can't be voided until its payments are taken back
		expect((await portal(`money/invoices/${inv.id}/void`, { body: {} })).status).toBe(409);
	});

	it("voiding a sent, unpaid invoice takes it off the client's totals", async () => {
		const clientId = await addClient();
		const inv = await writeAndSend({ clientId, billName: undefined, billEmail: undefined });
		const v = await portal(`money/invoices/${inv.id}/void`, { body: { note: "Booked twice" } });
		expect(v.data.invoice.status).toBe("void");
		const c = await env.DB.prepare("SELECT invoiced_pence, outstanding_pence FROM clients WHERE id = ?").bind(clientId).first();
		expect(c).toEqual({ invoiced_pence: 0, outstanding_pence: 0 });
	});

	it("payments only go against a sent invoice", async () => {
		const inv = await write();
		expect((await portal(`money/invoices/${inv.id}/payments`, { body: { amount: "10" } })).status).toBe(409);
	});
});

// ===== THE CLIENT'S PAGE AND STRIPE =====

describe("the invoice page", () => {
	it("opens only by its random link, only once sent, with nothing but the token in the address", async () => {
		const inv = await write();
		const token = (await row(inv.id)).token;
		expect(token).toMatch(/^[0-9a-f]{32}$/);
		expect((await call(new Request(`${BASE}/invoice/${token}`))).status).toBe(404); // not sent yet
		await portal(`money/invoices/${inv.id}/approve`, { body: {} });
		const page = await call(new Request(`${BASE}/invoice/${token}`));
		expect(page.status).toBe(200);
		expect(page.text).toContain("Invoice NS-0001");
		expect(page.text).toContain("£349.99");
		expect(page.text).toContain("Print or save as PDF");
		expect(page.headers.get("Content-Security-Policy")).toMatch(/script-src 'nonce-/);
		expect((await call(new Request(`${BASE}/invoice/${"0".repeat(32)}`))).status).toBe(404);
		expect((await call(new Request(`${BASE}/invoice/${inv.id}`))).status).toBe(404);
	});

	it("shows the bank details from the settings, and a card button when Stripe is set up", async () => {
		await portal("money/settings", { body: { bank: { accountName: "Novacane Studios Ltd", sortCode: "12-34-56", accountNumber: "12345678" } } });
		expect((await portal("money/settings", { body: { bank: { sortCode: "12" } } })).status).toBe(400);
		const inv = await writeAndSend();
		const token = (await row(inv.id)).token;
		const page = await call(new Request(`${BASE}/invoice/${token}`));
		expect(page.text).toContain("12-34-56");
		expect(page.text).toContain("Pay £349.99 by card");
		// Without Stripe's keys: bank only
		const noCard = await call(new Request(`${BASE}/invoice/${token}`), { ...EMAIL_ENV, STRIPE_SECRET_KEY: "", STRIPE_WEBHOOK_SECRET: "" });
		expect(noCard.text).not.toContain("by card");
	});

	it("Pay by card opens Stripe's checkout for what's left; the webhook records it once and marks it paid", async () => {
		const inv = await writeAndSend();
		const token = (await row(inv.id)).token;
		const res = await call(new Request(`${BASE}/invoice/${token}/pay`, { method: "POST" }));
		expect(res.status).toBe(303);
		expect(res.headers.get("Location")).toMatch(/^https:\/\/checkout\.stripe\.com\//);
		expect(stripe.sessions[0].form["metadata[invoice_id]"]).toBe(String(inv.id));
		expect(stripe.sessions[0].form["line_items[0][price_data][unit_amount]"]).toBe("34999");
		const event = {
			id: "evt_inv_1",
			type: "checkout.session.completed",
			data: { object: { id: "cs_test_x", payment_status: "paid", amount_total: 34999, payment_intent: "pi_inv_1", metadata: { invoice_id: String(inv.id) }, client_reference_id: `invoice-${inv.id}` } },
		};
		expect((await call(await stripeWebhook(event))).status).toBe(200);
		expect((await call(await stripeWebhook(event))).status).toBe(200); // Stripe sends it again
		const after = await row(inv.id);
		expect(after.status).toBe("paid");
		expect(after.paid_pence).toBe(34999);
		const { n } = await env.DB.prepare("SELECT COUNT(*) AS n FROM invoice_payments WHERE invoice_id = ?").bind(inv.id).first();
		expect(n).toBe(1);
		// A Stripe payment can't be taken back here
		const p = await env.DB.prepare("SELECT id FROM invoice_payments WHERE invoice_id = ?").bind(inv.id).first();
		expect((await portal(`money/payments/${p.id}/remove`, { body: {} })).status).toBe(409);
	});
});

// ===== REMINDERS =====

describe("reminders", () => {
	it("a reminder waits for an admin, then emails the client once", async () => {
		const inv = await writeAndSend();
		const { staff } = await otherSignIns();
		const r = await portal(`money/invoices/${inv.id}/reminder`, { body: {}, headers: staff });
		expect(r.data.reminder).toMatchObject({ status: "pending_approval" });
		expect(r.data.reminder.body).toContain("NS-0001");
		expect((await portal(`money/invoices/${inv.id}/reminder`, { body: {} })).status).toBe(409); // one at a time
		expect((await portal(`money/reminders/${r.data.reminder.id}/approve`, { body: {}, headers: staff })).status).toBe(403);
		expect(emails).toHaveLength(1); // just the invoice
		const ok = await portal(`money/reminders/${r.data.reminder.id}/approve`, { body: {} });
		expect(ok.data.reminder.status).toBe("sent");
		expect(emails).toHaveLength(2);
		expect(emails[1].subject).toBe("Reminder: invoice NS-0001 from Novacane Studios");
		expect((await portal(`money/reminders/${r.data.reminder.id}/approve`, { body: {} })).data.repeated).toBe(true);
		expect(emails).toHaveLength(2);
	});

	it("no reminders for unsent invoices", async () => {
		const inv = await write();
		expect((await portal(`money/invoices/${inv.id}/reminder`, { body: {} })).status).toBe(409);
	});
});

// ===== EXPENSES, THE SUMMARY AND THE EXPORT =====

describe("expenses and totals", () => {
	it("the AI's expenses are unconfirmed and count in nothing until a person confirms them", async () => {
		const today = new Intl.DateTimeFormat("en-CA", { timeZone: "Europe/London" }).format(new Date());
		const a = await agent("/nova-agent/money/expenses", { amount: "20", category: "Travel", supplier: "TfL", status: "confirmed" });
		expect(a.data.expense).toMatchObject({ status: "unconfirmed", amountPence: 2000, createdBy: "agent" });
		await portal("money/expenses", { body: { amount: "99.99", category: "Equipment", supplier: "Thomann", spentOn: today } });
		let s = (await portal("money")).data.summary;
		expect(s.month.outPence).toBe(9999);
		expect(s.unconfirmedExpenses).toBe(1);
		await portal(`money/expenses/${a.data.expense.id}/confirm`, { body: {} });
		s = (await portal("money")).data.summary;
		expect(s.month.outPence).toBe(11999);
		expect(s.taxYear.outByCategory[0]).toEqual({ category: "Equipment", pence: 9999 });
		expect((await portal("money/expenses", { body: { amount: "5", category: "Sweets" } })).status).toBe(400);
		expect((await portal("money/expenses", { body: { amount: "5", category: "Other", receiptId: "../../etc/passwd" } })).status).toBe(400);
		expect((await portal("money/expenses", { body: { amount: "5", category: "Other", receiptId: "r-20261012-ab12cd34" } })).data.expense.receiptId).toBe("r-20261012-ab12cd34");
		await portal(`money/expenses/${a.data.expense.id}/delete`, { body: {} });
		s = (await portal("money")).data.summary;
		expect(s.month.outPence).toBe(9999 + 500);
	});

	it("counts money in, what's owed and what's overdue", async () => {
		const today = new Intl.DateTimeFormat("en-CA", { timeZone: "Europe/London" }).format(new Date());
		const late = await writeAndSend({ issueDate: "2026-01-01", dueDate: "2026-01-15" });
		await writeAndSend({ issueDate: today, dueDate: "2099-01-01" });
		await portal(`money/invoices/${late.id}/payments`, { body: { amount: "49.99", method: "bank", paidOn: today } });
		const s = (await portal("money")).data.summary;
		expect(s.month.inPence).toBe(4999);
		expect(s.owed).toEqual({ count: 2, pence: 30000 + 34999 });
		expect(s.overdue).toEqual({ count: 1, pence: 30000 });
		expect((await portal("money")).data.invoices.find((i) => i.id === late.id).overdue).toBe(true);
	});

	it("exports CSV for the accountant, with nothing a spreadsheet would run", async () => {
		await writeAndSend({ billName: "=HYPERLINK(\"x\")", issueDate: "2026-05-01", dueDate: "2026-05-15" });
		const res = await portal("money/export.csv?what=invoices&from=2026-04-06&to=2027-04-05");
		expect(res.status).toBe(200);
		expect(res.headers.get("Content-Type")).toMatch(/text\/csv/);
		expect(res.text.split("\r\n")[0]).toBe("Number,Issued,Due,Client,Subtotal (£),VAT %,VAT (£),Total (£),Paid (£),Balance (£),Status,Sent");
		expect(res.text).toContain(`"'=HYPERLINK(""x"")"`);
		expect((await portal("money/export.csv?what=secrets")).status).toBe(400);
	});
});

// ===== THE INVOICER (src/invoicer.js) =====

describe("the Invoicer", () => {
	it("works out each stage and its sums in whole pence", () => {
		const inv = { number: "NS-0007", status: "sent", totalPence: 40001, paidPence: 0, issueDate: "2026-10-01", dueDate: "2026-10-10", billTo: { name: "Ada Client" }, lines: [] };
		expect(stageOf(inv, "2026-10-05")).toBe("deposit");
		expect(stageOf(inv, "2026-10-11")).toBe("overdue");
		expect(stageOf({ ...inv, paidPence: 20001 }, "2026-10-05")).toBe("balance");
		expect(stageOf({ ...inv, paidPence: 40001, status: "paid" }, "2026-10-20")).toBe("paid");
		// 50% of £400.01, to the penny; the rest later
		const dep = stageSums(inv, [], "deposit", "2026-10-05");
		expect(dep).toMatchObject({ depositPence: 20001, dueNowPence: 20001, laterPence: 20000, dueBy: "2026-10-01" });
		expect(dep.dueNowPence + dep.laterPence).toBe(40001);
		const pays = [{ amountPence: 20001, paidOn: "2026-10-02", methodName: "Bank transfer" }, { amountPence: 500, paidOn: "2026-10-03", removed: true }];
		expect(stageSums(inv, pays, "balance", "2026-10-05")).toMatchObject({ paidPence: 20001, dueNowPence: 20000 });
		expect(stageSums(inv, pays, "overdue", "2026-10-13")).toMatchObject({ dueNowPence: 20000, daysOverdue: 3 });
		expect(stageSums(inv, pays, "paid", "2026-10-13").dueNowPence).toBe(0);
	});

	it("writes an email for each stage with the right amounts, and never an empty one", () => {
		const inv = { number: "NS-0007", status: "sent", totalPence: 40000, paidPence: 20000, issueDate: "2026-10-01", dueDate: "2026-10-10", billTo: { name: "Ada Client" }, lines: [], pageUrl: "https://nova.test/invoice/abc" };
		for (const stage of STAGES) {
			const email = stageEmail(inv, stageSums(inv, [], stage, "2026-10-13"), stage, {});
			expect(email.subject).toContain("NS-0007");
			expect(email.body.startsWith("Hi Ada,")).toBe(true);
			expect(email.body.split(/\s+/).length).toBeLessThan(140);
		}
		expect(stageEmail(inv, stageSums(inv, [], "deposit", "2026-10-05"), "deposit", {}).body).toContain("£200.00");
		expect(stageEmail(inv, stageSums(inv, [], "overdue", "2026-10-13"), "overdue", {}).body).toContain("3 days overdue");
		expect(stageEmail(inv, stageSums(inv, [], "paid", "2026-10-13"), "paid", {}).body).not.toContain("https://");
	});

	it("shows the price list from the booking rules, and an invoice at any stage (team only)", async () => {
		const list = await portal("money/catalogue");
		expect(list.status).toBe(200);
		expect(list.data.depositPercent).toBe(50);
		expect(list.data.services.find((s) => /Rap Package - 1 song/.test(s.name)).pricePence).toBe(10000);
		expect(list.data.services.some((s) => s.id === "master-3" && s.pricePence === 3000)).toBe(true);

		const inv = await writeAndSend();
		const auto = await portal(`money/invoices/${inv.id}/stage`);
		expect(auto.status).toBe(200);
		expect(auto.data).toMatchObject({ stage: "deposit", autoStage: "deposit" });
		expect(auto.data.sums.dueNowPence).toBe(17500); // half of £349.99, rounded
		await portal(`money/invoices/${inv.id}/payments`, { body: { amount: "175", method: "bank", paidOn: "2026-10-01" } });
		expect((await portal(`money/invoices/${inv.id}/stage`)).data.autoStage).toBe("balance");
		const doc = await portal(`money/invoices/${inv.id}/document?stage=paid`);
		expect(doc.status).toBe(200);
		expect(doc.headers.get("Content-Type")).toContain("text/html");
		expect(doc.text).toContain("PAID");
		expect(doc.text).toContain("£0.00");
		expect(doc.text).toContain("10 Clyde Terrace");
		expect(doc.text).toContain(`aria-label="Novacane Studios sigil"`); // the studio's emblem, drawn in the page (so it prints)
		const overdue = await portal(`money/invoices/${inv.id}/document?stage=overdue`);
		expect(overdue.text).toContain("Overdue notice");
		expect(overdue.text).toContain("£174.99");
		// Signed out: nothing
		expect((await portal(`money/invoices/${inv.id}/document`, { headers: {} })).status).toBe(401);
		expect((await portal("money/catalogue", { headers: {} })).status).toBe(401);
	});
});

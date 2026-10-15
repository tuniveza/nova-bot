// Nova Bot's health for the Fixer (src/fixer-health.js): plain checks, read-only, no names in its words.
import { createExecutionContext, env, waitOnExecutionContext } from "cloudflare:test";
import { beforeEach, describe, expect, it } from "vitest";
import worker from "../src";
import { fixerHealth } from "../src/fixer-health.js";

const KEY = "agent-nova-test-key";
const MAIL = { MAIL_API_URL: "http://mail.test", MAIL_KEY: "k", ENQUIRY_EMAIL_FROM: "Novacane Studios <hello@novacane.test>", ENQUIRY_EMAIL_TO: "studio@novacane.test" };

beforeEach(async () => {
	await env.DB.batch(["money_log", "invoice_reminders", "invoice_payments", "invoices", "settings"].map((t) => env.DB.prepare(`DELETE FROM ${t}`)));
});

const byName = (h) => Object.fromEntries(h.checks.map((c) => [c.name, c]));
async function invoice(fields = {}) {
	const now = new Date().toISOString();
	const f = { seq: 1, status: "sent", total: 20000, paid: 0, due: "2026-01-01", updated: now, ...fields };
	const r = await env.DB.prepare(
		`INSERT INTO invoices (seq, token, bill_name, bill_email, lines, subtotal_pence, vat_pence, total_pence, paid_pence, issue_date, due_date, status, created_by, created_at, updated_at)
		 VALUES (?, ?, 'Ada Client', 'ada@example.com', ?, ?, 0, ?, ?, '2025-12-20', ?, ?, 'test', ?, ?) RETURNING id`,
	).bind(f.seq, String(f.seq).padStart(32, "a"), JSON.stringify([{ description: "Mixing", qty: 1, unit_pence: f.total }]), f.total, f.total, f.paid, f.due, f.status, f.updated, f.updated).first();
	return r.id;
}

describe("Nova Bot's health for the Fixer", () => {
	it("draws the invoice at every stage, its page and its email, from a sample when there are none", async () => {
		const h = byName(await fixerHealth({ ...env, ...MAIL }));
		expect(h["The invoice draws at every stage"].ok).toBe(true);
		expect(h["The client's invoice page"].ok).toBe(true);
		expect(h["The invoice email"].ok).toBe(true);
		expect(h["Emails can go out"].ok).toBe(true);
	});

	it("says when there's no way to pay (serious once an invoice is waiting), and when there is", async () => {
		const NO_CARD = { ...MAIL, STRIPE_SECRET_KEY: "", STRIPE_WEBHOOK_SECRET: "" };
		expect(byName(await fixerHealth({ ...env, ...NO_CARD }))["A way to pay"]).toMatchObject({ ok: false, severity: "minor" });
		await invoice();
		const h = byName(await fixerHealth({ ...env, ...NO_CARD }))["A way to pay"];
		expect(h).toMatchObject({ ok: false, severity: "serious", area: "server" });
		expect(h.detail).toMatch(/Portal → Money → Settings/);
		await env.DB.prepare("INSERT INTO settings (key, value) VALUES ('money_settings', ?)").bind(JSON.stringify({ bank: { accountName: "Studio", sortCode: "12-34-56", accountNumber: "12345678" } })).run();
		expect(byName(await fixerHealth({ ...env, ...NO_CARD }))["A way to pay"].ok).toBe(true);
	});

	it("finds emails stuck sending, paid amounts that don't add up, and overdue invoices, by number only", async () => {
		await invoice({ seq: 1, status: "approved", updated: new Date(Date.now() - 3600_000).toISOString() });
		await invoice({ seq: 2, status: "sent", paid: 5000 }); // paid without a payment: doesn't add up; overdue too
		const h = byName(await fixerHealth({ ...env, ...MAIL }));
		expect(h["Nothing stuck sending"]).toMatchObject({ ok: false, severity: "serious" });
		expect(h["Nothing stuck sending"].detail).toContain("NS-0001");
		expect(h["Paid amounts add up"].detail).toContain("NS-0002");
		expect(h["Overdue invoices"].detail).toContain("NS-0002");
		const words = JSON.stringify(h);
		expect(words).not.toContain("Ada");
		expect(words).not.toContain("ada@example.com");
	});

	it("Google: a part that stopped, or one late for its own schedule (backups are nightly, so 10 hours is fine)", async () => {
		const at = (h) => new Date(Date.now() - h * 3600_000).toISOString();
		const put = (v) => env.DB.prepare("INSERT OR REPLACE INTO settings (key, value) VALUES ('google_status', ?)").bind(JSON.stringify(v)).run();
		await put({ backups: { ok: true, at: at(10) }, calendar: { ok: true, at: at(0.1) }, docs: { ok: true, at: at(50) } });
		expect(byName(await fixerHealth({ ...env, ...MAIL })).Google.ok).toBe(true);
		await put({ backups: { ok: true, at: at(30) }, calendar: { ok: false, at: at(0.1) } });
		const g = byName(await fixerHealth({ ...env, ...MAIL })).Google;
		expect(g.ok).toBe(false);
		expect(g.detail).toMatch(/calendar isn't working/);
	});

	it("says when emails can't go out", async () => {
		const h = byName(await fixerHealth({ ...env, MAIL_API_URL: "", MAIL_KEY: "" }));
		expect(h["Emails can go out"]).toMatchObject({ ok: false, severity: "serious" });
		expect(h["Enquiry emails"].ok).toBe(false);
	});

	it("is only for Nova Agent's key, and changes nothing", async () => {
		const ask = async (headers) => {
			const ctx = createExecutionContext();
			const res = await worker.fetch(new Request("https://novacane-worker.test/nova-agent/fixer-health", { method: "POST", headers }), { ...env, AGENT_NOVA_KEY: KEY, ...MAIL }, ctx);
			await waitOnExecutionContext(ctx);
			return res;
		};
		expect((await ask({})).status).toBe(401);
		const id = await invoice();
		const before = await env.DB.prepare("SELECT * FROM invoices WHERE id = ?").bind(id).first();
		const res = await ask({ Authorization: `Bearer ${KEY}` });
		expect(res.status).toBe(200);
		const body = await res.json();
		expect(body.checks.length).toBeGreaterThan(10);
		expect(body.checks.every((c) => ["checks", "server"].includes(c.area) && typeof c.ok === "boolean")).toBe(true);
		expect(await env.DB.prepare("SELECT * FROM invoices WHERE id = ?").bind(id).first()).toEqual(before);
	});
});

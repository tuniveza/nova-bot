// Pay with Monzo (17 Oct 2026): the studio's Monzo link on the invoice, its page and its email, with
// the amount due now and the invoice number filled in, in the invoice's own theme.
import { describe, expect, it } from "vitest";
import { INVOICE_THEMES, invoiceDocument, monzoLink, stageEmail, stageSums } from "../src/invoicer.js";
import { invoiceEmailParts } from "../src/invoice-email.js";

const invoice = { number: "NS-0007", issueDate: "2026-10-16", dueDate: "2026-10-30", lines: [{ description: "Session", qty: 1, unitPence: 20000, totalPence: 20000 }], subtotalPence: 20000, vatPence: 0, totalPence: 20000, paidPence: 0, status: "sent", billTo: { name: "Tina" }, look: {} };
const settings = { monzo: { link: "https://monzo.me/novacane" } };

describe("the Monzo link", () => {
	it("a monzo.me name gets the amount and the reference; another Monzo link opens as it is", () => {
		expect(monzoLink({ link: "https://monzo.me/novacane" }, 10000, "NS-0007")).toBe("https://monzo.me/novacane/100.00?d=NS-0007");
		expect(monzoLink({ link: "monzo.me/novacane/" }, 4999, "NS-0007")).toBe("https://monzo.me/novacane/49.99?d=NS-0007");
		expect(monzoLink({ link: "https://monzo.com/pay/r/abc" }, 10000, "NS-0007")).toBe("https://monzo.com/pay/r/abc");
		expect(monzoLink({ link: "" }, 10000, "NS-0007")).toBe("");
		expect(monzoLink(undefined, 10000, "NS-0007")).toBe("");
	});
});

describe("on the invoice", () => {
	it("the client's page: a Pay with Monzo button for what's due now (the deposit), in the theme's blend", () => {
		const html = invoiceDocument(invoice, [], "deposit", settings, "2026-10-16", { page: { cardForm: "", nonce: "n" } });
		expect(html).toContain('href="https://monzo.me/novacane/100.00?d=NS-0007"');
		expect(html).toContain("Pay £100.00 with Monzo");
		expect(html).toContain('class="monzo"');
		expect(html).toMatch(/a\.monzo\{[^}]*background:var\(--blend\)/);
	});
	it("under a card button it's the outline, in the theme's accent", () => {
		const html = invoiceDocument(invoice, [], "balance", settings, "2026-10-16", { page: { cardForm: "<form><button>Pay by card</button></form>", nonce: "n" } });
		expect(html).toContain('class="monzo second"');
		expect(html).toContain("Pay £200.00 with Monzo");
		expect(html).toMatch(/a\.monzo\.second\{[^}]*color:var\(--accent\)/);
	});
	it("in every theme and mode (the accent it takes is the theme's own)", () => {
		for (const t of INVOICE_THEMES)
			for (const mode of ["bright", "dark"]) {
				const html = invoiceDocument(invoice, [], "deposit", settings, "2026-10-16", { theme: t.id, mode });
				expect(html).toContain(`--accent:${mode === "dark" ? t.accentDark : t.accent}`);
				expect(html).toContain("monzo.me/novacane");
			}
	});
	it("on paper (the PDF): the link to type; never on a receipt; nothing when there's no link", () => {
		expect(invoiceDocument(invoice, [], "deposit", settings, "2026-10-16")).toContain('<span class="k">Monzo</span>');
		const paid = { ...invoice, paidPence: 20000, status: "paid" };
		expect(invoiceDocument(paid, [], "paid", settings, "2026-10-16")).not.toContain("monzo.me");
		expect(invoiceDocument(invoice, [], "deposit", {}, "2026-10-16")).not.toContain("monzo.me");
	});
});

describe("in the emails", () => {
	it("the stage email's words", () => {
		const e = stageEmail(invoice, stageSums(invoice, [], "deposit", "2026-10-16"), "deposit", settings);
		expect(e.body).toContain("Or pay with Monzo: https://monzo.me/novacane/100.00?d=NS-0007");
	});
	it("the emailed invoice: an outline button in the theme's accent, and the plain-text twin", () => {
		const night = INVOICE_THEMES.find((t) => t.id === "night");
		const e = invoiceEmailParts({ invoice, stage: "deposit", settings: { ...settings, invoiceTheme: "night" }, today: "2026-10-16", base: "https://novacane.test", link: "https://novacane.test/invoice/x" });
		expect(e.html).toContain("Pay £100.00 with Monzo");
		expect(e.html).toContain(`border:1.5px solid ${night.accent}`);
		expect(e.text).toContain("Pay with Monzo: https://monzo.me/novacane/100.00?d=NS-0007");
		const receipt = invoiceEmailParts({ invoice: { ...invoice, paidPence: 20000, status: "paid" }, stage: "paid", settings, today: "2026-10-16", base: "https://novacane.test", link: "x" });
		expect(receipt.text).not.toContain("Monzo");
	});
});

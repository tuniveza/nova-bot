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

describe("easy to pay on the client's page (18 Oct 2026)", () => {
	const bankSettings = { ...settings, bank: { accountName: "Neiman Brown", sortCode: "04-00-03", accountNumber: "12345678", note: "" } };
	const page = (sets, stage = "deposit", extra = {}) => invoiceDocument(invoice, [], stage, sets, "2026-10-16", { page: { cardForm: "", nonce: "n", ...extra } });
	it("a big Pay with Monzo button straight under the amount, saying what it does", () => {
		const html = page(bankSettings);
		const quick = html.indexOf('class="quickpay"');
		expect(quick).toBeGreaterThan(html.indexOf('class="amount'));
		expect(quick).toBeLessThan(html.indexOf("<table>"));
		expect(html).toContain('<a aria-describedby="quickpay-help" class="monzo" href="https://monzo.me/novacane/100.00?d=NS-0007"');
		expect(html).toContain('id="quickpay-help">Opens Monzo with £100.00 and NS-0007 filled in.<br>No Monzo? <a href="#bank">Pay by bank transfer</a>.');
		expect(html).toMatch(/\.quickpay a\.monzo,[^{]*\{[^}]*min-height:52px/);
		expect(html).toMatch(/a\.monzo:focus-visible[^{]*\{outline:3px solid/);
		// (still in How to pay too)
		expect(html.split("Pay £100.00 with Monzo").length).toBe(3);
	});
	it("Monzo's M as a quiet pattern behind the words (no big M), a lighter shade of the theme's colours", () => {
		const html = page(bankSettings);
		expect(html).toContain('<a aria-describedby="quickpay-help" class="monzo" href="https://monzo.me/novacane/100.00?d=NS-0007" rel="noopener"><span class="nvsky" aria-hidden="true"></span><span class="mzwash" aria-hidden="true"></span><span class="mzgap" aria-hidden="true"></span><span class="mzgrain" aria-hidden="true"></span><span class="mzcorners" aria-hidden="true"></span><span class="mzgapglass" aria-hidden="true"></span><span class="mzshine" aria-hidden="true"></span>Pay £100.00 with Monzo</a>');
		// (Novacane's sky merged over it: its nebula glow, blended in; no stars or sparkles)
		expect(html).toMatch(/\.nvsky\{position:absolute;inset:0;z-index:-1;background:radial-gradient[^}]*mix-blend-mode:screen/);
		expect(html).not.toMatch(/\.nvsky\{[^}]*url\(/);
		// (no inner border: what filled the gap, stripes under glass, now fills the whole button)
		expect(html).not.toMatch(/mzinner|mzstripes/);
		expect(html).toMatch(/\.mzgap,\.mzgapglass\{position:absolute;inset:0;z-index:-1;border-radius:inherit;pointer-events:none\}/);
		expect(html).not.toMatch(/clip-path:polygon\(evenodd/);
		// (Monzo's stripes across the whole button, cut away where the M's sit, and its colours washed over it lightly)
		expect(html).toMatch(/\.mzgap\{background:repeating-linear-gradient\(135deg,#FF6E5A 0 1\.5px,transparent 1\.5px 4px,[^}]*mix-blend-mode:overlay;[^}]*mask:linear-gradient\(#000 0 0\) exclude,url\("data:image\/svg\+xml,[^"]*M4\.244[^}]*auto 100% round/);
		// (the words kept crisp over the busy texture: a soft shadow in the theme's own colour)
		expect(html).toMatch(/\.paynow a\.monzo:not\(\.second\)\{background:linear-gradient\(90deg,#[0-9A-F]{6},#[0-9A-F]{6}\);text-shadow:0 1px 2px/);
		// (the gradient's darker end lifted towards white, so it runs lighter)
		const [left, right] = html.match(/\.paynow a\.monzo:not\(\.second\)\{background:linear-gradient\(90deg,(#[0-9A-F]{6}),(#[0-9A-F]{6})\)/).slice(1);
		const accents = [html.match(/--accent:(#[0-9A-Fa-f]{6})/)[1], html.match(/--accent2:(#[0-9A-Fa-f]{6})/)[1]].map((h) => h.toUpperCase());
		expect([left, right].filter((h, i) => h === accents[i]).length).toBe(1);
		// (a texture on the outer border: a speckle of grain and a fine crosshatch)
		expect(html).toMatch(/\.paynow a\.monzo::after\{[^}]*background:url\("data:image\/svg\+xml,[^"]*feTurbulence[^}]*repeating-linear-gradient\(45deg,[^}]*repeating-linear-gradient\(135deg,/);
		// (the M's over the stripes, so they come through)
		expect(html.indexOf('class="mzgrain"')).toBeGreaterThan(html.indexOf('class="mzgap"'));
		expect(html).toMatch(/\.mzwash\{[^}]*linear-gradient\(100deg,#FF6E5A 0%,#FFC453 32%,#5BD0B8 66%,#4AA3DF 100%\)[^}]*mix-blend-mode:soft-light/);
		expect(html).toMatch(/\.mzgap\{background:repeating-linear-gradient\(135deg,#FF6E5A[^}]*#4AA3DF/);
		expect(html).toContain("@media (prefers-reduced-motion:reduce){.mzgapglass{transition:none}}");
		expect(html).not.toMatch(/mzring|mzglass\b/);
		expect(html).not.toContain('class="mz"');
		// (a fine grain of tiny M's over the whole button: thirty a tile, each turned its own way, eight shades)
		expect(html).toMatch(/\.mzgrain\{[^}]*background:url\("data:image\/svg\+xml,[^"]*M4\.244[^}]*auto 100% round;/);
		const pattern = decodeURIComponent(html.match(/\.mzgrain\{[^}]*?background:url\("data:image\/svg\+xml,([^"]+)"/)[1]);
		// (in drastically different sizes: from near the button's height down to a couple of pixels)
		const sizes = [...pattern.matchAll(/scale\(([\d.]+)\)/g)].map((m) => Number(m[1]));
		expect(pattern.split("M4.244").length - 1).toBe(sizes.length);
		expect(sizes.length).toBeGreaterThan(24);
		expect(Math.max(...sizes) / Math.min(...sizes)).toBeGreaterThan(10);
		expect(new Set([...pattern.matchAll(/fill="(#[0-9A-F]{6})"/g)].map((m) => m[1])).size).toBe(8);
		expect(new Set([...pattern.matchAll(/rotate\((-?\d+)\)/g)].map((m) => m[1])).size).toBeGreaterThan(15);
		// (no money in it any more)
		for (const piece of ["M3 6h18a2 2", "M12 2a10 10", "M3 6a9 3.5"]) expect(pattern).not.toContain(piece);
		expect(html).toMatch(/\.monzo\.second \.mzgrain\{background-image:url\("data:image\/svg\+xml,/);
		// (Monzo's line stripes in the four corners, two ways)
		expect(html).toMatch(/\.mzcorners::before\{background:repeating-linear-gradient\(45deg,#FF6E5A[^}]*#4AA3DF[^}]*circle at 0 0[^}]*circle at 100% 100%/);
		expect(html).toMatch(/\.mzcorners::after\{background:repeating-linear-gradient\(135deg,[^}]*circle at 100% 0[^}]*circle at 0 100%/);
		// (a reflective sheen and shine over it all, its glints drifting only on hover or focus)
		expect(html).toMatch(/\.mzshine\{[^}]*linear-gradient\(180deg,rgba\(255,255,255,\.34\)[^}]*linear-gradient\(110deg/);
		expect(html).toContain("@media (prefers-reduced-motion:reduce){.mzshine{transition:none}}");
		// (its thick border fades from the M's ink on the left)
		expect(html).toMatch(/\.paynow a\.monzo::after\{[^}]*padding:3px;background:url[^}]*linear-gradient\(90deg,currentColor 0%/);
	});
	it("no bank details: no bank line; a Monzo payment link (no amount): just 'Opens Monzo to pay.'", () => {
		expect(page(settings)).not.toContain("No Monzo?");
		expect(page({ monzo: { link: "https://monzo.com/pay/r/abc" } })).toContain('id="quickpay-help">Opens Monzo to pay.</p>');
	});
	it("Copy buttons by the sort code, account number and reference (shown by the script where it can copy)", () => {
		const html = page(bankSettings);
		expect(html).toContain('data-copy="040003" aria-label="Copy sort code" hidden>Copy</button>');
		expect(html).toContain('data-copy="12345678" aria-label="Copy account number" hidden>Copy</button>');
		expect(html).toContain('data-copy="NS-0007" aria-label="Copy reference" hidden>Copy</button>');
		expect(html).toContain('role="status" aria-live="polite"');
	});
	it("not on paper, a receipt, or with nothing due", () => {
		const paper = invoiceDocument(invoice, [], "deposit", bankSettings, "2026-10-16");
		expect(paper).not.toContain('class="quickpay"');
		expect(paper).not.toContain('class="copy"');
		expect(page(bankSettings, "paid")).not.toContain('class="quickpay"');
		expect(page({})).not.toContain('class="quickpay"');
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

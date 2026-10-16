// The invoice's words, one sentence to a line (16 Oct 2026): a line breaks after a full stop, never
// carrying the first words of the next sentence with it.
import { describe, expect, it } from "vitest";
import { sentenceLines } from "../src/invoicer.js";

describe("each sentence on a line of its own", () => {
	it("breaks after a full stop, an exclamation or a question", () => {
		expect(sentenceLines("Thanks for booking. Your session is on Saturday! Any questions? Just ask.")).toBe("Thanks for booking.\nYour session is on Saturday!\nAny questions?\nJust ask.");
	});
	it("only where a new sentence starts: not inside a price, a time or after a lower-case word", () => {
		expect(sentenceLines("It costs £150.00 for 4 hrs. e.g. mixing")).toBe("It costs £150.00 for 4 hrs. e.g. mixing");
		expect(sentenceLines("Starts 11.30am. £50 paid.")).toBe("Starts 11.30am.\n£50 paid.");
	});
	it("as <br> where it's asked for", () => {
		expect(sentenceLines("Paid. Thank you.", "<br>")).toBe("Paid.<br>Thank you.");
	});
});

describe("the emailed invoice too", () => {
	it("its message, its notes and its plain-text twin: a sentence to a line", async () => {
		const { invoiceEmailParts } = await import("../src/invoice-email.js");
		const invoice = { number: "NS-0001", issueDate: "2026-10-16", dueDate: "2026-10-30", lines: [{ description: "Session", qty: 1, unitPence: 10000, totalPence: 10000 }], subtotalPence: 10000, vatPence: 0, totalPence: 10000, depositPercent: 50, billTo: { name: "Tina" }, notes: "Bring your stems. Parking is free after 6pm.", look: {} };
		const e = invoiceEmailParts({ invoice, stage: "deposit", settings: {}, today: "2026-10-16", base: "https://novacane.test", link: "https://novacane.test/invoice/x", greeting: "Hi Tina,", paragraphs: ["Thank you for booking with Novacane Studios. Your invoice is below."] });
		expect(e.html).toContain("Thank you for booking with Novacane Studios.<br>Your invoice is below.");
		expect(e.html).toContain("Bring your stems.<br>Parking is free after 6pm.");
		expect(e.text).toContain("Thank you for booking with Novacane Studios.\nYour invoice is below.");
		expect(e.text).toContain("Notes: Bring your stems.\nParking is free after 6pm.");
	});
});

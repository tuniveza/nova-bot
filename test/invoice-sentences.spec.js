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

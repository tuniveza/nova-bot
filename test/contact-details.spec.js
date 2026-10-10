// NovaBot never sends anything to the studio for a reply without a name, an email and a mobile number
import { env } from "cloudflare:test";
import { beforeEach, describe, expect, it } from "vitest";
import { mobileNumber, sendEnquiry } from "../src/enquiries.js";
import { asksForReplyDetails } from "../src/index.js";

const visitor = { chatId: "chat-contact-0001", page: "/services", ip: "203.0.113.77" };
const base = { name: "Sam Singer", email: "sam@example.com", details: "Six-track album, vocals only, dates in November." };
const send = (extra) => sendEnquiry(env, { ...base, ...extra }, visitor, () => {});
const saved = async () => (await env.DB.prepare("SELECT name, email, phone FROM enquiries WHERE chat_id = ?").bind(visitor.chatId).all()).results;

beforeEach(async () => {
	await env.DB.prepare("DELETE FROM enquiries").run();
});

describe("a reply needs a name, an email and a mobile number", () => {
	it("no mobile number: not sent, and NovaBot is told to ask for it", async () => {
		const r = await send({});
		expect(r.sent).toBe(false);
		expect(r.message).toMatch(/mobile number is missing/);
		expect(await saved()).toEqual([]);
	});

	it("no name or no email: not sent", async () => {
		expect((await send({ name: "", phone: "07700 900123" })).sent).toBe(false);
		expect((await send({ email: "", phone: "07700 900123" })).sent).toBe(false);
		expect(await saved()).toEqual([]);
	});

	it("a number that isn't a mobile: not sent", async () => {
		for (const phone of ["0161 496 0000", "12345", "call me", "+44 161 496 0000"]) {
			const r = await send({ phone });
			expect(r.sent, phone).toBe(false);
			expect(r.message).toMatch(/mobile number/);
		}
		expect(await saved()).toEqual([]);
	});

	it("all three: sent, with the number as they wrote it", async () => {
		const r = await send({ phone: "07700 900123" });
		expect(r.sent).toBe(true);
		expect(await saved()).toEqual([{ name: "Sam Singer", email: "sam@example.com", phone: "07700 900123" }]);
	});

	it("UK mobiles however they're written, and numbers from abroad with their country code", () => {
		expect(mobileNumber("07700 900123")).toBe("07700900123");
		expect(mobileNumber("+44 7700 900123")).toBe("+447700900123");
		expect(mobileNumber("0044 (7700) 900-123")).toBe("+447700900123");
		expect(mobileNumber("+353 85 123 4567")).toBe("+353851234567");
		expect(mobileNumber("01614960000")).toBe("");
		expect(mobileNumber("")).toBe("");
	});
});

describe("the chat page's booking-card rule leaves enquiry questions alone", () => {
	it("knows a question about replying from a booking question", () => {
		expect(asksForReplyDetails("So the team can get back to you, what's your name, email and mobile number?")).toBe(true);
		expect(asksForReplyDetails("What's your email and phone number?")).toBe(false);
	});
});

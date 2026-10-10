// WhatsApp, texts and calls from the person's own phone (src/enquiry-replies.js staffLogged),
// and Portal's "How it works" list (src/services.js).
import { createExecutionContext, env, waitOnExecutionContext } from "cloudflare:test";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import worker from "../src";
import { dialNumber } from "../src/enquiries.js";
import { STAFF_COOKIE } from "./sign-in.js";

const BASE = "https://novacane-worker.test";
const AGENT_KEY = "agent-nova-test-key";
const EMAIL_ENV = { RESEND_API_KEY: "re_test_key", ENQUIRY_EMAIL_TO: "studio@novacane.test", ENQUIRY_EMAIL_FROM: "Novacane Studios <hello@novacane.test>" };

let resendCalls = [];
beforeEach(async () => {
	resendCalls = [];
	vi.spyOn(globalThis, "fetch").mockImplementation(async (url, init) => {
		if (String(url) === "https://api.resend.com/emails") {
			resendCalls.push(JSON.parse(init.body));
			return new Response(JSON.stringify({ id: "email_1" }), { status: 200 });
		}
		throw new Error("Unexpected fetch in test: " + url);
	});
	await env.DB.batch([
		env.DB.prepare("DELETE FROM enquiry_messages"),
		env.DB.prepare("DELETE FROM enquiries"),
		env.DB.prepare("DELETE FROM settings WHERE key LIKE 'test_email_%'"),
	]);
});
afterEach(() => vi.restoreAllMocks());

async function addEnquiry(extra = {}) {
	const e = { name: "Jordan Test", email: "jordan@example.com", phone: "07700 900123", ...extra };
	const { meta } = await env.DB.prepare(
		"INSERT INTO enquiries (created_at, name, email, phone, subject, details, page, consent_at, consent_source) VALUES ('2026-10-09T23:30:00.000Z', ?, ?, ?, 'EP mixing', 'Mixing 4 tracks next month', '/', '2026-10-09T23:30:00.000Z', 'NovaBot chat')"
	)
		.bind(e.name, e.email, e.phone)
		.run();
	return meta.last_row_id;
}

async function app(path, { body, headers = { Cookie: STAFF_COOKIE }, extraEnv = EMAIL_ENV } = {}) {
	const ctx = createExecutionContext();
	const h = { ...headers };
	if (body !== undefined) Object.assign(h, { "Content-Type": "application/json", Origin: BASE });
	const res = await worker.fetch(
		new Request(BASE + "/app/api/" + path, { method: body !== undefined ? "POST" : "GET", headers: h, body: body !== undefined ? JSON.stringify(body) : undefined }),
		{ ...env, ...extraEnv },
		ctx
	);
	await waitOnExecutionContext(ctx);
	return { status: res.status, data: await res.json() };
}

const thread = async (id) => (await app("enquiries/thread?id=" + id)).data;
const status = async (id) => env.DB.prepare("SELECT status FROM enquiries WHERE id = ?").bind(id).first("status");

describe("the number Call, Text and WhatsApp use", () => {
	it("is the full international number, whatever way it was typed", () => {
		expect(dialNumber("07700 900123")).toBe("+447700900123");
		expect(dialNumber("+44 7700 900123")).toBe("+447700900123");
		expect(dialNumber("0044 7700-900123")).toBe("+447700900123");
		expect(dialNumber("447700900123")).toBe("+447700900123");
		expect(dialNumber("+353 85 123 4567")).toBe("+353851234567");
		expect(dialNumber("01632 960000")).toBe(""); // a landline: no WhatsApp or texts
		expect(dialNumber("")).toBe("");
	});

	it("comes with each enquiry, for Portal's buttons", async () => {
		const id = await addEnquiry();
		expect((await thread(id)).enquiry.dial).toBe("+447700900123");
		const list = await app("enquiries?show=all");
		expect(list.data.enquiries[0].dial).toBe("+447700900123");
	});
});

describe("a WhatsApp message or text sent from the person's phone", () => {
	it("goes into the conversation as sent, from them, to the customer's number, and nothing is emailed", async () => {
		const id = await addEnquiry();
		const r = await app("enquiries/logged", { body: { id, kind: "whatsapp", body: "Hi Jordan, Tuesday works!", key: "press-whatsapp-1" } });
		expect(r.status).toBe(200);
		expect(r.data.message).toMatchObject({ direction: "out", channel: "whatsapp", status: "sent", body: "Hi Jordan, Tuesday works!", author_name: "Test Admin" });
		expect(resendCalls).toHaveLength(0);
		expect(await status(id)).toBe("replied");
		const row = await env.DB.prepare("SELECT sent_to, approved_by FROM enquiry_messages WHERE enquiry_id = ?").bind(id).first();
		expect(row).toEqual({ sent_to: "+447700900123", approved_by: "test-admin" });
	});

	it("is only written once, however many times the same press arrives", async () => {
		const id = await addEnquiry();
		const press = { id, kind: "sms", body: "See you Tuesday", key: "press-sms-1" };
		await Promise.all([app("enquiries/logged", { body: press }), app("enquiries/logged", { body: press })]);
		const again = await app("enquiries/logged", { body: press });
		expect(again.data.repeated).toBe(true);
		expect((await thread(id)).messages).toHaveLength(1);
	});

	it("needs what was sent", async () => {
		const id = await addEnquiry();
		const r = await app("enquiries/logged", { body: { id, kind: "whatsapp", body: "  " } });
		expect(r.status).toBe(400);
	});

	it("can't be recorded when they've asked not to be contacted, or there's no mobile", async () => {
		const stopped = await addEnquiry();
		await env.DB.prepare("UPDATE enquiries SET do_not_contact_at = '2026-10-10T09:00:00.000Z', do_not_contact_by = 'customer' WHERE id = ?").bind(stopped).run();
		expect((await app("enquiries/logged", { body: { id: stopped, kind: "whatsapp", body: "Hi" } })).status).toBe(409);
		const landline = await addEnquiry({ phone: "01632 960000" });
		expect((await app("enquiries/logged", { body: { id: landline, kind: "sms", body: "Hi" } })).status).toBe(409);
		expect((await thread(stopped)).messages).toHaveLength(0);
	});
});

describe("a call made from the person's phone", () => {
	it("is noted with how it went, and talking to them counts as replying", async () => {
		const id = await addEnquiry();
		const r = await app("enquiries/logged", { body: { id, kind: "call", outcome: "spoke", body: "Booked in for Tuesday 2pm" } });
		expect(r.data.message).toMatchObject({ direction: "note", body: "Phone call: Spoke to them\nBooked in for Tuesday 2pm" });
		expect(await status(id)).toBe("replied");
	});

	it("a missed call is noted but the enquiry still needs a reply", async () => {
		const id = await addEnquiry();
		await app("enquiries/logged", { body: { id, kind: "call", outcome: "no-answer" } });
		expect((await thread(id)).messages[0].body).toBe("Phone call: No answer");
		expect(await status(id)).toBe("new");
	});

	it("needs to know how it went", async () => {
		const id = await addEnquiry();
		expect((await app("enquiries/logged", { body: { id, kind: "call", outcome: "maybe" } })).status).toBe(400);
	});
});

describe("only signed-in staff can record contact", () => {
	it("refuses no sign-in, and Nova Agent's AI key", async () => {
		const id = await addEnquiry();
		expect((await app("enquiries/logged", { body: { id, kind: "whatsapp", body: "Hi" }, headers: {} })).status).toBe(401);
		const agent = await app("enquiries/logged", { body: { id, kind: "whatsapp", body: "Hi" }, headers: { Authorization: `Bearer ${AGENT_KEY}` }, extraEnv: { ...EMAIL_ENV, AGENT_NOVA_KEY: AGENT_KEY } });
		expect(agent.status).toBe(401);
		expect((await thread(id)).messages).toHaveLength(0);
	});
});

describe("How it works", () => {
	it("says what each part runs on and whether it's set up, without giving away any key", async () => {
		const r = await app("services", { extraEnv: { ...EMAIL_ENV, ANTHROPIC_API_KEY: "sk-ant-secret-value", VAPID_PUBLIC_KEY: "pub", VAPID_PRIVATE_KEY: "priv-secret" } });
		expect(r.status).toBe(200);
		const email = r.data.services.find((s) => s.id === "email");
		expect(email).toMatchObject({ name: "Enquiry emails", tech: "Resend (resend.com)", ready: true, test: true });
		expect(email.detail).toContain("hello@novacane.test");
		expect(r.data.services.find((s) => s.id === "ai")).toMatchObject({ tech: "Anthropic Claude", ready: true });
		const text = JSON.stringify(r.data);
		for (const secret of ["re_test_key", "sk-ant-secret-value", "priv-secret"]) expect(text).not.toContain(secret);
	});

	it("says when email isn't set up", async () => {
		const r = await app("services", { extraEnv: {} });
		const email = r.data.services.find((s) => s.id === "email");
		expect(email.ready).toBe(false);
		expect(email.test).toBe(false);
	});

	it("needs a Portal sign-in", async () => {
		expect((await app("services", { headers: {} })).status).toBe(401);
	});

	it("Send me a test email goes to the person who pressed it, through Resend, at most once a minute", async () => {
		const r = await app("services/test-email", { body: {} });
		expect(r.status).toBe(200);
		expect(resendCalls).toHaveLength(1);
		expect(resendCalls[0]).toMatchObject({ to: ["test-admin@novacane.test"], from: "Novacane Studios <hello@novacane.test>" });
		const again = await app("services/test-email", { body: {} });
		expect(again.status).toBe(429);
		expect(resendCalls).toHaveLength(1);
	});

	it("Send me a test email says so when email isn't set up", async () => {
		const r = await app("services/test-email", { body: {}, extraEnv: {} });
		expect(r.status).toBe(409);
		expect(resendCalls).toHaveLength(0);
	});
});

import { createExecutionContext, env, waitOnExecutionContext } from "cloudflare:test";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import worker from "../src";
import { forgetSessionTypes } from "../src/booking.js";
import { BOOKING_PAGE_HTML } from "./acuity-page.js";

const BASE = "https://novacane-worker.test";
const SITE = "https://novacane.co.uk";

// ----- A fake Claude and a fake Resend -----

let claudeReplies = []; // what the fake Claude answers, in order
let claudeCalls = []; // what the Worker sent to Claude
let emails = []; // what the Worker sent to Resend

const text = (words) => ({ stop_reason: "end_turn", content: [{ type: "text", text: words }] });
const enquiryCall = (input, id = "toolu_1") => ({
	stop_reason: "tool_use",
	content: [
		{ type: "text", text: "Sending that now." },
		{ type: "tool_use", id, name: "send_enquiry", input },
	],
});

const GOOD_ENQUIRY = {
	name: "Sam Singer",
	email: "Sam@Example.com",
	phone: "07700 900123",
	subject: "Album recording, 6 tracks",
	details: "Six-track album, vocals only, two singers, would like dates in November.",
};

beforeEach(async () => {
	claudeReplies = [];
	claudeCalls = [];
	emails = [];
	forgetSessionTypes();
	vi.spyOn(globalThis, "fetch").mockImplementation(async (url, init) => {
		if (String(url).startsWith("https://app.acuityscheduling.com/schedule.php?owner=18510650")) {
			return new Response(BOOKING_PAGE_HTML, { headers: { "Content-Type": "text/html" } });
		}
		if (String(url) === "https://api.anthropic.com/v1/messages") {
			claudeCalls.push(JSON.parse(init.body));
			const next = claudeReplies.shift();
			if (!next) return new Response("overloaded", { status: 529 });
			return new Response(JSON.stringify(next), { headers: { "Content-Type": "application/json" } });
		}
		if (String(url) === "https://api.resend.com/emails") {
			emails.push(JSON.parse(init.body));
			return new Response(JSON.stringify({ id: "email_1" }), { headers: { "Content-Type": "application/json" } });
		}
		throw new Error("Unexpected fetch in test: " + url);
	});
	await env.DB.batch([env.DB.prepare("DELETE FROM enquiries"), env.DB.prepare("DELETE FROM chat_messages")]);
});

afterEach(() => {
	vi.restoreAllMocks();
});

// ----- Helpers -----

let visitorNumber = 0;

// Send a chat message like the website does. Each test gets its own IP so the
// rate limit doesn't carry between tests.
async function chat(messages, { origin = SITE, ip, chatId = "chat-test-0001", page = "/services", extraEnv = {} } = {}) {
	const ctx = createExecutionContext();
	const res = await worker.fetch(
		new Request(BASE, {
			method: "POST",
			headers: { "Content-Type": "application/json", Origin: origin, "CF-Connecting-IP": ip || `203.0.113.${++visitorNumber}` },
			body: JSON.stringify({ messages, chatId, page }),
		}),
		{ ...env, ...extraEnv },
		ctx
	);
	await waitOnExecutionContext(ctx);
	return { status: res.status, data: await res.json(), headers: res.headers };
}

const ask = (words) => [{ role: "user", content: words }];
const enquiries = async () => (await env.DB.prepare("SELECT * FROM enquiries ORDER BY id").all()).results;

const auth = { Authorization: "Basic " + btoa("studio:test-admin-password") };
const admin = (path, init = {}) => worker.fetch(new Request(BASE + path, { ...init, headers: { ...auth, ...(init.headers || {}) } }), env);

// ----- Tests -----

describe("chat", () => {
	it("answers from Claude, with the enquiry tool available", async () => {
		claudeReplies.push(text("We're in Forest Hill."));
		const { status, data } = await chat(ask("Where are you?"));
		expect(status).toBe(200);
		expect(data.reply).toBe("We're in Forest Hill.");
		// (book_session is only added while Nova Agent is online and live: book-session.spec.js)
		expect(claudeCalls[0].tools.map((tool) => tool.name)).toEqual(["send_enquiry", "booking_link", "check_availability"]);
		expect(claudeCalls[0].system[0].text).toContain("https://novacane.co.uk/bookings-contact#enquiry");
	});

	it("only offers to book for people when Nova Agent is connected", async () => {
		claudeReplies.push(text("ok"));
		await chat(ask("hi"), { extraEnv: { AGENT_NOVA_KEY: "" } });
		expect(claudeCalls[0].tools.map((tool) => tool.name)).toEqual(["send_enquiry", "booking_link", "check_availability"]);
		expect(claudeCalls[0].system[1].text).not.toContain("BOOKING IT FOR THEM");
	});

	it("only lets the Novacane website use it", async () => {
		expect((await chat(ask("hi"), { origin: "https://evil.example" })).status).toBe(403);
		expect((await chat(ask("hi"), { origin: "https://novabot.pages.dev" })).status).toBe(403);
		expect(claudeCalls).toHaveLength(0);
	});

	it("falls back to the booking link if Claude is down", async () => {
		const { data } = await chat(ask("hi"));
		expect(data.reply).toContain("https://novacane.co.uk/bookings-contact");
	});

	it("slows down a visitor sending too many messages", async () => {
		for (let i = 0; i < 20; i++) claudeReplies.push(text("ok"));
		const results = [];
		for (let i = 0; i < 21; i++) results.push(await chat(ask("hi " + i), { ip: "198.51.100.7" }));
		expect(results.slice(0, 20).every((r) => r.status === 200)).toBe(true);
		expect(results[20].status).toBe(429);
		expect(results[20].data.message).toMatch(/minute/);
		expect(claudeCalls).toHaveLength(20);
		// Someone else is unaffected
		claudeReplies.push(text("ok"));
		expect((await chat(ask("hi"))).status).toBe(200);
	});

	it("logs each question and answer", async () => {
		claudeReplies.push(text("Yes, a Neumann U87 Ai."));
		await chat(ask("What mic do you use?"), { chatId: "chat-log-1234", page: "/services" });
		const { results } = await env.DB.prepare("SELECT role, content, page FROM chat_messages WHERE chat_id = ? ORDER BY id")
			.bind("chat-log-1234")
			.all();
		expect(results).toEqual([
			{ role: "user", content: "What mic do you use?", page: "/services" },
			{ role: "assistant", content: "Yes, a Neumann U87 Ai.", page: "/services" },
		]);
	});
});

describe("enquiries", () => {
	it("sends a confirmed enquiry to the team", async () => {
		claudeReplies.push(enquiryCall(GOOD_ENQUIRY), text("Done! The team will email you."));
		const { data } = await chat(ask("Yes, send it"), { chatId: "chat-enq-0001", page: "/bookings-contact" });
		expect(data.reply).toBe("Done! The team will email you.");

		const saved = await enquiries();
		expect(saved).toHaveLength(1);
		expect(saved[0]).toMatchObject({
			name: "Sam Singer",
			email: "sam@example.com",
			phone: "07700 900123",
			subject: "Album recording, 6 tracks",
			page: "/bookings-contact",
			chat_id: "chat-enq-0001",
			status: "new",
			emailed: 0,
		});
		// The IP address isn't stored, only a hash of it
		expect(saved[0].sender).toMatch(/^[0-9a-f]{24}$/);

		// Claude was told it worked
		const toolResult = claudeCalls[1].messages.at(-1).content[0];
		expect(toolResult).toMatchObject({ type: "tool_result", tool_use_id: "toolu_1", is_error: false });
		expect(toolResult.content).toMatch(/^Sent/);
	});

	it("doesn't send an enquiry with a bad email or no details", async () => {
		claudeReplies.push(enquiryCall({ ...GOOD_ENQUIRY, email: "sam at example" }), text("Could you check your email?"));
		await chat(ask("Yes"));
		claudeReplies.push(enquiryCall({ ...GOOD_ENQUIRY, details: "album" }), text("What's it about?"));
		await chat(ask("Yes"));
		expect(await enquiries()).toHaveLength(0);
		expect(claudeCalls[1].messages.at(-1).content[0]).toMatchObject({ is_error: true });
		expect(claudeCalls[1].messages.at(-1).content[0].content).toMatch(/email/);
	});

	it("doesn't save the same enquiry twice", async () => {
		claudeReplies.push(enquiryCall(GOOD_ENQUIRY), text("Sent."), enquiryCall(GOOD_ENQUIRY), text("Already sent."));
		await chat(ask("Yes"));
		await chat(ask("Yes, send it"));
		expect(await enquiries()).toHaveLength(1);
		expect(claudeCalls[3].messages.at(-1).content[0].content).toMatch(/^Already sent/);
	});

	it("limits one visitor to 5 enquiries a day", async () => {
		for (let i = 0; i < 6; i++) {
			claudeReplies.push(enquiryCall({ ...GOOD_ENQUIRY, details: `Project number ${i} with plenty of detail` }), text("ok"));
			await chat(ask("Yes"), { ip: "198.51.100.50" });
		}
		expect(await enquiries()).toHaveLength(5);
		expect(claudeCalls.at(-1).messages.at(-1).content[0].content).toMatch(/too many/);
	});

	it("still confirms the enquiry if Claude fails after sending it", async () => {
		claudeReplies.push(enquiryCall(GOOD_ENQUIRY)); // then Claude is down
		const { data } = await chat(ask("Yes"));
		expect(await enquiries()).toHaveLength(1);
		expect(data.reply).toMatch(/enquiry is with the Novacane team/);
	});

	it("emails a copy to the studio when that's set up", async () => {
		claudeReplies.push(enquiryCall(GOOD_ENQUIRY), text("Sent."));
		await chat(ask("Yes"), { extraEnv: { RESEND_API_KEY: "re_test", ENQUIRY_EMAIL_TO: "studio@example.com" } });
		expect(emails).toHaveLength(1);
		expect(emails[0]).toMatchObject({ to: ["studio@example.com"], reply_to: "sam@example.com" });
		expect(emails[0].subject).toBe("NovaBot enquiry: Album recording, 6 tracks");
		expect(emails[0].text).toContain("Six-track album");
		expect((await enquiries())[0].emailed).toBe(1);
	});

	it("doesn't try to email when it isn't set up", async () => {
		claudeReplies.push(enquiryCall(GOOD_ENQUIRY), text("Sent."));
		await chat(ask("Yes"));
		expect(emails).toHaveLength(0);
	});
});

describe("admin: enquiries and conversations", () => {
	it("needs the password", async () => {
		expect((await worker.fetch(new Request(BASE + "/admin/enquiries"), env)).status).toBe(401);
		expect((await worker.fetch(new Request(BASE + "/admin/conversations"), env)).status).toBe(401);
	});

	it("lists enquiries safely and marks them done", async () => {
		claudeReplies.push(enquiryCall({ ...GOOD_ENQUIRY, name: "<script>alert(1)</script>" }), text("Sent."));
		await chat(ask("Yes"), { chatId: "chat-admin-0001" });
		const [enquiry] = await enquiries();

		let html = await (await admin("/admin/enquiries")).text();
		expect(html).toContain("Enquiries (1 new)");
		expect(html).toContain("Six-track album");
		expect(html).toContain("&lt;script&gt;");
		expect(html).not.toContain("<script>alert");
		expect(html).toContain("/admin/conversations?chat=chat-admin-0001");

		// Only from the admin page itself
		const post = (origin) =>
			admin("/admin/enquiries/status", {
				method: "POST",
				headers: { Origin: origin, "Content-Type": "application/x-www-form-urlencoded" },
				body: "id=" + enquiry.id,
			});
		expect((await post("https://evil.example")).status).toBe(403);
		expect((await post(BASE)).status).toBe(303);
		expect((await enquiries())[0].status).toBe("done");

		html = await (await admin("/admin/enquiries")).text();
		expect(html).toContain("No new enquiries");
		html = await (await admin("/admin/enquiries?show=all")).text();
		expect(html).toContain("Move back to new");
	});

	it("shows conversations and their transcripts", async () => {
		claudeReplies.push(text("£50 an hour."), text("Yes, 2 hours minimum."));
		await chat([{ role: "user", content: "How much is it?" }], { chatId: "chat-conv-0001" });
		await chat(
			[
				{ role: "user", content: "How much is it?" },
				{ role: "assistant", content: "£50 an hour." },
				{ role: "user", content: "Is there a minimum?" },
			],
			{ chatId: "chat-conv-0001", page: "/bookings-contact" }
		);

		let html = await (await admin("/admin/conversations")).text();
		expect(html).toContain("How much is it?");
		expect(html).toContain("/admin/conversations?chat=chat-conv-0001");

		html = await (await admin("/admin/conversations?chat=chat-conv-0001")).text();
		const order = ["How much is it?", "£50 an hour.", "Is there a minimum?", "Yes, 2 hours minimum."].map((s) => html.indexOf(s));
		expect(order.every((at) => at > 0)).toBe(true);
		expect([...order].sort((a, b) => a - b)).toEqual(order);
	});

	it("sends a test email from the enquiries page, and says when email isn't set up", async () => {
		const testEmail = (extraEnv = {}) =>
			worker.fetch(
				new Request(BASE + "/admin/enquiries/test-email", { method: "POST", headers: { ...auth, Origin: BASE, "Content-Type": "application/x-www-form-urlencoded" }, body: "" }),
				{ ...env, ...extraEnv }
			);
		let res = await testEmail();
		expect(decodeURIComponent(res.headers.get("Location"))).toMatch(/aren't set up yet/);
		expect(emails).toHaveLength(0);
		expect(await (await admin("/admin/enquiries")).text()).toContain("Email copies: <strong>off</strong>");

		res = await testEmail({ RESEND_API_KEY: "re_test", ENQUIRY_EMAIL_TO: "studio@example.com, odysi@example.com" });
		expect(decodeURIComponent(res.headers.get("Location"))).toMatch(/Test email sent to studio@example.com, odysi@example.com/);
		expect(emails[0]).toMatchObject({ to: ["studio@example.com", "odysi@example.com"], subject: "NovaBot test email" });
	});

	it("shows Resend's reason when an email can't be sent", async () => {
		globalThis.fetch.mockImplementation(async () =>
			new Response(JSON.stringify({ message: "You can only send testing emails to your own email address" }), { status: 403 })
		);
		const res = await worker.fetch(
			new Request(BASE + "/admin/enquiries/test-email", { method: "POST", headers: { ...auth, Origin: BASE, "Content-Type": "application/x-www-form-urlencoded" }, body: "" }),
			{ ...env, RESEND_API_KEY: "re_test", ENQUIRY_EMAIL_TO: "someone@example.com" }
		);
		expect(decodeURIComponent(res.headers.get("Location"))).toContain("only send testing emails to your own email address");
	});

	it("keeps the referrals page working with the new tabs", async () => {
		const html = await (await admin("/admin")).text();
		expect(html).toContain("Referral codes");
		expect(html).toContain('href="/admin/enquiries"');
		expect(html).toContain('href="/admin/conversations"');
	});
});

describe("privacy page", () => {
	it("shows the Nova Hub privacy policy to anyone", async () => {
		const res = await worker.fetch(new Request(BASE + "/privacy"), env);
		expect(res.status).toBe(200);
		expect(res.headers.get("Content-Type")).toBe("text/html; charset=utf-8");
		const html = await res.text();
		expect(html).toContain("<h1>Nova Hub – Privacy Policy</h1>");
		expect(html).toContain("Data is never sold");
	});
});

describe("sandbox mode", () => {
	const sandbox = { SANDBOX: "true", ANTHROPIC_API_KEY: "" };

	it("serves the demo page only in the sandbox", async () => {
		let res = await worker.fetch(new Request(BASE + "/"), { ...env, ...sandbox });
		expect(await res.text()).toContain("NovaBot sandbox");
		res = await worker.fetch(new Request(BASE + "/"), env);
		expect(await res.text()).toBe("Novacane chatbot is running.");
	});

	it("gives a labelled stand-in reply without an AI key, and lets local pages use it", async () => {
		const ctx = createExecutionContext();
		const res = await worker.fetch(
			new Request(BASE, {
				method: "POST",
				headers: { "Content-Type": "application/json", Origin: "http://localhost:9999", "CF-Connecting-IP": "203.0.113.250" },
				body: JSON.stringify({ messages: [{ role: "user", content: "hello" }] }),
			}),
			{ ...env, ...sandbox },
			ctx
		);
		await waitOnExecutionContext(ctx);
		expect(res.status).toBe(200);
		expect((await res.json()).reply).toMatch(/^🧪 Sandbox mode/);
		expect(claudeCalls).toHaveLength(0);
	});

	it("doesn't let local pages use the live chatbot", async () => {
		const res = await worker.fetch(
			new Request(BASE, { method: "POST", headers: { "Content-Type": "application/json", Origin: "http://localhost:9999" }, body: "{}" }),
			env
		);
		expect(res.status).toBe(403);
	});
});

describe("remembering the conversation", () => {
	it("passes NovaBot the whole of a long booking chat (the last 40 messages)", async () => {
		// A booking chat like the one that went in circles: the session, day and
		// time come first, then many questions and answers
		const messages = [{ role: "user", content: "I'd like to book a rap session on 1 December at 10am" }];
		for (let i = 0; i < 18; i++) {
			messages.push({ role: "assistant", content: `Question ${i}` }, { role: "user", content: `Answer ${i}` });
		}
		expect(messages).toHaveLength(37);
		claudeReplies.push({ stop_reason: "end_turn", content: [{ type: "text", text: "Booked." }] });

		await chat(messages);

		const sent = claudeCalls[0].messages;
		expect(sent).toHaveLength(37);
		expect(sent[0].content).toContain("1 December at 10am");
	});

	it("tells NovaBot never to ask again for something it's been told", async () => {
		claudeReplies.push({ stop_reason: "end_turn", content: [{ type: "text", text: "Hi." }] });
		await chat([{ role: "user", content: "Hi" }]);
		expect(claudeCalls[0].system[0].text).toContain("never ask again for something the customer has already told you");
	});
});

it("tells NovaBot to use everything in the first booking message", async () => {
	claudeReplies.push({ stop_reason: "end_turn", content: [{ type: "text", text: "Hi." }] });
	await chat([{ role: "user", content: "Hi, I'm Jordan, I'd like to book a rap session on 1 December, 2 hours" }]);
	const instructions = claudeCalls[0].system[0].text;
	expect(instructions).toContain("USE EVERYTHING THEY'VE ALREADY SAID");
	expect(instructions).toContain("ask only for what's still missing,\n  all together in ONE message");
	expect(instructions).toContain("NEVER ask for any of those in the chat");
});

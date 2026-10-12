// Live chat (src/livechat.js): someone from the studio takes a website chat over in Portal,
// NovaBot goes quiet for it, the visitor's chat shows their messages, and hand back
import { createExecutionContext, env, waitOnExecutionContext } from "cloudflare:test";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import worker from "../src";
import { forgetSessionTypes } from "../src/booking.js";
import { asksForPerson, firstName, speakerOf } from "../src/livechat.js";
import { BOOKING_PAGE_HTML } from "./acuity-page.js";
import { STAFF_COOKIE } from "./sign-in.js";

const BASE = "https://novacane-worker.test";
const SITE = "https://novacane.co.uk";
const AGENT_KEY = "agent-nova-test-key";
const CHAT = "chat-live-0001";

let claudeCalls = [];
beforeEach(async () => {
	claudeCalls = [];
	forgetSessionTypes();
	vi.spyOn(globalThis, "fetch").mockImplementation(async (url, init) => {
		if (String(url).startsWith("https://app.acuityscheduling.com/schedule.php")) return new Response(BOOKING_PAGE_HTML, { headers: { "Content-Type": "text/html" } });
		if (String(url) === "https://api.anthropic.com/v1/messages") {
			claudeCalls.push(JSON.parse(init.body));
			return Response.json({ stop_reason: "end_turn", content: [{ type: "text", text: "NovaBot here, happy to help." }] });
		}
		return new Response(null, { status: 201 });
	});
	await env.DB.batch([
		env.DB.prepare("DELETE FROM chat_messages"),
		env.DB.prepare("DELETE FROM chat_live"),
		env.DB.prepare("DELETE FROM chat_tickets"),
		env.DB.prepare("INSERT INTO chat_messages (chat_id, created_at, role, content, page) VALUES (?, ?, 'user', 'Do you have time on Friday?', '/')").bind(CHAT, new Date().toISOString()),
		env.DB.prepare("INSERT INTO chat_messages (chat_id, created_at, role, content, page) VALUES (?, ?, 'assistant', 'Let me check for you.', '/')").bind(CHAT, new Date().toISOString()),
	]);
});
afterEach(() => vi.restoreAllMocks());

async function call(request) {
	const ctx = createExecutionContext();
	const res = await worker.fetch(request, { ...env, AGENT_NOVA_KEY: AGENT_KEY }, ctx);
	await waitOnExecutionContext(ctx);
	return { status: res.status, data: await res.json().catch(() => null) };
}

// The visitor's chat on the website
const visitor = (path, body) => call(new Request(BASE + path, { method: "POST", headers: { "Content-Type": "application/json", Origin: SITE }, body: JSON.stringify(body) }));
const say = (text, history = []) => visitor("/", { chatId: CHAT, page: "/", messages: [...history, { role: "user", content: text }] });
const poll = (after = 0) => visitor("/chat/live", { chatId: CHAT, after });

// Portal, signed in as the test admin ("Test Admin")
const portal = (path, body, { origin = BASE, cookie = STAFF_COOKIE, auth } = {}) => {
	const headers = {};
	if (cookie) headers.Cookie = cookie;
	if (auth) headers.Authorization = auth;
	if (body !== undefined) {
		headers["Content-Type"] = "application/json";
		headers.Origin = origin;
	}
	return call(new Request(BASE + "/app/api/" + path, { method: body !== undefined ? "POST" : "GET", headers, body: body !== undefined ? JSON.stringify(body) : undefined }));
};
const live = (action, extra = {}, opts) => portal("conversations/live", { chatId: CHAT, action, ...extra }, opts);

describe("the visitor's chat", () => {
	it("is NovaBot's until someone takes it over (and asking costs one small read)", async () => {
		const { status, data } = await poll();
		expect(status).toBe(200);
		expect(data).toEqual({ mode: "bot", staff: null, messages: [] });
	});

	it("shows who joined, their messages with their first name, and only newer ones on the next ask", async () => {
		expect((await live("takeover")).status).toBe(200);
		let { data } = await poll();
		expect(data.mode).toBe("staff");
		expect(data.staff).toBe("Test");
		expect(data.messages).toEqual([expect.objectContaining({ role: "note", content: "Test from the studio has joined the chat." })]);
		const after = data.messages[0].id;

		const sent = await live("reply", { text: "Hi! Friday at 2pm is free. Want it?" });
		expect(sent.status).toBe(200);
		({ data } = await poll(after));
		expect(data.messages).toEqual([expect.objectContaining({ role: "staff", name: "Test", content: "Hi! Friday at 2pm is free. Want it?" })]);
		({ data } = await poll(data.messages[0].id));
		expect(data.messages).toEqual([]);
	});

	it("goes to the person, not NovaBot, while they have it", async () => {
		await live("takeover");
		const { status, data } = await say("Yes please, 2pm works");
		expect(status).toBe(200);
		expect(data.reply).toBeNull();
		expect(data.live).toEqual({ mode: "staff", staff: "Test" });
		expect(claudeCalls).toHaveLength(0);
		const kept = await env.DB.prepare("SELECT role, content FROM chat_messages WHERE chat_id = ? ORDER BY id DESC LIMIT 1").bind(CHAT).first();
		expect(kept).toEqual({ role: "user", content: "Yes please, 2pm works" });
		expect(await env.DB.prepare("SELECT visitor_at FROM chat_live WHERE chat_id = ?").bind(CHAT).first("visitor_at")).toBeTruthy();
	});

	it("is NovaBot's again after Hand back, and NovaBot reads what the person said", async () => {
		await live("takeover");
		await live("reply", { text: "Booked you in for 2pm." });
		expect((await live("handback")).status).toBe(200);
		const { data: polled } = await poll();
		expect(polled.mode).toBe("bot");
		expect(polled.messages.at(-1)).toEqual(expect.objectContaining({ role: "note", content: "Test has handed you back to NovaBot. Ask anything, any time." }));

		// The widget sends the person's message as NovaBot's side of the chat, with their name
		const { data } = await say("Thanks! What should I bring?", [
			{ role: "user", content: "Do you have time on Friday?" },
			{ role: "assistant", content: "(Test from the studio) Booked you in for 2pm." },
		]);
		expect(data.reply).toBe("NovaBot here, happy to help.");
		expect(claudeCalls).toHaveLength(1);
		expect(JSON.stringify(claudeCalls[0].messages)).toContain("(Test from the studio) Booked you in for 2pm.");
	});

	it("asking for a person marks the chat and pings the team once per half hour", async () => {
		await say("Can I speak to a real person please?");
		const ticket = await env.DB.prepare("SELECT state FROM chat_tickets WHERE chat_id = ?").bind(CHAT).first("state");
		expect(ticket).toBe("needs-person");
		const first = await env.DB.prepare("SELECT pinged_at, mode FROM chat_live WHERE chat_id = ?").bind(CHAT).first();
		expect(first.mode).toBe("bot");
		expect(first.pinged_at).toBeTruthy();
		await say("Hello? Is someone there? I want to talk to a human");
		const second = await env.DB.prepare("SELECT pinged_at FROM chat_live WHERE chat_id = ?").bind(CHAT).first("pinged_at");
		expect(second).toBe(first.pinged_at);
	});

	it("a chat already marked keeps its mark", async () => {
		await env.DB.prepare("INSERT INTO chat_tickets (chat_id, state, updated_at) VALUES (?, 'done', ?)").bind(CHAT, new Date().toISOString()).run();
		await say("can I talk to someone");
		expect(await env.DB.prepare("SELECT state FROM chat_tickets WHERE chat_id = ?").bind(CHAT).first("state")).toBe("done");
	});

	it("another website can't ask", async () => {
		const res = await call(new Request(BASE + "/chat/live", { method: "POST", headers: { "Content-Type": "application/json", Origin: "https://evil.example" }, body: JSON.stringify({ chatId: CHAT }) }));
		expect(res.status).toBe(403);
	});
});

describe("Portal → Conversations", () => {
	it("replying to a chat NovaBot has takes it over first", async () => {
		const { status, data } = await live("reply", { text: "Hey, it's the studio here." });
		expect(status).toBe(200);
		expect(data.live).toEqual(expect.objectContaining({ mode: "staff", staffName: "Test" }));
		const roles = (await env.DB.prepare("SELECT role FROM chat_messages WHERE chat_id = ? ORDER BY id").bind(CHAT).all()).results.map((r) => r.role);
		expect(roles).toEqual(["user", "assistant", "note", "staff"]);
	});

	it("shows the chat with who has it, and only newer messages with ?after", async () => {
		await live("takeover");
		let { data } = await portal(`conversations?chat=${CHAT}`);
		expect(data.live).toEqual(expect.objectContaining({ mode: "staff", staffId: "test-admin", staffName: "Test" }));
		const last = data.messages.at(-1);
		expect(last).toEqual(expect.objectContaining({ role: "note", sender: "Test" }));
		await live("reply", { text: "One more thing" });
		({ data } = await portal(`conversations?chat=${CHAT}&after=${last.id}`));
		expect(data.messages.map((m) => m.content)).toEqual(["One more thing"]);
		({ data } = await portal("conversations"));
		expect(data.conversations.find((c) => c.chat_id === CHAT)).toEqual(expect.objectContaining({ live: "staff", live_name: "Test" }));
	});

	it("needs a Portal sign-in, from Portal's own pages, and Nova Agent's key can't post", async () => {
		expect((await live("reply", { text: "hi" }, { cookie: null })).status).toBe(401);
		expect((await live("reply", { text: "hi" }, { origin: "https://evil.example" })).status).toBe(403);
		expect((await live("reply", { text: "hi" }, { cookie: null, auth: `Bearer ${AGENT_KEY}` })).status).toBe(401);
		const agent = await call(new Request(BASE + "/nova-agent/conversations/live", { method: "POST", headers: { "Content-Type": "application/json", Authorization: `Bearer ${AGENT_KEY}` }, body: JSON.stringify({ chatId: CHAT, action: "reply", text: "hi" }) }));
		expect(agent.status).toBe(404);
		expect(await env.DB.prepare("SELECT COUNT(*) AS n FROM chat_messages WHERE role = 'staff'").first("n")).toBe(0);
	});

	it("refuses an empty message, a missing chat and a made-up action", async () => {
		expect((await live("reply", { text: "   " })).status).toBe(400);
		expect((await portal("conversations/live", { chatId: "no-such-chat-0001", action: "takeover" })).status).toBe(404);
		expect((await live("dance")).status).toBe(400);
	});

	it("taking over twice adds one note; handing back a chat NovaBot has changes nothing", async () => {
		await live("takeover");
		await live("takeover");
		expect(await env.DB.prepare("SELECT COUNT(*) AS n FROM chat_messages WHERE role = 'note'").first("n")).toBe(1);
		await live("handback");
		const { data } = await live("handback");
		expect(data.unchanged).toBe(true);
		expect(await env.DB.prepare("SELECT COUNT(*) AS n FROM chat_messages WHERE role = 'note'").first("n")).toBe(2);
	});
});

describe("small pieces", () => {
	it("knows when a visitor asks for a person", () => {
		for (const t of ["Can I speak to a real person?", "talk to someone please", "are you a bot?", "human please", "Can I chat with the engineer"]) expect(asksForPerson(t)).toBe(true);
		for (const t of ["How much is a vocal session?", "I'm a singer", "Do you have a person who can mix?"]) expect(asksForPerson(t)).toBe(false);
	});
	it("uses first names and says who spoke", () => {
		expect(firstName("Sam Brown")).toBe("Sam");
		expect(firstName("")).toBe("Someone");
		expect(speakerOf({ role: "staff", sender: "Sam" })).toBe("Sam from the studio");
		expect(speakerOf({ role: "note" })).toBeNull();
		expect(speakerOf({ role: "user" })).toBe("Customer");
		expect(speakerOf({ role: "assistant" })).toBe("NovaBot");
	});
});

import { createExecutionContext, env, waitOnExecutionContext } from "cloudflare:test";
import { STAFF_AUTH, STAFF_COOKIE } from "./sign-in.js";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import worker from "../src";
import { forgetSessionTypes } from "../src/booking.js";
import { BOOKING_PAGE_HTML } from "./acuity-page.js";

const BASE = "https://novacane-worker.test";

let claudeCalls = [];

beforeEach(async () => {
	claudeCalls = [];
	forgetSessionTypes();
	vi.spyOn(globalThis, "fetch").mockImplementation(async (url, init) => {
		if (String(url).startsWith("https://app.acuityscheduling.com/schedule.php")) return new Response(BOOKING_PAGE_HTML);
		if (String(url) === "https://api.anthropic.com/v1/messages") {
			claudeCalls.push(JSON.parse(init.body));
			return new Response(JSON.stringify({ stop_reason: "end_turn", content: [{ type: "text", text: "We're in Forest Hill." }] }));
		}
		throw new Error("Unexpected fetch in test: " + url);
	});
	await env.DB.batch([env.DB.prepare("DELETE FROM enquiries"), env.DB.prepare("DELETE FROM chat_messages")]);
});

afterEach(() => {
	vi.restoreAllMocks();
});

let ip = 0;

// A request to the app's data, like the app on a phone sends
async function app(path, { body, cookie, origin = BASE, extraEnv = {} } = {}) {
	const ctx = createExecutionContext();
	const headers = { "CF-Connecting-IP": `192.0.2.${(++ip % 250) + 1}` };
	if (body !== undefined) {
		headers["Content-Type"] = "application/json";
		headers.Origin = origin;
	}
	if (cookie) headers.Cookie = cookie;
	const res = await worker.fetch(
		new Request(BASE + "/app/api/" + path, { method: body !== undefined ? "POST" : "GET", headers, body: body !== undefined ? JSON.stringify(body) : undefined }),
		{ ...env, ...extraEnv },
		ctx
	);
	await waitOnExecutionContext(ctx);
	return { status: res.status, data: await res.json(), headers: res.headers };
}

// Signed in with Portal (test/sign-in.js)
async function signIn() {
	return STAFF_COOKIE;
}

async function addEnquiry(extra = {}) {
	const { meta } = await env.DB.prepare(
		"INSERT INTO enquiries (created_at, name, email, phone, subject, details, chat_id, status) VALUES (?, ?, ?, ?, ?, ?, ?, ?)"
	)
		.bind(new Date().toISOString(), "Sam Singer", "sam@example.com", "07700 900123", "Two songs", "<b>Rapper</b>, two songs", "chat-app-0001", "new")
		.run();
	return meta.last_row_id;
}

describe("signing in to the staff app", () => {
	it("is Portal's job: there's no password here", async () => {
		const res = await app("login", { body: { password: "test-admin-password" } });
		expect(res.status).toBe(410);
		expect(res.data.signIn).toBe("/portal/");
	});

	it("keeps everything behind a Portal sign-in", async () => {
		for (const path of ["me", "enquiries", "sessions", "conversations"]) expect((await app(path)).status).toBe(401);
		expect((await app("chat", { body: { messages: [{ role: "user", content: "hi" }] } })).status).toBe(401);
		expect((await app("me", { cookie: STAFF_COOKIE })).data).toEqual({ ok: true });
	});

	it("doesn't take the old shared-password cookie", async () => {
		expect((await app("me", { cookie: "nvadmin=9999999999999.forged" })).status).toBe(401);
	});

	it("only accepts changes sent from the app itself", async () => {
		expect((await app("logout", { body: {}, origin: "https://evil.example" })).status).toBe(403);
	});

	it("signs out of Portal (everything), clearing any old cookie too", async () => {
		const res = await app("logout", { body: {}, cookie: STAFF_COOKIE });
		const cookies = res.headers.get("Set-Cookie");
		expect(cookies).toMatch(/nvadmin=; Path=\/app; Max-Age=0/);
		expect(cookies).toMatch(/nova_session=;/);
		expect((await app("me", { cookie: STAFF_COOKIE })).status).toBe(401);
	});
});


describe("staff app data", () => {
	it("lists enquiries and marks them done", async () => {
		const cookie = await signIn();
		const id = await addEnquiry();
		let { data } = await app("enquiries", { cookie });
		expect(data.newCount).toBe(1);
		expect(data.enquiries[0]).toMatchObject({ id, name: "Sam Singer", details: "<b>Rapper</b>, two songs", status: "new" });
		expect(data.enquiries[0].sender).toBeUndefined(); // the hashed IP isn't sent to the app

		expect((await app("enquiries/status", { cookie, body: { id, status: "done" } })).status).toBe(200);
		({ data } = await app("enquiries", { cookie }));
		expect(data.enquiries).toHaveLength(0);
		({ data } = await app("enquiries?show=all", { cookie }));
		expect(data.enquiries[0].status).toBe("done");

		expect((await app("enquiries/status", { cookie, body: { id, status: "deleted" } })).status).toBe(400);
		expect((await app("enquiries/status", { cookie, body: { id: 999999, status: "done" } })).status).toBe(404);
	});

	it("makes a booking link with the customer's details", async () => {
		const cookie = await signIn();
		const id = await addEnquiry();
		const { data } = await app("sessions", { cookie });
		expect(data.sessions.map((s) => s.id)).toEqual([11846136, 64806309, 12738216]);
		const link = await app("booking-link", { cookie, body: { enquiryId: id, typeId: 64806309 } });
		expect(link.data).toEqual({
			url: "https://app.acuityscheduling.com/schedule.php?owner=18510650&appointmentType=64806309&firstName=Sam&lastName=Singer&email=sam%40example.com&phone=07700+900123",
			session: "Rap Package - 2 songs (2 hours recording with engineer + 2 hours mixing)",
		});
		expect((await app("booking-link", { cookie, body: { enquiryId: id, typeId: 99999901 } })).status).toBe(400); // private session
	});

	it("shows conversations and transcripts", async () => {
		const cookie = await signIn();
		const now = new Date().toISOString();
		await env.DB.batch([
			env.DB.prepare("INSERT INTO chat_messages (chat_id, created_at, role, content) VALUES (?, ?, ?, ?)").bind("chat-app-0001", now, "user", "Where are you?"),
			env.DB.prepare("INSERT INTO chat_messages (chat_id, created_at, role, content) VALUES (?, ?, ?, ?)").bind("chat-app-0001", now, "assistant", "Forest Hill."),
		]);
		let { data } = await app("conversations", { cookie });
		expect(data.conversations[0]).toMatchObject({ chat_id: "chat-app-0001", first_question: "Where are you?", messages: 1 });
		({ data } = await app("conversations?chat=chat-app-0001", { cookie }));
		expect(data.messages.map((m) => m.content)).toEqual(["Where are you?", "Forest Hill."]);
	});

	it("lets staff ask NovaBot, without saving it to the chat log", async () => {
		const cookie = await signIn();
		const { status, data } = await app("chat", { cookie, body: { messages: [{ role: "user", content: "Where are you?" }] } });
		expect(status).toBe(200);
		expect(data.reply).toBe("We're in Forest Hill.");
		// One call for the reply; anything else is Index learning in the background
		const replies = claudeCalls.filter((c) => !(c.tool_choice && c.tool_choice.type === "tool"));
		expect(replies).toHaveLength(1);
		const { count } = await env.DB.prepare("SELECT COUNT(*) AS count FROM chat_messages").first();
		expect(count).toBe(0);
	});
});

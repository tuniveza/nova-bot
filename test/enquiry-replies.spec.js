// Replying to enquiries (src/enquiry-replies.js): staff send, Nova Agent's AI only drafts,
// a person approves, each reply goes once, to the customer only, with the UK GDPR footer
// and a working stop link.
import { createExecutionContext, env, waitOnExecutionContext } from "cloudflare:test";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import worker from "../src";
import { sendEnquiry } from "../src/enquiries.js";
import { sha256 } from "../src/portal/auth.js";
import { STAFF_COOKIE } from "./sign-in.js";

const BASE = "https://novacane-worker.test";
const AGENT_KEY = "agent-nova-test-key";
// Email set up (never real: every call to Resend is caught below)
const EMAIL_ENV = { RESEND_API_KEY: "re_test_key", ENQUIRY_EMAIL_TO: "studio@novacane.test, owner@novacane.test", ENQUIRY_EMAIL_FROM: "Novacane Studios <hello@novacane.test>" };

// What Resend was asked to send, and how it answers next
let resendCalls = [];
let resendAnswer = () => new Response(JSON.stringify({ id: "email_" + resendCalls.length }), { status: 200 });

beforeEach(async () => {
	resendCalls = [];
	resendAnswer = () => new Response(JSON.stringify({ id: "email_" + resendCalls.length }), { status: 200 });
	vi.spyOn(globalThis, "fetch").mockImplementation(async (url, init) => {
		if (String(url) === "https://api.resend.com/emails") {
			resendCalls.push({ headers: init.headers, body: JSON.parse(init.body) });
			// A little wait, so two presses at once really overlap
			await new Promise((r) => setTimeout(r, 20));
			return resendAnswer();
		}
		throw new Error("Unexpected fetch in test: " + url);
	});
	await env.DB.batch([env.DB.prepare("DELETE FROM enquiry_messages"), env.DB.prepare("DELETE FROM enquiries"), env.DB.prepare("DELETE FROM notifications")]);
});

afterEach(() => {
	vi.restoreAllMocks();
});

// An enquiry from NovaBot's chat. 23:30 UTC on 9 October is 00:30 on the 10th in London (BST).
async function addEnquiry(extra = {}) {
	const e = { created_at: "2026-10-09T23:30:00.000Z", name: "Jordan Test", email: "jordan@example.com", phone: "07700 900123", subject: "EP mixing", details: "Mixing 4 tracks next month", page: "/bookings-contact", ...extra };
	const { meta } = await env.DB.prepare(
		"INSERT INTO enquiries (created_at, name, email, phone, subject, details, page, consent_at, consent_source) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)"
	)
		.bind(e.created_at, e.name, e.email, e.phone, e.subject, e.details, e.page, e.created_at, "NovaBot chat on " + e.page)
		.run();
	return meta.last_row_id;
}

// Portal in a browser (the session cookie and this site's Origin), or whatever headers a test gives
async function app(path, { body, cookie = STAFF_COOKIE, origin = BASE, headers = {}, extraEnv = EMAIL_ENV } = {}) {
	const ctx = createExecutionContext();
	const h = { ...headers };
	if (body !== undefined) {
		h["Content-Type"] = "application/json";
		if (origin) h.Origin = origin;
	}
	if (cookie) h.Cookie = cookie;
	const res = await worker.fetch(
		new Request(BASE + "/app/api/" + path, { method: body !== undefined ? "POST" : "GET", headers: h, body: body !== undefined ? JSON.stringify(body) : undefined }),
		{ ...env, ...extraEnv },
		ctx
	);
	await waitOnExecutionContext(ctx);
	return { status: res.status, data: await res.json() };
}

// Nova Agent on the PC, with its key
async function agent(path, body = {}, extraEnv = EMAIL_ENV) {
	const ctx = createExecutionContext();
	const res = await worker.fetch(
		new Request(BASE + path, { method: "POST", headers: { "Content-Type": "application/json", Authorization: `Bearer ${AGENT_KEY}` }, body: JSON.stringify(body) }),
		{ ...env, ...extraEnv },
		ctx
	);
	await waitOnExecutionContext(ctx);
	return { status: res.status, data: await res.json() };
}

async function page(path, init = {}) {
	const ctx = createExecutionContext();
	const res = await worker.fetch(new Request(BASE + path, init), { ...env, ...EMAIL_ENV }, ctx);
	await waitOnExecutionContext(ctx);
	return { status: res.status, text: await res.text() };
}

const messages = async (id) => (await env.DB.prepare("SELECT * FROM enquiry_messages WHERE enquiry_id = ? ORDER BY id").bind(id).all()).results;
const enquiry = async (id) => env.DB.prepare("SELECT * FROM enquiries WHERE id = ?").bind(id).first();
const key = () => "k-" + crypto.randomUUID();

describe("Staff replying from Portal", () => {
	it("a signed-in staff member's Send emails the customer and records it", async () => {
		const id = await addEnquiry();
		const res = await app("enquiries/reply", { body: { id, body: "Hi Jordan, yes we can mix those.", key: key() } });
		expect(res.status).toBe(200);
		expect(res.data.message).toMatchObject({ direction: "out", status: "sent", created_by: "staff", author_staff_id: "test-admin", approved_by: "test-admin", attempts: 1 });
		expect(res.data.message.sent_at).toMatch(/Z$/);
		expect(resendCalls).toHaveLength(1);
		expect((await enquiry(id)).status).toBe("replied");
		// The thread shows it, with who sent it
		const thread = await app("enquiries/thread?id=" + id);
		expect(thread.data.enquiry).toMatchObject({ id, state: "replied", mobile: "07700900123", consent_source: "NovaBot chat on /bookings-contact" });
		expect(thread.data.messages[0]).toMatchObject({ body: "Hi Jordan, yes we can mix those.", status: "sent", author_name: "Test Admin" });
	});

	it("signed-out people can't send, read a thread or add a note", async () => {
		const id = await addEnquiry();
		expect((await app("enquiries/reply", { body: { id, body: "Hello", key: key() }, cookie: null })).status).toBe(401);
		expect((await app("enquiries/note", { body: { id, body: "Hello", key: key() }, cookie: null })).status).toBe(401);
		expect((await app("enquiries/thread?id=" + id, { cookie: null })).status).toBe(401);
		expect((await app("enquiries/reply", { body: { id, body: "Hello" }, cookie: "nova_session=not-a-real-session" })).status).toBe(401);
		expect(resendCalls).toHaveLength(0);
		expect(await messages(id)).toHaveLength(0);
	});

	it("another website can't send for a signed-in browser (Origin check)", async () => {
		const id = await addEnquiry();
		expect((await app("enquiries/reply", { body: { id, body: "Hello", key: key() }, origin: "https://evil.example" })).status).toBe(403);
		expect(resendCalls).toHaveLength(0);
	});

	it("an app's sign-in token (not a browser) can read but can't send", async () => {
		const id = await addEnquiry();
		const token = "nsess_test-app-token";
		const now = new Date().toISOString();
		await env.DB.prepare("INSERT OR REPLACE INTO sessions (id, staff_id, kind, created_at, expires_at, last_seen_at) VALUES (?, 'test-admin', 'token', ?, ?, ?)")
			.bind(await sha256(token), now, new Date(Date.now() + 86_400_000).toISOString(), now)
			.run();
		const headers = { Authorization: "Bearer " + token };
		expect((await app("enquiries/thread?id=" + id, { cookie: null, headers })).status).toBe(200);
		expect((await app("enquiries/reply", { body: { id, body: "Hello", key: key() }, cookie: null, headers })).status).toBe(403);
		expect(resendCalls).toHaveLength(0);
	});

	it("a double click on Send (the same key twice, at once) sends one email", async () => {
		const id = await addEnquiry();
		const k = key();
		const [a, b] = await Promise.all([app("enquiries/reply", { body: { id, body: "Once only", key: k } }), app("enquiries/reply", { body: { id, body: "Once only", key: k } })]);
		expect(a.status).toBe(200);
		expect(b.status).toBe(200);
		expect(resendCalls).toHaveLength(1);
		expect(await messages(id)).toHaveLength(1);
	});

	it("internal notes are saved for the team and never emailed", async () => {
		const id = await addEnquiry();
		const res = await app("enquiries/note", { body: { id, body: "Called them, they'll book Friday", key: key() } });
		expect(res.data.message).toMatchObject({ direction: "note", status: null, author_name: "Test Admin" });
		expect(resendCalls).toHaveLength(0);
		expect((await enquiry(id)).status).toBe("new");
	});
});

describe("Email: only to the customer, with why and how to stop", () => {
	it("goes only to the enquiry's own address, from the studio, replies to the studio inbox", async () => {
		const id = await addEnquiry({ email: "jordan@example.com" });
		await app("enquiries/reply", { body: { id, body: "Hello Jordan", key: key() } });
		const sent = resendCalls[0].body;
		expect(sent.to).toEqual(["jordan@example.com"]);
		expect(sent.cc).toBeUndefined();
		expect(sent.bcc).toBeUndefined();
		expect(sent.from).toBe("Novacane Studios <hello@novacane.test>");
		expect(sent.reply_to).toBe("studio@novacane.test");
		expect(sent.subject).toBe("Re: EP mixing");
		expect(resendCalls[0].headers["Idempotency-Key"]).toMatch(/^enquiry-reply-\d+-1$/);
		// Never the studio's own list
		expect(JSON.stringify(sent.to)).not.toContain("owner@novacane.test");
	});

	it("says why they're getting it (the enquiry's UK date) and has a working stop link", async () => {
		const id = await addEnquiry();
		await app("enquiries/reply", { body: { id, body: "Hello Jordan", key: key() } });
		const { text, headers } = resendCalls[0].body;
		expect(text).toContain("Hello Jordan");
		// 23:30 UTC on the 9th is the 10th in London
		expect(text).toContain("You're getting this because you sent Novacane Studios an enquiry on 10 October 2026");
		const link = text.match(/https:\/\/novacane-worker\.test\/enquiry\/stop\?t=([0-9a-f]{48})/);
		expect(link).not.toBeNull();
		expect(headers["List-Unsubscribe"]).toBe(`<${link[0]}>`);
		expect(headers["List-Unsubscribe-Post"]).toBe("List-Unsubscribe=One-Click");
		// Opening the link only asks (a mail scanner can't stop emails by looking)
		const ask = await page(new URL(link[0]).pathname + new URL(link[0]).search, { headers: { "Sec-Fetch-Dest": "document" } });
		expect(ask.status).toBe(200);
		expect(ask.text).toContain("Stop emails");
		expect((await enquiry(id)).do_not_contact_at).toBeNull();
		// Pressing the button stops them
		const done = await page("/enquiry/stop", { method: "POST", headers: { "Content-Type": "application/x-www-form-urlencoded" }, body: "t=" + link[1] });
		expect(done.status).toBe(200);
		expect(done.text).toContain("email you about your enquiry again");
		expect(await enquiry(id)).toMatchObject({ do_not_contact_by: "customer" });
		expect((await app("enquiries/thread?id=" + id)).data.enquiry.state).toBe("do-not-contact");
	});

	it("an email app's one-click unsubscribe works too", async () => {
		const id = await addEnquiry();
		await app("enquiries/reply", { body: { id, body: "Hello", key: key() } });
		const url = new URL(resendCalls[0].body.headers["List-Unsubscribe"].slice(1, -1));
		const res = await page(url.pathname + url.search, { method: "POST", headers: { "Content-Type": "application/x-www-form-urlencoded" }, body: "List-Unsubscribe=One-Click" });
		expect(res.status).toBe(200);
		expect((await enquiry(id)).do_not_contact_at).not.toBeNull();
	});

	it("a wrong stop link changes nothing", async () => {
		const res = await page("/enquiry/stop?t=" + "0".repeat(48), { method: "POST" });
		expect(res.status).toBe(404);
	});

	it("new enquiries record when and where consent came from", async () => {
		const result = await sendEnquiry(env, { name: "Sam Lee", email: "sam@example.com", phone: "07700900456", details: "Podcast recording for 2 people" }, { chatId: "c1", page: "/podcasts", ip: "192.0.2.9" }, () => {});
		expect(result.sent).toBe(true);
		const row = await env.DB.prepare("SELECT created_at, consent_at, consent_source FROM enquiries WHERE email = 'sam@example.com'").first();
		expect(row.consent_at).toBe(row.created_at);
		expect(row.consent_source).toBe("NovaBot chat on /podcasts");
	});
});

describe("Don't contact", () => {
	it("Portal's toggle blocks every send, and drafts", async () => {
		const id = await addEnquiry();
		const draft = (await agent(`/nova-agent/enquiries/${id}/drafts`, { body: "Hi Jordan" })).data.draft;
		expect((await app("enquiries/contact", { body: { id, doNotContact: true } })).status).toBe(200);
		expect((await app("enquiries/reply", { body: { id, body: "Hello", key: key() } })).status).toBe(409);
		expect((await app("enquiries/draft/approve", { body: { messageId: draft.id } })).status).toBe(409);
		expect((await agent(`/nova-agent/enquiries/${id}/drafts`, { body: "Another" })).status).toBe(409);
		expect(resendCalls).toHaveLength(0);
		// Staff can switch their own one off again
		expect((await app("enquiries/contact", { body: { id, doNotContact: false } })).status).toBe(200);
		expect((await app("enquiries/reply", { body: { id, body: "Hello", key: key() } })).data.message.status).toBe("sent");
	});

	it("the customer's own stop can't be switched off in Portal", async () => {
		const id = await addEnquiry();
		await env.DB.prepare("UPDATE enquiries SET do_not_contact_at = ?, do_not_contact_by = 'customer' WHERE id = ?").bind(new Date().toISOString(), id).run();
		expect((await app("enquiries/contact", { body: { id, doNotContact: false } })).status).toBe(409);
		expect((await app("enquiries/reply", { body: { id, body: "Hello", key: key() } })).status).toBe(409);
		expect(resendCalls).toHaveLength(0);
	});

	it("a failed reply can't be retried once they've asked to stop", async () => {
		const id = await addEnquiry();
		resendAnswer = () => new Response(JSON.stringify({ message: "Rate limited" }), { status: 429 });
		const failed = (await app("enquiries/reply", { body: { id, body: "Hello", key: key() } })).data.message;
		await app("enquiries/contact", { body: { id, doNotContact: true } });
		resendAnswer = () => new Response("{}", { status: 200 });
		expect((await app("enquiries/retry", { body: { messageId: failed.id } })).status).toBe(409);
		expect(resendCalls).toHaveLength(1);
	});
});

describe("Nova Agent's AI: drafts only", () => {
	it("can list and read enquiries and add a draft, which isn't sent", async () => {
		const id = await addEnquiry();
		const list = await agent("/nova-agent/enquiries", { show: "all" });
		expect(list.data.enquiries.map((e) => e.id)).toContain(id);
		const read = await agent(`/nova-agent/enquiries/${id}`);
		expect(read.data.enquiry.name).toBe("Jordan Test");
		const res = await agent(`/nova-agent/enquiries/${id}/drafts`, { body: "Hi Jordan, thanks for getting in touch." });
		expect(res.status).toBe(200);
		expect(res.data.draft).toMatchObject({ enquiryId: id, status: "draft" });
		expect(res.data.portalUrl).toBe(`${BASE}/portal/?view=enquiries&enquiry=${id}`);
		const [m] = await messages(id);
		expect(m).toMatchObject({ status: "draft", created_by: "agent", author_staff_id: null, approved_by: null, sent_at: null });
		expect(resendCalls).toHaveLength(0);
	});

	it("can't approve or send through any route, with any body", async () => {
		const id = await addEnquiry();
		const draft = (await agent(`/nova-agent/enquiries/${id}/drafts`, { body: "Draft", status: "approved", approved_by: "test-admin" })).data.draft;
		expect((await messages(id))[0].status).toBe("draft");
		const bearer = { Authorization: `Bearer ${AGENT_KEY}` };
		// Every staff route, with the agent's key (and this site's Origin): not signed in
		for (const [path, body] of [
			["enquiries/reply", { id, body: "x", key: key() }],
			["enquiries/note", { id, body: "x", key: key() }],
			["enquiries/draft/edit", { messageId: draft.id, body: "x" }],
			["enquiries/draft/approve", { messageId: draft.id }],
			["enquiries/draft/discard", { messageId: draft.id }],
			["enquiries/retry", { messageId: draft.id }],
			["enquiries/contact", { id, doNotContact: true }],
			["enquiries/status", { id, status: "done" }],
		]) {
			expect((await app(path, { body, cookie: null, headers: bearer })).status, path).toBe(401);
		}
		expect((await app("enquiries/thread?id=" + id, { cookie: null, headers: bearer })).status).toBe(401);
		// Every made-up agent route that sounds like sending
		for (const path of [
			`/nova-agent/enquiries/${id}/approve`,
			`/nova-agent/enquiries/${id}/send`,
			`/nova-agent/enquiries/${id}/reply`,
			`/nova-agent/enquiries/${id}/drafts/${draft.id}`,
			`/nova-agent/enquiries/${id}/drafts/${draft.id}/approve`,
			`/nova-agent/enquiries/${id}/drafts/${draft.id}/send`,
			`/nova-agent/enquiries/${id}/retry`,
			`/nova-agent/enquiries/approve`,
			`/nova-agent/enquiries/send`,
		]) {
			expect((await agent(path, { messageId: draft.id, id, body: "x" })).status, path).toBe(404);
		}
		expect((await messages(id)).map((m) => m.status)).toEqual(["draft"]);
		expect(resendCalls).toHaveLength(0);
	});

	it("staff see the draft, and Approve & send goes exactly once (double click)", async () => {
		const id = await addEnquiry();
		const draft = (await agent(`/nova-agent/enquiries/${id}/drafts`, { body: "Hi Jordan" })).data.draft;
		const thread = await app("enquiries/thread?id=" + id);
		expect(thread.data.messages[0]).toMatchObject({ id: draft.id, status: "draft", created_by: "agent" });
		const [a, b] = await Promise.all([
			app("enquiries/draft/approve", { body: { messageId: draft.id, body: "Hi Jordan, see you Friday." } }),
			app("enquiries/draft/approve", { body: { messageId: draft.id, body: "Hi Jordan, see you Friday." } }),
		]);
		expect([a.status, b.status]).toEqual([200, 200]);
		expect(resendCalls).toHaveLength(1);
		// What the person approved is what went
		expect(resendCalls[0].body.text).toContain("Hi Jordan, see you Friday.");
		const [m] = await messages(id);
		expect(m).toMatchObject({ status: "sent", created_by: "agent", approved_by: "test-admin", attempts: 1 });
		// A later press (or a retry of the request) sends nothing more
		const again = await app("enquiries/draft/approve", { body: { messageId: draft.id } });
		expect(again.data.repeated).toBe(true);
		expect((await app("enquiries/retry", { body: { messageId: draft.id } })).status).toBe(409);
		expect(resendCalls).toHaveLength(1);
	});

	it("drafts can be edited and discarded, and a discarded one can't be approved", async () => {
		const id = await addEnquiry();
		const draft = (await agent(`/nova-agent/enquiries/${id}/drafts`, { body: "Hi" })).data.draft;
		expect((await app("enquiries/draft/edit", { body: { messageId: draft.id, body: "Hi Jordan!" } })).data.message.body).toBe("Hi Jordan!");
		expect((await app("enquiries/draft/discard", { body: { messageId: draft.id } })).status).toBe(200);
		expect((await app("enquiries/draft/approve", { body: { messageId: draft.id } })).status).toBe(404);
		expect((await app("enquiries/thread?id=" + id)).data.messages).toHaveLength(0);
		expect(resendCalls).toHaveLength(0);
	});
});

describe("Failed sends", () => {
	it("are recorded with Resend's reason, and Retry sends them", async () => {
		const id = await addEnquiry();
		resendAnswer = () => new Response(JSON.stringify({ message: "The domain is not verified" }), { status: 403 });
		const failed = (await app("enquiries/reply", { body: { id, body: "Hello", key: key() } })).data.message;
		expect(failed).toMatchObject({ status: "failed", attempts: 1 });
		expect(failed.error).toContain("The domain is not verified");
		expect((await enquiry(id)).status).toBe("new");
		resendAnswer = () => new Response(JSON.stringify({ id: "ok" }), { status: 200 });
		const retried = (await app("enquiries/retry", { body: { messageId: failed.id } })).data.message;
		expect(retried).toMatchObject({ status: "sent", attempts: 2, error: null });
		expect(resendCalls.map((c) => c.headers["Idempotency-Key"])).toEqual([`enquiry-reply-${failed.id}-1`, `enquiry-reply-${failed.id}-2`]);
		expect((await enquiry(id)).status).toBe("replied");
	});

	it("two Retry presses at once send one email", async () => {
		const id = await addEnquiry();
		resendAnswer = () => new Response("{}", { status: 500 });
		const failed = (await app("enquiries/reply", { body: { id, body: "Hello", key: key() } })).data.message;
		resendAnswer = () => new Response("{}", { status: 200 });
		await Promise.all([app("enquiries/retry", { body: { messageId: failed.id } }), app("enquiries/retry", { body: { messageId: failed.id } })]);
		expect(resendCalls).toHaveLength(2); // the failed try, then one retry
	});

	it("with email not set up, the reply is kept as failed with the reason", async () => {
		const id = await addEnquiry();
		const res = await app("enquiries/reply", { body: { id, body: "Hello", key: key() }, extraEnv: {} });
		expect(res.data.message.status).toBe("failed");
		expect(res.data.message.error).toContain("RESEND_API_KEY");
		expect(resendCalls).toHaveLength(0);
	});
});

describe("The enquiry list", () => {
	it("shows each enquiry's state and waiting drafts; the status chips still work", async () => {
		const id = await addEnquiry();
		await agent(`/nova-agent/enquiries/${id}/drafts`, { body: "Hi" });
		let list = await app("enquiries?show=all");
		expect(list.data.enquiries[0]).toMatchObject({ id, state: "new", drafts: 1 });
		expect(list.data.newCount).toBe(1);
		expect((await app("enquiries/status", { body: { id, status: "closed" } })).status).toBe(200);
		list = await app("enquiries?show=all");
		expect(list.data.enquiries[0]).toMatchObject({ status: "done", state: "closed" });
		expect((await app("enquiries/status", { body: { id, status: "new" } })).status).toBe(200);
	});
});

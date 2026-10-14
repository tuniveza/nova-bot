// The inbox (src/inbox.js): the spam filter's rules, enquiries sorted like tickets, saved
// replies, website chats marked "needs a person" / "done", and what Nova Agent's key can do
import { createExecutionContext, env, waitOnExecutionContext } from "cloudflare:test";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import worker from "../src";
import { sendEnquiry } from "../src/enquiries.js";
import { readState, spamCheck } from "../src/inbox.js";
import { STAFF_COOKIE } from "./sign-in.js";

const BASE = "https://novacane-worker.test";
const AGENT_KEY = "agent-nova-test-key";
const EMAIL_ENV = { MAIL_KEY: "re_test_key", ENQUIRY_EMAIL_TO: "studio@novacane.test" };

let outside = [];
beforeEach(async () => {
	outside = [];
	vi.spyOn(globalThis, "fetch").mockImplementation(async (url) => {
		outside.push(String(url));
		return new Response(JSON.stringify({ id: "email_1" }), { status: 200 });
	});
	await env.DB.batch([
		env.DB.prepare("DELETE FROM enquiry_messages"),
		env.DB.prepare("DELETE FROM enquiries"),
		env.DB.prepare("DELETE FROM notifications"),
		env.DB.prepare("DELETE FROM saved_replies"),
		env.DB.prepare("DELETE FROM chat_tickets"),
		env.DB.prepare("DELETE FROM chat_messages"),
	]);
});
afterEach(() => vi.restoreAllMocks());

async function addEnquiry(extra = {}) {
	const e = { created_at: new Date().toISOString(), name: "Jordan Test", email: "jordan@example.com", phone: "07700 900123", subject: "EP mixing", details: "Mixing 4 tracks next month", status: "new", ...extra };
	const { meta } = await env.DB.prepare("INSERT INTO enquiries (created_at, name, email, phone, subject, details, status) VALUES (?, ?, ?, ?, ?, ?, ?)")
		.bind(e.created_at, e.name, e.email, e.phone, e.subject, e.details, e.status)
		.run();
	return meta.last_row_id;
}

async function app(path, body, { origin = BASE } = {}) {
	const ctx = createExecutionContext();
	const headers = { Cookie: STAFF_COOKIE };
	if (body !== undefined) {
		headers["Content-Type"] = "application/json";
		headers.Origin = origin;
	}
	const res = await worker.fetch(
		new Request(BASE + "/app/api/" + path, { method: body !== undefined ? "POST" : "GET", headers, body: body !== undefined ? JSON.stringify(body) : undefined }),
		{ ...env, ...EMAIL_ENV },
		ctx
	);
	await waitOnExecutionContext(ctx);
	return { status: res.status, data: await res.json() };
}

async function agent(path, body = {}) {
	const ctx = createExecutionContext();
	const res = await worker.fetch(
		new Request(BASE + path, { method: "POST", headers: { "Content-Type": "application/json", Authorization: `Bearer ${AGENT_KEY}` }, body: JSON.stringify(body) }),
		{ ...env, ...EMAIL_ENV },
		ctx
	);
	await waitOnExecutionContext(ctx);
	return { status: res.status, data: await res.json() };
}

// A visitor confirming an enquiry in the website chat
async function fromChat(input, ip = "203.0.113.9") {
	const waits = [];
	const result = await sendEnquiry({ ...env, ...EMAIL_ENV }, { name: "Sam Visitor", email: "sam@example.com", phone: "07700 900456", subject: "Recording", ...input }, { chatId: "chat-1", page: "/contact", ip }, (p) => waits.push(p));
	await Promise.all(waits);
	return result;
}

describe("the spam filter's rules", () => {
	it("lets a normal studio enquiry through", () => {
		const c = spamCheck({ name: "Jordan Test", email: "jordan@gmail.com", subject: "EP mixing", details: "Hi, I'd like 4 tracks mixed next month. Here's a demo: https://soundcloud.com/jordan/demo-4cOdK2wGLETKBW3PvgPWqT" });
		expect(c).toMatchObject({ spam: false, score: 0, reasons: [] });
	});

	it("catches lots of links", () => {
		const c = spamCheck({ details: "See https://a.example http://b.example and www.c-site.com for offers" });
		expect(c.spam).toBe(true);
		expect(c.reasons).toContain("3 links");
	});

	it("two links alone aren't enough", () => {
		expect(spamCheck({ details: "My tracks: https://soundcloud.com/a and https://youtu.be/b please have a listen" }).spam).toBe(false);
	});

	it("catches a throwaway email address", () => {
		const c = spamCheck({ email: "x@mailinator.com", details: "Book me a session please, next week" });
		expect(c.spam).toBe(true);
		expect(c.reasons[0]).toBe("a throwaway email address (mailinator.com)");
	});

	it("catches spam phrases, whole words only", () => {
		const c = spamCheck({ details: "We offer SEO services and backlinks to rank your website" });
		expect(c.spam).toBe(true);
		expect(c.reasons[0]).toMatch(/^spam words \("seo services", "backlinks", "rank your website"\)$/);
		// "casino" inside another word isn't the word
		expect(spamCheck({ details: "Recording at the old Casinoworks venue next week please" }).spam).toBe(false);
	});

	it("catches keyboard mashing and symbol soup", () => {
		expect(spamCheck({ name: "xkcdrtvbnm", details: "qwrtplkjhg sdfghjkl" }).reasons[0]).toMatch(/^random letters/);
		expect(spamCheck({ details: "$$$ !!! ### @@@ ??? %%% &&& ***" }).reasons).toContain("mostly symbols, not words");
	});

	it("adds up small signs: two links and a busy visitor", () => {
		const c = spamCheck({ details: "Look at https://a.example and https://b.example for my work" }, { recent: 3 });
		expect(c).toMatchObject({ spam: true, score: 2 });
		expect(c.reasons).toEqual(["2 links", "4 enquiries from the same visitor today"]);
	});

	it("reads the names people use for the states", () => {
		expect(readState("Waiting on them")).toBe("replied");
		expect(readState("waiting")).toBe("replied");
		expect(readState("closed")).toBe("done");
		expect(readState("not spam")).toBe("new");
		expect(readState("open")).toBe("open");
		expect(readState("deleted")).toBe(null);
	});
});

describe("an enquiry arriving", () => {
	it("likely spam goes to Spam, quietly: no phone ping, no email copy, and the visitor hears 'Sent'", async () => {
		const result = await fromChat({ details: "Get backlinks and SEO services cheap: https://a.example https://b.example https://c.example" });
		expect(result.sent).toBe(true);
		const row = await env.DB.prepare("SELECT status, spam_reason, state_by FROM enquiries").first();
		expect(row.status).toBe("spam");
		expect(row.spam_reason).toMatch(/^Likely spam: 3 links; spam words/);
		expect(row.state_by).toBe("filter");
		expect(outside.filter((u) => u.includes("mail.test"))).toEqual([]);
		expect((await env.DB.prepare("SELECT COUNT(*) AS n FROM notifications").first()).n).toBe(0);
	});

	it("a normal one is New and the team is told, as before", async () => {
		await fromChat({ details: "Two hour vocal session for a single next Friday" });
		const row = await env.DB.prepare("SELECT status, spam_reason FROM enquiries").first();
		expect(row).toEqual({ status: "new", spam_reason: null });
		expect(outside).toContain("http://mail.test/emails");
	});
});

describe("Portal: the sorted inbox", () => {
	it("moves an enquiry between states in one press, and counts each place (the badge: new and open)", async () => {
		const a = await addEnquiry();
		const b = await addEnquiry({ name: "Alex" });
		await addEnquiry({ name: "Spammy", status: "spam" });

		let r = await app("inbox/sort", { id: a, state: "open" });
		expect(r.status).toBe(200);
		expect(r.data.enquiry.status).toBe("open");
		r = await app("inbox/sort", { id: b, state: "waiting" });
		expect(r.data.enquiry.status).toBe("replied");

		const list = await app("enquiries?show=all");
		expect(list.data.counts).toEqual({ new: 0, open: 1, replied: 1, done: 0, spam: 1 });
		expect(list.data.newCount).toBe(1);
		// "All" leaves Spam out; Spam is its own folder
		expect(list.data.enquiries.map((e) => e.name).sort()).toEqual(["Alex", "Jordan Test"]);
		const spam = await app("enquiries?box=spam");
		expect(spam.data.enquiries.map((e) => e.name)).toEqual(["Spammy"]);
		const open = await app("enquiries?box=open");
		expect(open.data.enquiries.map((e) => e.state)).toEqual(["open"]);
	});

	it("Spam and Not spam: nothing is deleted, and the reason goes when it comes back", async () => {
		const id = await addEnquiry();
		let r = await app("inbox/sort", { id, state: "spam" });
		expect(r.data.enquiry).toMatchObject({ status: "spam", spam_reason: "Moved to Spam by a person" });
		r = await app("inbox/sort", { id, state: "not spam" });
		expect(r.data.enquiry).toMatchObject({ status: "new", spam_reason: null });
		expect((await env.DB.prepare("SELECT COUNT(*) AS n FROM enquiries").first()).n).toBe(1);
	});

	it("takes one on (me), labels it, and finds it by search", async () => {
		const id = await addEnquiry({ details: "Podcast recording for 3 people" });
		await addEnquiry({ name: "Other", details: "Mastering an album" });
		let r = await app("inbox/sort", { id, assignedTo: "me", label: "  Podcast   work " });
		expect(r.data.enquiry).toMatchObject({ assigned_to: "test-admin", label: "Podcast work" });
		r = await app("inbox/sort", { id, assignedTo: "someone-else" });
		expect(r.status).toBe(400);

		const found = await app("enquiries?show=all&q=podcast");
		expect(found.data.enquiries).toHaveLength(1);
		expect(found.data.enquiries[0]).toMatchObject({ id, assigned_name: "Test Admin", label: "Podcast work" });
		expect(found.data.labels).toEqual(["Podcast work"]);
		expect(found.data.team).toContainEqual({ id: "test-admin", name: "Test Admin" });
		// % and _ are plain characters in a search
		expect((await app("enquiries?show=all&q=%25")).data.enquiries).toHaveLength(0);
	});

	it("a reply sent from Open moves it to Waiting on them", async () => {
		const id = await addEnquiry();
		await app("inbox/sort", { id, state: "open" });
		const sent = await app("enquiries/reply", { id, body: "Thanks, we can do that.", key: "press-000001" });
		expect(sent.status).toBe(200);
		expect((await env.DB.prepare("SELECT status FROM enquiries WHERE id = ?").bind(id).first()).status).toBe("replied");
	});

	it("only from Portal's own pages", async () => {
		const id = await addEnquiry();
		expect((await app("inbox/sort", { id, state: "done" }, { origin: "https://evil.example" })).status).toBe(403);
	});
});

describe("saved replies", () => {
	it("are added, changed, listed by name and removed", async () => {
		let r = await app("inbox/saved", { title: "Prices", body: "Our rates are £40 an hour." });
		expect(r.status).toBe(200);
		r = await app("inbox/saved", { title: "Opening times", body: "We're open 10am to 10pm." });
		expect(r.data.saved.map((s) => s.title)).toEqual(["Opening times", "Prices"]);
		const id = r.data.saved[1].id;
		r = await app("inbox/saved", { id, title: "Prices", body: "Our rates are £45 an hour." });
		expect(r.data.saved[1]).toMatchObject({ title: "Prices", body: "Our rates are £45 an hour.", updatedBy: "Test Admin" });
		expect((await app("inbox/saved", { title: "", body: "x" })).status).toBe(400);
		r = await app("inbox/saved/remove", { id });
		expect(r.data.saved.map((s) => s.title)).toEqual(["Opening times"]);
		expect((await app("inbox/saved")).data.saved).toHaveLength(1);
	});
});

describe("website chats as tickets", () => {
	it("marks a chat needs-person, then done, then clears it; the list shows the mark", async () => {
		await env.DB.prepare("INSERT INTO chat_messages (chat_id, created_at, role, content) VALUES ('c1', ?, 'user', 'Can a person call me?'), ('c1', ?, 'assistant', 'I will pass that on.')")
			.bind(new Date().toISOString(), new Date().toISOString())
			.run();
		let r = await app("inbox/chat", { chatId: "c1", state: "needs-person", assignedTo: "me" });
		expect(r.data.ticket).toMatchObject({ state: "needs-person", assigned_to: "test-admin" });
		let list = await app("conversations");
		expect(list.data.conversations[0]).toMatchObject({ chat_id: "c1", ticket: "needs-person", assigned_name: "Test Admin" });
		expect(list.data.needsPerson).toBe(1);
		r = await app("inbox/chat", { chatId: "c1", state: "done" });
		expect(r.data.ticket).toMatchObject({ state: "done", assigned_to: "test-admin" });
		expect((await app("conversations?chat=c1")).data.ticket).toMatchObject({ state: "done" });
		await app("inbox/chat", { chatId: "c1", state: null });
		list = await app("conversations");
		expect(list.data.conversations[0].ticket).toBe(null);
		expect((await app("inbox/chat", { chatId: "gone", state: "done" })).status).toBe(404);
	});
});

describe("Nova Agent's key", () => {
	it("can sort and move to Spam, and read saved replies, but never choose who's on it", async () => {
		const id = await addEnquiry();
		await app("inbox/saved", { title: "Prices", body: "Our rates are £40 an hour." });
		let r = await agent("/nova-agent/inbox/sort", { id, state: "spam", label: "Junk", assignedTo: "test-admin" });
		expect(r.status).toBe(200);
		expect(r.data.enquiry).toMatchObject({ status: "spam", label: "Junk", assigned_to: null, spam_reason: "Moved to Spam by Agent" });
		r = await agent("/nova-agent/enquiries", { show: "spam" });
		expect(r.data.enquiries[0]).toMatchObject({ id, state: "spam", label: "Junk", spam_reason: "Moved to Spam by Agent" });
		expect((await agent("/nova-agent/enquiries", { show: "all" })).data.enquiries).toHaveLength(0);
		r = await agent("/nova-agent/inbox/saved");
		expect(r.data.saved).toEqual([{ id: expect.any(Number), title: "Prices", body: "Our rates are £40 an hour." }]);
		// No saving or removing saved replies, no marking chats
		expect((await agent("/nova-agent/inbox/saved/remove", { id: 1 })).status).toBe(404);
		expect((await agent("/nova-agent/inbox/chat", { chatId: "c1", state: "done" })).status).toBe(404);
		// Nothing went out
		expect(outside).toEqual([]);
	});

	it("without the key: nothing", async () => {
		const ctx = createExecutionContext();
		const res = await worker.fetch(new Request(BASE + "/nova-agent/inbox/sort", { method: "POST", headers: { "Content-Type": "application/json" }, body: "{}" }), env, ctx);
		await waitOnExecutionContext(ctx);
		expect(res.status).toBe(401);
	});
});

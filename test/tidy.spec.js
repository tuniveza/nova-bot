// Portal → Test stuff (src/tidy.js): what's flagged and why (and what never is), admins only,
// deleting into the bin and putting back, "Not a test", and Nova Agent's read-only view
import { createExecutionContext, env, waitOnExecutionContext } from "cloudflare:test";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import worker from "../src";
import { findTestStuff } from "../src/tidy.js";
import { dramaPhone, jokeWordsIn, testEmail, testWordsIn } from "../src/tidy-words.js";
import { relayRule } from "../src/agent-relay.js";
import { STAFF_COOKIE } from "./sign-in.js";

const BASE = "https://novacane-worker.test";
const AGENT_KEY = "agent-nova-test-key";
const DAYS_AGO = (n) => new Date(Date.now() - n * 86_400_000).toISOString();

beforeEach(async () => {
	vi.spyOn(globalThis, "fetch").mockImplementation(async () => new Response("{}", { status: 200 }));
	await env.DB.batch(
		[
			"tidy_bin", "tidy_real", "tidy_log", "enquiry_messages", "enquiries", "client_sessions", "client_consent_log", "clients", "chat_messages", "chat_bookings",
			"agent_jobs", "memory_files", "memory_removed", "memory_progress", "memory_pending", "shared_notes", "social_post_log", "social_posts",
		].map((t) => env.DB.prepare(`DELETE FROM ${t}`))
	);
});
afterEach(() => vi.restoreAllMocks());

function portal(path, { body, cookie = STAFF_COOKIE, origin = BASE } = {}) {
	const headers = { Cookie: cookie };
	if (body !== undefined) Object.assign(headers, { "Content-Type": "application/json", Origin: origin });
	const ctx = createExecutionContext();
	return (async () => {
		const res = await worker.fetch(new Request(BASE + "/app/api/" + path, { method: body !== undefined ? "POST" : "GET", headers, body: body !== undefined ? JSON.stringify(body) : undefined }), env, ctx);
		await waitOnExecutionContext(ctx);
		return { status: res.status, data: await res.json() };
	})();
}

// ---- The rules, on plain data ----

describe("the words and numbers", () => {
	it("finds test, rude and joke words as whole words only", () => {
		expect(testWordsIn("Just testing the bot")).toEqual(["testing"]);
		expect(testWordsIn("Latest single, contest entry")).toEqual([]);
		expect(jokeWordsIn("Sensual Shagger")).toEqual(["shagger"]);
		expect(jokeWordsIn("Scunthorpe session")).toEqual([]);
		expect(jokeWordsIn("im looking to record your mum")).toEqual(["your mum"]);
	});
	it("knows Ofcom's TV and film numbers and made-up email addresses", () => {
		expect(dramaPhone("07700 900 789")).toBe(true);
		expect(dramaPhone("+44 7700 900123")).toBe(true);
		expect(dramaPhone("07450 908706")).toBe(false);
		expect(testEmail("jordan@example.com")).toMatch(/made-up/);
		expect(testEmail("test1@gmail.com")).toMatch(/test email name/);
		expect(testEmail("kf.realclient19@gmail.com")).toBeNull();
	});
});

const STAFF = [{ id: "tuniveza", email: "owner@novacane.test", display_name: "Tuniveza" }];
const base = (extra = {}) => ({ staff: STAFF, enquiries: [], clients: [], chats: [], chatMessages: [], bookings: [], jobs: [], index: [], notes: [], social: [], outreach: [], invoices: [], expenses: [], real: [], ...extra });
const byKey = (items) => Object.fromEntries(items.map((i) => [i.key, i]));

describe("findTestStuff", () => {
	it("flags what the studio's own tests looked like, with the reasons", () => {
		const items = byKey(
			findTestStuff(
				base({
					enquiries: [
						{ id: 3, created_at: DAYS_AGO(3), name: "Bilad", email: "owner@novacane.test", phone: "07510 108566", subject: "3 vocal tracks", details: "Singing", chat_id: "c-own", status: "done" },
						{ id: 6, created_at: DAYS_AGO(3), name: "Ronald Spanker", email: "gordon@gmail.com", phone: "07700 900 789", subject: "Vinyl sessions", details: "Availability", chat_id: null, status: "done" },
						{ id: 9, created_at: DAYS_AGO(1), name: "Sam Lee", email: "sam@gmail.com", phone: "07450 111222", subject: "Mixing", details: "Can you mix 4 songs?", chat_id: null, status: "new" },
					],
					chats: [
						{ chat_id: "claude-test-card-0001", n: 2, first: DAYS_AGO(5), last: DAYS_AGO(5) },
						{ chat_id: "c-mum", n: 4, first: DAYS_AGO(5), last: DAYS_AGO(5) },
						{ chat_id: "c-real", n: 6, first: DAYS_AGO(4), last: DAYS_AGO(4) },
						{ chat_id: "c-own", n: 10, first: DAYS_AGO(3), last: DAYS_AGO(3) },
					],
					chatMessages: [
						{ chat_id: "claude-test-card-0001", content: "Hi, I'd like to book a singer session next Thursday", created_at: DAYS_AGO(5) },
						{ chat_id: "c-mum", content: "im looking to record your mum", created_at: DAYS_AGO(5) },
						{ chat_id: "c-real", content: "do you work with singers who use auto tune?", created_at: DAYS_AGO(4) },
						{ chat_id: "c-own", content: "Are we able to book a session", created_at: DAYS_AGO(3) },
					],
				})
			)
		);
		expect(items["enquiry:3"].confidence).toBe("likely");
		expect(items["enquiry:3"].reasons.map((r) => r.text)).toContain("Uses Tuniveza's own email");
		expect(items["enquiry:3"].linked.map((l) => l.key)).toContain("chat:c-own");
		expect(items["enquiry:6"].reasons.map((r) => r.text).join(" ")).toMatch(/TV and film phone number/);
		expect(items["enquiry:9"]).toBeUndefined();
		expect(items["chat:claude-test-card-0001"].reasons[0].text).toBe("Made by Claude while testing");
		expect(items["chat:c-mum"].confidence).toBe("likely");
		expect(items["chat:c-real"]).toBeUndefined();
		// The chat that made the test enquiry
		expect(items["chat:c-own"].reasons.map((r) => r.text)).toContain("Its enquiry looks like a test");
	});

	it("never flags a real Acuity client, even sharing a name with nothing odd", () => {
		const items = findTestStuff(
			base({
				clients: [
					{ id: 1, name: "Kai Francis", email: "kai@gmail.com", phone: "+447450908706", source: "booking", created_at: DAYS_AGO(9), sessions: 2, invoices: 0, outreach: 0, consent_log: 0, marketing_consent: 0, deposits_paid_pence: 0 },
					{ id: 2, name: "Femi", email: "femi@battaleone.com", phone: null, source: "booking", created_at: DAYS_AGO(9), sessions: 1, invoices: 0, outreach: 0, consent_log: 0, marketing_consent: 1, deposits_paid_pence: 0 },
				],
			})
		);
		expect(items).toEqual([]);
	});

	it("a real client with a strong sign is only a Maybe, and locked", () => {
		const [item] = findTestStuff(
			base({ clients: [{ id: 5, name: "Rio", email: "owner@novacane.test", phone: null, source: "booking", created_at: DAYS_AGO(9), sessions: 1, invoices: 0, outreach: 0, consent_log: 0, marketing_consent: 0, deposits_paid_pence: 0 }] })
		);
		expect(item.confidence).toBe("maybe");
		expect(item.locked).toBe(true);
	});

	it("a client made from a test enquiry goes with it", () => {
		const items = byKey(
			findTestStuff(
				base({
					enquiries: [{ id: 5, created_at: DAYS_AGO(3), name: "Tree Wood Thacker", email: "cock@gmail.co.uk", phone: null, subject: "Singing", details: "October", chat_id: null, status: "done" }],
					clients: [{ id: 12, name: "Tree Wood Thacker", email: "cock@gmail.co.uk", phone: null, source: "enquiry", created_at: DAYS_AGO(2), sessions: 0, invoices: 0, outreach: 0, consent_log: 0, marketing_consent: 0, deposits_paid_pence: 0 }],
				})
			)
		);
		expect(items["client:12"].confidence).toBe("likely");
		expect(items["enquiry:5"].linked.map((l) => l.key)).toContain("client:12");
	});

	it("chat bookings that never reached Acuity, their jobs, and the same first message minutes apart", () => {
		const t = Date.now() - 3 * 86_400_000;
		const at = (m) => new Date(t + m * 60_000).toISOString();
		const items = byKey(
			findTestStuff(
				base({
					bookings: [
						{ id: 1, created_at: at(0), appointment_id: null, starts_at: "2026-12-01 10:00", name: "Bollard Baxter", email: "x@gmail.com", phone: null, chat_id: "c1" },
						{ id: 13, created_at: at(5), appointment_id: null, starts_at: "2026-11-25 12:00", name: "Neiman Brown", email: "n@gmail.com", phone: null, chat_id: "gone" },
						{ id: 20, created_at: at(6), appointment_id: 555, starts_at: "2026-11-26 12:00", name: "Real Person", email: "r@gmail.com", phone: null, chat_id: null },
					],
					jobs: [{ id: 1, created_at: at(0), kind: "book", appointment_id: null, client_name: "Bollard Baxter", status: "failed" }],
					chats: ["c1", "a", "b", "c"].map((id, i) => ({ chat_id: id, n: 6, first: at(i), last: at(i) })),
					chatMessages: [
						{ chat_id: "c1", content: "Book me in", created_at: at(0) },
						...["a", "b", "c"].map((id, i) => ({ chat_id: id, content: "How much is a studio session?", created_at: at(i + 1) })),
					],
				})
			)
		);
		expect(items["booking:1"].confidence).toBe("likely");
		expect(items["booking:1"].job).toBe(1);
		expect(items["booking:13"].confidence).toBe("likely"); // never reached Acuity + its chat is gone
		expect(items["booking:20"]).toBeUndefined();
		expect(items["chat:c1"].linked.map((l) => l.key)).toContain("booking:1");
		expect(items["chat:a"].reasons.map((r) => r.text)).toContain("Starts the same way as 2 other chats minutes apart");
		expect(items["chat:a"].confidence).toBe("maybe");
	});

	it("Index pages whose chat is gone, the same facts twice, and copies of notes and drafts", () => {
		const items = byKey(
			findTestStuff(
				base({
					index: [
						{ id: "i1", scope: "customer", owner_id: "chat:gone", path: "profile", name: "profile", description: "", body: "- [stated] raps", updated_at: 1 },
						{ id: "i2", scope: "staff", owner_id: "tuniveza", path: "topics/process", name: "process", description: "", body: "- [stated] mixes on Mondays", updated_at: 1 },
						{ id: "i3", scope: "staff", owner_id: "tuniveza", path: "topics/workflow", name: "workflow", description: "", body: "- [stated] mixes on Mondays", updated_at: 2 },
						{ id: "i4", scope: "studio", owner_id: null, path: "people/dildo-twaine", name: "dildo-twaine", description: "Dildo Twaine's contact", body: "- x", updated_at: 1 },
						{ id: "i5", scope: "studio", owner_id: null, path: "studio", name: "studio", description: "The studio", body: "- [stated] in Forest Hill", updated_at: 1 },
					],
					notes: [
						{ id: "n1", title: "Plan", size: 900, head: "<p>a</p>", created_at: DAYS_AGO(3), updated_at: DAYS_AGO(3) },
						{ id: "n2", title: "Plan", size: 900, head: "<p>a</p>", created_at: DAYS_AGO(2), updated_at: DAYS_AGO(2) },
						{ id: "n3", title: "Nova Board", size: 2600, head: "<p>b</p>", created_at: DAYS_AGO(2), updated_at: DAYS_AGO(2) },
					],
					social: [
						{ id: 1, caption: "New single out Friday", status: "pending_approval", created_by: "agent", created_at: DAYS_AGO(2) },
						{ id: 2, caption: "New single out Friday", status: "pending_approval", created_by: "agent", created_at: DAYS_AGO(1) },
						{ id: 3, caption: "testing the planner", status: "draft", created_by: "tuniveza", created_at: DAYS_AGO(1) },
					],
				})
			)
		);
		expect(items["index:i1"].reasons[0].text).toBe("Its website chat is gone");
		expect(items["index:i2"].reasons.map((r) => r.text)).toContain("The same facts as “topics/workflow”");
		expect(items["index:i3"]).toBeUndefined(); // the newer copy stays
		expect(items["index:i4"].confidence).toBe("likely");
		expect(items["index:i5"]).toBeUndefined();
		expect(items["note:n1"].confidence).toBe("likely");
		expect(items["note:n2"]).toBeUndefined();
		expect(items["note:n3"]).toBeUndefined();
		expect(items["social:1"].confidence).toBe("likely");
		expect(items["social:2"]).toBeUndefined();
		expect(items["social:3"].confidence).toBe("likely");
	});

	it("leaves out what an admin said isn't a test", () => {
		const data = base({ chats: [{ chat_id: "claude-test-1", n: 2, first: DAYS_AGO(1), last: DAYS_AGO(1) }], chatMessages: [{ chat_id: "claude-test-1", content: "hi", created_at: DAYS_AGO(1) }] });
		expect(findTestStuff(data)).toHaveLength(1);
		expect(findTestStuff({ ...data, real: [{ key: "chat:claude-test-1" }] })).toHaveLength(0);
	});
});

// ---- Portal ----

async function seed() {
	const old = DAYS_AGO(3);
	await env.DB.batch([
		env.DB.prepare("INSERT INTO enquiries (id, created_at, name, email, phone, subject, details, chat_id, status) VALUES (7, ?, 'Dominic Hughes', 'test-admin@novacane.test', '07700 900789', 'Vinyl', 'Sessions', 'chat-t', 'replied')").bind(old),
		env.DB.prepare("INSERT INTO enquiry_messages (enquiry_id, direction, body, created_by, created_at, updated_at) VALUES (7, 'note', 'a note', 'staff', ?, ?)").bind(old, old),
		env.DB.prepare("INSERT INTO chat_messages (chat_id, created_at, role, content) VALUES ('chat-t', ?, 'user', 'Book a session'), ('chat-t', ?, 'assistant', 'Sure')").bind(old, old),
		env.DB.prepare("INSERT INTO chat_bookings (id, created_at, appointment_id, type_id, starts_at, name, email, phone, chat_id, sender) VALUES (1, ?, NULL, 1, '2026-12-01 10:00', 'Shit head', 'x@gmail.com', NULL, 'chat-t', 'h')").bind(old),
		env.DB.prepare("INSERT INTO agent_jobs (id, created_at, kind, appointment_id, client_name, changes, summary, status) VALUES (1, ?, 'book', NULL, 'Shit head', '{}', 'Book', 'failed')").bind(old),
		env.DB.prepare("INSERT INTO memory_files (id, scope, owner_id, path, name, description, aliases, body, version, source_app, updated_at) VALUES ('f1', 'customer', 'chat:chat-t', 'profile', 'profile', 'p', '[]', '- [stated] raps', 'v1', 'bot', 1)"),
		env.DB.prepare("INSERT INTO clients (id, name, email, source, created_at, updated_at) VALUES (1, 'Kai Francis', 'kai@gmail.com', 'booking', ?, ?)").bind(old, old),
		env.DB.prepare("INSERT INTO client_sessions (acuity_id, client_id, session, starts_at, status, source, updated_at) VALUES (1707528280, 1, 'Rap Package', ?, 'booked', 'feed', ?)").bind(old, old),
	]);
}

describe("Portal → Test stuff", () => {
	it("is for admins only", async () => {
		await env.DB.prepare(
			"INSERT OR IGNORE INTO staff (id, email, password_hash, display_name, role, status, created_at, planet_seed, index_partition) VALUES ('test-staff', 'test-staff@novacane.test', NULL, 'Test Staff', 'staff', 'active', ?, 'test-staff', 'staff:test-staff')"
		)
			.bind(new Date().toISOString())
			.run();
		const { sha256 } = await import("../src/portal/auth.js");
		await env.DB.prepare("INSERT OR REPLACE INTO sessions (id, staff_id, kind, created_at, expires_at, last_seen_at) VALUES (?, 'test-staff', 'cookie', ?, ?, ?)")
			.bind(await sha256("staff-session"), new Date().toISOString(), DAYS_AGO(-1), new Date().toISOString())
			.run();
		expect((await portal("tidy", { cookie: "nova_session=staff-session" })).status).toBe(403);
		expect((await portal("tidy/delete", { cookie: "nova_session=staff-session", body: { items: [{ key: "chat:x" }] } })).status).toBe(403);
		expect((await portal("tidy", { cookie: "" })).status).toBe(401);
		// Another website can't make an admin delete things
		expect((await portal("tidy/delete", { body: { items: [{ key: "chat:x" }] }, origin: "https://evil.example" })).status).toBe(403);
	});

	it("lists them, deletes one with what goes with it into the bin, and puts it all back", async () => {
		await seed();
		const list = await portal("tidy");
		expect(list.status).toBe(200);
		const keys = list.data.items.map((i) => i.key);
		expect(keys).toEqual(expect.arrayContaining(["enquiry:7", "chat:chat-t", "booking:1", "index:f1"]));
		expect(keys).not.toContain("client:1");
		const chat = list.data.items.find((i) => i.key === "chat:chat-t");
		expect(chat.linked.map((l) => l.key)).toEqual(expect.arrayContaining(["booking:1", "enquiry:7", "index:f1"]));

		const del = await portal("tidy/delete", { body: { items: [{ key: chat.key, title: chat.title, together: true, linked: chat.linked.map((l) => l.key) }] } });
		expect(del.data.failed).toEqual([]);
		const count = async (sql) => (await env.DB.prepare(sql).first()).n;
		expect(await count("SELECT COUNT(*) AS n FROM chat_messages")).toBe(0);
		expect(await count("SELECT COUNT(*) AS n FROM chat_bookings")).toBe(0);
		expect(await count("SELECT COUNT(*) AS n FROM agent_jobs")).toBe(0);
		expect(await count("SELECT COUNT(*) AS n FROM enquiries")).toBe(0);
		expect(await count("SELECT COUNT(*) AS n FROM enquiry_messages")).toBe(0);
		expect(await count("SELECT COUNT(*) AS n FROM memory_files")).toBe(0);
		// The Index page went through Index's own bin
		expect(await count("SELECT COUNT(*) AS n FROM memory_removed WHERE reason = 'Deleted in Portal → Test stuff'")).toBe(1);
		// The real client is untouched
		expect(await count("SELECT COUNT(*) AS n FROM clients")).toBe(1);
		// The log has ids and kinds, nothing else
		const logged = await env.DB.prepare("SELECT * FROM tidy_log").all();
		expect(logged.results).toEqual([expect.objectContaining({ action: "delete", item_key: "chat:chat-t", by: "test-admin" })]);

		const after = await portal("tidy");
		expect(after.data.items).toEqual([]);
		expect(after.data.recent).toHaveLength(1);
		const back = await portal("tidy/restore", { body: { binId: after.data.recent[0].binId } });
		expect(back.data.ok).toBe(true);
		expect(await count("SELECT COUNT(*) AS n FROM chat_messages")).toBe(2);
		expect(await count("SELECT COUNT(*) AS n FROM chat_bookings")).toBe(1);
		expect(await count("SELECT COUNT(*) AS n FROM agent_jobs")).toBe(1);
		expect(await count("SELECT COUNT(*) AS n FROM enquiries")).toBe(1);
		expect(await count("SELECT COUNT(*) AS n FROM enquiry_messages")).toBe(1);
		expect(await count("SELECT COUNT(*) AS n FROM memory_files WHERE scope = 'customer' AND owner_id = 'chat:chat-t'")).toBe(1);
		expect((await portal("tidy/restore", { body: { binId: after.data.recent[0].binId } })).status).toBe(409);
	});

	it("won't delete a client with sessions, even if asked", async () => {
		await seed();
		const res = await portal("tidy/delete", { body: { items: [{ key: "client:1", title: "Kai" }] } });
		expect(res.data.failed[0].error).toMatch(/stays/);
		expect((await env.DB.prepare("SELECT COUNT(*) AS n FROM clients").first()).n).toBe(1);
	});

	it("deletes a shared note the way Notes does, and puts it back", async () => {
		const now = new Date().toISOString();
		await env.DB.batch(
			["n-old", "n-new"].map((id, i) =>
				env.DB.prepare("INSERT INTO shared_notes (id, title, html, meta, created_at, updated_at, created_by, created_by_name, updated_by, updated_by_name, size, rev) VALUES (?, 'Plan', '<p>same</p>', '{}', ?, ?, 'test-admin', 'Test Admin', 'test-admin', 'Test Admin', 11, ?)").bind(id, now, i ? DAYS_AGO(-0.001) : now, i + 1)
			)
		);
		const list = await portal("tidy");
		const note = list.data.items.find((i) => i.kind === "note");
		expect(note.key).toBe("note:n-old");
		await portal("tidy/delete", { body: { items: [{ key: note.key, title: note.title }] } });
		const gone = await env.DB.prepare("SELECT html, deleted_at, rev FROM shared_notes WHERE id = 'n-old'").first();
		expect(gone.html).toBe("");
		expect(gone.deleted_at).toBeTruthy();
		expect(gone.rev).toBe(3);
		const recent = (await portal("tidy")).data.recent;
		await portal("tidy/restore", { body: { binId: recent[0].binId } });
		const back = await env.DB.prepare("SELECT html, deleted_at FROM shared_notes WHERE id = 'n-old'").first();
		expect(back).toEqual({ html: "<p>same</p>", deleted_at: null });
	});

	it("Not a test is remembered, and Undo brings it back to the list", async () => {
		await seed();
		await portal("tidy/real", { body: { key: "booking:1", title: "Shit head" } });
		let list = await portal("tidy");
		expect(list.data.items.map((i) => i.key)).not.toContain("booking:1");
		expect(list.data.real.map((r) => r.key)).toEqual(["booking:1"]);
		await portal("tidy/unreal", { body: { key: "booking:1" } });
		list = await portal("tidy");
		expect(list.data.items.map((i) => i.key)).toContain("booking:1");
	});
});

describe("Nova Agent and the link to the PC", () => {
	it("Nova Agent's key can only read the list", async () => {
		await seed();
		const ctx = createExecutionContext();
		const call = (path) => worker.fetch(new Request(BASE + path, { method: "POST", headers: { "Content-Type": "application/json", Authorization: `Bearer ${AGENT_KEY}` }, body: "{}" }), { ...env, AGENT_NOVA_KEY: AGENT_KEY }, ctx);
		const res = await call("/nova-agent/tidy");
		const data = await res.json();
		expect(data.counts.likely).toBeGreaterThan(0);
		expect(data.items[0]).not.toHaveProperty("key");
		expect((await call("/nova-agent/tidy/delete")).status).toBe(404);
		await waitOnExecutionContext(ctx);
	});

	it("the PC's Test stuff addresses are relayed for admins only", () => {
		expect(relayRule("GET", "/tidy-api/state")).toMatchObject({ admin: true });
		expect(relayRule("POST", "/actions/tidy/delete")).toMatchObject({ admin: true });
		expect(relayRule("POST", "/actions/tidy/everything")).toBeNull();
	});
});

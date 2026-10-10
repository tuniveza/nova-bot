// Email campaigns on Resend, with an admin's approval (src/campaigns.js, src/resend-marketing.js,
// src/fans.js, the /nova-agent/campaigns/* routes and Portal's /app/api/campaigns). Nothing goes to
// Resend as a broadcast unless an admin, signed in to Portal in a browser, pressed Approve on
// exactly what's saved. Only people who opted in are put into Resend, and unsubscribes come back.
import { createExecutionContext, env, waitOnExecutionContext } from "cloudflare:test";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import worker from "../src";
import { campaignEmail, campaignsOnSchedule, checkScheduled, refreshStats, sendApproved } from "../src/campaigns.js";
import { sha256 } from "../src/portal/auth.js";
import { STAFF_COOKIE } from "./sign-in.js";

const BASE = "https://novacane-worker.test";
const KEY = "agent-nova-test-key";
const MARKETING_KEY = "re_test_marketing_secret_123";
const SEND_KEY = "re_test_sending_secret_456";
const RESEND_ENV = { RESEND_MARKETING_KEY: MARKETING_KEY, RESEND_API_KEY: SEND_KEY, CAMPAIGN_FROM: "Novacane Studios <news@novacane.co.uk>" };

// ----- A fake Resend -----

let segments; // id -> name
let contacts; // id -> { id, email, first_name, last_name, unsubscribed, segments: Set, properties }
let broadcasts; // id -> { id, segment_id, subject, html, text, from, status, scheduled_at, sent_at }
let recipients; // broadcast id -> type -> [{ id, email }]
let calls; // "METHOD /path" for every call to Resend
let emails; // bodies POSTed to /emails
let scripted; // answers to give first: [{ status, body, headers }]
let nextId;

const reply = (data, status = 200, headers = {}) => new Response(JSON.stringify(data), { status, headers: { "Content-Type": "application/json", ...headers } });
const findContact = (ref) => contacts.get(ref) || [...contacts.values()].find((c) => c.email === decodeURIComponent(ref).toLowerCase());
const contactShape = (c) => ({ object: "contact", id: c.id, email: c.email, first_name: c.first_name || null, last_name: c.last_name || null, created_at: "2026-10-01 10:00:00.000+00", unsubscribed: c.unsubscribed });
const page = (list, u) => {
	const limit = Number(u.searchParams.get("limit")) || 20;
	const after = u.searchParams.get("after");
	const start = after ? list.findIndex((x) => x.id === after) + 1 : 0;
	const data = list.slice(start, start + limit);
	return reply({ object: "list", has_more: start + limit < list.length, data });
};

// A contact already in Resend (as if put there earlier)
function resendContact(email, { unsubscribed = false, inSegments = [], properties = {} } = {}) {
	const id = `contact-${nextId++}`;
	contacts.set(id, { id, email, unsubscribed, segments: new Set(inSegments), properties });
	return id;
}

beforeEach(async () => {
	await env.DB.batch([
		env.DB.prepare("DELETE FROM email_campaign_log"),
		env.DB.prepare("DELETE FROM email_campaigns"),
		env.DB.prepare("DELETE FROM fans"),
		env.DB.prepare("DELETE FROM client_consent_log"),
		env.DB.prepare("DELETE FROM client_sessions"),
		env.DB.prepare("DELETE FROM clients"),
		env.DB.prepare("DELETE FROM settings"),
	]);
	segments = new Map();
	contacts = new Map();
	broadcasts = new Map();
	recipients = new Map();
	calls = [];
	emails = [];
	scripted = [];
	nextId = 1;
	vi.spyOn(globalThis, "fetch").mockImplementation(async (url, init = {}) => {
		const u = new URL(String(url));
		if (u.origin !== "https://api.resend.com") return reply({ error: "not_found" }, 404);
		const method = init.method || "GET";
		const path = u.pathname;
		const body = init.body ? JSON.parse(init.body) : null;
		calls.push(`${method} ${path}`);
		if (path === "/emails") {
			expect(init.headers.Authorization).toBe(`Bearer ${SEND_KEY}`);
			emails.push(body);
			return reply({ id: `email-${nextId++}` });
		}
		expect(init.headers.Authorization).toBe(`Bearer ${MARKETING_KEY}`);
		if (scripted.length) {
			const next = scripted.shift();
			return reply(next.body ?? {}, next.status, next.headers);
		}
		if (path === "/segments" && method === "GET") return reply({ object: "list", data: [...segments].map(([id, name]) => ({ id, name })) });
		if (path === "/segments" && method === "POST") {
			const id = `segment-${nextId++}`;
			segments.set(id, body.name);
			return reply({ object: "segment", id, name: body.name });
		}
		if (path === "/contact-properties" && method === "POST") return reply({ object: "contact_property", id: `property-${body.key}` });
		if (path === "/contacts" && method === "GET") {
			const sid = u.searchParams.get("segment_id");
			return page([...contacts.values()].filter((c) => c.segments.has(sid)).map(contactShape), u);
		}
		if (path === "/contacts" && method === "POST") {
			if (findContact(body.email)) return reply({ statusCode: 409, name: "conflict", message: "Contact already exists" }, 409);
			const id = resendContact(body.email, { unsubscribed: body.unsubscribed === true, inSegments: (body.segments || []).map((s) => s.id), properties: { ...body.properties } });
			Object.assign(contacts.get(id), { first_name: body.first_name, last_name: body.last_name });
			return reply({ object: "contact", id });
		}
		const inSegment = path.match(/^\/contacts\/([^/]+)\/segments\/([^/]+)$/);
		if (inSegment) {
			const c = findContact(inSegment[1]);
			if (!c) return reply({ message: "not found" }, 404);
			if (method === "POST") c.segments.add(decodeURIComponent(inSegment[2]));
			if (method === "DELETE") c.segments.delete(decodeURIComponent(inSegment[2]));
			return reply({ id: c.id });
		}
		const contact = path.match(/^\/contacts\/([^/]+)$/);
		if (contact) {
			const c = findContact(contact[1]);
			if (!c) return reply({ message: "not found" }, 404);
			if (method === "GET") return reply({ ...contactShape(c), properties: Object.fromEntries(Object.entries(c.properties).map(([k, v]) => [k, { value: v, type: "string" }])) });
			if (method === "PATCH") {
				if ("unsubscribed" in body) c.unsubscribed = body.unsubscribed;
				Object.assign(c.properties, body.properties || {});
				return reply({ object: "contact", id: c.id });
			}
		}
		if (path === "/broadcasts" && method === "POST") {
			const id = `broadcast-${nextId++}`;
			broadcasts.set(id, { id, ...body, status: "draft", scheduled_at: null, sent_at: null });
			return reply({ id });
		}
		const send = path.match(/^\/broadcasts\/([^/]+)\/send$/);
		if (send && method === "POST") {
			const b = broadcasts.get(send[1]);
			if (!b || b.status !== "draft") return reply({ message: "not a draft" }, 422);
			Object.assign(b, body?.scheduled_at ? { status: "scheduled", scheduled_at: body.scheduled_at } : { status: "sent", sent_at: "2026-10-11 12:00:00.000+00" });
			return reply({ id: b.id });
		}
		const listed = path.match(/^\/broadcasts\/([^/]+)\/recipients$/);
		if (listed) return page(recipients.get(listed[1])?.[u.searchParams.get("type")] || [], u);
		const one = path.match(/^\/broadcasts\/([^/]+)$/);
		if (one) {
			const b = broadcasts.get(one[1]);
			if (!b) return reply({ message: "not found" }, 404);
			if (method === "GET") return reply({ object: "broadcast", ...b });
			if (method === "DELETE") {
				if (!["draft", "scheduled"].includes(b.status)) return reply({ message: "can't delete a sent broadcast" }, 422);
				broadcasts.delete(one[1]);
				return reply({ object: "broadcast", id: b.id, deleted: true });
			}
		}
		return reply({ message: "unknown route" }, 404);
	});
});

afterEach(() => {
	vi.restoreAllMocks();
});

// ----- Calling the Worker -----

async function call(request, extraEnv = RESEND_ENV) {
	const ctx = createExecutionContext();
	const res = await worker.fetch(request, { ...env, AGENT_NOVA_KEY: KEY, ...extraEnv }, ctx);
	await waitOnExecutionContext(ctx);
	const text = await res.text();
	let data = null;
	try {
		data = JSON.parse(text);
	} catch {}
	return { status: res.status, data, text, headers: res.headers };
}

const agent = (path, body = {}) =>
	call(new Request(BASE + path, { method: "POST", headers: { "Content-Type": "application/json", Authorization: `Bearer ${KEY}` }, body: JSON.stringify(body) }));

function portal(route, { body, headers = { Cookie: STAFF_COOKIE }, extraEnv } = {}) {
	const init = body === undefined ? { headers } : { method: "POST", headers: { "Content-Type": "application/json", Origin: BASE, ...headers }, body: JSON.stringify(body) };
	return call(new Request(`${BASE}/app/api/${route}`, init), extraEnv);
}

const ENV = () => ({ ...env, ...RESEND_ENV });
const row = (id) => env.DB.prepare("SELECT * FROM email_campaigns WHERE id = ?").bind(id).first();
const broadcastCalls = () => calls.filter((c) => c.startsWith("POST /broadcasts"));
const later = (hours) => new Date(Date.now() + hours * 3600000).toISOString();
const segmentId = (name) => [...segments].find(([, n]) => n === name)?.[0];
const segmentEmails = (name) => [...contacts.values()].filter((c) => c.segments.has(segmentId(name))).map((c) => c.email).sort();

// ----- People -----

async function addFan(email, status = "confirmed", name = "Fan Person") {
	const at = "2026-10-03T12:00:00.000Z";
	await env.DB.prepare("INSERT INTO fans (email, name, status, created_at, confirmed_at, consent_at, consent_source) VALUES (?, ?, ?, ?, ?, ?, ?)")
		.bind(email, name, status, at, status === "pending" ? null : at, status === "pending" ? null : at, status === "pending" ? null : "Fan sign-up form, confirmed by email")
		.run();
}

async function addClient(email, consent, name = "Client Person") {
	const at = "2026-10-03T09:00:00.000Z";
	const { id } = await env.DB.prepare(
		"INSERT INTO clients (name, email, marketing_consent, consent_at, consent_source, consent_by, source, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, 'staff', ?, ?) RETURNING id"
	)
		.bind(name, email, consent, consent ? at : null, consent ? "Said yes in person" : null, consent ? "test-admin" : null, at, at)
		.first();
	if (consent) await env.DB.prepare("INSERT INTO client_consent_log (client_id, consent, at, source, \"by\", recorded_at) VALUES (?, 1, ?, 'Said yes in person', 'test-admin', ?)").bind(id, at, at).run();
	return id;
}

async function draft(fields = {}) {
	const { status, data } = await agent("/nova-agent/campaigns/draft", { subject: "New single out Friday", body: "Hello!\n\nOur new single is out on **Friday**. Listen at https://novacane.co.uk/listen", audience: "fans", ...fields });
	expect(status).toBe(200);
	return data.campaign;
}

// A staff member who isn't an admin, and the admin signed in through an app (a token, not the cookie)
async function otherSignIns() {
	const now = new Date().toISOString();
	const until = new Date(Date.now() + 86_400_000).toISOString();
	await env.DB.batch([
		env.DB.prepare(
			"INSERT OR IGNORE INTO staff (id, email, password_hash, display_name, role, status, created_at, planet_seed, index_partition) VALUES ('test-staff', 'test-staff@novacane.test', NULL, 'Test Staff', 'staff', 'active', ?, 'test-staff', 'staff:test-staff')"
		).bind(now),
		env.DB.prepare("INSERT OR REPLACE INTO sessions (id, staff_id, kind, created_at, expires_at, last_seen_at) VALUES (?, 'test-staff', 'cookie', ?, ?, ?)").bind(await sha256("test-staff-session"), now, until, now),
		env.DB.prepare("INSERT OR REPLACE INTO sessions (id, staff_id, kind, created_at, expires_at, last_seen_at) VALUES (?, 'test-admin', 'token', ?, ?, ?)").bind(await sha256("nsess_test-admin-app"), now, until, now),
	]);
	return { staff: { Cookie: "nova_session=test-staff-session" }, adminToken: { Authorization: "Bearer nsess_test-admin-app" } };
}

// ===== 1. APPROVAL IS ENFORCED =====

describe("approval", () => {
	beforeEach(async () => {
		await addFan("fan@example.com");
	});

	it("the AI's draft waits for approval; no agent-key route can approve, send, schedule or test-send", async () => {
		const c = await draft({ status: "approved", approved_hash: "x", decidedBy: "test-admin" });
		expect(c).toMatchObject({ status: "pending_approval", createdBy: "agent", decidedBy: null, audience: "fans" });
		expect(c.portalUrl).toBe(`${BASE}/portal/?view=campaigns&campaign=${c.id}`);
		for (const path of [`/nova-agent/campaigns/${c.id}/approve`, `/nova-agent/campaigns/${c.id}/send`, `/nova-agent/campaigns/${c.id}/schedule`, `/nova-agent/campaigns/${c.id}/test-send`, "/nova-agent/campaigns/test-send", "/nova-agent/campaigns/approve"]) {
			expect((await agent(path, { id: c.id })).status).toBe(404);
		}
		// The agent's key on Portal's routes: not signed in
		const viaKey = await call(new Request(`${BASE}/app/api/campaigns/${c.id}/approve`, { method: "POST", headers: { Origin: BASE, Authorization: `Bearer ${KEY}` }, body: "{}" }));
		expect(viaKey.status).toBe(401);
		expect((await row(c.id)).status).toBe("pending_approval");
		expect((await row(c.id)).approved_hash).toBeNull();
		expect(broadcastCalls()).toEqual([]);
		expect(emails).toEqual([]);
	});

	it("only an admin with the browser cookie can approve, reject or test-send: staff and a token session get 403", async () => {
		const c = await draft();
		const { staff, adminToken } = await otherSignIns();
		const seen = await portal("campaigns", { headers: staff });
		expect(seen.status).toBe(200);
		expect(seen.data.canDecide).toBe(false);
		expect((await portal("campaigns", { headers: adminToken })).data.canDecide).toBe(false);
		expect((await portal("campaigns")).data.canDecide).toBe(true);
		for (const headers of [staff, adminToken]) {
			expect((await portal(`campaigns/${c.id}/approve`, { body: {}, headers })).status).toBe(403);
			expect((await portal(`campaigns/${c.id}/reject`, { body: {}, headers })).status).toBe(403);
			expect((await portal("campaigns/test-send", { body: { id: c.id }, headers })).status).toBe(403);
		}
		// Another website, or not signed in
		expect((await portal(`campaigns/${c.id}/approve`, { body: {}, headers: { Cookie: STAFF_COOKIE, Origin: "https://evil.example" } })).status).toBe(403);
		expect((await portal(`campaigns/${c.id}/approve`, { body: {}, headers: {} })).status).toBe(401);
		// Staff can still write and edit (it stays waiting)
		const edited = await portal(`campaigns/${c.id}/edit`, { body: { subject: "New single out this Friday" }, headers: staff });
		expect(edited.data.campaign.status).toBe("pending_approval");
		expect((await row(c.id)).status).toBe("pending_approval");
		expect(broadcastCalls()).toEqual([]);
		expect(emails).toEqual([]);
	});

	it("draft, pending_approval, rejected and edited-after-approval campaigns are never sent or scheduled", async () => {
		const pending = await draft();
		const rejected = await draft({ subject: "Not this one" });
		expect((await portal(`campaigns/${rejected.id}/reject`, { body: { note: "Too soon" } })).data.campaign).toMatchObject({ status: "rejected", note: "Too soon", decidedBy: "test-admin" });
		expect((await portal(`campaigns/${rejected.id}/approve`, { body: {} })).status).toBe(409);
		const now = new Date().toISOString();
		const { id: draftId } = await env.DB.prepare(
			"INSERT INTO email_campaigns (subject, body, audience, status, created_by, created_at, updated_at) VALUES ('A draft', 'Just a draft, not sent for approval.', 'fans', 'draft', 'agent', ?, ?) RETURNING id"
		)
			.bind(now, now)
			.first();
		// Approved and scheduled, then edited: back to waiting, and Resend's scheduled send is cancelled
		const edited = await draft({ subject: "Later", sendAt: later(48) });
		expect((await portal(`campaigns/${edited.id}/approve`, { body: {} })).data.campaign.status).toBe("scheduled");
		const before = broadcastCalls().length;
		const after = await agent(`/nova-agent/campaigns/${edited.id}/edit`, { body: "Changed after the approval, by the AI." });
		expect(after.data.campaign).toMatchObject({ status: "pending_approval", decidedBy: null });
		expect(broadcasts.size).toBe(0);

		// The sender, the cron and the agent can't move any of them
		for (const id of [pending.id, rejected.id, draftId, edited.id]) await sendApproved(ENV(), id);
		await campaignsOnSchedule(ENV(), Date.now() + 49 * 3600000);
		expect(broadcastCalls().length).toBe(before);
		expect((await row(pending.id)).status).toBe("pending_approval");
		expect((await row(rejected.id)).status).toBe("rejected");
		expect((await row(draftId)).status).toBe("draft");
		expect((await row(edited.id)).status).toBe("pending_approval");
		expect((await row(edited.id)).approved_hash).toBeNull();
	});
});

// ===== 2. EDITING AFTER APPROVAL =====

describe("the approval hash", () => {
	it("editing clears the approval, and the sender refuses anything that changed since it was approved", async () => {
		await addFan("fan@example.com");
		const c = await draft({ sendAt: later(24) });
		await portal(`campaigns/${c.id}/approve`, { body: {} });
		const approved = await row(c.id);
		expect(approved.status).toBe("scheduled");
		expect(approved.approved_hash).toMatch(/^[0-9a-f]{64}$/);

		await portal(`campaigns/${c.id}/edit`, { body: { subject: "A new subject" } });
		const edited = await row(c.id);
		expect(edited).toMatchObject({ status: "pending_approval", approved_hash: null, decided_by: null, broadcast_id: null });
		expect(calls).toContain(`DELETE /broadcasts/${approved.broadcast_id}`);

		// Something changes what's saved while it's 'approved' (with the old approval's hash): refused
		await env.DB.prepare("UPDATE email_campaigns SET status = 'approved', approved_hash = ? WHERE id = ?").bind(approved.approved_hash, c.id).run();
		const before = broadcastCalls().length;
		const result = await sendApproved(ENV(), c.id);
		expect(result.status).toBe("pending_approval");
		expect(result.error).toMatch(/changed after it was approved/);
		expect(broadcastCalls().length).toBe(before);
		expect((await row(c.id)).approved_hash).toBeNull();
	});
});

// ===== 3. EXACTLY ONCE =====

describe("approve", () => {
	it("two presses at once send it exactly once", async () => {
		await addFan("fan@example.com");
		const c = await draft();
		const [a, b] = await Promise.all([portal(`campaigns/${c.id}/approve`, { body: {} }), portal(`campaigns/${c.id}/approve`, { body: {} })]);
		expect([a.status, b.status]).toEqual([200, 200]);
		expect(calls.filter((x) => x === "POST /broadcasts")).toHaveLength(1);
		expect(calls.filter((x) => /^POST \/broadcasts\/.+\/send$/.test(x))).toHaveLength(1);
		const saved = await row(c.id);
		expect(saved).toMatchObject({ status: "sent", recipients: 1, decided_by: "test-admin" });
		// Pressed again later: still once
		expect((await portal(`campaigns/${c.id}/approve`, { body: {} })).data.repeated).toBe(true);
		await sendApproved(ENV(), c.id);
		expect(calls.filter((x) => x === "POST /broadcasts")).toHaveLength(1);
		const events = (await portal(`campaigns/${c.id}`)).data.log.map((l) => l.event);
		expect(events).toEqual(["created", "submitted", "approved", "sent"]);
	});

	it("waits and tries again when Resend says 429", async () => {
		await addFan("fan@example.com");
		const c = await draft();
		scripted.push({ status: 429, body: { message: "Too many requests" }, headers: { "Retry-After": "0" } });
		const { data } = await portal(`campaigns/${c.id}/approve`, { body: {} });
		expect(data.campaign.status).toBe("sent");
	});

	it("refuses before approving when Resend isn't set up or nobody has opted in", async () => {
		const c = await draft();
		expect((await portal(`campaigns/${c.id}/approve`, { body: {} })).status).toBe(409); // no fans yet
		await addFan("fan@example.com");
		const notSetUp = await portal(`campaigns/${c.id}/approve`, { body: {}, extraEnv: {} });
		expect(notSetUp.status).toBe(409);
		expect(notSetUp.data.error).toMatch(/RESEND_MARKETING_KEY/);
		expect((await row(c.id)).status).toBe("pending_approval");
		expect(calls).toEqual([]);
	});
});

// ===== 4. ONLY OPTED-IN PEOPLE =====

describe("who goes into Resend", () => {
	it("confirmed fans and clients who said yes; pending or unsubscribed fans and clients who said no are left out or taken out", async () => {
		await addFan("fan@example.com", "confirmed", "Ava Stone");
		await addFan("pending@example.com", "pending");
		await addFan("gone@example.com", "unsubscribed");
		await addClient("client@example.com", 1, "Kai Fenwick");
		await addClient("no@example.com", 0);
		await addClient("both@example.com", 1);
		await addFan("both@example.com");
		const c = await draft({ audience: "everyone" });
		const { data } = await portal(`campaigns/${c.id}/approve`, { body: {} });
		expect(data.campaign).toMatchObject({ status: "sent", recipients: 3 });
		expect(segmentEmails("Nova · Everyone")).toEqual(["both@example.com", "client@example.com", "fan@example.com"]);
		const ava = [...contacts.values()].find((x) => x.email === "fan@example.com");
		expect(ava).toMatchObject({ first_name: "Ava", last_name: "Stone", unsubscribed: false });
		expect(ava.properties.why).toBe("you signed up for Novacane Studios news on 3 Oct 2026");
		expect([...contacts.values()].find((x) => x.email === "client@example.com").properties.why).toBe("you said yes to studio news from Novacane Studios on 3 Oct 2026");

		// A client withdraws consent in Nova: the next send takes them out of the segment
		await env.DB.prepare("UPDATE clients SET marketing_consent = 0 WHERE email = 'client@example.com'").run();
		const next = await draft({ audience: "everyone", subject: "Studio offer" });
		expect((await portal(`campaigns/${next.id}/approve`, { body: {} })).data.campaign).toMatchObject({ status: "sent", recipients: 2 });
		expect(segmentEmails("Nova · Everyone")).toEqual(["both@example.com", "fan@example.com"]);
		// Clients only: the one who's still a client and said yes
		const third = await draft({ audience: "clients", subject: "Clients only" });
		expect((await portal(`campaigns/${third.id}/approve`, { body: {} })).data.campaign).toMatchObject({ status: "sent", recipients: 1 });
		expect(segmentEmails("Nova · Studio clients")).toEqual(["both@example.com"]);
		// Nobody pending, unsubscribed or without consent was ever added
		const all = [...contacts.values()].map((x) => x.email);
		for (const email of ["pending@example.com", "gone@example.com", "no@example.com"]) expect(all).not.toContain(email);
		// The segments were made once
		expect(calls.filter((x) => x === "POST /segments")).toHaveLength(3);
	});
});

// ===== 5. UNSUBSCRIBES COME BACK =====

describe("unsubscribes", () => {
	it("a fan who unsubscribed in Resend becomes 'unsubscribed'; a client's consent goes to no, logged as theirs", async () => {
		await addFan("fan@example.com");
		const clientId = await addClient("client@example.com", 1);
		await addFan("stays@example.com");
		const c = await draft({ audience: "everyone" });
		await portal(`campaigns/${c.id}/approve`, { body: {} });
		for (const x of contacts.values()) if (x.email !== "stays@example.com") x.unsubscribed = true;

		await campaignsOnSchedule(ENV(), Date.now());
		expect((await env.DB.prepare("SELECT status, unsubscribed_at FROM fans WHERE email = 'fan@example.com'").first()).status).toBe("unsubscribed");
		expect((await env.DB.prepare("SELECT status FROM fans WHERE email = 'stays@example.com'").first()).status).toBe("confirmed");
		const client = await env.DB.prepare("SELECT marketing_consent, consent_source, consent_by FROM clients WHERE id = ?").bind(clientId).first();
		expect(client).toEqual({ marketing_consent: 0, consent_source: "Unsubscribed from a Nova email", consent_by: "customer" });
		const log = await env.DB.prepare('SELECT consent, source, "by" FROM client_consent_log WHERE client_id = ? ORDER BY id DESC').bind(clientId).first();
		expect(log).toEqual({ consent: 0, source: "Unsubscribed from a Nova email", by: "customer" });

		// The next sync takes them out of the segment, and never subscribes them again
		const next = await draft({ audience: "everyone", subject: "Another" });
		expect((await portal(`campaigns/${next.id}/approve`, { body: {} })).data.campaign.recipients).toBe(1);
		expect(segmentEmails("Nova · Everyone")).toEqual(["stays@example.com"]);
		expect([...contacts.values()].filter((x) => x.email !== "stays@example.com").every((x) => x.unsubscribed)).toBe(true);
	});

	it("a client who says yes again later is subscribed again (only after a newer yes)", async () => {
		const clientId = await addClient("client@example.com", 1);
		const c = await draft({ audience: "clients" });
		await portal(`campaigns/${c.id}/approve`, { body: {} });
		[...contacts.values()][0].unsubscribed = true;
		await campaignsOnSchedule(ENV(), Date.now());
		expect((await env.DB.prepare("SELECT marketing_consent FROM clients WHERE id = ?").bind(clientId).first("marketing_consent"))).toBe(0);

		const edited = await portal(`clients/${clientId}`, { body: { consent: { yes: true, source: "Said yes again at the studio" } } });
		expect(edited.status).toBe(200);
		const next = await draft({ audience: "clients", subject: "Welcome back" });
		expect((await portal(`campaigns/${next.id}/approve`, { body: {} })).data.campaign.recipients).toBe(1);
		expect([...contacts.values()][0].unsubscribed).toBe(false);
	});
});

// ===== 6. THE EMAIL =====

describe("the email", () => {
	it("has the header, the paragraphs, who it's from, why they're getting it and Resend's unsubscribe link", async () => {
		const { html, text } = campaignEmail({ subject: "News <3", audience: "fans", body: "Hi **all**!\n\nSee [our page](https://novacane.co.uk/a?b=1&c=2) or https://novacane.co.uk/x.\nNew line <script>" });
		expect(html).toContain("Novacane Studios</div>");
		expect(html).toContain("You're getting this because {{{contact.why|you signed up for news from Novacane Studios}}}. Novacane Studios, London. Unsubscribe:");
		expect(html).toContain('href="{{{RESEND_UNSUBSCRIBE_URL}}}"');
		expect(html).toContain("<strong>all</strong>");
		expect(html).toContain('<a href="https://novacane.co.uk/a?b=1&amp;c=2"');
		expect(html).toContain('<a href="https://novacane.co.uk/x"');
		expect(html).toContain("&lt;script&gt;");
		expect(html).not.toContain("<script>");
		expect(html).toContain("<title>News &lt;3</title>");
		expect(text).toContain("our page (https://novacane.co.uk/a?b=1&c=2)");
		expect(text).toMatch(/Unsubscribe: \{\{\{RESEND_UNSUBSCRIBE_URL\}\}\}$/);
	});

	it("the broadcast Resend gets is that email, from the studio's address, to the audience's segment; Portal's preview fills in the placeholders", async () => {
		await addFan("fan@example.com");
		const c = await draft();
		const detail = await portal(`campaigns/${c.id}`);
		expect(detail.data.previewHtml).toContain("Our new single is out on <strong>Friday</strong>");
		expect(detail.data.previewHtml).not.toContain("{{{");
		await portal(`campaigns/${c.id}/approve`, { body: {} });
		const [b] = [...broadcasts.values()];
		expect(b).toMatchObject({ from: "Novacane Studios <news@novacane.co.uk>", subject: "New single out Friday", segment_id: segmentId("Nova · Fans") });
		expect(b.html).toContain("{{{RESEND_UNSUBSCRIBE_URL}}}");
		expect(b.html).toContain("You're getting this because {{{contact.why|");
	});

	it("Send me a test: once, to the admin's own address only, marked [TEST]; the campaign doesn't change", async () => {
		const c = await draft();
		const sent = await portal("campaigns/test-send", { body: { id: c.id } });
		expect(sent.status).toBe(200);
		expect(emails).toHaveLength(1);
		expect(emails[0]).toMatchObject({ to: ["test-admin@novacane.test"], subject: "[TEST] New single out Friday" });
		expect(emails[0].html).not.toContain("{{{");
		expect((await portal("campaigns/test-send", { body: { id: c.id } })).status).toBe(429);
		expect((await row(c.id)).status).toBe("pending_approval");
		expect(broadcastCalls()).toEqual([]);
	});
});

// ===== 7. FAN SIGN-UP =====

describe("fan sign-up (/join)", () => {
	const join = (fields, ip = "198.51.100.7") =>
		call(new Request(`${BASE}/join`, { method: "POST", headers: { "Content-Type": "application/x-www-form-urlencoded", "CF-Connecting-IP": ip }, body: new URLSearchParams(fields).toString() }));
	const fan = (email) => env.DB.prepare("SELECT * FROM fans WHERE email = ?").bind(email).first();

	it("shows the form (also when opened in a browser, not sent to Nova Agent)", async () => {
		const res = await call(new Request(`${BASE}/join`, { headers: { "Sec-Fetch-Dest": "document" } }));
		expect(res.status).toBe(200);
		expect(res.text).toContain("Send me news about releases and studio offers from Novacane Studios. I can unsubscribe any time.");
		expect(res.text).toContain('name="website"');
	});

	it("pending until the link is opened; the link works once", async () => {
		const res = await join({ name: "Ava", email: "Ava@Example.com", consent: "yes" });
		expect(res.status).toBe(200);
		expect(res.text).toContain("Check your inbox");
		const pending = await fan("ava@example.com");
		expect(pending).toMatchObject({ status: "pending", consent_at: null, name: "Ava" });
		expect(pending.signup_ip_hash).toMatch(/^[0-9a-f]{64}$/);
		expect(pending.signup_ip_hash).not.toContain("198.51");
		expect(emails).toHaveLength(1);
		expect(emails[0].to).toEqual(["ava@example.com"]);
		const link = emails[0].text.match(/https:\/\/novacane-worker\.test\/join\/confirm\?t=\S+/)[0];
		expect(link).toContain(pending.confirm_token);

		const confirmed = await call(new Request(link));
		expect(confirmed.status).toBe(200);
		expect(confirmed.text).toContain("You&#39;re on the list");
		expect(await fan("ava@example.com")).toMatchObject({ status: "confirmed", confirm_token: null, consent_source: "Fan sign-up form, confirmed by email" });
		expect((await fan("ava@example.com")).consent_at).toBeTruthy();
		// Twice: doesn't work again
		expect((await call(new Request(link))).status).toBe(404);
		expect((await call(new Request(`${BASE}/join/confirm?t=nonsense`))).status).toBe(404);
	});

	it("needs the tick; a filled-in honeypot saves nothing but looks the same", async () => {
		expect((await join({ email: "x@example.com" })).status).toBe(400);
		const bot = await join({ email: "bot@example.com", consent: "yes", website: "http://spam.example" });
		expect(bot.status).toBe(200);
		expect(bot.text).toContain("Check your inbox");
		expect(await fan("bot@example.com")).toBeNull();
		expect(await fan("x@example.com")).toBeNull();
		expect(emails).toEqual([]);
	});

	it("never shows whether someone's already on the list", async () => {
		await addFan("already@example.com");
		const known = await join({ email: "already@example.com", consent: "yes" });
		const fresh = await join({ email: "new@example.com", consent: "yes" });
		expect(known.status).toBe(fresh.status);
		expect(known.text).toBe(fresh.text);
		expect((await fan("already@example.com")).status).toBe("confirmed");
		expect(emails.map((e) => e.to[0])).toEqual(["new@example.com"]);
	});

	it("five sign-ups an hour from one visitor, then no more", async () => {
		for (let i = 0; i < 5; i++) expect((await join({ email: `p${i}@example.com`, consent: "yes" })).status).toBe(200);
		const sixth = await join({ email: "p5@example.com", consent: "yes" });
		expect(sixth.status).toBe(429);
		expect(await fan("p5@example.com")).toBeNull();
		// Someone else is fine
		expect((await join({ email: "other@example.com", consent: "yes" }, "203.0.113.50")).status).toBe(200);
	});

	it("an expired link says so; signing up again sends a new one", async () => {
		await join({ email: "late@example.com", consent: "yes" });
		const old = (await fan("late@example.com")).confirm_token;
		const expired = `${(Date.now() - 8 * 86400000).toString(36)}.${old.split(".")[1]}`;
		await env.DB.prepare("UPDATE fans SET confirm_token = ? WHERE email = 'late@example.com'").bind(expired).run();
		expect((await call(new Request(`${BASE}/join/confirm?t=${expired}`))).status).toBe(410);
		await join({ email: "late@example.com", consent: "yes" });
		const fresh = (await fan("late@example.com")).confirm_token;
		expect(fresh).not.toBe(expired);
		expect((await call(new Request(`${BASE}/join/confirm?t=${fresh}`))).status).toBe(200);
	});
});

// ===== 8 AND 9. THE NUMBERS, AND SCHEDULED ONES =====

describe("after sending", () => {
	it("the numbers are fetched from Resend (with pagination) and stored", async () => {
		await addFan("fan@example.com");
		const c = await draft();
		await portal(`campaigns/${c.id}/approve`, { body: {} });
		const { broadcast_id } = await row(c.id);
		const people = (n, type) => Array.from({ length: n }, (_, i) => ({ id: `${type}-${i}`, email: `p${i}@example.com` }));
		recipients.set(broadcast_id, { sent: people(150, "s"), delivered: people(140, "d"), opened: people(60, "o"), clicked: people(12, "c"), bounced: people(2, "b"), unsubscribed: people(1, "u") });
		await refreshStats(ENV());
		const { stats } = (await portal(`campaigns/${c.id}`)).data.campaign;
		expect(stats).toMatchObject({ sent: 150, delivered: 140, opened: 60, clicked: 12, bounced: 2, unsubscribed: 1, complained: 0 });
		expect(stats.fetchedAt).toBeTruthy();
		expect((await portal(`campaigns/${c.id}`)).data.log.at(-1)).toMatchObject({ event: "stats", by: "resend" });
		// Nova Agent's context has it too
		const context = await agent("/nova-agent/campaigns/context");
		expect(context.data.audiences).toEqual({ fans: 1, clients: 0, everyone: 1 });
		expect(context.data.recent[0].stats.opened).toBe(60);
		expect(context.data.today).toMatch(/^\d{4}-\d{2}-\d{2}$/);
	});

	it("a scheduled campaign becomes 'sent' once Resend says so (the cron)", async () => {
		await addFan("fan@example.com");
		const c = await draft({ sendAt: later(3) });
		const approved = await portal(`campaigns/${c.id}/approve`, { body: {} });
		expect(approved.data.campaign).toMatchObject({ status: "scheduled", recipients: 1, sentAt: null });
		const { broadcast_id } = await row(c.id);
		expect(broadcasts.get(broadcast_id).scheduled_at).toBe((await row(c.id)).send_at);

		// Not yet due: nothing
		expect(await checkScheduled(ENV())).toBe(0);
		// Its time has come, and Resend sent it
		await env.DB.prepare("UPDATE email_campaigns SET send_at = ? WHERE id = ?").bind(new Date(Date.now() - 60000).toISOString(), c.id).run();
		Object.assign(broadcasts.get(broadcast_id), { status: "sent", sent_at: "2026-10-11 15:00:00.123+00" });
		const ctx = createExecutionContext();
		await worker.scheduled({ scheduledTime: Date.now(), cron: "* * * * *" }, ENV(), ctx);
		await waitOnExecutionContext(ctx);
		expect(await row(c.id)).toMatchObject({ status: "sent", sent_at: "2026-10-11T15:00:00.123Z" });
		expect((await portal(`campaigns/${c.id}`)).data.log.map((l) => l.event)).toContain("sent");
	});
});

// ===== 10. HOW IT WORKS =====

describe("How it works", () => {
	it("lists Email newsletters on Resend without showing any key", async () => {
		const { data, text } = await portal("services");
		const line = data.services.find((s) => s.id === "newsletters");
		expect(line).toMatchObject({ name: "Email newsletters", ready: true });
		expect(line.tech).toMatch(/^Resend/);
		expect(line.detail).toContain("news@novacane.co.uk");
		expect(text).not.toContain(MARKETING_KEY);
		expect(text).not.toContain(SEND_KEY);
		const bare = await portal("services", { extraEnv: {} });
		expect(bare.data.services.find((s) => s.id === "newsletters")).toMatchObject({ ready: false });
		expect(bare.data.services.find((s) => s.id === "newsletters").detail).toMatch(/RESEND_MARKETING_KEY/);
	});
});

// ===== PORTAL'S LIST =====

describe("Portal's list", () => {
	it("waiting ones first, with the opted-in counts and the sign-up link; staff can write one too", async () => {
		await addFan("fan@example.com");
		await addFan("p@example.com", "pending");
		await addClient("client@example.com", 1);
		const staffMade = await portal("campaigns", { body: { subject: "From staff", body: "Written in Portal by a person.", audience: "clients", sendAt: "2027-01-15T10:00" } });
		expect(staffMade.data.campaign).toMatchObject({ status: "pending_approval", createdBy: "test-admin", sendAt: "2027-01-15T10:00:00.000Z" });
		const list = await portal("campaigns");
		expect(list.data).toMatchObject({ audiences: { fans: 1, clients: 1, everyone: 2 }, signupUrl: `${BASE}/join` });
		expect(list.data.campaigns[0].id).toBe(staffMade.data.campaign.id);
		expect((await portal("campaigns", { body: { subject: "", body: "x", audience: "fans" } })).status).toBe(400);
		expect((await portal("campaigns", { body: { subject: "Hi", body: "Long enough body.", audience: "nobody" } })).status).toBe(400);
		expect((await agent("/nova-agent/campaigns", {})).data.campaigns).toHaveLength(1);
	});
});

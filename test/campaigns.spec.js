// Email campaigns through the studio's own mail server, with an admin's approval
// (src/campaigns.js, src/fans.js, the /nova-agent/campaigns/* routes and Portal's
// /app/api/campaigns). Nothing is sent unless an admin, signed in to Portal in a browser, pressed
// Approve on exactly what's saved. Only people who opted in get it, a few at a time, each with
// their own unsubscribe link that works.
import { createExecutionContext, env, waitOnExecutionContext } from "cloudflare:test";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import worker from "../src";
import { campaignEmail, campaignsOnSchedule, sendApproved, unsubscribeUrl } from "../src/campaigns.js";
import { sha256 } from "../src/portal/auth.js";
import { STAFF_COOKIE } from "./sign-in.js";

const BASE = "https://novacane-worker.test";
const KEY = "agent-nova-test-key";
const MAIL_KEY = "mail_test_secret_456";
const MAIL_ENV = { MAIL_KEY, CAMPAIGN_FROM: "Novacane Studios <news@novacane.co.uk>" };

// ----- A fake mail server -----

let emails; // bodies POSTed to /emails
let keys; // their Idempotency-Keys
let answers; // answers to give first: [status]

const reply = (data, status = 200) => new Response(JSON.stringify(data), { status, headers: { "Content-Type": "application/json" } });

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
	emails = [];
	keys = [];
	answers = [];
	vi.spyOn(globalThis, "fetch").mockImplementation(async (url, init = {}) => {
		const u = new URL(String(url));
		if (u.origin !== "http://mail.test" || u.pathname !== "/emails") return reply({ error: "not_found" }, 404);
		expect(init.headers.Authorization).toBe(`Bearer ${MAIL_KEY}`);
		const status = answers.length ? answers.shift() : 200;
		if (status !== 200) return reply({ message: `No (${status})` }, status);
		emails.push(JSON.parse(init.body));
		keys.push(init.headers["Idempotency-Key"]);
		return reply({ id: `email-${emails.length}` });
	});
});

afterEach(() => vi.restoreAllMocks());

// ----- Calling the Worker -----

async function call(request, extraEnv = MAIL_ENV) {
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

const ENV = (extra = {}) => ({ ...env, ...MAIL_ENV, ...extra });
const row = (id) => env.DB.prepare("SELECT * FROM email_campaigns WHERE id = ?").bind(id).first();
const later = (hours) => new Date(Date.now() + hours * 3600000).toISOString();
const sentTo = () => emails.map((e) => e.to[0]).sort();
// The every-minute sender, run until nothing more goes (at most `minutes` times)
async function minutes(n = 10, at = Date.now(), extra = {}) {
	for (let i = 0; i < n; i++) {
		const r = await campaignsOnSchedule(ENV(extra), at);
		if (!r?.sent) break;
	}
}

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
		await minutes();
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
		await minutes();
		expect(emails).toEqual([]);
	});

	it("draft, pending_approval, rejected and edited-after-approval campaigns are never sent", async () => {
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
		// Approved for later, then edited: back to waiting, its list dropped
		const edited = await draft({ subject: "Later", sendAt: later(48) });
		expect((await portal(`campaigns/${edited.id}/approve`, { body: {} })).data.campaign.status).toBe("scheduled");
		const after = await agent(`/nova-agent/campaigns/${edited.id}/edit`, { body: "Changed after the approval, by the AI." });
		expect(after.data.campaign).toMatchObject({ status: "pending_approval", decidedBy: null });
		expect(await env.DB.prepare("SELECT COUNT(*) AS n FROM settings WHERE key LIKE 'campaign_queue:%'").first("n")).toBe(0);

		// The sender, the cron and the agent can't move any of them
		for (const id of [pending.id, rejected.id, draftId, edited.id]) await sendApproved(ENV(), id);
		await minutes(10, Date.now() + 49 * 3600000);
		expect(emails).toEqual([]);
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
		expect(await row(c.id)).toMatchObject({ status: "pending_approval", approved_hash: null, decided_by: null });

		// Something changes what's saved while it's 'approved' (with the old approval's hash): refused
		await env.DB.prepare("UPDATE email_campaigns SET status = 'approved', approved_hash = ? WHERE id = ?").bind(approved.approved_hash, c.id).run();
		const result = await sendApproved(ENV(), c.id);
		expect(result.status).toBe("pending_approval");
		expect(result.error).toMatch(/changed after it was approved/);
		expect((await row(c.id)).approved_hash).toBeNull();

		// …or while it's going out (changed behind the sender's back): it stops
		const d = await draft({ subject: "Second" });
		await portal(`campaigns/${d.id}/approve`, { body: {} });
		await env.DB.prepare("UPDATE email_campaigns SET body = 'Sneaky change to the text after approval.' WHERE id = ?").bind(d.id).run();
		await minutes();
		expect(emails).toEqual([]);
		expect(await row(d.id)).toMatchObject({ status: "failed" });
		expect((await row(d.id)).error).toMatch(/changed after it was approved/);
	});

	it("can't be changed once its emails have started going out", async () => {
		for (let i = 0; i < 3; i++) await addFan(`f${i}@example.com`);
		const c = await draft();
		await portal(`campaigns/${c.id}/approve`, { body: {} });
		await campaignsOnSchedule(ENV({ CAMPAIGN_BATCH: "1" }));
		expect(emails).toHaveLength(1);
		const tried = await portal(`campaigns/${c.id}/edit`, { body: { subject: "Too late" } });
		expect(tried.status).toBe(409);
		expect(tried.data.error).toMatch(/going out right now \(1 sent so far\)/);
		expect((await row(c.id)).status).toBe("scheduled");
	});
});

// ===== 3. EXACTLY ONCE, A FEW AT A TIME =====

describe("approve", () => {
	it("two presses at once send it exactly once", async () => {
		await addFan("fan@example.com");
		const c = await draft();
		const [a, b] = await Promise.all([portal(`campaigns/${c.id}/approve`, { body: {} }), portal(`campaigns/${c.id}/approve`, { body: {} })]);
		expect([a.status, b.status]).toEqual([200, 200]);
		expect(await env.DB.prepare("SELECT COUNT(*) AS n FROM settings WHERE key LIKE 'campaign_queue:%'").first("n")).toBe(1);
		// Two cron runs at once: one takes the list, the other finds it taken
		await Promise.all([campaignsOnSchedule(ENV()), campaignsOnSchedule(ENV())]);
		await minutes();
		expect(sentTo()).toEqual(["fan@example.com"]);
		expect(await row(c.id)).toMatchObject({ status: "sent", recipients: 1, decided_by: "test-admin" });
		// Pressed again later: still once
		expect((await portal(`campaigns/${c.id}/approve`, { body: {} })).data.repeated).toBe(true);
		await sendApproved(ENV(), c.id);
		await minutes();
		expect(emails).toHaveLength(1);
		const events = (await portal(`campaigns/${c.id}`)).data.log.map((l) => l.event);
		expect(events).toEqual(["created", "submitted", "approved", "scheduled", "sent"]);
	});

	it("goes out a batch a minute, showing how far it's got", async () => {
		for (let i = 0; i < 5; i++) await addFan(`f${i}@example.com`);
		const c = await draft();
		const approved = await portal(`campaigns/${c.id}/approve`, { body: {} });
		expect(approved.data.campaign).toMatchObject({ status: "scheduled", recipients: 5, sending: { sent: 0, total: 5 } });
		await campaignsOnSchedule(ENV({ CAMPAIGN_BATCH: "2" }));
		expect(emails).toHaveLength(2);
		expect((await portal(`campaigns/${c.id}`)).data.campaign.sending).toEqual({ sent: 2, total: 5 });
		await campaignsOnSchedule(ENV({ CAMPAIGN_BATCH: "2" }));
		await campaignsOnSchedule(ENV({ CAMPAIGN_BATCH: "2" }));
		expect(sentTo()).toEqual(["f0@example.com", "f1@example.com", "f2@example.com", "f3@example.com", "f4@example.com"]);
		const done = (await portal(`campaigns/${c.id}`)).data.campaign;
		expect(done).toMatchObject({ status: "sent", recipients: 5, sending: null });
		expect(done.stats).toMatchObject({ sent: 5, failed: 0, skipped: 0 });
	});

	it("waits for the next minute when the mail server can't take one, and gives up on an address it refuses", async () => {
		await addFan("a@example.com");
		await addFan("b@example.com");
		const c = await draft();
		await portal(`campaigns/${c.id}/approve`, { body: {} });
		answers.push(503);
		await campaignsOnSchedule(ENV());
		expect(emails).toEqual([]);
		expect((await row(c.id)).status).toBe("scheduled");
		answers.push(422); // the next address is refused outright
		await minutes();
		expect(emails).toHaveLength(1);
		const saved = await row(c.id);
		expect(saved).toMatchObject({ status: "sent", recipients: 1 });
		expect(JSON.parse(saved.stats)).toMatchObject({ sent: 1, failed: 1 });
		// The same email asked for twice gets the same idempotency key (so the mail server sends it once)
		expect(new Set(keys).size).toBe(keys.length);
		expect(keys[0]).toMatch(new RegExp(`^campaign-${c.id}-[0-9a-f]{12}-[0-9a-f]{16}$`));
	});

	it("refuses before approving when the mail server isn't set up or nobody has opted in", async () => {
		const c = await draft();
		expect((await portal(`campaigns/${c.id}/approve`, { body: {} })).status).toBe(409); // no fans yet
		await addFan("fan@example.com");
		const notSetUp = await portal(`campaigns/${c.id}/approve`, { body: {}, extraEnv: { MAIL_KEY: "" } });
		expect(notSetUp.status).toBe(409);
		expect(notSetUp.data.error).toMatch(/MAIL_API_URL and MAIL_KEY/);
		expect((await row(c.id)).status).toBe("pending_approval");
		expect(emails).toEqual([]);
	});

	it("a scheduled one waits for its time", async () => {
		await addFan("fan@example.com");
		const c = await draft({ sendAt: later(3) });
		const approved = await portal(`campaigns/${c.id}/approve`, { body: {} });
		expect(approved.data.campaign).toMatchObject({ status: "scheduled", recipients: 1, sentAt: null, sending: null });
		await minutes();
		expect(emails).toEqual([]);
		// Its time has come (the real cron)
		const ctx = createExecutionContext();
		await worker.scheduled({ scheduledTime: Date.now() + 4 * 3600000, cron: "* * * * *" }, ENV(), ctx);
		await waitOnExecutionContext(ctx);
		await minutes(10, Date.now() + 4 * 3600000);
		expect(sentTo()).toEqual(["fan@example.com"]);
		expect((await row(c.id)).status).toBe("sent");
	});
});

// ===== 4. ONLY OPTED-IN PEOPLE =====

describe("who gets it", () => {
	it("confirmed fans and clients who said yes; never pending or unsubscribed fans or clients who said no", async () => {
		await addFan("fan@example.com", "confirmed", "Ava Stone");
		await addFan("pending@example.com", "pending");
		await addFan("gone@example.com", "unsubscribed");
		await addClient("client@example.com", 1, "Kai Fenwick");
		await addClient("no@example.com", 0);
		await addClient("both@example.com", 1);
		await addFan("both@example.com");
		const c = await draft({ audience: "everyone" });
		expect((await portal(`campaigns/${c.id}/approve`, { body: {} })).data.campaign).toMatchObject({ status: "scheduled", recipients: 3 });
		await minutes();
		expect(sentTo()).toEqual(["both@example.com", "client@example.com", "fan@example.com"]);
		const ava = emails.find((e) => e.to[0] === "fan@example.com");
		expect(ava.text).toContain("You're getting this because you signed up for Novacane Studios news on 3 Oct 2026.");
		expect(emails.find((e) => e.to[0] === "client@example.com").text).toContain("you said yes to studio news from Novacane Studios on 3 Oct 2026");

		// A client withdraws consent: the next one leaves them out
		await env.DB.prepare("UPDATE clients SET marketing_consent = 0 WHERE email = 'client@example.com'").run();
		emails = [];
		const next = await draft({ audience: "everyone", subject: "Studio offer" });
		await portal(`campaigns/${next.id}/approve`, { body: {} });
		await minutes();
		expect(sentTo()).toEqual(["both@example.com", "fan@example.com"]);
		// Clients only: the one who's still a client and said yes
		emails = [];
		const third = await draft({ audience: "clients", subject: "Clients only" });
		await portal(`campaigns/${third.id}/approve`, { body: {} });
		await minutes();
		expect(sentTo()).toEqual(["both@example.com"]);
	});

	it("someone who unsubscribes while it's going out is skipped", async () => {
		await addFan("a@example.com");
		await addFan("b@example.com");
		const c = await draft();
		await portal(`campaigns/${c.id}/approve`, { body: {} });
		await env.DB.prepare("UPDATE fans SET status = 'unsubscribed' WHERE email = 'b@example.com'").run();
		await minutes();
		expect(sentTo()).toEqual(["a@example.com"]);
		expect(JSON.parse((await row(c.id)).stats)).toMatchObject({ sent: 1, skipped: 1 });
		expect((await portal(`campaigns/${c.id}`)).data.log.at(-1).detail).toMatch(/1 unsubscribed before it reached them/);
	});
});

// ===== 5. UNSUBSCRIBING =====

describe("unsubscribing", () => {
	it("every email has its own link and the one-click headers; the link asks first, then a fan is unsubscribed", async () => {
		await addFan("fan@example.com");
		await addFan("stays@example.com");
		const c = await draft();
		await portal(`campaigns/${c.id}/approve`, { body: {} });
		await minutes();
		const mine = emails.find((e) => e.to[0] === "fan@example.com");
		const link = mine.headers["List-Unsubscribe"].slice(1, -1);
		expect(link).toBe(await unsubscribeUrl(ENV(), "fan@example.com", c.id));
		expect(mine.headers["List-Unsubscribe-Post"]).toBe("List-Unsubscribe=One-Click");
		expect(mine.text).toContain(`Unsubscribe: ${link}`);
		expect(mine.html).toContain(`href="${link.replace(/&/g, "&amp;")}"`);
		expect(mine.html).not.toContain("{{{");
		// Someone else's link is a different one
		expect(emails.find((e) => e.to[0] === "stays@example.com").headers["List-Unsubscribe"]).not.toContain(link);

		// Opening it (or a link scanner opening it) changes nothing
		const opened = await call(new Request(link));
		expect(opened.status).toBe(200);
		expect(opened.text).toContain('action="/unsubscribe"');
		expect((await env.DB.prepare("SELECT status FROM fans WHERE email = 'fan@example.com'").first()).status).toBe("confirmed");
		// Pressing the button
		const u = new URL(link);
		const pressed = await call(new Request(`${BASE}/unsubscribe`, { method: "POST", headers: { "Content-Type": "application/x-www-form-urlencoded" }, body: new URLSearchParams(Object.fromEntries(u.searchParams)).toString() }));
		expect(pressed.status).toBe(200);
		expect(pressed.text).toContain("You&#39;re unsubscribed");
		expect((await env.DB.prepare("SELECT status, unsubscribed_at FROM fans WHERE email = 'fan@example.com'").first()).status).toBe("unsubscribed");
		expect((await env.DB.prepare("SELECT status FROM fans WHERE email = 'stays@example.com'").first()).status).toBe("confirmed");
		expect(JSON.parse((await row(c.id)).stats).unsubscribed).toBe(1);
	});

	it("an email app's one-click unsubscribe works straight away; a client's consent goes to no, logged as theirs", async () => {
		const clientId = await addClient("client@example.com", 1);
		const link = await unsubscribeUrl(ENV(), "client@example.com", 7);
		const res = await call(new Request(link, { method: "POST", headers: { "Content-Type": "application/x-www-form-urlencoded" }, body: "List-Unsubscribe=One-Click" }));
		expect(res.status).toBe(200);
		const client = await env.DB.prepare("SELECT marketing_consent, consent_source, consent_by FROM clients WHERE id = ?").bind(clientId).first();
		expect(client).toEqual({ marketing_consent: 0, consent_source: "Unsubscribed from a Nova email", consent_by: "customer" });
		const log = await env.DB.prepare('SELECT consent, source, "by" FROM client_consent_log WHERE client_id = ? ORDER BY id DESC').bind(clientId).first();
		expect(log).toEqual({ consent: 0, source: "Unsubscribed from a Nova email", by: "customer" });
	});

	it("a changed or made-up link does nothing", async () => {
		await addFan("fan@example.com");
		await addFan("other@example.com");
		const link = new URL(await unsubscribeUrl(ENV(), "fan@example.com", 3));
		const other = btoa("other@example.com").replace(/=+$/, "");
		for (const bad of [`${BASE}/unsubscribe?e=${other}&c=3&s=${link.searchParams.get("s")}`, `${BASE}/unsubscribe?e=${link.searchParams.get("e")}&c=4&s=${link.searchParams.get("s")}`, `${BASE}/unsubscribe`, `${BASE}/unsubscribe?e=x&c=1&s=nope`]) {
			const r = await call(new Request(bad, { method: "POST", headers: { "Content-Type": "application/x-www-form-urlencoded" }, body: "List-Unsubscribe=One-Click" }));
			expect(r.status).toBe(404);
		}
		expect((await env.DB.prepare("SELECT COUNT(*) AS n FROM fans WHERE status = 'confirmed'").first("n"))).toBe(2);
	});
});

// ===== 6. THE EMAIL =====

describe("the email", () => {
	it("has the header, the paragraphs, who it's from, why they're getting it and an unsubscribe link", async () => {
		const { html, text } = campaignEmail({ subject: "News <3", audience: "fans", body: "Hi **all**!\n\nSee [our page](https://novacane.co.uk/a?b=1&c=2) or https://novacane.co.uk/x.\nNew line <script>" });
		expect(html).toContain("Novacane Studios</div>");
		expect(html).toContain("You're getting this because {{{why|you signed up for news from Novacane Studios}}}. Novacane Studios, London. Unsubscribe:");
		expect(html).toContain('href="{{{unsubscribe_url}}}"');
		expect(html).toContain("<strong>all</strong>");
		expect(html).toContain('<a href="https://novacane.co.uk/a?b=1&amp;c=2"');
		expect(html).toContain('<a href="https://novacane.co.uk/x"');
		expect(html).toContain("&lt;script&gt;");
		expect(html).not.toContain("<script>");
		expect(html).toContain("<title>News &lt;3</title>");
		expect(text).toContain("our page (https://novacane.co.uk/a?b=1&c=2)");
		expect(text).toMatch(/Unsubscribe: \{\{\{unsubscribe_url\}\}\}$/);
	});

	it("goes from the studio's address with the reply-to; Portal's preview fills in the placeholders", async () => {
		await addFan("fan@example.com");
		const c = await draft();
		const detail = await portal(`campaigns/${c.id}`);
		expect(detail.data.previewHtml).toContain("Our new single is out on <strong>Friday</strong>");
		expect(detail.data.previewHtml).not.toContain("{{{");
		await portal(`campaigns/${c.id}/approve`, { body: {} });
		await minutes(10, Date.now(), { CAMPAIGN_REPLY_TO: "admin@kulturekingdom.uk" });
		expect(emails[0]).toMatchObject({ from: "Novacane Studios <news@novacane.co.uk>", to: ["fan@example.com"], subject: "New single out Friday", reply_to: "admin@kulturekingdom.uk" });
		expect(emails[0].html).toContain("Our new single is out on <strong>Friday</strong>");
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

		// Opening the link (or an email scanner opening it) changes nothing: it shows a Confirm button
		const opened = await call(new Request(link));
		expect(opened.status).toBe(200);
		expect(opened.text).toContain('action="/join/confirm"');
		expect(await fan("ava@example.com")).toMatchObject({ status: "pending" });
		const press = () => call(new Request(`${BASE}/join/confirm`, { method: "POST", headers: { "Content-Type": "application/x-www-form-urlencoded" }, body: new URLSearchParams({ t: pending.confirm_token }).toString() }));
		const confirmed = await press();
		expect(confirmed.status).toBe(200);
		expect(confirmed.text).toContain("You&#39;re on the list");
		expect(await fan("ava@example.com")).toMatchObject({ status: "confirmed", confirm_token: null, consent_source: "Fan sign-up form, confirmed by email" });
		expect((await fan("ava@example.com")).consent_at).toBeTruthy();
		// Twice: doesn't work again
		expect((await press()).status).toBe(404);
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

// ===== 8. NOVA AGENT'S CONTEXT =====

describe("after sending", () => {
	it("Nova Agent's context has the opted-in counts and how recent ones went", async () => {
		await addFan("fan@example.com");
		const c = await draft();
		await portal(`campaigns/${c.id}/approve`, { body: {} });
		await minutes();
		const context = await agent("/nova-agent/campaigns/context");
		expect(context.data.audiences).toEqual({ fans: 1, clients: 0, everyone: 1 });
		expect(context.data.recent[0]).toMatchObject({ status: "sent", recipients: 1 });
		expect(context.data.recent[0].stats.sent).toBe(1);
		expect(context.data.today).toMatch(/^\d{4}-\d{2}-\d{2}$/);
	});
});

// ===== 10. HOW IT WORKS =====

describe("How it works", () => {
	it("lists Email newsletters on the studio's own mail server without showing any key", async () => {
		const { data, text } = await portal("services");
		const line = data.services.find((s) => s.id === "newsletters");
		expect(line).toMatchObject({ name: "Email newsletters", ready: true });
		expect(line.tech).toMatch(/own mail server/);
		expect(line.detail).toContain("news@novacane.co.uk");
		expect(text).not.toContain(MAIL_KEY);
		const bare = await portal("services", { extraEnv: { MAIL_KEY: "" } });
		expect(bare.data.services.find((s) => s.id === "newsletters")).toMatchObject({ ready: false });
		expect(bare.data.services.find((s) => s.id === "newsletters").detail).toMatch(/MAIL_API_URL and MAIL_KEY/);
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

describe("Portal's preview of a campaign", () => {
	it("is its own page whose rules allow the email's styles and nothing else", async () => {
		const { meta } = await env.DB.prepare(
			"INSERT INTO email_campaigns (subject, body, audience, status, created_by, created_at, updated_at) VALUES ('Hello', 'Hi there', 'fans', 'pending_approval', 'agent', '2026-10-10T10:00:00.000Z', '2026-10-10T10:00:00.000Z')"
		).run();
		const res = await worker.fetch(new Request(`${BASE}/app/api/campaigns/${meta.last_row_id}/preview`, { headers: { Cookie: STAFF_COOKIE } }), env);
		expect(res.status).toBe(200);
		expect(res.headers.get("Content-Type")).toContain("text/html");
		const csp = res.headers.get("Content-Security-Policy");
		expect(csp).toContain("style-src 'unsafe-inline'");
		expect(csp).toContain("default-src 'none'");
		expect(csp).toContain("sandbox");
		expect(await res.text()).toContain("Hi there");
		const anon = await worker.fetch(new Request(`${BASE}/app/api/campaigns/${meta.last_row_id}/preview`), env);
		expect(anon.status).toBe(401);
	});
});

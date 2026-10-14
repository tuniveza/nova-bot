// One-to-one emails with an admin's approval (src/outreach.js, the /nova-agent/outreach/* routes,
// Portal's /app/api/outreach and the /no-thanks page). Nothing goes to the mail server unless an admin,
// signed in to Portal in a browser, pressed Approve on exactly what's saved, and only to people the
// studio may email (UK GDPR / PECR).
import { createExecutionContext, env, waitOnExecutionContext } from "cloudflare:test";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import worker from "../src";
import { sendApproved } from "../src/outreach.js";
import { sha256 } from "../src/portal/auth.js";
import { STAFF_COOKIE } from "./sign-in.js";

const BASE = "https://novacane-worker.test";
const KEY = "agent-nova-test-key";
const SEND_KEY = "re_test_sending_secret_456";
const MAIL_ENV = { MAIL_KEY: SEND_KEY, ENQUIRY_REPLY_FROM: "Novacane Studios <hello@novacane.co.uk>", ENQUIRY_EMAIL_TO: "studio@novacane.co.uk" };

let emails; // bodies POSTed to the mail server's /emails
let failNext;

beforeEach(async () => {
	await env.DB.batch([
		env.DB.prepare("DELETE FROM outreach_log"),
		env.DB.prepare("DELETE FROM outreach_emails"),
		env.DB.prepare("DELETE FROM outreach_optouts"),
		env.DB.prepare("DELETE FROM fans"),
		env.DB.prepare("DELETE FROM client_consent_log"),
		env.DB.prepare("DELETE FROM client_sessions"),
		env.DB.prepare("DELETE FROM clients"),
		env.DB.prepare("DELETE FROM enquiries"),
		env.DB.prepare("DELETE FROM settings"),
	]);
	emails = [];
	failNext = false;
	vi.spyOn(globalThis, "fetch").mockImplementation(async (url, init = {}) => {
		const u = new URL(String(url));
		if (u.origin === "http://mail.test" && u.pathname === "/emails") {
			expect(init.headers.Authorization).toBe(`Bearer ${SEND_KEY}`);
			if (failNext) {
				failNext = false;
				return new Response(JSON.stringify({ message: "domain not verified" }), { status: 422 });
			}
			emails.push(JSON.parse(init.body));
			return new Response(JSON.stringify({ id: `email-${emails.length}` }), { status: 200 });
		}
		return new Response("{}", { status: 404 });
	});
});

afterEach(() => {
	vi.restoreAllMocks();
});

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

const ENV = () => ({ ...env, ...MAIL_ENV });
const row = (id) => env.DB.prepare("SELECT * FROM outreach_emails WHERE id = ?").bind(id).first();

const VENUE = { kind: "business", toEmail: "Bookings@TheVenue.co.uk", toName: "Sam", organisation: "The Venue", subject: "Live session idea", body: "Hi Sam,\n\nWe'd love to record a live session at The Venue.\n\nNovacane Studios" };

async function draft(fields = {}) {
	const { status, data } = await agent("/nova-agent/outreach/draft", { ...VENUE, ...fields });
	expect(status, JSON.stringify(data)).toBe(200);
	return data.outreach;
}

async function addClient(email, consent) {
	const at = "2026-10-03T09:00:00.000Z";
	const { id } = await env.DB.prepare("INSERT INTO clients (name, email, marketing_consent, source, created_at, updated_at) VALUES ('Client Person', ?, ?, 'staff', ?, ?) RETURNING id")
		.bind(email, consent, at, at)
		.first();
	return id;
}

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

describe("approval", () => {
	it("the AI's email waits for approval; no agent-key route can approve, send or test-send", async () => {
		const o = await draft({ status: "approved", approvedHash: "x", decidedBy: "test-admin" });
		expect(o).toMatchObject({ status: "pending_approval", createdBy: "agent", decidedBy: null, toEmail: "bookings@thevenue.co.uk", kind: "business" });
		expect(o.portalUrl).toBe(`${BASE}/portal/?view=campaigns&outreach=${o.id}`);
		for (const path of [`/nova-agent/outreach/${o.id}/approve`, `/nova-agent/outreach/${o.id}/send`, `/nova-agent/outreach/${o.id}/test-send`, "/nova-agent/outreach/test-send", "/nova-agent/outreach/approve"]) {
			expect((await agent(path, { id: o.id })).status).toBe(404);
		}
		const viaKey = await call(new Request(`${BASE}/app/api/outreach/${o.id}/approve`, { method: "POST", headers: { Origin: BASE, Authorization: `Bearer ${KEY}` }, body: "{}" }));
		expect(viaKey.status).toBe(401);
		await sendApproved(ENV(), o.id);
		expect((await row(o.id)).status).toBe("pending_approval");
		expect(emails).toEqual([]);
	});

	it("only an admin with the browser cookie can approve, reject or test-send", async () => {
		const o = await draft();
		const { staff, adminToken } = await otherSignIns();
		expect((await portal("outreach", { headers: staff })).data.canDecide).toBe(false);
		expect((await portal("outreach", { headers: adminToken })).data.canDecide).toBe(false);
		expect((await portal("outreach")).data.canDecide).toBe(true);
		for (const headers of [staff, adminToken]) {
			expect((await portal(`outreach/${o.id}/approve`, { body: {}, headers })).status).toBe(403);
			expect((await portal(`outreach/${o.id}/reject`, { body: {}, headers })).status).toBe(403);
			expect((await portal("outreach/test-send", { body: { id: o.id }, headers })).status).toBe(403);
		}
		expect((await portal(`outreach/${o.id}/approve`, { body: {}, headers: { Cookie: STAFF_COOKIE, Origin: "https://evil.example" } })).status).toBe(403);
		// Staff can write and edit (it stays waiting)
		const edited = await portal(`outreach/${o.id}/edit`, { body: { subject: "A live session at The Venue?" }, headers: staff });
		expect(edited.data.outreach.status).toBe("pending_approval");
		expect(emails).toEqual([]);
	});

	it("approved: sent once, to that person, with the footer and the opt-out link; pressing twice sends once", async () => {
		const o = await draft();
		const [a, b] = await Promise.all([portal(`outreach/${o.id}/approve`, { body: {} }), portal(`outreach/${o.id}/approve`, { body: {} })]);
		expect([a.status, b.status]).toEqual([200, 200]);
		expect(emails).toHaveLength(1);
		const sent = emails[0];
		expect(sent.to).toEqual(["Sam <bookings@thevenue.co.uk>"]);
		expect(sent.subject).toBe("Live session idea");
		expect(sent.reply_to).toBe("studio@novacane.co.uk");
		const saved = await row(o.id);
		expect(saved).toMatchObject({ status: "sent", decided_by: "test-admin", resend_id: "email-1" });
		expect(sent.text).toContain(`${BASE}/no-thanks?t=${saved.optout_token}`);
		expect(sent.text).toContain('Reply "no thanks"');
		expect(sent.text).toContain("Novacane Studios, Forest Hill, London");
		expect(sent.html).toContain("no-thanks?t=");
		expect(sent.headers["List-Unsubscribe"]).toBe(`<${BASE}/no-thanks?t=${saved.optout_token}>`);
		expect((await portal(`outreach/${o.id}/approve`, { body: {} })).data.repeated).toBe(true);
		await sendApproved(ENV(), o.id);
		expect(emails).toHaveLength(1);
	});

	it("a rejected one never sends; the mail server failing marks it 'failed' with the reason", async () => {
		const o = await draft();
		expect((await portal(`outreach/${o.id}/reject`, { body: { note: "Not yet" } })).data.outreach).toMatchObject({ status: "rejected", note: "Not yet" });
		expect((await portal(`outreach/${o.id}/approve`, { body: {} })).status).toBe(409);
		const other = await draft({ toEmail: "hello@label.co.uk", organisation: "A Label" });
		failNext = true;
		const done = await portal(`outreach/${other.id}/approve`, { body: {} });
		expect(done.data.outreach.status).toBe("failed");
		expect(done.data.outreach.error).toMatch(/domain not verified/);
		expect(emails).toEqual([]);
	});

	it("not set up (no sending key): Approve says so and nothing changes", async () => {
		const o = await draft();
		const r = await portal(`outreach/${o.id}/approve`, { body: {}, extraEnv: { MAIL_KEY: "" } });
		expect(r.status).toBe(409);
		expect(r.data.error).toMatch(/MAIL_KEY/);
		expect((await row(o.id)).status).toBe("pending_approval");
	});
});

describe("the approval hash", () => {
	it("editing clears the approval, and the sender refuses anything that changed after approval", async () => {
		const o = await draft();
		// As if approved but not sent yet
		const hashOf = async () => {
			const { outreachHash } = await import("../src/outreach.js");
			return outreachHash(await row(o.id));
		};
		const hash = await hashOf();
		await env.DB.prepare("UPDATE outreach_emails SET status = 'approved', approved_hash = ?, decided_by = 'test-admin' WHERE id = ?").bind(hash, o.id).run();
		// Changed underneath it: refused
		await env.DB.prepare("UPDATE outreach_emails SET body = 'Something else entirely, changed after approval.' WHERE id = ?").bind(o.id).run();
		const result = await sendApproved(ENV(), o.id);
		expect(result.status).toBe("pending_approval");
		expect(result.error).toMatch(/changed after it was approved/);
		expect(emails).toEqual([]);
		expect((await row(o.id)).approved_hash).toBeNull();

		// Approved then edited by the AI: back to waiting, approval cleared
		await env.DB.prepare("UPDATE outreach_emails SET status = 'rejected' WHERE id = ?").bind(o.id).run();
		const again = await agent(`/nova-agent/outreach/${o.id}/edit`, { body: "Hi Sam,\n\nA new version of the email.\n\nNovacane Studios" });
		expect(again.data.outreach).toMatchObject({ status: "pending_approval", decidedBy: null });
	});
});

describe("who can be emailed", () => {
	it("refuses anyone who opted out, by link or by a recorded 'no thanks'", async () => {
		const o = await draft();
		const saved = await row(o.id);
		// The link: GET only shows a button; POST records it
		const look = await call(new Request(`${BASE}/no-thanks?t=${saved.optout_token}`));
		expect(look.status).toBe(200);
		expect(look.text).toContain("Don't email me again");
		expect(await env.DB.prepare("SELECT COUNT(*) AS n FROM outreach_optouts").first("n")).toBe(0);
		const form = new FormData();
		form.set("t", saved.optout_token);
		const pressed = await call(new Request(`${BASE}/no-thanks`, { method: "POST", body: form }));
		expect(pressed.status).toBe(200);
		expect(pressed.text).toContain("get emails like this from Novacane Studios again");
		expect(await env.DB.prepare("SELECT source, outreach_id FROM outreach_optouts WHERE email = 'bookings@thevenue.co.uk'").first()).toEqual({ source: "The link in an email", outreach_id: o.id });
		// What was waiting to them won't go, and nothing new can be written
		expect((await row(o.id)).status).toBe("rejected");
		const refused = await agent("/nova-agent/outreach/draft", VENUE);
		expect(refused.status).toBe(409);
		expect(refused.data.error).toMatch(/asked not to get emails/);
		// A bad token
		expect((await call(new Request(`${BASE}/no-thanks?t=nope`))).status).toBe(404);

		// Staff record a reply saying no thanks
		const other = await draft({ toEmail: "info@club.co.uk", organisation: "The Club" });
		expect((await portal("outreach/optouts", { body: { email: "INFO@club.co.uk" } })).status).toBe(200);
		expect((await row(other.id)).status).toBe("rejected");
		expect((await env.DB.prepare("SELECT source FROM outreach_optouts WHERE email = 'info@club.co.uk'").first("source"))).toMatch(/recorded by Test Admin/);
		expect(emails).toEqual([]);
	});

	it("an opt-out after approval but before sending stops it", async () => {
		const o = await draft();
		const { outreachHash } = await import("../src/outreach.js");
		await env.DB.prepare("UPDATE outreach_emails SET status = 'approved', approved_hash = ? WHERE id = ?").bind(await outreachHash(await row(o.id)), o.id).run();
		await env.DB.prepare("INSERT INTO outreach_optouts (email, at, source) VALUES ('bookings@thevenue.co.uk', ?, 'test')").bind(new Date().toISOString()).run();
		const result = await sendApproved(ENV(), o.id);
		expect(result.status).toBe("failed");
		expect(emails).toEqual([]);
	});

	it("business: needs an organisation and a work address; personal mailboxes and non-consenting clients or unsubscribed fans are refused", async () => {
		expect((await agent("/nova-agent/outreach/draft", { ...VENUE, organisation: "" })).data.error).toMatch(/organisation/);
		const gmail = await agent("/nova-agent/outreach/draft", { ...VENUE, toEmail: "someone@gmail.com" });
		expect(gmail.status).toBe(409);
		expect(gmail.data.error).toMatch(/personal mailbox/);
		await addClient("owner@shop.co.uk", 0);
		expect((await agent("/nova-agent/outreach/draft", { ...VENUE, toEmail: "owner@shop.co.uk" })).data.error).toMatch(/hasn't said yes/);
		await env.DB.prepare("INSERT INTO fans (email, name, status, created_at) VALUES ('gone@brand.co.uk', 'Gone', 'unsubscribed', ?)").bind(new Date().toISOString()).run();
		expect((await agent("/nova-agent/outreach/draft", { ...VENUE, toEmail: "gone@brand.co.uk" })).data.error).toMatch(/unsubscribed/);
		expect((await agent("/nova-agent/outreach/draft", { ...VENUE, toEmail: "not-an-email" })).data.error).toMatch(/doesn't look right/);
		expect(await env.DB.prepare("SELECT COUNT(*) AS n FROM outreach_emails").first("n")).toBe(0);
	});

	it("a business that just got one waits a week", async () => {
		const o = await draft();
		await portal(`outreach/${o.id}/approve`, { body: {} });
		const again = await agent("/nova-agent/outreach/draft", VENUE);
		expect(again.status).toBe(409);
		expect(again.data.error).toMatch(/Give it a week/);
	});

	it("client: marketing only with consent; about their own booking is fine without it", async () => {
		const no = await addClient("artist@gmail.com", 0);
		const yes = await addClient("fan@gmail.com", 1);
		const news = { kind: "client", subject: "Studio news", body: "Hi,\n\nWe've got a new live room.\n\nNovacane Studios" };
		const refused = await agent("/nova-agent/outreach/draft", { ...news, toEmail: "artist@gmail.com", clientId: no });
		expect(refused.status).toBe(409);
		expect(refused.data.error).toMatch(/only an email about their own booking/);
		const booking = await agent("/nova-agent/outreach/draft", { ...news, toEmail: "artist@gmail.com", clientId: no, aboutBooking: true, subject: "Your session on Friday" });
		expect(booking.status).toBe(200);
		expect(booking.data.outreach).toMatchObject({ kind: "client", aboutBooking: true, clientId: no });
		// Found by email when no id is given; consent yes is fine
		const ok = await agent("/nova-agent/outreach/draft", { ...news, toEmail: "fan@gmail.com" });
		expect(ok.data.outreach).toMatchObject({ clientId: yes, aboutBooking: false });
		// Not a client, or the wrong address for that client
		expect((await agent("/nova-agent/outreach/draft", { ...news, toEmail: "stranger@gmail.com" })).data.error).toMatch(/isn't one of the studio's clients/);
		expect((await agent("/nova-agent/outreach/draft", { ...news, toEmail: "artist@gmail.com", clientId: yes })).data.error).toMatch(/isn't the one on the client's record/);
		// The footer says why
		await portal(`outreach/${booking.data.outreach.id}/approve`, { body: {} });
		expect(emails[0].text).toContain("because of your booking");
	});

	it("reply: only to someone who wrote in, unless they asked not to be contacted", async () => {
		const r = { kind: "reply", toEmail: "writer@gmail.com", subject: "Re: your enquiry", body: "Hi,\n\nThanks for getting in touch about mixing.\n\nNovacane Studios" };
		expect((await agent("/nova-agent/outreach/draft", r)).data.error).toMatch(/Nobody with that address has written/);
		await env.DB.prepare("INSERT INTO enquiries (created_at, name, email, details) VALUES (?, 'Writer', 'Writer@Gmail.com', 'Mixing please')").bind(new Date().toISOString()).run();
		expect((await agent("/nova-agent/outreach/draft", r)).status).toBe(200);
		await env.DB.prepare("UPDATE enquiries SET do_not_contact_at = ? WHERE email = 'Writer@Gmail.com'").bind(new Date().toISOString()).run();
		expect((await agent("/nova-agent/outreach/draft", r)).data.error).toMatch(/asked not to be contacted/);
	});

	it("at most 20 waiting at once", async () => {
		for (let i = 0; i < 20; i++) await draft({ toEmail: `hello${i}@venue${i}.co.uk` });
		const more = await agent("/nova-agent/outreach/draft", { ...VENUE, toEmail: "one@more.co.uk" });
		expect(more.status).toBe(429);
	});
});

describe("Portal", () => {
	it("lists them, shows one with the email as it goes, and test-sends only to the admin", async () => {
		const o = await draft();
		const list = await portal("outreach");
		expect(list.data).toMatchObject({ canDecide: true, ready: true, optouts: 0, sentToday: 0 });
		expect(list.data.outreach.map((x) => x.id)).toEqual([o.id]);
		const one = await portal(`outreach/${o.id}`);
		expect(one.data.email).toContain("Don't want emails like this?");
		expect(one.data.log.map((e) => e.event)).toEqual(["created", "submitted"]);
		const test = await portal("outreach/test-send", { body: { id: o.id } });
		expect(test.status).toBe(200);
		expect(emails).toHaveLength(1);
		expect(emails[0].to).toEqual(["test-admin@novacane.test"]);
		expect(emails[0].subject).toBe("[TEST] Live session idea");
		expect((await row(o.id)).status).toBe("pending_approval");
		// Staff (not admin) write one from Portal
		const { staff } = await otherSignIns();
		const mine = await portal("outreach", { body: { ...VENUE, toEmail: "press@magazine.co.uk", organisation: "Magazine" }, headers: staff });
		expect(mine.data.outreach).toMatchObject({ createdBy: "test-staff", createdByName: "Test Staff", status: "pending_approval" });
	});
});

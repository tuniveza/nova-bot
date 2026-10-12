// Google everywhere (src/google/): Calendar both ways, Gmail sending and replies, Contacts, Drive,
// Sheets, Portal's Admin → Google and Nova Agent's read-only tools, against a fake Google.
import { createExecutionContext, env, waitOnExecutionContext } from "cloudflare:test";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import worker from "../src";
import { STAFF_COOKIE } from "./sign-in.js";
import { forgetGoogleToken } from "../src/nova/google.js";
import { saveItem } from "../src/calendar/items.js";
import { syncCalendar, toRecurrence, fromRecurrence, fromEvent, ukWall } from "../src/google/calendar.js";
import { pullReplies, sendStudioEmail, stripQuoted } from "../src/google/gmail.js";
import { syncContacts } from "../src/google/contacts.js";
import { refreshSheet } from "../src/google/sheets.js";
import { fetchMedia } from "../src/social.js";
import { setOptions } from "../src/google/common.js";
import { googleOnSchedule } from "../src/google/index.js";

const BASE = "https://novacane-worker.test";
const ALL_SCOPES = [
	"https://www.googleapis.com/auth/calendar",
	"https://www.googleapis.com/auth/gmail.send",
	"https://www.googleapis.com/auth/gmail.readonly",
	"https://www.googleapis.com/auth/contacts",
	"https://www.googleapis.com/auth/drive.file",
].join(" ");
// Connected: the test env's client, plus a refresh token
const genv = () => ({ ...env, GOOGLE_REFRESH_TOKEN: "test-refresh" });

// ===== A FAKE GOOGLE =====
let G;
function freshGoogle() {
	G = {
		seq: 0,
		calendars: { primary: new Map() }, // id -> Map(eventId -> event)
		sent: [],
		threads: new Map(), // threadId -> [messages]
		messages: new Map(),
		groups: [],
		people: new Map(),
		files: new Map(),
		sheets: new Map(),
		resend: [],
		calls: [],
	};
}
const ok = (data, status = 200, headers = {}) => new Response(JSON.stringify(data), { status, headers: { "Content-Type": "application/json", ...headers } });
const bodyOf = async (init) => {
	try {
		return JSON.parse(init?.body || "{}");
	} catch {
		return {};
	}
};
function fakeFetch() {
	vi.spyOn(globalThis, "fetch").mockImplementation(async (input, init = {}) => {
		const url = new URL(typeof input === "string" ? input : input.url);
		const method = (init.method || "GET").toUpperCase();
		const p = url.pathname;
		G.calls.push(`${method} ${url.host}${p}`);
		if (url.host === "oauth2.googleapis.com") return ok({ access_token: "access", expires_in: 3600 });
		if (url.host === "api.resend.com") {
			G.resend.push(await bodyOf(init));
			return ok({ id: "resend-1" });
		}
		// ---- Calendar ----
		if (url.host === "www.googleapis.com" && p.startsWith("/calendar/v3")) {
			if (p === "/calendar/v3/calendars" && method === "POST") {
				G.calendars["studio-cal"] = new Map();
				return ok({ id: "studio-cal" });
			}
			if (p === "/calendar/v3/freeBusy") return ok({ calendars: { primary: { busy: [{ start: "2026-11-02T10:00:00Z", end: "2026-11-02T11:00:00Z" }] } } });
			const m = p.match(/^\/calendar\/v3\/calendars\/([^/]+)\/events(?:\/([^/]+))?$/);
			if (m) {
				const cal = G.calendars[decodeURIComponent(m[1])];
				if (!cal) return ok({ error: { message: "Not Found" } }, 404);
				const eid = m[2] && decodeURIComponent(m[2]);
				if (!eid && method === "GET") {
					const since = Number(url.searchParams.get("syncToken") || 0);
					const items = [...cal.values()].filter((e) => e.seq > since);
					return ok({ items, nextSyncToken: String(G.seq) });
				}
				if (!eid && method === "POST") {
					const e = { ...(await bodyOf(init)), id: "ev" + ++G.seq, seq: G.seq, status: "confirmed", updated: new Date().toISOString() };
					cal.set(e.id, e);
					return ok(e);
				}
				const e = cal.get(eid);
				if (!e) return ok({ error: { message: "Not Found" } }, 404);
				if (method === "PATCH") {
					Object.assign(e, await bodyOf(init), { seq: ++G.seq, updated: new Date().toISOString() });
					return ok(e);
				}
				if (method === "DELETE") {
					Object.assign(e, { status: "cancelled", seq: ++G.seq });
					return new Response(null, { status: 204 });
				}
			}
		}
		// ---- Gmail ----
		if (url.host === "gmail.googleapis.com") {
			if (p.endsWith("/messages/send")) {
				const b = await bodyOf(init);
				const threadId = b.threadId || "t" + ++G.seq;
				const id = "m" + ++G.seq;
				const raw = atob(b.raw.replace(/-/g, "+").replace(/_/g, "/"));
				G.sent.push({ id, threadId, raw });
				const msg = { id, threadId, labelIds: ["SENT"], internalDate: String(Date.now()), payload: { headers: [{ name: "From", value: "Novacane Studios <studio@example.com>" }] } };
				G.messages.set(id, msg);
				G.threads.set(threadId, [...(G.threads.get(threadId) || []), msg]);
				return ok({ id, threadId });
			}
			const t = p.match(/\/threads\/([^/]+)$/);
			if (t) return ok({ messages: G.threads.get(decodeURIComponent(t[1])) || [] });
			if (p.endsWith("/messages")) {
				const q = url.searchParams.get("q") || "";
				const from = (q.match(/from:(\S+)/) || [])[1];
				return ok({ messages: [...G.messages.values()].filter((m) => !from || JSON.stringify(m.payload.headers).includes(from)).filter((m) => !(m.labelIds || []).includes("SENT")).map((m) => ({ id: m.id })) });
			}
			const mm = p.match(/\/messages\/([^/]+)$/);
			if (mm) return ok(G.messages.get(decodeURIComponent(mm[1])));
		}
		// ---- People ----
		if (url.host === "people.googleapis.com") {
			if (p === "/v1/contactGroups" && method === "GET") return ok({ contactGroups: G.groups });
			if (p === "/v1/contactGroups" && method === "POST") {
				const g = { resourceName: "contactGroups/nc", name: "Novacane clients", groupType: "USER_CONTACT_GROUP" };
				G.groups.push(g);
				return ok(g);
			}
			if (p === "/v1/people/me/connections") return ok({ connections: [...G.people.values()], nextSyncToken: "pt" + G.seq });
			if (p === "/v1/people:createContact") {
				const b = await bodyOf(init);
				const person = { ...b, resourceName: "people/c" + ++G.seq, etag: "e" + G.seq, metadata: { sources: [{ updateTime: new Date().toISOString() }] } };
				G.people.set(person.resourceName, person);
				return ok(person);
			}
			if (p === "/v1/people:searchContacts") return ok({ results: [] });
			const u = p.match(/^\/v1\/(people\/[^:]+):updateContact$/);
			if (u) {
				const person = G.people.get(u[1]);
				Object.assign(person, await bodyOf(init), { etag: "e" + ++G.seq });
				return ok(person);
			}
		}
		// ---- Drive and Sheets ----
		if (url.host === "www.googleapis.com" && p.startsWith("/drive/v3/files")) {
			const f = p.match(/^\/drive\/v3\/files\/([^/]+)$/);
			if (!f && method === "POST") {
				const b = await bodyOf(init);
				const id = "f" + ++G.seq;
				G.files.set(id, { ...b, id });
				return ok({ id });
			}
			if (f) {
				const file = G.files.get(decodeURIComponent(f[1]));
				if (!file) return ok({ error: { message: "Not Found" } }, 404);
				if (url.searchParams.get("alt") === "media") return new Response(file.bytes, { headers: { "Content-Type": file.type || "image/jpeg", "Content-Length": String(file.bytes.byteLength) } });
				if (method === "PATCH") Object.assign(file, await bodyOf(init));
				return ok({ id: file.id, trashed: Boolean(file.trashed) });
			}
		}
		if (url.host === "www.googleapis.com" && p === "/upload/drive/v3/files") {
			if (url.searchParams.get("uploadType") === "resumable") {
				const meta = await bodyOf(init);
				const id = "f" + ++G.seq;
				G.files.set(id, { ...meta, id, type: init.headers["X-Upload-Content-Type"] });
				return new Response(null, { status: 200, headers: { Location: `https://www.googleapis.com/upload/session/${id}` } });
			}
			const id = "f" + ++G.seq;
			G.files.set(id, { id, doc: true });
			return ok({ id, webViewLink: `https://docs.google.com/document/d/${id}/edit` });
		}
		if (url.host === "www.googleapis.com" && p.startsWith("/upload/session/")) {
			const id = p.split("/").pop();
			G.files.get(id).bytes = new Uint8Array(init.body);
			return ok({ id });
		}
		if (url.host === "sheets.googleapis.com") {
			if (p === "/v4/spreadsheets" && method === "POST") {
				G.sheets.set("s1", { writes: 0, data: null });
				G.files.set("s1", { id: "s1" });
				return ok({ spreadsheetId: "s1", spreadsheetUrl: "https://docs.google.com/spreadsheets/d/s1/edit" });
			}
			if (p.endsWith(":batchClear")) return ok({});
			if (p.endsWith(":batchUpdate")) {
				const s = G.sheets.get("s1");
				s.writes++;
				s.data = await bodyOf(init);
				return ok({});
			}
		}
		return ok({ error: { message: `fake Google: nothing at ${method} ${url.host}${p}` } }, 404);
	});
}

async function call(path, { e = genv(), method = "GET", cookie = STAFF_COOKIE, body, headers = {} } = {}) {
	const h = { ...headers };
	if (cookie) h.Cookie = cookie;
	if (method !== "GET") {
		h.Origin = BASE;
		h["Content-Type"] ||= "application/json";
	}
	const ctx = createExecutionContext();
	const res = await worker.fetch(new Request(BASE + path, { method, headers: h, body: body === undefined ? undefined : typeof body === "string" || body instanceof Uint8Array ? body : JSON.stringify(body) }), e, ctx);
	await waitOnExecutionContext(ctx);
	return res;
}
const agent = (path, body, extra = {}) => call(path, { method: "POST", cookie: "", body, headers: { Authorization: "Bearer agent-nova-test-key", ...extra } });

beforeEach(async () => {
	freshGoogle();
	forgetGoogleToken();
	await env.DB.prepare("DELETE FROM settings WHERE key LIKE 'google_%'").run();
	await env.DB.prepare("DELETE FROM google_links").run();
	await env.DB.prepare("DELETE FROM calendar_items").run();
	await env.DB.prepare("INSERT INTO settings (key, value) VALUES ('google_account', 'studio@example.com'), ('google_scopes', ?)").bind(ALL_SCOPES).run();
	fakeFetch();
});
afterEach(() => vi.restoreAllMocks());

const budget = () => ({ left: 40 });

describe("Calendar: Nova and Google, both ways", () => {
	it("sends Nova's events to the Novacane Studio calendar once, and doesn't echo them back", async () => {
		await saveItem(env, { kind: "event", id: "ev-1", title: "Engineer in", start: "2026-11-02T10:00", end: "2026-11-02T12:00", updated: new Date().toISOString() });
		await syncCalendar(genv(), budget());
		const studio = [...G.calendars["studio-cal"].values()];
		expect(studio).toHaveLength(1);
		expect(studio[0]).toMatchObject({ summary: "Engineer in", start: { dateTime: "2026-11-02T10:00:00", timeZone: "Europe/London" }, extendedProperties: { private: { novaId: "ev-1" } } });
		// The next run: nothing new written either way
		const writes = G.calls.length;
		await syncCalendar(genv(), budget());
		expect(G.calls.slice(writes).filter((c) => !c.startsWith("GET") && !c.includes("oauth2"))).toEqual([]);
		const row = await env.DB.prepare("SELECT data FROM calendar_items WHERE id = 'ev-1'").first();
		expect(JSON.parse(row.data).end).toBe("2026-11-02T12:00");
	});

	it("brings events from the studio's own Google Calendar into Nova (UK time), and their deletion too", async () => {
		G.calendars.primary.set("abc", { id: "abc", seq: ++G.seq, status: "confirmed", summary: "Dentist", start: { dateTime: "2026-07-01T09:00:00Z" }, end: { dateTime: "2026-07-01T10:00:00Z" }, updated: new Date().toISOString() });
		await syncCalendar(genv(), budget());
		const row = await env.DB.prepare("SELECT data, deleted FROM calendar_items WHERE id = 'gp-abc'").first();
		// 09:00 UTC in July is 10:00 in London
		expect(JSON.parse(row.data)).toMatchObject({ title: "Dentist", start: "2026-07-01T10:00", end: "2026-07-01T11:00", author: "Google Calendar" });
		// Not sent back to Google as a new event
		expect(G.calendars["studio-cal"].size).toBe(0);
		Object.assign(G.calendars.primary.get("abc"), { status: "cancelled", seq: ++G.seq, updated: new Date(Date.now() + 1000).toISOString() });
		await syncCalendar(genv(), budget());
		expect((await env.DB.prepare("SELECT deleted FROM calendar_items WHERE id = 'gp-abc'").first()).deleted).toBe(1);
	});

	it("sends a change made in Nova to an event from Google back to Google", async () => {
		G.calendars.primary.set("x1", { id: "x1", seq: ++G.seq, status: "confirmed", summary: "Lunch", start: { dateTime: "2026-11-03T12:00:00Z" }, end: { dateTime: "2026-11-03T13:00:00Z" }, updated: "2026-10-01T00:00:00.000Z" });
		await syncCalendar(genv(), budget());
		const row = await env.DB.prepare("SELECT data FROM calendar_items WHERE id = 'gp-x1'").first();
		await saveItem(env, { ...JSON.parse(row.data), id: "gp-x1", title: "Lunch with Kai", updated: new Date().toISOString() });
		await syncCalendar(genv(), budget());
		expect(G.calendars.primary.get("x1").summary).toBe("Lunch with Kai");
	});

	it("keeps Nova Agent's plan out of Google unless that's switched on", async () => {
		await saveItem(env, { kind: "event", id: "quest-1", title: "✦ Mix", start: "2026-11-04T10:00", end: "2026-11-04T11:00", updated: new Date().toISOString() });
		await syncCalendar(genv(), budget());
		expect(G.calendars["studio-cal"].size).toBe(0);
		await setOptions(env, { calendarPlan: true });
		await saveItem(env, { kind: "event", id: "quest-1", title: "✦ Mix (2)", start: "2026-11-04T10:00", end: "2026-11-04T11:00", updated: new Date(Date.now() + 1000).toISOString() });
		await syncCalendar(genv(), budget());
		expect([...G.calendars["studio-cal"].values()].map((e) => e.summary)).toEqual(["✦ Mix (2)"]);
	});

	it("turns repeats into Google's rules and back", () => {
		const item = { start: "2026-11-02T10:00", allDay: false, repeat: { freq: "weekly", interval: 2, byDay: [1, 3], until: "2026-12-31" }, exdates: ["2026-11-16"] };
		const lines = toRecurrence(item);
		expect(lines[0]).toBe("RRULE:FREQ=WEEKLY;INTERVAL=2;BYDAY=MO,WE;UNTIL=20261231T235959Z");
		expect(fromRecurrence(lines)).toEqual({ repeat: { freq: "weekly", interval: 2, byDay: [1, 3], until: "2026-12-31" }, exdates: ["2026-11-16"] });
		// All-day: Google's end date is the day after
		expect(fromEvent({ start: { date: "2026-11-05" }, end: { date: "2026-11-07" }, summary: "Away" }, "g-a")).toMatchObject({ allDay: true, start: "2026-11-05T00:00", end: "2026-11-06T23:59" });
		expect(ukWall("2026-01-10T09:30:00Z")).toBe("2026-01-10T09:30");
	});
});

describe("Gmail: approved emails from the studio's Gmail, replies back into Enquiries", () => {
	it("sends from Gmail when it's on (remembering the thread), and through Resend when Google isn't connected", async () => {
		const sent = await sendStudioEmail(genv(), { to: ["kai@example.com"], subject: "Your session", text: "Hi", html: "<p>Hi</p>", headers: { "List-Unsubscribe": "<https://x.test/stop>" } }, { kind: "enquiry", id: 7 });
		expect(sent).toMatchObject({ ok: true, via: "gmail" });
		expect(G.sent[0].raw).toContain("To: kai@example.com");
		expect(G.sent[0].raw).toContain("List-Unsubscribe: <https://x.test/stop>");
		expect(await env.DB.prepare("SELECT google_id FROM google_links WHERE kind = 'gmail-thread' AND nova_id = 'enquiry:7'").first("google_id")).toBe(G.sent[0].threadId);
		// The next email about it joins the same thread
		await sendStudioEmail(genv(), { to: ["kai@example.com"], subject: "Re: Your session", text: "More" }, { kind: "enquiry", id: 7 });
		expect(G.sent[1].threadId).toBe(G.sent[0].threadId);
		expect(G.sent[1].raw).toMatch(/In-Reply-To: <nova-/);
		// Not connected: Resend, as before
		const viaResend = await sendStudioEmail({ ...env, GOOGLE_REFRESH_TOKEN: "", RESEND_API_KEY: "re_test" }, { to: ["kai@example.com"], subject: "S", text: "T" });
		expect(viaResend.via).toBe("resend");
		expect(G.resend).toHaveLength(1);
	});

	it("brings a customer's reply into their enquiry once, and opens it again", async () => {
		const { meta } = await env.DB.prepare("INSERT INTO enquiries (created_at, name, email, subject, details, status) VALUES (?, 'Kai', 'kai@example.com', 'Session', 'Hi', 'replied')").bind(new Date().toISOString()).run();
		const id = meta.last_row_id;
		await sendStudioEmail(genv(), { to: ["kai@example.com"], subject: "Your session", text: "Hi" }, { kind: "enquiry", id });
		const threadId = G.sent[0].threadId;
		const text = btoa("Sounds good, Thursday works.\n\nOn Mon, 12 Oct 2026 at 10:00, Novacane Studios wrote:\n> Hi").replace(/\+/g, "-").replace(/\//g, "_");
		const reply = { id: "r1", threadId, internalDate: String(Date.now()), payload: { headers: [{ name: "From", value: "Kai <kai@example.com>" }, { name: "Subject", value: "Re: Your session" }], mimeType: "text/plain", body: { data: text } } };
		G.messages.set("r1", reply);
		G.threads.get(threadId).push(reply);
		await pullReplies(genv(), budget());
		await pullReplies(genv(), budget());
		const msgs = await env.DB.prepare("SELECT direction, body, created_by FROM enquiry_messages WHERE enquiry_id = ?").bind(id).all();
		expect(msgs.results).toEqual([{ direction: "in", body: "Sounds good, Thursday works.", created_by: "customer" }]);
		expect((await env.DB.prepare("SELECT status FROM enquiries WHERE id = ?").bind(id).first()).status).toBe("open");
	});

	it("cuts the quoted email under a reply", () => {
		expect(stripQuoted("Yes please\n\nOn Tue, 1 Oct 2026, Studio <a@b.c> wrote:\n> old")).toBe("Yes please");
		expect(stripQuoted("Thanks!\n> quoted\nBye")).toBe("Thanks!\nBye");
	});
});

describe("Contacts: Clients ⇄ Google Contacts", () => {
	it("puts clients in Google under the label (never their consent), and a labelled contact becomes a client", async () => {
		await env.DB.prepare("DELETE FROM clients").run();
		const now = new Date().toISOString();
		await env.DB.prepare("INSERT INTO clients (name, email, phone, marketing_consent, source, created_at, updated_at) VALUES ('Kai Francis', 'kai@example.com', '07700900123', 1, 'booking', ?, ?)").bind(now, now).run();
		G.people.set("people/g1", { resourceName: "people/g1", etag: "x", names: [{ displayName: "Rio King" }], emailAddresses: [{ value: "Rio@Example.com" }], memberships: [{ contactGroupMembership: { contactGroupResourceName: "contactGroups/nc" } }], metadata: { sources: [{ updateTime: now }] } });
		G.groups.push({ resourceName: "contactGroups/nc", name: "Novacane clients", groupType: "USER_CONTACT_GROUP" });
		await syncContacts(genv(), budget());
		const made = [...G.people.values()].find((p) => p.names?.[0]?.unstructuredName === "Kai Francis");
		expect(made).toBeTruthy();
		expect(made.memberships[0].contactGroupMembership.contactGroupResourceName).toBe("contactGroups/nc");
		expect(JSON.stringify(made)).not.toMatch(/consent/i);
		const rio = await env.DB.prepare("SELECT name, email, marketing_consent, source, updated_by FROM clients WHERE email = 'rio@example.com'").first();
		expect(rio).toEqual({ name: "Rio King", email: "rio@example.com", marketing_consent: 0, source: "import", updated_by: "google" });
		// Run again: nothing made twice
		const before = G.people.size;
		await syncContacts(genv(), budget());
		expect(G.people.size).toBe(before);
		expect((await env.DB.prepare("SELECT COUNT(*) AS n FROM clients").first()).n).toBe(2);
	});
});

describe("Drive and Sheets", () => {
	it("keeps the PC's picture in Drive, and Meta's copy comes from there", async () => {
		const bytes = new Uint8Array([0xff, 0xd8, 0xff, 0xe0, 1, 2, 3]);
		const id = "a".repeat(32);
		const res = await agent(`/nova-agent/google/drive/put?kind=media&id=${id}&name=cover.jpg&type=image%2Fjpeg`, bytes, { "Content-Type": "image/jpeg" });
		expect(res.status).toBe(200);
		expect((await res.json()).ok).toBe(true);
		const got = await fetchMedia(genv(), `${id}.jpg`);
		expect(new Uint8Array(await got.arrayBuffer())).toEqual(bytes);
		// Portal's thumbnail with the PC off: the Drive copy, for signed-in staff only
		const shown = await call(`/social-media/${id}.jpg`);
		expect(shown.status).toBe(200);
		expect(shown.headers.get("X-Nova-From")).toBe("google-drive");
		expect((await call(`/social-media/${id}.jpg`, { cookie: "" })).status).not.toBe(200);
		// Off: skipped, nothing stored
		await setOptions(env, { drive: false });
		const off = await agent(`/nova-agent/google/drive/put?kind=media&id=${"b".repeat(32)}&type=image%2Fjpeg`, bytes, { "Content-Type": "image/jpeg" });
		expect((await off.json()).skipped).toBe(true);
	});

	it("writes Money into one sheet as plain values, and only when something changed", async () => {
		const first = await refreshSheet(genv());
		expect(first.url).toContain("spreadsheets/d/s1");
		expect(G.sheets.get("s1").data.valueInputOption).toBe("RAW");
		expect(G.sheets.get("s1").data.data.map((d) => d.range)).toEqual(["'Invoices'!A1", "'Payments'!A1", "'Expenses'!A1"]);
		const again = await refreshSheet(genv());
		expect(again.written).toBe(false);
		expect(G.sheets.get("s1").writes).toBe(1);
	});
});

describe("Portal's Admin → Google and Nova Agent's tools", () => {
	it("Connect Google works with a one-time pass, whatever the sign-in (and only once)", async () => {
		const res = await call("/app/api/google/connect-link", { method: "POST", body: { popup: true } });
		expect(res.status).toBe(200);
		const { url } = await res.json();
		expect(url).toMatch(/^https:\/\/novacane-worker\.test\/admin\/google\?ticket=[0-9a-f]{48}&popup=1$/);
		const path = url.replace(BASE, "");
		// No cookie at all: the pass is enough, and Google's consent page is next
		const go = await call(path, { cookie: "" });
		expect(go.status).toBe(302);
		expect(go.headers.get("Location")).toContain("accounts.google.com");
		expect(go.headers.get("Set-Cookie")).toContain("nv_gstate=");
		// Used up
		const again = await call(path, { cookie: "" });
		expect(again.status).toBe(403);
		// A made-up pass doesn't work
		const forged = await call("/admin/google?ticket=" + "a".repeat(48), { cookie: "" });
		expect(forged.status).toBe(403);
	});

	it("Connect Google's pass is for admins only, and runs out after 10 minutes", async () => {
		const res = await call("/app/api/google/connect-link", { method: "POST", body: {} });
		const { url } = await res.json();
		const saved = JSON.parse(await env.DB.prepare("SELECT value FROM settings WHERE key = 'google_connect_ticket'").first("value"));
		await env.DB.prepare("UPDATE settings SET value = ? WHERE key = 'google_connect_ticket'").bind(JSON.stringify({ ...saved, at: Date.now() - 11 * 60 * 1000 })).run();
		expect((await call(url.replace(BASE, ""), { cookie: "" })).status).toBe(403);
		// Without a sign-in, no pass
		expect((await call("/app/api/google/connect-link", { method: "POST", body: {}, cookie: "" })).status).toBe(401);
	});

	it("shows admins the steps, what's on and what's missing; only admins change it", async () => {
		await env.DB.prepare("UPDATE settings SET value = ? WHERE key = 'google_scopes'").bind("https://www.googleapis.com/auth/calendar https://www.googleapis.com/auth/gmail.send").run();
		const res = await call("/app/api/google");
		const data = await res.json();
		expect(data).toMatchObject({ connected: true, account: "studio@example.com", canManage: true, hasKey: true });
		expect(data.steps).toHaveLength(6);
		expect(data.steps[3].copy).toContain("https://novacane-worker.test/admin/google/callback");
		expect(data.missing).toContain("Clients in Google Contacts");
		expect(data.parts.find((p) => p.id === "contacts").allowed).toBe(false);
		const bad = await call("/app/api/google/key", { method: "POST", body: { clientId: "nope", clientSecret: "x" } });
		expect(bad.status).toBe(400);
		const opt = await call("/app/api/google/options", { method: "POST", body: { changes: { calendarPlan: true, nonsense: true } } });
		expect((await opt.json()).options.calendarPlan).toBe(true);
	});

	it("tells a connection made before these features (no permissions saved) to connect again for the new ones", async () => {
		await env.DB.prepare("DELETE FROM settings WHERE key = 'google_scopes'").run();
		const data = await (await call("/app/api/google")).json();
		expect(data.connected).toBe(true);
		expect(data.missing).toEqual(expect.arrayContaining(["Customers' replies into Enquiries", "Clients in Google Contacts", "Pictures, videos and receipts in Google Drive"]));
		expect(data.parts.find((p) => p.id === "calendar").allowed).toBe(true);
		expect(data.steps[0].open.href).toContain("calendar-json.googleapis.com,gmail.googleapis.com,drive.googleapis.com,people.googleapis.com,sheets.googleapis.com,docs.googleapis.com");
	});

	it("gives Nova Agent busy times, and has no way to send", async () => {
		const busy = await agent("/nova-agent/google/busy", { from: "2026-11-01T00:00:00Z", to: "2026-11-05T00:00:00Z" });
		expect((await busy.json()).busy).toEqual([{ start: "2026-11-02T10:00:00Z", end: "2026-11-02T11:00:00Z" }]);
		expect((await agent("/nova-agent/google/gmail/send", { to: "x@y.z" })).status).toBe(404);
		expect((await call("/nova-agent/google/busy", { method: "POST", cookie: "", body: {} })).status).toBe(401);
	});

	it("runs one part at its own minute on the cron", async () => {
		// 12:05 UK in November = 12:05 UTC: the calendar's turn
		const result = await googleOnSchedule(genv(), Date.parse("2026-11-10T12:05:00Z"));
		expect(result).toMatchObject({ part: "calendar", ok: true });
		expect(await googleOnSchedule(genv(), Date.parse("2026-11-10T12:07:00Z"))).toBe(null);
	});
});

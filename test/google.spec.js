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
import { setOptions, readStatus, readBackoff } from "../src/google/common.js";
import { googleOnSchedule, runGooglePart } from "../src/google/index.js";

const BASE = "https://novacane-worker.test";
const ALL_SCOPES = [
	"https://www.googleapis.com/auth/calendar",
	"https://www.googleapis.com/auth/gmail.send",
	"https://www.googleapis.com/auth/gmail.readonly",
	"https://www.googleapis.com/auth/contacts",
	"https://www.googleapis.com/auth/drive.file",
	"https://www.googleapis.com/auth/gmail.modify",
	"https://www.googleapis.com/auth/tasks",
	"https://www.googleapis.com/auth/drive.readonly",
	"https://www.googleapis.com/auth/youtube.readonly",
	"https://www.googleapis.com/auth/youtube.upload",
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
		mail: [],
		calls: [],
		labels: [],
		modified: [],
		lists: [],
		tasks: new Map(),
		videos: new Map(),
		uploads: [],
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
		if (url.host === "mail.test") {
			G.mail.push(await bodyOf(init));
			return ok({ id: "mail-1" });
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
					if (e.conferenceData?.createRequest) e.hangoutLink = "https://meet.google.com/abc-defg-hij";
					cal.set(e.id, e);
					return ok(e);
				}
				const e = cal.get(eid);
				if (!e) return ok({ error: { message: "Not Found" } }, 404);
				if (method === "GET") return ok(e);
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
			if (p.endsWith("/labels") && method === "GET") return ok({ labels: G.labels });
			if (p.endsWith("/labels") && method === "POST") {
				const l = { id: "Label_" + ++G.seq, ...(await bodyOf(init)) };
				G.labels.push(l);
				return ok(l);
			}
			const mod = p.match(/\/(messages|threads)\/([^/]+)\/modify$/);
			if (mod) {
				G.modified.push({ what: mod[1], id: decodeURIComponent(mod[2]), ...(await bodyOf(init)) });
				return ok({});
			}
			if (p.endsWith("/messages") && (url.searchParams.get("q") || "").startsWith("in:inbox")) {
				return ok({ messages: [...G.messages.values()].filter((m) => (m.labelIds || []).includes("INBOX")).map((m) => ({ id: m.id, threadId: m.threadId })).reverse() });
			}
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
			const grp = p.match(/^\/v1\/(contactGroups\/[^/:]+)$/);
			if (grp && method === "GET") {
				const members = [...G.people.values()].filter((x) => (x.memberships || []).some((m) => m.contactGroupMembership?.contactGroupResourceName === grp[1])).map((x) => x.resourceName);
				return ok({ resourceName: grp[1], memberResourceNames: members });
			}
			if (p === "/v1/people:batchGet") {
				const names = url.searchParams.getAll("resourceNames");
				G.batchGets = (G.batchGets || 0) + 1;
				return ok({ responses: names.map((n) => (G.people.has(n) ? { requestedResourceName: n, person: G.people.get(n), status: {} } : { requestedResourceName: n, status: { code: 5 } })) });
			}
			if (p === "/v1/people:createContact") {
				const b = await bodyOf(init);
				const person = { ...b, resourceName: "people/c" + ++G.seq, etag: "e" + G.seq, metadata: { sources: [{ updateTime: new Date().toISOString() }] } };
				G.people.set(person.resourceName, person);
				return ok(person);
			}
			if (p === "/v1/people:searchContacts") {
				const q = String(url.searchParams.get("query") || "").toLowerCase();
				return ok({ results: [...G.people.values()].filter((x) => q && (JSON.stringify([x.names, x.emailAddresses]).toLowerCase().includes(q) || (x.phoneNumbers || []).some((t) => t.value === url.searchParams.get("query")))).map((person) => ({ person })) });
			}
			const u = p.match(/^\/v1\/(people\/[^:]+):updateContact$/);
			if (u) {
				const person = G.people.get(u[1]);
				Object.assign(person, await bodyOf(init), { etag: "e" + ++G.seq });
				return ok(person);
			}
		}
		// ---- Tasks ----
		if (url.host === "tasks.googleapis.com") {
			if (p === "/tasks/v1/users/@me/lists" && method === "GET") return ok({ items: G.lists });
			if (p === "/tasks/v1/users/@me/lists" && method === "POST") {
				const l = { id: "list" + ++G.seq, ...(await bodyOf(init)) };
				G.lists.push(l);
				return ok(l);
			}
			const tm = p.match(/^\/tasks\/v1\/lists\/([^/]+)\/tasks(?:\/([^/]+))?$/);
			if (tm) {
				const tid = tm[2] && decodeURIComponent(tm[2]);
				if (!tid && method === "GET") return ok({ items: [...G.tasks.values()] });
				if (!tid && method === "POST") {
					const t = { id: "task" + ++G.seq, ...(await bodyOf(init)), updated: new Date().toISOString() };
					G.tasks.set(t.id, t);
					return ok(t);
				}
				const t = G.tasks.get(tid);
				if (!t) return ok({ error: { message: "Not Found" } }, 404);
				if (method === "PATCH") return ok(Object.assign(t, await bodyOf(init)));
				if (method === "DELETE") {
					G.tasks.delete(tid);
					return new Response(null, { status: 204 });
				}
			}
		}
		// ---- YouTube ----
		if (url.host === "www.googleapis.com" && p === "/upload/youtube/v3/videos") {
			G.ytMeta = await bodyOf(init);
			return new Response(null, { status: 200, headers: { Location: "https://www.googleapis.com/upload/yt-session/1" } });
		}
		if (url.host === "www.googleapis.com" && p.startsWith("/upload/yt-session/")) {
			const bytes = new Uint8Array(await new Response(init.body).arrayBuffer());
			const id = "vid" + ++G.seq;
			G.uploads.push({ id, bytes: bytes.byteLength, meta: G.ytMeta });
			G.videos.set(id, { viewCount: "120", likeCount: "9", commentCount: "2" });
			return ok({ id });
		}
		if (url.host === "www.googleapis.com" && p === "/youtube/v3/videos") return ok({ items: (url.searchParams.get("id") || "").split(",").filter((id) => G.videos.has(id)).map((id) => ({ id, statistics: G.videos.get(id) })) });
		if (url.host === "www.googleapis.com" && p === "/youtube/v3/playlistItems") return ok({ items: [...G.videos.keys()].map((id) => ({ snippet: { title: "A video", publishedAt: "2026-10-01T00:00:00Z", resourceId: { videoId: id } } })) });
		if (url.host === "www.googleapis.com" && p === "/youtube/v3/channels") return ok({ items: [{ id: "ch1", snippet: { title: "Novacane Studios" }, statistics: { subscriberCount: "321", viewCount: "9000", videoCount: "14" }, contentDetails: { relatedPlaylists: { uploads: "UU1" } } }] });
		// ---- Drive extras (Docs kept in step, invoices) ----
		const exp = url.host === "www.googleapis.com" && p.match(/^\/drive\/v3\/files\/([^/]+)\/export$/);
		if (exp) {
			const file = G.files.get(decodeURIComponent(exp[1]));
			if (!file) return ok({ error: { message: "Not Found" } }, 404);
			return new Response(url.searchParams.get("mimeType") === "text/plain" ? String(file.html || "").replace(/<[^>]+>/g, "") : `<html><head><style>p{}</style></head><body>${file.html || ""}</body></html>`, { headers: { "Content-Type": "text/html" } });
		}
		const cp = url.host === "www.googleapis.com" && p.match(/^\/drive\/v3\/files\/([^/]+)\/copy$/);
		if (cp) {
			const id = "f" + ++G.seq;
			G.files.set(id, { ...G.files.get(decodeURIComponent(cp[1])), id, ...(await bodyOf(init)) });
			return ok({ id });
		}
		const up = url.host === "www.googleapis.com" && p.match(/^\/upload\/drive\/v3\/files\/([^/]+)$/);
		if (up && method === "PATCH") {
			const file = G.files.get(decodeURIComponent(up[1]));
			if (!file) return ok({ error: { message: "Not Found" } }, 404);
			if (file.readOnly) return ok({ error: { message: "Forbidden" } }, 403);
			const text = typeof init.body === "string" ? init.body : new TextDecoder().decode(init.body);
			file.html = (text.match(/<body>([\s\S]*)<\/body>/) || [, text])[1];
			file.modifiedTime = new Date(Date.now() + ++G.seq).toISOString();
			return ok({ id: file.id, modifiedTime: file.modifiedTime });
		}
		if (url.host === "www.googleapis.com" && p === "/drive/v3/files" && method === "GET") return ok({ files: [...G.files.values()].filter((f) => f.name).map((f) => ({ id: f.id, name: f.name, mimeType: f.mimeType, modifiedTime: f.modifiedTime, webViewLink: "https://docs.google.com/document/d/" + f.id })) });
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
				if (url.searchParams.get("alt") === "media") {
					const range = /^bytes=(\d+)-(\d+)$/.exec((init.headers && init.headers.Range) || "");
					if (range) {
						const part = file.bytes.subarray(Number(range[1]), Number(range[2]) + 1);
						return new Response(part, { status: 206, headers: { "Content-Type": file.type || "image/jpeg", "Content-Length": String(part.byteLength), "Content-Range": `bytes ${range[1]}-${range[2]}/${file.bytes.byteLength}` } });
					}
					return new Response(file.bytes, { headers: { "Content-Type": file.type || "image/jpeg", "Content-Length": String(file.bytes.byteLength) } });
				}
				if (method === "PATCH") Object.assign(file, await bodyOf(init));
				return ok({ id: file.id, trashed: Boolean(file.trashed), parents: file.parents, name: file.name, mimeType: file.mimeType || (file.doc ? "application/vnd.google-apps.document" : undefined), modifiedTime: file.modifiedTime || "2026-10-01T00:00:00.000Z", webViewLink: "https://docs.google.com/document/d/" + file.id + "/edit", capabilities: { canEdit: !file.readOnly } });
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
			const text = typeof init.body === "string" ? init.body : "";
			const meta = JSON.parse((text.match(/\r\n\r\n(\{[^\r]*\})\r\n/) || [, "{}"])[1]);
			const html = (text.match(/<body>([\s\S]*)<\/body>/) || [, ""])[1];
			const modifiedTime = new Date(Date.now() + ++G.seq).toISOString();
			G.files.set(id, { id, doc: true, name: meta.name, mimeType: meta.mimeType, parents: meta.parents, html, modifiedTime });
			return ok({ id, webViewLink: `https://docs.google.com/document/d/${id}/edit`, modifiedTime });
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

	it("the old copies of Acuity's bookings go: ones to come deleted, past ones kept", async () => {
		await env.DB.prepare("INSERT INTO settings (key, value) VALUES ('google_studio_calendar', 'studio-cal') ON CONFLICT (key) DO UPDATE SET value = excluded.value").run();
		{
			G.calendars["studio-cal"] = new Map();
			const at = (days, hour) => new Date(Date.now() + days * 86400000 + hour * 3600000).toISOString();
			const copy = (id, nova, days) => ({ id, seq: ++G.seq, status: "confirmed", summary: "Booking: Rap Package", start: { dateTime: at(days, 0) }, end: { dateTime: at(days, 2) }, extendedProperties: { private: { novaBooking: nova } } });
			G.calendars["studio-cal"].set("copy-future", copy("copy-future", "1782089433", 5));
			G.calendars["studio-cal"].set("copy-past", copy("copy-past", "1782089400", -5));
			const now = new Date().toISOString();
			for (const [nova, google] of [["1782089433", "copy-future"], ["1782089400", "copy-past"]]) {
				await env.DB.prepare("INSERT INTO google_links (kind, nova_id, google_id, extra, hash, synced_at) VALUES ('booking', ?, ?, 'studio-cal', 'h', ?)").bind(nova, google, now).run();
			}
			await syncCalendar(genv(), budget());
			expect(G.calendars["studio-cal"].get("copy-future").status).toBe("cancelled");
			expect(G.calendars["studio-cal"].get("copy-past").status).toBe("confirmed");
			expect((await env.DB.prepare("SELECT COUNT(*) AS n FROM google_links WHERE kind = 'booking'").first()).n).toBe(0);
			// Nothing left: the next run makes no booking calls
			const before = G.calls.length;
			await syncCalendar(genv(), budget());
			expect(G.calls.slice(before).filter((c) => c.includes("copy-"))).toEqual([]);
		}
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
	it("sends from Gmail when it's on (remembering the thread), and through the studio's mail server when Google isn't connected", async () => {
		const sent = await sendStudioEmail(genv(), { to: ["kai@example.com"], subject: "Your session", text: "Hi", html: "<p>Hi</p>", headers: { "List-Unsubscribe": "<https://x.test/stop>" } }, { kind: "enquiry", id: 7 });
		expect(sent).toMatchObject({ ok: true, via: "gmail" });
		expect(G.sent[0].raw).toContain("To: kai@example.com");
		expect(G.sent[0].raw).toContain("List-Unsubscribe: <https://x.test/stop>");
		expect(await env.DB.prepare("SELECT google_id FROM google_links WHERE kind = 'gmail-thread' AND nova_id = 'enquiry:7'").first("google_id")).toBe(G.sent[0].threadId);
		// The next email about it joins the same thread
		await sendStudioEmail(genv(), { to: ["kai@example.com"], subject: "Re: Your session", text: "More" }, { kind: "enquiry", id: 7 });
		expect(G.sent[1].threadId).toBe(G.sent[0].threadId);
		expect(G.sent[1].raw).toMatch(/In-Reply-To: <nova-/);
		// Not connected: the studio's mail server
		const viaMail = await sendStudioEmail({ ...env, GOOGLE_REFRESH_TOKEN: "", MAIL_KEY: "test" }, { to: ["kai@example.com"], subject: "S", text: "T" });
		expect(viaMail.via).toBe("vps");
		expect(G.mail).toHaveLength(1);
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

	it("a Board's big file: the PC uploads it to Drive itself, and Board shows it from there online (Range works)", async () => {
		const id = "b-20261013-0123456789ab";
		const bytes = new Uint8Array(50_000);
		bytes.set(new TextEncoder().encode("\0\0\0\x18ftypisom"), 0);
		for (let i = 16; i < bytes.length; i++) bytes[i] = i & 255;
		// The PC asks for an upload, sends the file straight to Google, then says which file it became
		const start = await (await agent("/nova-agent/google/drive/start", { kind: "board", id, name: "set.mp4", type: "video/mp4", size: bytes.byteLength })).json();
		expect(start.session).toMatch(/^https:\/\/www\.googleapis\.com\/upload\//);
		const made = await (await globalThis.fetch(start.session, { method: "PUT", headers: { "Content-Type": "video/mp4" }, body: bytes })).json();
		const linked = await (await agent("/nova-agent/google/drive/link", { kind: "board", id, driveId: made.id, name: "set.mp4" })).json();
		expect(linked, JSON.stringify(linked)).toMatchObject({ ok: true });
		// Online, signed in: from Drive, whole or a part
		const whole = await call(`/board-files/${id}`);
		expect(whole.status).toBe(200);
		expect(whole.headers.get("X-Nova-From")).toBe("google-drive");
		expect(whole.headers.get("Content-Security-Policy")).toContain("sandbox");
		expect(new Uint8Array(await whole.arrayBuffer())).toEqual(bytes);
		const part = await call(`/board-files/${id}`, { headers: { Range: "bytes=100-199" } });
		expect(part.status).toBe(206);
		expect(part.headers.get("Content-Range")).toBe(`bytes 100-199/${bytes.byteLength}`);
		expect(new Uint8Array(await part.arrayBuffer())).toEqual(bytes.subarray(100, 200));
		// Not signed in: nothing
		expect((await call(`/board-files/${id}`, { cookie: "" })).status).not.toBe(200);
		// Only Board's own uploads can be linked (not some other file in the studio's Drive)
		G.files.set("someone-elses-file", { id: "someone-elses-file", parents: ["elsewhere"] });
		expect((await agent("/nova-agent/google/drive/link", { kind: "board", id: "b-20261013-aaaaaaaaaaaa", driveId: "someone-elses-file" })).status).toBe(400);
		// Only board files, by their made-up names
		expect((await agent("/nova-agent/google/drive/start", { kind: "media", id, size: 10 })).status).toBe(400);
		expect((await agent("/nova-agent/google/drive/start", { kind: "board", id: "../x", size: 10 })).status).toBe(400);
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
		expect(data.missing).toContain("Clients in Contacts");
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
		expect(data.missing).toEqual(expect.arrayContaining(["Replies into Enquiries", "Clients in Contacts", "Pictures in Drive"]));
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

describe("Within the free Workers plan: small steps, carrying on next run", () => {
	it("Contacts: a long client list goes over in steps, says how far it got, and nothing is made twice", async () => {
		await env.DB.prepare("DELETE FROM clients").run();
		const now = new Date().toISOString();
		const add = env.DB.prepare("INSERT INTO clients (name, email, source, created_at, updated_at) VALUES (?, ?, 'booking', ?, ?)");
		await env.DB.batch(Array.from({ length: 25 }, (_, i) => add.bind(`Client ${i}`, `c${i}@example.com`, now, now)));
		G.groups.push({ resourceName: "contactGroups/nc", name: "Novacane clients", groupType: "USER_CONTACT_GROUP" });
		const first = await syncContacts(genv(), budget());
		expect(first.more).toBe(true);
		expect(first.note).toMatch(/of 25 clients in Google so far · the rest next run/);
		let guard = 0;
		let last = first;
		while (last.more && guard++ < 5) last = await syncContacts(genv(), budget());
		expect(last.more).toBe(false);
		expect(last.note).toMatch(/^25 clients in Google Contacts/);
		const made = [...G.people.values()].filter((p) => /^Client /.test(p.names?.[0]?.unstructuredName || ""));
		expect(made).toHaveLength(25);
		// Only the label's people are read (in batches), never the whole Google account
		expect(G.calls.some((c) => c.includes("/people/me/connections"))).toBe(false);
		expect(G.batchGets).toBeGreaterThan(0);
	});

	it("Calendar: many events come in over a few runs, each within its trips to the database", async () => {
		for (let i = 0; i < 70; i++) {
			const day = String(1 + (i % 28)).padStart(2, "0");
			G.calendars.primary.set("m" + i, { id: "m" + i, seq: ++G.seq, status: "confirmed", summary: "Meeting " + i, start: { dateTime: `2026-11-${day}T09:00:00Z` }, end: { dateTime: `2026-11-${day}T10:00:00Z` }, updated: new Date().toISOString() });
		}
		const runs = [];
		let out;
		do {
			const b = { left: 40, db: 30 };
			out = await syncCalendar(genv(), b);
			expect(b.db).toBeGreaterThanOrEqual(0);
			runs.push(out);
		} while (out.more && runs.length < 10);
		expect(runs.length).toBeGreaterThan(1);
		expect(out.more).toBe(false);
		const { n } = await env.DB.prepare("SELECT COUNT(*) AS n FROM calendar_items WHERE id LIKE 'gp-m%' AND deleted = 0").first();
		expect(n).toBe(70);
		// Nothing sent back to Google as new events
		expect(G.calendars["studio-cal"].size).toBe(0);
	});

	it("Google busy: the part waits a while (longer each time) and the schedule leaves it alone till then", async () => {
		vi.restoreAllMocks();
		vi.spyOn(globalThis, "fetch").mockImplementation(async (input) => {
			const url = new URL(typeof input === "string" ? input : input.url);
			if (url.host === "oauth2.googleapis.com") return ok({ access_token: "access", expires_in: 3600 });
			return ok({ error: { message: "Backend Error" } }, 503);
		});
		forgetGoogleToken();
		const r = await runGooglePart(genv(), "calendar");
		expect(r.ok).toBe(false);
		const held = (await readBackoff(env)).calendar;
		expect(held.n).toBe(1);
		expect(held.until).toBeGreaterThan(Date.now());
		expect((await readStatus(env)).calendar.note).toMatch(/Next try/);
		// The next five-minute mark: left alone
		// (a five-minute mark that's only Calendar's, before the hold ends)
		let at = Math.floor(Date.now() / 300_000) * 300_000;
		while ([10, 20, 35, 50].includes(new Date(at).getUTCMinutes())) at -= 300_000;
		expect(await googleOnSchedule(genv(), at)).toMatchObject({ part: "calendar", held: true });
	});

	it("Google turns the connection down: Portal says Connect again, and it's mended by connecting", async () => {
		vi.restoreAllMocks();
		vi.spyOn(globalThis, "fetch").mockImplementation(async (input) => {
			const url = new URL(typeof input === "string" ? input : input.url);
			if (url.host === "oauth2.googleapis.com") return ok({ error: "invalid_grant" }, 400);
			return ok({});
		});
		forgetGoogleToken();
		const r = await runGooglePart(genv(), "calendar");
		expect(r.error).toMatch(/Connect again/);
		const overview = await (await call("/app/api/google")).json();
		expect(overview.needsReconnect).toBe(true);
		// Not held: waiting wouldn't mend it
		expect((await readBackoff(env)).calendar).toBeUndefined();
	});

	it("Sync now answers straight away and the sync finishes in the background", async () => {
		const res = await call("/app/api/google/sync", { method: "POST", body: { part: "calendar" } });
		const data = await res.json();
		expect(data).toMatchObject({ ok: true, started: true });
		// (call() waits for the background work too)
		const status = (await readStatus(env)).calendar;
		expect(status.running).toBeUndefined();
		expect(status.ok).toBe(true);
	});
});

describe("Google where it fits", () => {
	const mail = (id, from, subject, text, extraHeaders = [], labels = ["INBOX"]) => {
		const data = btoa(text).replace(/\+/g, "-").replace(/\//g, "_");
		const msg = { id, threadId: "th-" + id, labelIds: labels, internalDate: String(Date.now()), payload: { headers: [{ name: "From", value: from }, { name: "Subject", value: subject }, { name: "Message-ID", value: `<${id}@mail>` }, ...extraHeaders], mimeType: "text/plain", body: { data } } };
		G.messages.set(id, msg);
		return msg;
	};

	it("Gmail as the inbox: a customer's email becomes an enquiry (labelled Nova), automatic mail stays out, spam goes to Spam, Done archives it", async () => {
		mail("c1", "Kai Francis <kai@example.com>", "Session on Friday?", "Hi, can I book two hours on Friday afternoon for vocals?");
		mail("n1", "Studio Weekly <hello@studioweekly.com>", "This week's news", "Lots of news", [{ name: "List-Unsubscribe", value: "<https://x>" }]);
		mail("s1", "Stripe <noreply@stripe.com>", "Your receipt", "Paid £10");
		mail("x1", "Win Big <win@example.org>", "Claim your prize", "Congratulations you have won, click here http://a.b http://c.d http://e.f");
		const r = await runGooglePart(genv(), "inbox");
		expect(r.ok).toBe(true);
		const rows = (await env.DB.prepare("SELECT email, status, page FROM enquiries WHERE page = 'gmail' ORDER BY id").all()).results;
		expect(rows).toEqual([
			{ email: "kai@example.com", status: "new", page: "gmail" },
			{ email: "win@example.org", status: "spam", page: "gmail" },
		]);
		expect(G.labels.map((l) => l.name)).toEqual(["Nova"]);
		expect(G.modified.some((m) => m.what === "messages" && m.id === "c1" && m.addLabelIds?.length)).toBe(true);
		// Again: nothing twice
		await runGooglePart(genv(), "inbox");
		expect((await env.DB.prepare("SELECT COUNT(*) AS n FROM enquiries WHERE page = 'gmail'").first()).n).toBe(2);
		// Done in Enquiries: archived in Gmail
		await env.DB.prepare("UPDATE enquiries SET status = 'done' WHERE email = 'kai@example.com'").run();
		await runGooglePart(genv(), "inbox");
		expect(G.modified.some((m) => m.what === "threads" && m.id === "th-c1" && m.removeLabelIds?.includes("INBOX"))).toBe(true);
	});

	it("Google Meet: an event with Meet ticked gets a link, shown in Nova's Calendar", async () => {
		await saveItem(env, { kind: "event", id: "ev-meet", title: "Call with label", start: "2026-11-05T15:00", end: "2026-11-05T15:30", meet: true, updated: new Date().toISOString() });
		await syncCalendar(genv(), budget());
		const sent = [...G.calendars["studio-cal"].values()][0];
		expect(sent.conferenceData.createRequest.conferenceSolutionKey.type).toBe("hangoutsMeet");
		const row = await env.DB.prepare("SELECT data FROM calendar_items WHERE id = 'ev-meet'").first();
		expect(JSON.parse(row.data).meetUrl).toBe("https://meet.google.com/abc-defg-hij");
		// The next run: not sent again (the link doesn't count as a change)
		const before = G.calls.length;
		await syncCalendar(genv(), budget());
		expect(G.calls.slice(before).filter((c) => c.startsWith("PATCH") || c.startsWith("POST"))).toEqual([]);
	});

	it("Today: today's events (Nova's and Google's) for Portal, without Nova Agent's plan", async () => {
		const day = new Date().toLocaleDateString("en-CA", { timeZone: "Europe/London" });
		await saveItem(env, { kind: "event", id: "gp-today", title: "Dentist", author: "Google Calendar", start: `${day}T10:00`, end: `${day}T11:00`, updated: new Date().toISOString() });
		await saveItem(env, { kind: "event", id: "quest-x", title: "✦ Mix", start: `${day}T12:00`, end: `${day}T13:00`, updated: new Date().toISOString() });
		const data = await (await call("/app/api/google/today")).json();
		expect(data.events.map((e) => [e.title, e.start, e.from])).toEqual([["Dentist", "10:00", "Google Calendar"]]);
	});

	it("Google Tasks: quests become tasks, ticked off in Google comes back, removed in Nova goes", async () => {
		const sync = async (quests) => (await agent("/nova-agent/google/tasks/sync", { quests })).json();
		const first = await sync([{ id: "q1", title: "Mix the EP", due: "2026-11-01" }, { id: "q2", title: "Already done", done: true }]);
		expect(first.ok).toBe(true);
		expect([...G.tasks.values()].map((t) => [t.title, t.due, t.status])).toEqual([["Mix the EP", "2026-11-01T00:00:00.000Z", "needsAction"]]);
		[...G.tasks.values()][0].status = "completed";
		const second = await sync([{ id: "q1", title: "Mix the EP", due: "2026-11-01" }]);
		expect(second.completed).toEqual(["q1"]);
		await sync([]);
		expect(G.tasks.size).toBe(0);
	});

	it("Notes ⇄ Google Docs: kept in step both ways, and the older side kept as a copy when both changed", async () => {
		const now = new Date().toISOString();
		await env.DB.prepare("INSERT INTO shared_notes (id, title, html, meta, created_at, updated_at, created_by, rev, size) VALUES ('n1', 'Plan', '<p>One</p>', '{}', ?, ?, 'tuniveza', 1, 10)").bind(now, now).run();
		const kept = await (await call("/app/api/google/docs/keep", { method: "POST", body: { noteId: "n1" } })).json();
		expect(kept.kept).toBe(true);
		const docId = (await env.DB.prepare("SELECT google_id FROM google_links WHERE kind = 'notedoc' AND nova_id = 'n1'").first()).google_id;
		expect(G.files.get(docId).html).toContain("<p>One</p>");
		// Changed in the Doc: comes into the note
		Object.assign(G.files.get(docId), { html: '<p><span style="font-weight:700">Two</span></p>', modifiedTime: new Date(Date.now() + 60000).toISOString() });
		await runGooglePart(genv(), "docs");
		expect((await env.DB.prepare("SELECT html FROM shared_notes WHERE id = 'n1'").first()).html).toBe("<p><strong>Two</strong></p>");
		// Changed in Notes: goes to the Doc
		await env.DB.prepare("UPDATE shared_notes SET html = '<p>Three</p>', updated_at = ? WHERE id = 'n1'").bind(new Date(Date.now() + 120000).toISOString()).run();
		await runGooglePart(genv(), "docs");
		expect(G.files.get(docId).html).toContain("<p>Three</p>");
		// Both: the newer (Notes') wins and the Doc's version is kept as a copy in Drive
		const files = G.files.size;
		Object.assign(G.files.get(docId), { html: "<p>Doc four</p>", modifiedTime: new Date(Date.now() + 180000).toISOString() });
		await env.DB.prepare("UPDATE shared_notes SET html = '<p>Note four</p>', updated_at = ? WHERE id = 'n1'").bind(new Date(Date.now() + 240000).toISOString()).run();
		await runGooglePart(genv(), "docs");
		expect(G.files.get(docId).html).toContain("Note four");
		expect(G.files.size).toBe(files + 1);
	});

	it("Opens a Google Doc into Notes; one Nova can't change only comes in", async () => {
		G.files.set("1234567890abcdefghijklmnop", { id: "1234567890abcdefghijklmnop", name: "Lyrics", mimeType: "application/vnd.google-apps.document", html: "<p>Verse</p>", modifiedTime: "2026-10-01T00:00:00.000Z", readOnly: true });
		const out = await (await call("/app/api/google/docs/import", { method: "POST", body: { url: "https://docs.google.com/document/d/1234567890abcdefghijklmnop/edit" } })).json();
		expect(out).toMatchObject({ ok: true, oneWay: true });
		const note = await env.DB.prepare("SELECT title, html FROM shared_notes WHERE id = ?").bind(out.noteId).first();
		expect(note).toEqual({ title: "Lyrics", html: "<p>Verse</p>" });
	});

	it("Sent invoices are kept as Docs in Drive's Invoices folder", async () => {
		const now = new Date().toISOString();
		await env.DB.prepare(
			`INSERT INTO invoices (seq, token, bill_name, bill_email, bill_address, lines, vat_rate, subtotal_pence, vat_pence, total_pence, issue_date, due_date, status, created_by, created_at, updated_at)
			 VALUES (1, 'tok1', 'Kai Francis', 'kai@example.com', '', '[{"description":"Mixing","qty":1,"unit_pence":15000}]', 0, 15000, 0, 15000, '2026-10-12', '2026-10-26', 'sent', 'tuniveza', ?, ?)`
		).bind(now, now).run();
		const r = await runGooglePart(genv(), "files");
		expect(r.ok).toBe(true);
		const doc = [...G.files.values()].find((f) => /^Invoice NS-0001/.test(f.name || ""));
		expect(doc).toBeTruthy();
		expect(doc.html).toContain("Mixing");
	});

	it("YouTube: a video post goes up only after an admin's Approve, and its numbers come back", async () => {
		const bytes = new Uint8Array([0, 0, 0, 24, 102, 116, 121, 112, 1, 2, 3, 4]);
		const id = "c".repeat(32);
		await agent(`/nova-agent/google/drive/put?kind=media&id=${id}&name=clip.mp4&type=video%2Fmp4`, bytes, { "Content-Type": "video/mp4" });
		// A picture can't go to YouTube
		const bad = await call("/app/api/social", { method: "POST", body: { caption: "Hi", platforms: ["youtube"], media: [{ id: "d".repeat(32), ext: "jpg" }] } });
		expect(bad.status).toBe(400);
		const made = await (await call("/app/api/social", { method: "POST", body: { caption: "New single: Night Drive\nOut now everywhere #Shorts", platforms: ["youtube"], media: [{ id, ext: "mp4" }] } })).json();
		expect(G.uploads).toHaveLength(0);
		const approved = await (await call(`/app/api/social/${made.post.id}/approve`, { method: "POST", body: {} })).json();
		expect(G.uploads).toHaveLength(1);
		expect(G.uploads[0].meta.snippet.title).toBe("New single: Night Drive");
		expect(G.uploads[0].bytes).toBe(bytes.byteLength);
		expect(approved.post.status).toBe("posted");
		expect(approved.post.targets.youtube.url).toMatch(/^https:\/\/youtube\.com\/shorts\/vid/);
		const { refreshResults } = await import("../src/social.js");
		await refreshResults(genv());
		const row = await env.DB.prepare("SELECT stats FROM social_posts WHERE id = ?").bind(made.post.id).first();
		expect(JSON.parse(row.stats).youtube).toEqual({ views: 120, likes: 9, comments: 2 });
	});

	it("Import from contacts: a phone number finds the Google contact with it, with everything on its card", async () => {
		G.people.set("people/p7", {
			resourceName: "people/p7",
			names: [{ displayName: "Kemi Adeyemi" }],
			emailAddresses: [{ value: "Kemi@Example.com" }, { value: "kemi.music@example.com" }],
			phoneNumbers: [{ value: "+44 7700 900123" }, { value: "020 8291 3028" }],
			addresses: [{ formattedValue: "12 Station Road\nLondon SE23 3BA" }],
			organizations: [{ name: "Kemi Music", title: "Singer" }],
			birthdays: [{ date: { day: 4, month: 7 } }],
			biographies: [{ value: "Met at the open mic" }],
		});
		G.people.set("people/p8", { resourceName: "people/p8", names: [{ displayName: "Someone Else" }], phoneNumbers: [{ value: "+44 7700 900999" }] });
		// (typed the UK way; kept in Google the international way)
		const found = await (await call("/app/api/google/contacts/phone?phone=07700%20900123")).json();
		expect(found.contacts).toEqual([
			{ name: "Kemi Adeyemi", emails: ["kemi@example.com", "kemi.music@example.com"], phones: ["+44 7700 900123", "020 8291 3028"], addresses: ["12 Station Road London SE23 3BA"], organisation: "Kemi Music, Singer", birthday: "04/07", notes: "Met at the open mic" },
		]);
		expect((await (await call("/app/api/google/contacts/phone?phone=07700%20900555")).json()).contacts).toEqual([]);
		expect((await call("/app/api/google/contacts/phone?phone=123")).status).toBe(400);
	});

	it("Contacts search for the write forms, and Agent's read-only Drive, Docs, Tasks and YouTube", async () => {
		G.people.set("people/p9", { resourceName: "people/p9", names: [{ displayName: "Sam Venue" }], emailAddresses: [{ value: "sam@thewindmill.co.uk" }] });
		const found = await (await call("/app/api/google/contacts?q=windmill")).json();
		expect(found.contacts).toEqual([{ name: "Sam Venue", email: "sam@thewindmill.co.uk", phone: null }]);
		G.files.set("doc12345678901234567890", { id: "doc12345678901234567890", name: "Rider", mimeType: "application/vnd.google-apps.document", html: "<p>Two vocal mics</p>" });
		expect((await (await agent("/nova-agent/google/drive/search", { q: "Rider" })).json()).files[0]).toMatchObject({ name: "Rider", kind: "Google Doc" });
		expect((await (await agent("/nova-agent/google/doc/read", { id: "doc12345678901234567890" })).json()).text).toBe("Two vocal mics");
		const yt = await (await agent("/nova-agent/google/youtube/stats", {})).json();
		expect(yt.channel).toMatchObject({ subscribers: 321, videos: 14 });
		expect((await agent("/nova-agent/google/tasks/list", {})).status).toBe(200);
		// Without the permission: not available
		await env.DB.prepare("UPDATE settings SET value = 'https://www.googleapis.com/auth/calendar' WHERE key = 'google_scopes'").run();
		expect((await agent("/nova-agent/google/drive/search", { q: "Rider" })).status).toBe(409);
	});
});

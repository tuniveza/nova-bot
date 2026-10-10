// Booking changes through Acuity's API, proposed by an AI and approved by a person
// (src/acuity/api.js, src/booking-actions.js, the /nova-agent/acuity/* and /nova-agent/booking-actions
// routes, and Portal's /app/api/booking-actions). Nothing is written to Acuity unless an admin, signed in
// to Portal in a browser, pressed Approve.
import { createExecutionContext, env, waitOnExecutionContext } from "cloudflare:test";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import worker from "../src";
import { executeApproved } from "../src/booking-actions.js";
import { toLondonIso, ukWallToUtc } from "../src/acuity/api.js";
import { sha256 } from "../src/portal/auth.js";
import { BOOKING_PAGE_HTML } from "./acuity-page.js";
import { STAFF_COOKIE } from "./sign-in.js";

const BASE = "https://novacane-worker.test";
const API = "https://acuityscheduling.com/api/v1";
const KEY = "agent-nova-test-key";
const WEBHOOK_KEY = "test-webhook-key";

// ----- Days and times -----

// A UK day this many days from now ("YYYY-MM-DD")
const ukDay = (days) => new Date(Date.now() + days * 86400000).toLocaleDateString("en-CA", { timeZone: "Europe/London" });
// Acuity's own way of writing a time: the London clock with its offset ("2026-10-31T17:00:00+0000")
const acuityTime = (utcIso) => toLondonIso(utcIso).replace(/:(\d{2})$/, "$1");
const utc = (wall) => ukWallToUtc(wall).toISOString();

// ----- A fake Acuity API -----

let appointments; // id -> appointment (Acuity's shape)
let blocks; // id -> blocked time
let writes; // every POST, PUT or DELETE sent to Acuity: "METHOD /path?query" and its body
let calls; // every request to Acuity's API: "METHOD /path"
let scripted; // answers to give first, before the fake's own: [{ status, body, headers } | "network"]
let failWrites; // { status, body } to answer every write with
let claudeReplies;

function appointment(id, extra = {}) {
	const start = utc(`${ukDay(20)}T17:00`);
	return {
		id,
		firstName: "Dana",
		lastName: "Hollis",
		email: "dana@example.com",
		phone: "+447700900123",
		datetime: acuityTime(start),
		duration: "240",
		type: "Rap Package - 2 songs",
		appointmentTypeID: 555,
		price: "200.00",
		paid: "no",
		amountPaid: "0.00",
		notes: "",
		canceled: false,
		calendar: "Studio A",
		calendarID: 7,
		...extra,
	};
}

const reply = (data, status = 200, headers = {}) => new Response(JSON.stringify(data), { status, headers: { "Content-Type": "application/json", ...headers } });

beforeEach(async () => {
	await env.DB.batch([env.DB.prepare("DELETE FROM booking_actions"), env.DB.prepare("DELETE FROM settings"), env.DB.prepare("DELETE FROM agent_jobs")]);
	appointments = new Map([
		[1001, appointment(1001)],
		[1002, appointment(1002, { firstName: "Kai", lastName: "Fenwick", email: "kai@example.com" })],
		[1003, appointment(1003, { firstName: "Old", lastName: "Booking", canceled: true })],
	]);
	const blockStart = utc(`${ukDay(21)}T10:00`);
	blocks = new Map([[88, { id: 88, calendarID: 7, calendar: "Studio A", start: acuityTime(blockStart), end: acuityTime(new Date(Date.parse(blockStart) + 4 * 3600000).toISOString()), notes: "Maintenance" }]]);
	writes = [];
	calls = [];
	scripted = [];
	failWrites = null;
	claudeReplies = [];
	vi.spyOn(globalThis, "fetch").mockImplementation(async (url, init = {}) => {
		const u = new URL(String(url));
		if (u.pathname === "/schedule.php") return new Response(BOOKING_PAGE_HTML);
		if (String(url) === "https://api.anthropic.com/v1/messages") {
			return reply(claudeReplies.shift() || { stop_reason: "end_turn", content: [{ type: "text", text: "Done." }] });
		}
		if (!String(url).startsWith(API)) return reply({ error: "not_found" }, 404);
		expect(init.headers.Authorization).toBe("Basic " + btoa("12345:test-acuity-key"));
		const method = init.method || "GET";
		const path = u.pathname.slice("/api/v1".length);
		calls.push(`${method} ${path}`);
		if (scripted.length) {
			const next = scripted.shift();
			if (next === "network") throw new TypeError("Network connection lost.");
			return reply(next.body ?? {}, next.status, next.headers);
		}
		if (method !== "GET") {
			writes.push({ call: `${method} ${path}${u.search}`, body: init.body ? JSON.parse(init.body) : null });
			if (failWrites) return reply(failWrites.body, failWrites.status);
			if (path === "/appointments") return reply({ id: 2001 });
			if (path === "/blocks") return reply({ id: 89 });
			return reply({});
		}
		const one = path.match(/^\/appointments\/(\d+)$/);
		if (one) return appointments.has(Number(one[1])) ? reply(appointments.get(Number(one[1]))) : reply({ status_code: 404, error: "not_found" }, 404);
		if (path === "/appointments") {
			const from = u.searchParams.get("minDate");
			const to = u.searchParams.get("maxDate");
			const all = u.searchParams.get("showall") === "true";
			const day = (a) => new Date(Date.parse(a.datetime.replace(/(\d{2})(\d{2})$/, "$1:$2"))).toLocaleDateString("en-CA", { timeZone: "Europe/London" });
			return reply([...appointments.values()].filter((a) => (all || !a.canceled) && day(a) >= from && day(a) <= to));
		}
		const block = path.match(/^\/blocks\/(\d+)$/);
		if (block) return blocks.has(Number(block[1])) ? reply(blocks.get(Number(block[1]))) : reply({ status_code: 404, error: "not_found" }, 404);
		if (path === "/blocks") return reply([...blocks.values()]);
		if (path === "/appointment-types") return reply([{ id: 555, name: "Rap Package - 2 songs", price: "200.00", duration: 240, active: true, private: false }]);
		if (path === "/calendars") return reply([{ id: 7, name: "Studio A" }]);
		if (path === "/availability/times") return reply([{ time: acuityTime(utc(`${u.searchParams.get("date")}T14:00`)), slotsAvailable: 1 }]);
		if (path === "/clients") return reply([{ firstName: "Dana", lastName: "Hollis", email: "dana@example.com", phone: "+447700900123", notes: "" }]);
		return reply({ status_code: 404, error: "not_found" }, 404);
	});
});

afterEach(() => {
	vi.restoreAllMocks();
});

// ----- Calling the Worker -----

async function call(request, extraEnv = {}) {
	const ctx = createExecutionContext();
	const res = await worker.fetch(request, { ...env, AGENT_NOVA_KEY: KEY, ...extraEnv }, ctx);
	await waitOnExecutionContext(ctx);
	return { status: res.status, data: await res.json().catch(() => null) };
}

// Nova Agent (the agent's key)
const agent = (path, body = {}) =>
	call(new Request(BASE + path, { method: "POST", headers: { "Content-Type": "application/json", Authorization: `Bearer ${KEY}` }, body: JSON.stringify(body) }));

// Portal (a browser signed in as the test admin, unless other headers are given)
function portal(route, { body, headers = { Cookie: STAFF_COOKIE } } = {}) {
	const init = body === undefined ? { headers } : { method: "POST", headers: { "Content-Type": "application/json", Origin: BASE, ...headers }, body: JSON.stringify(body) };
	return call(new Request(`${BASE}/app/api/${route}`, init));
}

const row = (id) => env.DB.prepare("SELECT status, payload, summary, decided_by, started_at FROM booking_actions WHERE id = ?").bind(id).first();

async function proposeMove(start = `${ukDay(22)}T14:00`) {
	const { status, data } = await agent("/nova-agent/booking-actions/propose", { kind: "reschedule", payload: { appointmentId: 1001, start }, reason: "Dana asked to move" });
	expect(status).toBe(200);
	return data.action;
}

// A second Portal person who isn't an admin, and the admin signed in through an app (a token, not the cookie)
async function otherSignIns() {
	const now = new Date().toISOString();
	const later = new Date(Date.now() + 86_400_000).toISOString();
	await env.DB.batch([
		env.DB.prepare(
			"INSERT OR IGNORE INTO staff (id, email, password_hash, display_name, role, status, created_at, planet_seed, index_partition) VALUES ('test-staff', 'test-staff@novacane.test', NULL, 'Test Staff', 'staff', 'active', ?, 'test-staff', 'staff:test-staff')"
		).bind(now),
		env.DB.prepare("INSERT OR REPLACE INTO sessions (id, staff_id, kind, created_at, expires_at, last_seen_at) VALUES (?, 'test-staff', 'cookie', ?, ?, ?)").bind(
			await sha256("test-staff-session"),
			now,
			later,
			now
		),
		env.DB.prepare("INSERT OR REPLACE INTO sessions (id, staff_id, kind, created_at, expires_at, last_seen_at) VALUES (?, 'test-admin', 'token', ?, ?, ?)").bind(
			await sha256("nsess_test-admin-app"),
			now,
			later,
			now
		),
	]);
	return { staff: { Cookie: "nova_session=test-staff-session" }, adminToken: { Authorization: "Bearer nsess_test-admin-app" } };
}

// ----- UK time -----

describe("UK time", () => {
	it("turns a UK wall clock into UTC, in summer (BST) and winter (GMT), and back for Acuity", () => {
		expect(ukWallToUtc("2026-10-24T17:00").toISOString()).toBe("2026-10-24T16:00:00.000Z");
		expect(ukWallToUtc("2026-11-04T14:00").toISOString()).toBe("2026-11-04T14:00:00.000Z");
		expect(toLondonIso("2026-10-24T16:00:00.000Z")).toBe("2026-10-24T17:00:00+01:00");
		expect(toLondonIso("2026-11-04T14:00:00.000Z")).toBe("2026-11-04T14:00:00+00:00");
		// 01:30 on the morning the clocks go forward never happens
		expect(ukWallToUtc("2027-03-28T01:30")).toBeNull();
	});
});

// ----- (f) Reading Acuity -----

describe("Nova Agent reading Acuity", () => {
	it("lists a week of bookings through the API, with times in UTC", async () => {
		appointments = new Map([
			[1, appointment(1, { datetime: "2026-10-24T17:00:00+0100", duration: "120" })], // BST
			[2, appointment(2, { datetime: "2026-10-26T09:30:00+0000", duration: "60", firstName: "Kai", lastName: "Fenwick" })], // GMT
			[3, appointment(3, { datetime: "2026-11-09T09:30:00+0000" })], // outside the week
		]);
		const { status, data } = await agent("/nova-agent/acuity/appointments", { from: "2026-10-24", to: "2026-10-30" });
		expect(status).toBe(200);
		expect(calls).toEqual(["GET /appointments"]);
		expect(data.appointments).toEqual([
			{
				id: 1, start: "2026-10-24T16:00:00.000Z", end: "2026-10-24T18:00:00.000Z", type: "Rap Package - 2 songs", typeId: 555, name: "Dana Hollis",
				email: "dana@example.com", phone: "+447700900123", price: "200.00", paid: false, amountPaid: "0.00", notes: "", canceled: false, calendar: "Studio A", calendarId: 7,
			},
			expect.objectContaining({ id: 2, start: "2026-10-26T09:30:00.000Z", end: "2026-10-26T10:30:00.000Z", name: "Kai Fenwick" }),
		]);
	});

	it("reads free times, blocked times, session types and clients", async () => {
		const day = "2026-11-04";
		expect((await agent("/nova-agent/acuity/availability", { typeId: 555, date: day })).data).toEqual({ times: [{ start: "2026-11-04T14:00:00.000Z", label: "14:00" }] });
		const blocked = (await agent("/nova-agent/acuity/blocks", { from: ukDay(0), to: ukDay(30) })).data.blocks;
		expect(blocked).toEqual([expect.objectContaining({ id: 88, notes: "Maintenance", calendarId: 7 })]);
		expect(blocked[0].start).toMatch(/Z$/);
		expect((await agent("/nova-agent/acuity/types", {})).data.types).toEqual([{ id: 555, name: "Rap Package - 2 songs", price: "200.00", duration: 240, active: true, private: false }]);
		expect((await agent("/nova-agent/acuity/clients", { search: "dana" })).data.clients).toHaveLength(1);
		expect(writes).toHaveLength(0);
	});

	it("turns bad input away", async () => {
		expect((await agent("/nova-agent/acuity/appointments", { from: "2026-10-24" })).status).toBe(400);
		expect((await agent("/nova-agent/acuity/appointments", { from: "2026-10-30", to: "2026-10-24" })).status).toBe(400);
		expect((await agent("/nova-agent/acuity/appointments", { from: "2026-01-01", to: "2026-06-01" })).status).toBe(400);
		expect(calls).toHaveLength(0);
	});

	it("needs the agent's key", async () => {
		const res = await call(new Request(BASE + "/nova-agent/acuity/types", { method: "POST", body: "{}" }));
		expect(res.status).toBe(401);
	});
});

// ----- (g) Acuity busy or down -----

describe("when Acuity is busy or down", () => {
	it("waits and tries again after a 429, then answers", async () => {
		scripted = [{ status: 429, body: { error: "too_many_requests" }, headers: { "Retry-After": "0" } }];
		const { status, data } = await agent("/nova-agent/acuity/types", {});
		expect(status).toBe(200);
		expect(data.types).toHaveLength(1);
		expect(calls).toEqual(["GET /appointment-types", "GET /appointment-types"]);
	});

	it("still busy after two retries: 429 with rateLimited", async () => {
		scripted = [0, 1, 2].map(() => ({ status: 429, body: {}, headers: { "Retry-After": "0" } }));
		const { status, data } = await agent("/nova-agent/acuity/types", {});
		expect(status).toBe(429);
		expect(data).toEqual({ error: "Acuity is busy right now (too many requests). Try again in a minute.", rateLimited: true });
		expect(calls).toHaveLength(3);
	});

	it("down (5xx after one retry, or no connection): 503 with unreachable", async () => {
		scripted = [{ status: 503 }, { status: 502 }];
		const down = await agent("/nova-agent/acuity/appointments", { from: "2026-10-24", to: "2026-10-30" });
		expect(down.status).toBe(503);
		expect(down.data.unreachable).toBe(true);
		expect(down.data.error).toMatch(/^Acuity unreachable: /);
		expect(calls).toHaveLength(2);

		scripted = ["network", "network"];
		const offline = await agent("/nova-agent/acuity/types", {});
		expect(offline.status).toBe(503);
		expect(offline.data.unreachable).toBe(true);
	});

	it("a 5xx once, then fine: answers", async () => {
		scripted = [{ status: 500 }];
		expect((await agent("/nova-agent/acuity/types", {})).status).toBe(200);
	});

	it("not set up: 409", async () => {
		const res = await call(
			new Request(BASE + "/nova-agent/acuity/types", { method: "POST", headers: { Authorization: `Bearer ${KEY}` }, body: "{}" }),
			{ ACUITY_API_KEY: "" }
		);
		expect(res.status).toBe(409);
		expect(calls).toHaveLength(0);
	});
});

// ----- (a) Proposing never changes anything -----

describe("proposing (the AI's only power)", () => {
	it("a proposed move can't happen without approval: nothing is written to Acuity by any agent-key route", async () => {
		const start = `${ukDay(22)}T14:00`;
		// A summary or status from the proposer is ignored
		const { status, data } = await agent("/nova-agent/booking-actions/propose", {
			kind: "reschedule",
			payload: { appointmentId: 1001, start, summary: "Nothing to see" },
			reason: "Dana asked to move",
			summary: "Totally harmless",
			status: "approved",
		});
		expect(status).toBe(200);
		const action = data.action;
		expect(action).toMatchObject({ kind: "reschedule", status: "pending", proposedBy: "agent", reason: "Dana asked to move", payload: { appointmentId: 1001, start: utc(start), notifyClient: true } });
		expect(action.summary).toMatch(/^Move Dana Hollis's Rap Package - 2 songs from .+ 17:00 to .+ 14:00 \(Acuity emails the client\)$/);
		expect(action.portalUrl).toBe(`${BASE}/portal/?view=approvals&action=${action.id}`);

		// Everything the agent's key can reach, including made-up approve / execute routes
		expect((await agent("/nova-agent/booking-actions", {})).data.actions.map((a) => a.id)).toEqual([action.id]);
		expect((await agent("/nova-agent/booking-actions", { status: "all" })).status).toBe(200);
		for (const path of ["approve", "execute", "edit", "reject", String(action.id), `${action.id}/approve`]) {
			expect((await agent(`/nova-agent/booking-actions/${path}`, { id: action.id, payload: { appointmentId: 1001, start } })).status).toBe(404);
		}
		await agent("/nova-agent/acuity/appointments", { from: ukDay(0), to: ukDay(30) });
		await agent("/nova-agent/next", { wait: 0, bookingsSeen: "" });
		// Proposing the same thing again hands back the same one
		expect((await agent("/nova-agent/booking-actions/propose", { kind: "reschedule", payload: { appointmentId: 1001, start } })).data.action.id).toBe(action.id);

		expect((await row(action.id)).status).toBe("pending");
		expect(writes).toHaveLength(0);
		// And even the executor itself does nothing with a pending one
		expect((await executeApproved(env, action.id)).status).toBe("pending");
		expect(writes).toHaveLength(0);
	});

	it("checks every kind against Acuity and writes its own summary", async () => {
		const start = `${ukDay(23)}T11:00`;
		const ok = async (kind, payload) => {
			const res = await agent("/nova-agent/booking-actions/propose", { kind, payload });
			expect(res.status, JSON.stringify(res.data)).toBe(200);
			return res.data.action.summary;
		};
		expect(await ok("create", { typeId: 555, start, firstName: "Sam", lastName: "Singer", email: "Sam@Example.com", notifyClient: false })).toMatch(
			/^Book Sam Singer \(sam@example.com\) for Rap Package - 2 songs on .+ 11:00–15:00 \(no email to the client\)$/
		);
		expect(await ok("cancel", { appointmentId: 1002, note: "Studio closed" })).toMatch(/^Cancel Kai Fenwick's Rap Package - 2 songs on .+ \(Acuity emails the client, with the note "Studio closed"\)$/);
		expect(await ok("update", { appointmentId: 1001, phone: "07700 900789", email: "dana@example.com" })).toMatch(/: phone "\+447700900123" → "07700 900789"$/);
		expect(await ok("block_add", { start, end: `${ukDay(23)}T13:00`, calendarId: 7, notes: "Mic service" })).toMatch(/^Block off .+ 11:00–13:00 in Studio A \("Mic service"\)$/);
		expect(await ok("block_remove", { blockId: 88 })).toMatch(/^Remove the blocked-off time .+ 10:00–14:00 \("Maintenance"\)$/);

		const bad = async (kind, payload) => (await agent("/nova-agent/booking-actions/propose", { kind, payload })).status;
		expect(await bad("delete_everything", {})).toBe(400);
		expect(await bad("reschedule", { appointmentId: 1003, start })).toBe(400); // already cancelled
		expect(await bad("reschedule", { appointmentId: 9999, start })).toBe(400);
		expect(await bad("reschedule", { appointmentId: 1001, start: "2020-01-01T10:00" })).toBe(400); // past
		expect(await bad("reschedule", { appointmentId: 1001, start: "tomorrow at 2" })).toBe(400);
		expect(await bad("create", { typeId: 999, start, firstName: "A", lastName: "B", email: "a@b.co" })).toBe(400);
		expect(await bad("update", { appointmentId: 1001, phone: "+447700900123" })).toBe(400); // nothing changes
		expect(await bad("block_add", { start, end: start })).toBe(400);
		expect(await bad("block_remove", { blockId: 77 })).toBe(400);
		expect(writes).toHaveLength(0);
	});

	it("Acuity down while proposing: 503, nothing saved", async () => {
		scripted = [{ status: 500 }, { status: 500 }];
		const res = await agent("/nova-agent/booking-actions/propose", { kind: "cancel", payload: { appointmentId: 1001 } });
		expect(res.status).toBe(503);
		expect(res.data.unreachable).toBe(true);
		expect((await env.DB.prepare("SELECT COUNT(*) AS n FROM booking_actions").first()).n).toBe(0);
	});
});

// ----- Portal: who can decide -----

describe("Portal approvals", () => {
	it("any staff can see them; only an admin in a browser can decide (b)", async () => {
		const action = await proposeMove();
		const { staff, adminToken } = await otherSignIns();

		const seen = await portal("booking-actions", { headers: staff });
		expect(seen.status).toBe(200);
		expect(seen.data.canDecide).toBe(false);
		expect(seen.data.actions.map((a) => a.id)).toEqual([action.id]);
		expect((await portal("booking-actions", { headers: adminToken })).data.canDecide).toBe(false);
		expect((await portal("booking-actions")).data.canDecide).toBe(true);

		for (const headers of [staff, adminToken]) {
			expect((await portal("booking-actions/approve", { body: { id: action.id }, headers })).status).toBe(403);
			expect((await portal("booking-actions/edit", { body: { id: action.id, payload: { appointmentId: 1001, start: `${ukDay(24)}T10:00` } }, headers })).status).toBe(403);
			expect((await portal("booking-actions/reject", { body: { id: action.id }, headers })).status).toBe(403);
		}
		// Not signed in, or another website
		expect((await portal("booking-actions/approve", { body: { id: action.id }, headers: {} })).status).toBe(401);
		expect((await portal("booking-actions/approve", { body: { id: action.id }, headers: { Cookie: STAFF_COOKIE, Origin: "https://evil.example" } })).status).toBe(403);

		expect((await row(action.id)).status).toBe("pending");
		expect(writes).toHaveLength(0);
	});

	it("an admin's approve makes the change in Acuity, with the UK offset", async () => {
		const start = `${ukDay(22)}T14:00`;
		const action = await proposeMove(start);
		const { status, data } = await portal("booking-actions/approve", { body: { id: action.id } });
		expect(status).toBe(200);
		expect(data.action).toMatchObject({ status: "executed", decidedBy: "test-admin", decidedByName: "Test Admin", result: { appointmentId: 1001 }, error: null });
		expect(data.action.executedAt).toBeTruthy();
		expect(writes).toEqual([{ call: "PUT /appointments/1001/reschedule?admin=true", body: { datetime: toLondonIso(utc(start)) } }]);
		expect(writes[0].body.datetime).toMatch(/^\d{4}-\d{2}-\d{2}T14:00:00\+0[01]:00$/);
		// Nova Agent hears the bookings changed
		expect((await agent("/nova-agent/next", { wait: 0 })).data.bookingsChanged).toBeTruthy();
	});

	it("edit keeps it pending with a new summary; approve can carry the edited details", async () => {
		const action = await proposeMove(`${ukDay(22)}T14:00`);
		const edited = await portal("booking-actions/edit", { body: { id: action.id, payload: { appointmentId: 1001, start: `${ukDay(22)}T16:00`, notifyClient: false } } });
		expect(edited.status).toBe(200);
		expect(edited.data.action.status).toBe("pending");
		expect(edited.data.action.summary).toMatch(/ to .+ 16:00 \(no email to the client\)$/);
		expect(writes).toHaveLength(0);

		const approved = await portal("booking-actions/approve", { body: { id: action.id, payload: { appointmentId: 1001, start: `${ukDay(22)}T15:00`, notifyClient: false } } });
		expect(approved.data.action.status).toBe("executed");
		expect(approved.data.action.summary).toMatch(/ to .+ 15:00 \(no email to the client\)$/);
		expect(writes).toEqual([{ call: "PUT /appointments/1001/reschedule?admin=true&noEmail=true", body: { datetime: toLondonIso(utc(`${ukDay(22)}T15:00`)) } }]);
	});

	it("two presses at once: carried out exactly once (c)", async () => {
		const action = await proposeMove();
		const [a, b] = await Promise.all([portal("booking-actions/approve", { body: { id: action.id } }), portal("booking-actions/approve", { body: { id: action.id } })]);
		expect(a.status).toBe(200);
		expect(b.status).toBe(200);
		expect(writes).toHaveLength(1);
		expect((await row(action.id)).status).toBe("executed");
		// And again later: still once
		expect((await portal("booking-actions/approve", { body: { id: action.id } })).data.repeated).toBe(true);
		expect(await executeApproved(env, action.id)).toMatchObject({ status: "executed" });
		expect(writes).toHaveLength(1);
	});

	it("reject never carries it out (d)", async () => {
		const action = await proposeMove();
		const rejected = await portal("booking-actions/reject", { body: { id: action.id, note: "She changed her mind" } });
		expect(rejected.data.action).toMatchObject({ status: "rejected", decidedBy: "test-admin", note: "She changed her mind" });
		// Approving (or editing) afterwards does nothing
		expect((await portal("booking-actions/approve", { body: { id: action.id } })).data.action.status).toBe("rejected");
		expect((await portal("booking-actions/edit", { body: { id: action.id, payload: { appointmentId: 1001, start: `${ukDay(24)}T10:00` } } })).status).toBe(409);
		expect((await portal("booking-actions/reject", { body: { id: action.id } })).status).toBe(409);
		expect(await executeApproved(env, action.id)).toMatchObject({ status: "rejected" });
		expect(writes).toHaveLength(0);
	});

	it("each kind, once approved, sends the right request; Acuity saying no marks it failed", async () => {
		const start = `${ukDay(23)}T11:00`;
		const approve = async (kind, payload) => {
			const { data } = await agent("/nova-agent/booking-actions/propose", { kind, payload });
			return (await portal("booking-actions/approve", { body: { id: data.action.id } })).data.action;
		};
		expect((await approve("create", { typeId: 555, start, firstName: "Sam", lastName: "Singer", email: "sam@example.com", phone: "07700 900123" })).result).toEqual({ appointmentId: 2001 });
		expect(await approve("cancel", { appointmentId: 1002, notifyClient: false, note: "Closed" })).toMatchObject({ status: "executed" });
		expect(await approve("update", { appointmentId: 1001, notes: "Bringing a guitarist" })).toMatchObject({ status: "executed" });
		expect((await approve("block_add", { start, end: `${ukDay(23)}T13:00` })).result).toEqual({ blockId: 89, calendarId: 7 });
		expect(await approve("block_remove", { blockId: 88 })).toMatchObject({ status: "executed" });
		expect(writes.map((w) => w.call)).toEqual([
			"POST /appointments?admin=true",
			"PUT /appointments/1002/cancel?admin=true&noEmail=true",
			"PUT /appointments/1001?admin=true",
			"POST /blocks",
			"DELETE /blocks/88",
		]);
		expect(writes[0].body).toEqual({ appointmentTypeID: 555, datetime: toLondonIso(utc(start)), firstName: "Sam", lastName: "Singer", email: "sam@example.com", phone: "07700 900123" });
		expect(writes[1].body).toEqual({ cancelNote: "Closed" });
		expect(writes[2].body).toEqual({ notes: "Bringing a guitarist" });
		expect(writes[3].body).toEqual({ start: toLondonIso(utc(start)), end: toLondonIso(utc(`${ukDay(23)}T13:00`)), calendarID: 7 });

		failWrites = { status: 400, body: { status_code: 400, error: "not_available", message: "The time is not available" } };
		const failed = await approve("reschedule", { appointmentId: 1001, start: `${ukDay(25)}T09:00` });
		expect(failed).toMatchObject({ status: "failed", error: 'Acuity said "The time is not available".' });
	});
});

// ----- (e) Portal's staff chat only proposes -----

describe("Portal's staff chat", () => {
	it("cancel, reschedule and update from the chat only propose; nothing is written to Acuity", async () => {
		claudeReplies = [
			{ stop_reason: "tool_use", content: [{ type: "tool_use", id: "t1", name: "cancel_booking", input: { appointment_id: 1001, notify_client: true, confirmed: true } }] },
			{ stop_reason: "tool_use", content: [{ type: "tool_use", id: "t2", name: "reschedule_booking", input: { appointment_id: 1002, date: ukDay(22), time: "14:00", notify_client: true, confirmed: true } }] },
			{ stop_reason: "tool_use", content: [{ type: "tool_use", id: "t3", name: "update_booking", input: { appointment_id: 1002, phone: "07700 900555", confirmed: true } }] },
			{ stop_reason: "end_turn", content: [{ type: "text", text: "Proposed: an admin approves them in Portal." }] },
		];
		const res = await portal("chat", { body: { messages: [{ role: "user", content: "Cancel Dana, move Kai to 2pm, and fix Kai's phone. Yes, do it." }] } });
		expect(res.status).toBe(200);
		const { results } = await env.DB.prepare("SELECT kind, status, proposed_by FROM booking_actions ORDER BY id").all();
		expect(results).toEqual([
			{ kind: "cancel", status: "pending", proposed_by: "staff-chat" },
			{ kind: "reschedule", status: "pending", proposed_by: "staff-chat" },
			{ kind: "update", status: "pending", proposed_by: "staff-chat" },
		]);
		expect(writes).toHaveLength(0);
	});
});

// ----- (h) Acuity's webhook and Nova Agent's /next -----

describe("bookings changed", () => {
	const webhook = (action = "rescheduled", id = 1001) =>
		call(
			new Request(`${BASE}/acuity/webhook?key=${WEBHOOK_KEY}`, { method: "POST", headers: { "Content-Type": "application/x-www-form-urlencoded" }, body: `action=${action}&id=${id}&calendarID=7&appointmentTypeID=555` }),
			{ ACUITY_WEBHOOK_KEY: WEBHOOK_KEY }
		).catch(() => null);

	it("the webhook sets bookingsChanged, and /next hands it over", async () => {
		expect((await agent("/nova-agent/next", { wait: 0, bookingsSeen: "" })).data.bookingsChanged).toBeNull();
		const before = new Date().toISOString();
		await webhook();
		const changed = (await agent("/nova-agent/next", { wait: 0 })).data.bookingsChanged;
		expect(changed >= before).toBe(true);
	});

	it("/next returns early when bookingsChanged is newer than bookingsSeen, and waits when it isn't", async () => {
		const seen = new Date(Date.now() - 60000).toISOString();
		await webhook();
		let started = Date.now();
		const early = await agent("/nova-agent/next", { wait: 5, bookingsSeen: seen });
		expect(Date.now() - started).toBeLessThan(2000);
		expect(early.data.job).toBeNull();
		expect(Date.parse(early.data.bookingsChanged)).toBeGreaterThan(Date.parse(seen));

		// Already seen: it waits the whole time
		started = Date.now();
		await agent("/nova-agent/next", { wait: 1, bookingsSeen: early.data.bookingsChanged });
		expect(Date.now() - started).toBeGreaterThanOrEqual(900);

		// An older Nova Agent that never sends bookingsSeen: waits as before
		started = Date.now();
		await agent("/nova-agent/next", { wait: 1 });
		expect(Date.now() - started).toBeGreaterThanOrEqual(900);

		// A webhook while it waits ends the wait
		started = Date.now();
		setTimeout(() => void webhook("canceled", 1002), 300);
		const woken = await agent("/nova-agent/next", { wait: 5, bookingsSeen: early.data.bookingsChanged });
		expect(Date.now() - started).toBeLessThan(3000);
		expect(Date.parse(woken.data.bookingsChanged)).toBeGreaterThan(Date.parse(early.data.bookingsChanged));
	});
});

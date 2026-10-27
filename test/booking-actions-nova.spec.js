// Booking changes proposed by an AI and approved by a person, for Nova's own booking system
// (src/booking-actions.js keeps the queue; src/nova/booking-changes.js checks and makes each change;
// the /nova-agent/booking-actions and /nova-agent/bookings/* routes, and Portal's /app/api/booking-actions).
// Nothing changes a booking, the calendar, an email or a payment unless an admin, signed in to Portal
// in a browser, pressed Approve.
import { createExecutionContext, env, waitOnExecutionContext } from "cloudflare:test";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import worker from "../src";
import { executeApproved, getAction } from "../src/booking-actions.js";
import { bookSession } from "../src/nova/book-session.js";
import { getBooking, paymentReceived } from "../src/nova/bookings.js";
import { sha256 } from "../src/portal/auth.js";
import { readTime, ukShort, ukWallToUtc } from "../src/uk-time.js";
import { STAFF_COOKIE } from "./sign-in.js";
import { BASE, clearTables, connectGoogle, installFakes, ukDay, ukEvent } from "./fakes.js";

const KEY = "agent-nova-test-key";
const RAP_2 = 64806309; // £200, deposit £100, 4 hours
const VOICE_1H = 12738216; // £80, 1 hour
const utc = (wall) => ukWallToUtc(wall).toISOString();

let fakes;
beforeEach(async () => {
	await clearTables();
	await env.DB.prepare("DELETE FROM agent_jobs").run();
	fakes = installFakes();
	await connectGoogle();
});
afterEach(() => vi.restoreAllMocks());

async function call(request, extraEnv = {}) {
	const ctx = createExecutionContext();
	const res = await worker.fetch(request, { ...env, AGENT_NOVA_KEY: KEY, ...extraEnv }, ctx);
	await waitOnExecutionContext(ctx);
	return { status: res.status, data: await res.json().catch(() => null) };
}
// Nova Agent (the agent's key)
const agent = (path, body = {}) => call(new Request(BASE + path, { method: "POST", headers: { "Content-Type": "application/json", Authorization: `Bearer ${KEY}` }, body: JSON.stringify(body) }));
// Portal (a browser signed in as the test admin, unless other headers are given)
function portal(route, { body, headers = { Cookie: STAFF_COOKIE } } = {}) {
	const init = body === undefined ? { headers } : { method: "POST", headers: { "Content-Type": "application/json", Origin: BASE, ...headers }, body: JSON.stringify(body) };
	return call(new Request(`${BASE}/app/api/${route}`, init));
}
const row = (id) => env.DB.prepare("SELECT status, payload, summary FROM booking_actions WHERE id = ?").bind(id).first();
const stripeCalls = () => fetch.mock.calls.filter(([url]) => String(url).startsWith("https://api.stripe.com"));

// A booking made by staff (in the calendar, deposit link emailed); `paid` pence paid online
async function makeBooking({ day = ukDay(20), time = "14:00", type = RAP_2, first = "Dana", last = "Hollis", email = "dana@example.com", paid = 0 } = {}) {
	const out = await bookSession(env, { session_type_id: type, date: day, time, first_name: first, last_name: last, email, phone: "07700 900111" }, { ip: "staff", staff: true });
	expect(out.ok).toBe(true);
	if (paid) await paymentReceived(env, { bookingId: out.booked.id, amountPence: paid, stripeId: `pi_${out.booked.id}_${paid}`, purpose: "deposit" });
	fakes.google.emails.length = 0;
	fakes.push.length = 0;
	return getBooking(env, out.booked.id);
}

async function propose(kind, payload, reason = "Asked for") {
	const { status, data } = await agent("/nova-agent/booking-actions/propose", { kind, payload, reason });
	expect(data.error).toBeUndefined();
	expect(status).toBe(200);
	return data.action;
}
const approve = async (id, payload) => (await portal("booking-actions/approve", { body: payload ? { id, payload } : { id } })).data.action;

// A second Portal person who isn't an admin, and the admin signed in through an app (a token, not the cookie)
async function otherSignIns() {
	const now = new Date().toISOString();
	const later = new Date(Date.now() + 86_400_000).toISOString();
	await env.DB.batch([
		env.DB.prepare(
			"INSERT OR IGNORE INTO staff (id, email, password_hash, display_name, role, status, created_at, planet_seed, index_partition) VALUES ('test-staff', 'test-staff@novacane.test', NULL, 'Test Staff', 'staff', 'active', ?, 'test-staff', 'staff:test-staff')"
		).bind(now),
		env.DB.prepare("INSERT OR REPLACE INTO sessions (id, staff_id, kind, created_at, expires_at, last_seen_at) VALUES (?, 'test-staff', 'cookie', ?, ?, ?)").bind(await sha256("test-staff-session"), now, later, now),
		env.DB.prepare("INSERT OR REPLACE INTO sessions (id, staff_id, kind, created_at, expires_at, last_seen_at) VALUES (?, 'test-admin', 'token', ?, ?, ?)").bind(await sha256("nsess_test-admin-app"), now, later, now),
	]);
	return { staff: { Cookie: "nova_session=test-staff-session" }, adminToken: { Authorization: "Bearer nsess_test-admin-app" } };
}

describe("Nova Agent reading the diary (read only)", () => {
	it("lists bookings with times in UTC, free times, blocked times, session types and clients", async () => {
		const b = await makeBooking({ paid: 10000 });
		fakes.google.add(ukEvent(ukDay(21), "10:00", "12:00", { summary: "Maintenance" }));
		const list = await agent("/nova-agent/bookings/appointments", { from: ukDay(19), to: ukDay(21) });
		expect(list.status).toBe(200);
		expect(list.data.appointments).toEqual([
			expect.objectContaining({ id: b.id, start: b.starts_at, end: b.ends_at, type: b.session, typeId: RAP_2, name: "Dana Hollis", email: "dana@example.com", price: "200.00", amountPaid: "100.00", paid: false, canceled: false }),
		]);
		const free = await agent("/nova-agent/bookings/availability", { typeId: VOICE_1H, date: ukDay(21) });
		expect(free.data.times.length).toBeGreaterThan(0);
		expect(free.data.times.map((t) => t.label)).not.toContain("10:30"); // inside the blocked time
		const blocks = await agent("/nova-agent/bookings/blocks", { from: ukDay(21), to: ukDay(21) });
		expect(blocks.data.blocks).toEqual([expect.objectContaining({ notes: "Maintenance", start: utc(`${ukDay(21)}T10:00`) })]);
		const types = await agent("/nova-agent/bookings/types", {});
		expect(types.data.types).toContainEqual(expect.objectContaining({ id: RAP_2, price: "200.00", duration: 240 }));
		const clients = await agent("/nova-agent/bookings/clients", { search: "dana" });
		expect(clients.data.clients).toEqual([expect.objectContaining({ firstName: "Dana", lastName: "Hollis", email: "dana@example.com" })]);
		// The old addresses answer the same
		expect((await agent("/nova-agent/acuity/appointments", { from: ukDay(19), to: ukDay(21) })).data).toEqual(list.data);
		expect((await agent("/nova-agent/bookings-feed", { from: ukDay(19), to: ukDay(21) })).data.appointments).toEqual([{ id: b.id, start: b.starts_at, end: b.ends_at, type: b.session, name: "Dana Hollis" }]);
	});

	it("turns bad input away, and needs the agent's key", async () => {
		expect((await agent("/nova-agent/bookings/appointments", { from: "soon", to: ukDay(2) })).status).toBe(400);
		expect((await agent("/nova-agent/bookings/appointments", { from: ukDay(0), to: ukDay(90) })).status).toBe(400);
		expect((await agent("/nova-agent/bookings/availability", { typeId: "x", date: ukDay(2) })).status).toBe(400);
		expect((await agent("/nova-agent/bookings/clients", { search: "d" })).status).toBe(400);
		const res = await call(new Request(`${BASE}/nova-agent/bookings/types`, { method: "POST", headers: { Authorization: "Bearer wrong" } }));
		expect(res.status).toBe(401);
	});
});

describe("proposing (the AI's only power)", () => {
	it("a proposed move can't happen without approval: nothing changes from any agent-key route", async () => {
		const b = await makeBooking();
		const start = `${ukDay(22)}T11:00`;
		// A summary or status from the proposer is ignored
		const { data } = await agent("/nova-agent/booking-actions/propose", {
			kind: "reschedule",
			payload: { appointmentId: b.id, start, summary: "Nothing to see" },
			reason: "Dana asked to move",
			summary: "Totally harmless",
			status: "approved",
		});
		const action = data.action;
		expect(action).toMatchObject({ kind: "reschedule", status: "pending", proposedBy: "agent", reason: "Dana asked to move", payload: { bookingId: b.id, start: utc(start), notifyClient: true } });
		expect(action.summary).toMatch(new RegExp(`^Move Dana Hollis's Rap Package - 2 songs .* \\(#${b.id}\\) from .+ 14:00 to .+ 11:00 \\(the client is emailed\\)$`));
		expect(action.portalUrl).toBe(`${BASE}/portal/?view=approvals&action=${action.id}`);

		for (const path of ["approve", "execute", "edit", "reject", String(action.id), `${action.id}/approve`]) {
			expect((await agent(`/nova-agent/booking-actions/${path}`, { id: action.id })).status).toBe(404);
		}
		// Proposing the same thing again hands back the same one
		expect((await agent("/nova-agent/booking-actions/propose", { kind: "reschedule", payload: { bookingId: b.id, start } })).data.action.id).toBe(action.id);
		expect((await row(action.id)).status).toBe("pending");
		expect(await getBooking(env, b.id)).toEqual(b);
		// And even the executor itself does nothing with a pending one
		expect((await executeApproved(env, action.id)).status).toBe("pending");
		expect(await getBooking(env, b.id)).toEqual(b);
		expect(fakes.google.emails).toHaveLength(0);
	});

	it("checks every kind against the bookings and the calendar, and writes its own summary", async () => {
		const b = await makeBooking({ paid: 10000 });
		const blockId = fakes.google.add(ukEvent(ukDay(25), "10:00", "12:00", { summary: "Maintenance" }));
		const start = `${ukDay(23)}T11:00`;
		expect((await propose("create", { typeId: VOICE_1H, start, firstName: "Kai", lastName: "Moss", email: "Kai@Example.com" })).summary).toMatch(/^Book Kai Moss \(kai@example\.com\) for Voiceover Recording with Engineer - 1 hour on .+ 11:00–12:00 \(the client is emailed, with a link to pay the deposit\)$/);
		expect((await propose("cancel", { bookingId: b.id, notifyClient: false })).summary).toMatch(/^Cancel Dana Hollis's .+: £100 refunded to their card \(the studio's policy\) \(no email to the client\)$/);
		expect((await propose("update", { bookingId: b.id, phone: "07700 900999" })).summary).toMatch(/: phone "07700 900111" → "07700 900999"$/);
		expect((await propose("extras", { bookingId: b.id, type: String(VOICE_1H), paid: true })).summary).toMatch(/session ".+" → "Voiceover Recording with Engineer - 1 hour", mark it paid in full/);
		expect((await propose("extras", { bookingId: b.id, paymentLink: "balance" })).summary).toMatch(/email dana@example\.com a link to pay the balance \(£100\)/);
		expect((await propose("extras", { bookingId: b.id, refund: 4000, reason: "Started late" })).summary).toMatch(/refund £40 to their card \("Started late"\)/);
		expect((await propose("block_add", { start: `${ukDay(24)}T09:00`, end: `${ukDay(24)}T13:00`, notes: "Gear service" })).summary).toMatch(/^Block off .+ 09:00–13:00 in the studio's calendar \("Gear service"\)$/);
		expect((await propose("block_remove", { blockId })).summary).toMatch(/^Remove the blocked-off time .+ 10:00–12:00 \("Maintenance"\)$/);

		const refused = async (kind, payload) => {
			const res = await agent("/nova-agent/booking-actions/propose", { kind, payload });
			expect(res.status).toBe(400);
			return res.data.error;
		};
		expect(await refused("reschedule", { bookingId: 99999, start })).toMatch(/no booking #99999/);
		expect(await refused("cancel", { bookingId: b.id, refund: 50000 })).toMatch(/Only £100 has been paid/);
		expect(await refused("extras", { bookingId: b.id, refund: 50000 })).toMatch(/at most that can go back/);
		expect(await refused("create", { typeId: 1, start, firstName: "A", lastName: "B", email: "a@b.co" })).toMatch(/no session type/);
		expect(await refused("create", { typeId: VOICE_1H, start: `${ukDay(-2)}T11:00`, firstName: "A", lastName: "B", email: "a@b.co" })).toMatch(/in the past/);
		expect(await refused("block_remove", { blockId: b.event_id })).toMatch(/That's a booking/);
		expect(await refused("block_remove", { blockId: "no-such-event" })).toMatch(/no blocked time/);
		expect(await refused("update", { bookingId: b.id, phone: "07700 900111" })).toMatch(/Nothing to change/);
		expect(await refused("wipe", {})).toMatch(/kind must be one of/);
		// Nothing changed
		expect(await getBooking(env, b.id)).toEqual(b);
		expect(fakes.google.emails).toHaveLength(0);
		expect(stripeCalls()).toHaveLength(0);
	});
});

describe("Portal approvals", () => {
	it("any staff can see them; only an admin in a browser can decide", async () => {
		const b = await makeBooking();
		const action = await propose("reschedule", { bookingId: b.id, start: `${ukDay(22)}T11:00` });
		const { staff, adminToken } = await otherSignIns();
		const seen = await portal("booking-actions", { headers: staff });
		expect(seen.status).toBe(200);
		expect(seen.data.canDecide).toBe(false);
		expect(seen.data.actions.map((a) => a.id)).toEqual([action.id]);
		expect((await portal("booking-actions", { headers: adminToken })).data.canDecide).toBe(false);
		expect((await portal("booking-actions")).data.canDecide).toBe(true);
		for (const headers of [staff, adminToken]) {
			expect((await portal("booking-actions/approve", { body: { id: action.id }, headers })).status).toBe(403);
			expect((await portal("booking-actions/reject", { body: { id: action.id }, headers })).status).toBe(403);
		}
		expect((await portal("booking-actions/approve", { body: { id: action.id }, headers: {} })).status).toBe(401);
		expect((await portal("booking-actions/approve", { body: { id: action.id }, headers: { Cookie: STAFF_COOKIE, Origin: "https://evil.example" } })).status).toBe(403);
		expect((await row(action.id)).status).toBe("pending");
		expect(await getBooking(env, b.id)).toEqual(b);
	});

	it("approving a move moves it, emails the client, and tells Nova Agent the bookings changed", async () => {
		const b = await makeBooking();
		const action = await propose("reschedule", { bookingId: b.id, start: `${ukDay(22)}T11:00` });
		const before = new Date().toISOString();
		const done = await approve(action.id);
		expect(done).toMatchObject({ status: "executed", decidedBy: "test-admin", decidedByName: "Test Admin", result: { bookingId: b.id }, error: null });
		expect((await getBooking(env, b.id)).starts_at).toBe(utc(`${ukDay(22)}T11:00`));
		expect(fakes.google.events.get(b.event_id).start.dateTime).toBe(utc(`${ukDay(22)}T11:00`));
		expect(fakes.google.emails.map((m) => m.to)).toEqual(["dana@example.com"]);
		expect((await agent("/nova-agent/next", { wait: 0 })).data.bookingsChanged >= before).toBe(true);
	});

	it("each kind, once approved, does what it said", async () => {
		const b = await makeBooking({ paid: 10000 });
		const kai = await makeBooking({ day: ukDay(26), first: "Kai", last: "Moss", email: "kai@example.com" });

		// create, with no email
		const made = await approve((await propose("create", { typeId: VOICE_1H, start: `${ukDay(23)}T11:00`, firstName: "Ola", lastName: "Ade", email: "ola@example.com", notifyClient: false })).id);
		expect(made.status).toBe("executed");
		const ola = await getBooking(env, made.result.bookingId);
		expect(ola).toMatchObject({ status: "booked", source: "staff", type_id: VOICE_1H, email: "ola@example.com", starts_at: utc(`${ukDay(23)}T11:00`) });
		expect(fakes.google.emails).toHaveLength(0);

		// update
		await approve((await propose("update", { bookingId: b.id, phone: "07700 900999", notes: "Vocal booth" })).id);
		expect(await getBooking(env, b.id)).toMatchObject({ phone: "07700 900999", notes: "Vocal booth" });

		// extras: session type and paid in full (cash)
		await approve((await propose("extras", { bookingId: b.id, type: VOICE_1H, paid: true })).id);
		expect(await getBooking(env, b.id)).toMatchObject({ type_id: VOICE_1H, price_pence: 8000, paid_pence: 8000 });

		// extras: a payment link
		await approve((await propose("extras", { bookingId: kai.id, paymentLink: "deposit" })).id);
		expect(fakes.google.emails.map((m) => m.to)).toEqual(["kai@example.com"]);

		// extras: a refund of money paid online
		await approve((await propose("extras", { bookingId: b.id, refund: 1000, reason: "Started late" })).id);
		expect(fakes.stripe.refunds).toHaveLength(1);
		expect((await getBooking(env, b.id)).refunded_pence).toBe(1000);

		// cancel: no refund, no email
		fakes.google.emails.length = 0;
		await approve((await propose("cancel", { bookingId: kai.id, notifyClient: false, refund: "none" })).id);
		expect((await getBooking(env, kai.id)).status).toBe("cancelled");
		expect(fakes.google.events.get(kai.event_id)).toMatchObject({ transparency: "transparent" });
		expect(fakes.google.emails).toHaveLength(0);

		// block_add and block_remove
		const blocked = await approve((await propose("block_add", { start: `${ukDay(24)}T09:00`, end: `${ukDay(24)}T13:00`, notes: "Gear service" })).id);
		expect(blocked.status).toBe("executed");
		const event = fakes.google.events.get(blocked.result.blockId);
		expect(event).toMatchObject({ summary: "Blocked: Gear service", start: { dateTime: utc(`${ukDay(24)}T09:00`) }, transparency: "opaque" });
		await approve((await propose("block_remove", { blockId: blocked.result.blockId })).id);
		expect(fakes.google.events.has(blocked.result.blockId)).toBe(false);
	});

	it("a change that can't be made any more is marked failed, with the reason", async () => {
		const b = await makeBooking();
		const other = await makeBooking({ day: ukDay(22), time: "10:00", first: "Kai", last: "Moss", email: "kai@example.com" });
		// Proposed while the time was free; by approval time it's taken
		const action = await propose("reschedule", { bookingId: b.id, start: `${ukDay(22)}T10:00` });
		const done = await approve(action.id);
		expect(done.status).toBe("failed");
		expect(done.error).toMatch(/isn't free/);
		expect((await getBooking(env, b.id)).starts_at).toBe(b.starts_at);
		expect(other.status).toBe("booked");
	});

	it("edit keeps it pending with a new summary; approve can carry the edited details", async () => {
		const b = await makeBooking();
		const action = await propose("reschedule", { bookingId: b.id, start: `${ukDay(22)}T11:00` });
		const edited = await portal("booking-actions/edit", { body: { id: action.id, payload: { start: `${ukDay(22)}T16:00`, notifyClient: false } } });
		expect(edited.status).toBe(200);
		expect(edited.data.action.status).toBe("pending");
		expect(edited.data.action.summary).toMatch(/ to .+ 16:00 \(no email to the client\)$/);
		const approved = await approve(action.id, { start: `${ukDay(22)}T15:00` });
		expect(approved.status).toBe("executed");
		expect((await getBooking(env, b.id)).starts_at).toBe(utc(`${ukDay(22)}T15:00`));
		expect(fakes.google.emails).toHaveLength(0);
	});

	it("two presses at once: carried out exactly once; reject never carries it out", async () => {
		const b = await makeBooking({ paid: 10000 });
		const action = await propose("extras", { bookingId: b.id, refund: 1000 });
		await Promise.all([approve(action.id), approve(action.id)]);
		expect(fakes.stripe.refunds).toHaveLength(1);
		expect(await executeApproved(env, action.id)).toMatchObject({ status: "executed" });
		expect(fakes.stripe.refunds).toHaveLength(1);

		const second = await propose("cancel", { bookingId: b.id });
		const rejected = await portal("booking-actions/reject", { body: { id: second.id, note: "She changed her mind" } });
		expect(rejected.data.action).toMatchObject({ status: "rejected", note: "She changed her mind" });
		expect((await approve(second.id)).status).toBe("rejected");
		expect((await getBooking(env, b.id)).status).toBe("booked");
	});
});

describe("a change cut off part-way", () => {
	it("shows as failed, telling the admin to check the booking, instead of hanging as approved", async () => {
		const long = new Date(Date.now() - 10 * 60 * 1000).toISOString();
		const { meta } = await env.DB.prepare(
			"INSERT INTO booking_actions (kind, payload, summary, status, proposed_by, created_at, updated_at, decided_by, decided_at, started_at) VALUES ('cancel', '{\"bookingId\":1}', 'Cancel test', 'approved', 'agent', ?, ?, 'test-admin', ?, ?)"
		)
			.bind(long, long, long, long)
			.run();
		const action = await getAction(env, meta.last_row_id);
		expect(action.status).toBe("failed");
		expect(action.error).toMatch(/Check the booking/);
	});
});

describe("UK time", () => {
	it("turns a UK wall clock into UTC, in summer (BST) and winter (GMT)", () => {
		expect(ukWallToUtc("2026-07-01T17:00").toISOString()).toBe("2026-07-01T16:00:00.000Z");
		expect(ukWallToUtc("2026-12-01T17:00").toISOString()).toBe("2026-12-01T17:00:00.000Z");
		// The hour the clocks skip doesn't exist
		expect(ukWallToUtc("2027-03-28T01:30")).toBeNull();
		expect(readTime("2026-07-01T16:00:00Z").toISOString()).toBe("2026-07-01T16:00:00.000Z");
		expect(readTime("2026-07-01T17:00:00+0100").toISOString()).toBe("2026-07-01T16:00:00.000Z");
		expect(readTime("soon")).toBeNull();
		expect(ukShort("2026-07-01T16:00:00Z")).toBe("Wed 1 Jul 17:00");
	});
});

describe("an admin's edits", () => {
	it("can send just what changed: the rest of the proposal is kept", async () => {
		const action = await propose("block_add", { start: `${ukDay(30)}T10:00`, end: `${ukDay(30)}T12:00`, notes: "Gear service" });
		const { editAction } = await import("../src/booking-actions.js");
		const out = await editAction(env, { id: "test-admin", role: "admin", session_kind: "cookie" }, { id: action.id, payload: { end: `${ukDay(30)}T13:00` } });
		expect(out.error).toBeUndefined();
		expect(out.action.payload).toMatchObject({ start: utc(`${ukDay(30)}T10:00`), end: utc(`${ukDay(30)}T13:00`), notes: "Gear service" });
		expect(out.action.status).toBe("pending");
	});
});

describe("bookings changed (Nova Agent's /next)", () => {
	it("a booking made, moved or cancelled sets bookingsChanged; /next returns early when it's newer than bookingsSeen", async () => {
		expect((await agent("/nova-agent/next", { wait: 0, bookingsSeen: "" })).data.bookingsChanged).toBeNull();
		const seen = new Date(Date.now() - 60000).toISOString();
		const b = await makeBooking();
		let started = Date.now();
		const early = await agent("/nova-agent/next", { wait: 5, bookingsSeen: seen });
		expect(Date.now() - started).toBeLessThan(2000);
		expect(early.data.job).toBeNull();
		expect(Date.parse(early.data.bookingsChanged)).toBeGreaterThan(Date.parse(seen));

		// Already seen: it waits the whole time
		started = Date.now();
		await agent("/nova-agent/next", { wait: 1, bookingsSeen: early.data.bookingsChanged });
		expect(Date.now() - started).toBeGreaterThanOrEqual(900);

		// A change while it waits ends the wait
		const { cancelBooking } = await import("../src/nova/bookings.js");
		started = Date.now();
		setTimeout(() => void cancelBooking(env, b, { by: "staff", notify: false }), 300);
		const woken = await agent("/nova-agent/next", { wait: 5, bookingsSeen: early.data.bookingsChanged });
		expect(Date.now() - started).toBeLessThan(3000);
		expect(Date.parse(woken.data.bookingsChanged)).toBeGreaterThan(Date.parse(early.data.bookingsChanged));
	});
});

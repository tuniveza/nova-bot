// Acuity test booking (src/acuity-test-booking.js): a real booking in Acuity as staff, with
// no payment and no emails, checked step by step, alerting only the admin who ran it, kept
// out of referrals, and always cancelled in Acuity (by itself, or after 15 minutes at most).
import { createExecutionContext, env, waitOnExecutionContext } from "cloudflare:test";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import worker from "../src";
import { CANCEL_AFTER_MS, checkAcuityTest, readTest, runAcuityTest, tidyAcuityTests } from "../src/acuity-test-booking.js";
import { phoneId, savePhone } from "../src/push.js";
import { STAFF_COOKIE } from "./sign-in.js";

const BASE = "https://novacane-worker.test";
const API = "https://acuityscheduling.com/api/v1";
const FEED = "https://acuity.test/feed.ics";
const SLOT = "2026-11-04T17:00:00+0000";
const ADMIN = { id: "test-admin", email: "test-admin@novacane.test", display_name: "Test Admin" };

let calls; // what was asked of Acuity: "METHOD /path?query"
let booked; // the appointment Acuity has, or null
let inFeed; // whether the calendar feed lists it yet
let delivered; // phones "Apple" was handed an alert for
let keys;
let nextId;

const b64url = (bytes) => btoa(String.fromCharCode(...new Uint8Array(bytes))).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
async function vapidKeys() {
	const pair = await crypto.subtle.generateKey({ name: "ECDSA", namedCurve: "P-256" }, true, ["sign", "verify"]);
	const jwk = await crypto.subtle.exportKey("jwk", pair.privateKey);
	return { VAPID_PUBLIC_KEY: b64url(await crypto.subtle.exportKey("raw", pair.publicKey)), VAPID_PRIVATE_KEY: jwk.d };
}
async function phone(endpoint) {
	const pair = await crypto.subtle.generateKey({ name: "ECDH", namedCurve: "P-256" }, true, ["deriveBits"]);
	return { endpoint, keys: { p256dh: b64url(await crypto.subtle.exportKey("raw", pair.publicKey)), auth: b64url(crypto.getRandomValues(new Uint8Array(16))) } };
}

const reply = (data, status = 200) => new Response(JSON.stringify(data), { status, headers: { "Content-Type": "application/json" } });

beforeEach(async () => {
	calls = [];
	booked = null;
	inFeed = false;
	delivered = [];
	nextId = 900001;
	keys = await vapidKeys();
	vi.spyOn(globalThis, "fetch").mockImplementation(async (url, init = {}) => {
		const u = String(url);
		if (u.startsWith("https://web.push.apple.com/")) {
			delivered.push(u);
			return new Response(null, { status: 201 });
		}
		if (u === FEED) {
			const event = booked && inFeed && !booked.canceled
				? `BEGIN:VEVENT\nUID:${booked.id}@scheduling\nSUMMARY:Nova TEST booking: Mixing (Novacane Studios)\nDTSTART:20261104T170000Z\nDTEND:20261104T190000Z\nDESCRIPTION:Name: Nova TEST booking\\nEmail: test-admin@novacane.test\nEND:VEVENT\n`
				: "";
			return new Response(`BEGIN:VCALENDAR\n${event}END:VCALENDAR\n`);
		}
		if (!u.startsWith(API)) throw new Error("Unexpected fetch in test: " + u);
		const path = u.slice(API.length);
		const method = init.method || "GET";
		calls.push(method + " " + path);
		if (path === "/appointment-types") {
			return reply([
				{ id: 11, name: "Mixing", price: "50.00", duration: 120, active: true, private: false, type: "service" },
				{ id: 12, name: "Secret", price: "10.00", duration: 60, active: true, private: true, type: "service" },
			]);
		}
		if (path.startsWith("/availability/times")) return reply(booked && !booked.canceled ? [] : [{ time: "2026-11-04T15:00:00+0000" }, { time: SLOT }]);
		if (path === "/appointments?admin=true&noEmail=true" && method === "POST") {
			booked = { id: nextId++, ...JSON.parse(init.body), canceled: false };
			return reply(booked);
		}
		const one = path.match(/^\/appointments\/(\d+)(\/cancel\?admin=true&noEmail=true)?$/);
		if (one && booked && Number(one[1]) === booked.id) {
			if (one[2] && method === "PUT") booked.canceled = true;
			return reply(booked);
		}
		return reply({ message: "not found" }, 404);
	});
	await env.DB.batch([
		env.DB.prepare("DELETE FROM settings WHERE key LIKE 'acuity_test%'"),
		env.DB.prepare("DELETE FROM booking_events"),
		env.DB.prepare("DELETE FROM booking_details"),
		env.DB.prepare("DELETE FROM notifications"),
		env.DB.prepare("DELETE FROM push_subscriptions"),
		env.DB.prepare("DELETE FROM appointments"),
		env.DB.prepare(
			"INSERT OR IGNORE INTO staff (id, email, password_hash, display_name, role, status, created_at, planet_seed, index_partition) VALUES ('test-staff', 'test-staff@novacane.test', NULL, 'Test Staff', 'staff', 'active', '2030-01-01T00:00:00.000Z', 'test-staff', 'staff:test-staff')"
		),
	]);
});
afterEach(() => vi.restoreAllMocks());

const testEnv = (extra = {}) => ({ ...env, ...keys, ACUITY_CALENDAR_URL: FEED, ACUITY_TEST_WAIT_MS: "0", ...extra });

async function sign(body) {
	const key = await crypto.subtle.importKey("raw", new TextEncoder().encode("test-acuity-key"), { name: "HMAC", hash: "SHA-256" }, false, ["sign"]);
	return btoa(String.fromCharCode(...new Uint8Array(await crypto.subtle.sign("HMAC", key, new TextEncoder().encode(body)))));
}
// Acuity's webhook (signed, like the Powerhouse plan sends it)
async function webhook(action, id, e = testEnv()) {
	const body = `action=${action}&id=${id}&calendarID=1&appointmentTypeID=11`;
	const res = await worker.fetch(
		new Request(`${BASE}/acuity/webhook`, { method: "POST", headers: { "Content-Type": "application/x-www-form-urlencoded", "x-acuity-signature": await sign(body) }, body }),
		e
	);
	expect(res.status).toBe(200);
}
const status = (t) => Object.fromEntries(Object.entries(t.steps).map(([k, v]) => [k, v.status]));

describe("running an Acuity test booking", () => {
	it("books it in Acuity as staff, with no payment and no emails, named as a test", async () => {
		const { test: t } = await runAcuityTest(testEnv(), ADMIN, { typeId: 11, datetime: SLOT });
		expect(calls).toContain("POST /appointments?admin=true&noEmail=true");
		expect(booked).toMatchObject({ appointmentTypeID: 11, datetime: SLOT, firstName: "Nova", lastName: "TEST booking", email: "test-admin@novacane.test" });
		expect(status(t)).toMatchObject({ slot: "pass", booking: "pass", payment: "skip", webhook: "fail", cancel: "waiting" });
	});

	it("checks every step, cancels itself in Acuity, and passes", async () => {
		const e = testEnv();
		const { test: first } = await runAcuityTest(e, ADMIN, { typeId: 11, datetime: SLOT });
		inFeed = true;
		await webhook("scheduled", first.id, e);
		const t = await checkAcuityTest(e, first.id);
		expect(status(t)).toMatchObject({ webhook: "pass", alert: "pass", calendar: "pass", cancel: "pass", cancelHeard: "waiting" });
		expect(t.steps.alert.detail).toContain("held back");
		expect(calls).toContain(`PUT /appointments/${first.id}/cancel?admin=true&noEmail=true`);
		expect(booked.canceled).toBe(true);
		await webhook("canceled", first.id, e);
		const done = await checkAcuityTest(e, first.id);
		expect(done.done).toBe(true);
		expect(done.ok).toBe(true);
		// Nobody was alerted, nothing went into Portal's Alerts, and it isn't a referral booking
		expect(delivered).toEqual([]);
		expect((await env.DB.prepare("SELECT COUNT(*) AS n FROM notifications").first()).n).toBe(0);
		expect((await env.DB.prepare("SELECT COUNT(*) AS n FROM appointments").first()).n).toBe(0);
	});

	it("sends the alert only to the admin's own phones when asked, marked TEST", async () => {
		const e = testEnv();
		await savePhone(e, await phone("https://web.push.apple.com/admin"), { staffId: "test-admin" });
		await savePhone(e, await phone("https://web.push.apple.com/staff"), { staffId: "test-staff" });
		const { test: first } = await runAcuityTest(e, ADMIN, { typeId: 11, datetime: SLOT, alertMe: true });
		inFeed = true;
		await webhook("scheduled", first.id, e);
		const t = await checkAcuityTest(e, first.id);
		expect(delivered).toEqual(["https://web.push.apple.com/admin"]);
		expect(t.steps.alert.status).toBe("pass");
		expect(t.alert.title).toMatch(/^TEST · /);
		expect((await env.DB.prepare("SELECT COUNT(*) AS n FROM notifications").first()).n).toBe(0);
		expect(await phoneId("https://web.push.apple.com/admin")).toMatch(/^[0-9a-f]{12}$/);
	});

	it("runs one at a time", async () => {
		await runAcuityTest(testEnv(), ADMIN, { typeId: 11, datetime: SLOT });
		const again = await runAcuityTest(testEnv(), ADMIN, { typeId: 11, datetime: "2026-11-04T15:00:00+0000" });
		expect(again.error).toMatch(/still in Acuity/);
		expect(calls.filter((c) => c.startsWith("POST")).length).toBe(1);
	});

	it("won't book a time that isn't free, or a private session", async () => {
		expect((await runAcuityTest(testEnv(), ADMIN, { typeId: 11, datetime: "2026-11-04T09:00:00+0000" })).error).toMatch(/isn't free/);
		expect((await runAcuityTest(testEnv(), ADMIN, { typeId: 12, datetime: SLOT })).error).toMatch(/Pick a session/);
		expect(booked).toBe(null);
	});
});

describe("a test booking is never left in Acuity", () => {
	it("the every-minute timer cancels it after 15 minutes, even if nothing else happened", async () => {
		const e = testEnv();
		const { test: first } = await runAcuityTest(e, ADMIN, { typeId: 11, datetime: SLOT });
		await tidyAcuityTests(e, first.madeAt + 60_000);
		expect(booked.canceled).toBe(false);
		await tidyAcuityTests(e, first.madeAt + CANCEL_AFTER_MS);
		expect(booked.canceled).toBe(true);
		const t = await readTest(e, first.id);
		expect(status(t)).toMatchObject({ webhook: "fail", calendar: "fail", cancel: "pass" });
		expect(t.steps.webhook.detail).toContain("/acuity/webhook");
	});

	it("Cancel it now cancels straight away", async () => {
		const e = testEnv();
		const { test: first } = await runAcuityTest(e, ADMIN, { typeId: 11, datetime: SLOT });
		const t = await checkAcuityTest(e, first.id, { cancelNow: true });
		expect(t.steps.cancel.status).toBe("pass");
		expect(booked.canceled).toBe(true);
	});
});

describe("the page", () => {
	async function admin(path, body, cookie = STAFF_COOKIE) {
		const ctx = createExecutionContext();
		const res = await worker.fetch(
			new Request(BASE + "/admin/test-booking/acuity/" + path, {
				method: body ? "POST" : "GET",
				headers: { Cookie: cookie, ...(body ? { "Content-Type": "application/json", Origin: BASE } : {}) },
				body: body ? JSON.stringify(body) : undefined,
			}),
			testEnv(),
			ctx
		);
		await waitOnExecutionContext(ctx);
		return { status: res.status, data: await res.json().catch(() => null) };
	}

	it("lists the public sessions and a quiet time about four weeks ahead", async () => {
		const r = await admin("state");
		expect(r.status).toBe(200);
		expect(r.data.sessions.map((s) => s.name)).toEqual(["Mixing"]);
		expect(r.data.quiet.time).toBe(SLOT);
		expect(r.data.system).toBe("acuity");
	});

	it("runs and cancels from the page", async () => {
		const run = await admin("run", { session: 11, datetime: SLOT });
		expect(run.status).toBe(200);
		const cancel = await admin("cancel", { id: run.data.test.id });
		expect(cancel.data.test.cancelled).toBe(true);
	});

	it("is for admins only", async () => {
		const r = await admin("state", undefined, "nova_session=nobody");
		expect(r.status).not.toBe(200);
		expect(calls).toEqual([]);
	});
});

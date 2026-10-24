// Calendar reminders reach the phones they're meant for, only count as sent once a phone took
// them, are tried again when none did, and say so in Portal's Alerts when they never got through.
// Also: edits made on a device whose clock is behind still save.
import { createExecutionContext, env, waitOnExecutionContext } from "cloudflare:test";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import worker from "../src";
import { STAFF_COOKIE } from "./sign-in.js";
import { localToMs, RETRY_MS, sendCalendarReminders } from "../src/calendar/reminders.js";
import { listPhones, phoneId, phoneName, savePhone } from "../src/push.js";
import { saveItem } from "../src/calendar/items.js";

const BASE = "https://novacane-worker.test";
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

let delivered = []; // the phones "Apple" was handed a message for
let refusing = false; // "Apple" turns everything away (500)
let keys;

beforeEach(async () => {
	delivered = [];
	refusing = false;
	keys = await vapidKeys();
	vi.spyOn(globalThis, "fetch").mockImplementation(async (url) => {
		if (String(url).startsWith("https://web.push.apple.com/")) {
			if (refusing) return new Response("busy", { status: 500 });
			delivered.push(String(url));
			return new Response(null, { status: 201 });
		}
		throw new Error("Unexpected fetch in test: " + url);
	});
	await env.DB.batch([
		env.DB.prepare("DELETE FROM push_subscriptions"),
		env.DB.prepare("DELETE FROM notifications"),
		env.DB.prepare("DELETE FROM calendar_items"),
		env.DB.prepare("DELETE FROM calendar_reminders_sent"),
		env.DB.prepare("INSERT OR IGNORE INTO staff (id, email, password_hash, display_name, role, status, created_at, planet_seed, index_partition) VALUES ('test-staff', 'test-staff@novacane.test', NULL, 'Test Staff', 'staff', 'active', '2030-01-01T00:00:00.000Z', 'test-staff', 'staff:test-staff')"),
	]);
});
afterEach(() => vi.restoreAllMocks());

const withKeys = () => ({ ...env, ...keys });
const due = "2026-10-09T13:50"; // the reminder's minute (10 minutes before 14:00)
async function addEvent(extra = {}) {
	const r = await saveItem(env, { kind: "event", id: "ev-1", title: "Mix review", start: "2026-10-09T14:00", end: "2026-10-09T15:00", reminders: [10], updated: "2026-10-08T10:00:00.000Z", ...extra });
	expect(r.ok).toBe(true);
}
const status = async () => env.DB.prepare("SELECT status, tries FROM calendar_reminders_sent WHERE key = 'ev-1|2026-10-09|10'").first();
const alerts = async () => (await env.DB.prepare("SELECT title, phones FROM notifications").all()).results;

describe("which phones get a reminder", () => {
	it("names phones plainly", () => {
		expect(phoneName("Mozilla/5.0 (iPhone; CPU iPhone OS 17_0 like Mac OS X)")).toBe("iPhone");
		expect(phoneName("Mozilla/5.0 (Linux; Android 14; Pixel 7 Build/UQ1A) Chrome/120")).toBe("Android · Pixel 7");
		expect(phoneName("Mozilla/5.0 (Linux; Android 10; K) Chrome/120")).toBe("Android");
	});

	it("goes to the studio owner's phones by default (phones from before owners count as theirs)", async () => {
		await savePhone(env, await phone("https://web.push.apple.com/owner"), { staffId: "test-admin", name: "iPhone" });
		await savePhone(env, await phone("https://web.push.apple.com/old")); // no owner
		await savePhone(env, await phone("https://web.push.apple.com/staff"), { staffId: "test-staff", name: "Android" });
		await addEvent();
		await sendCalendarReminders(withKeys(), localToMs(due) + 1000);
		expect(delivered.sort()).toEqual(["https://web.push.apple.com/old", "https://web.push.apple.com/owner"]);
	});

	it("goes to just the phone picked", async () => {
		await savePhone(env, await phone("https://web.push.apple.com/owner"), { staffId: "test-admin" });
		await savePhone(env, await phone("https://web.push.apple.com/staff"), { staffId: "test-staff" });
		await addEvent({ phones: [await phoneId("https://web.push.apple.com/staff")] });
		await sendCalendarReminders(withKeys(), localToMs(due) + 1000);
		expect(delivered).toEqual(["https://web.push.apple.com/staff"]);
	});

	it("falls back to the owner's phones when the picked phone was turned off", async () => {
		await savePhone(env, await phone("https://web.push.apple.com/owner"), { staffId: "test-admin" });
		await addEvent({ phones: ["abcdef123456"] });
		await sendCalendarReminders(withKeys(), localToMs(due) + 1000);
		expect(delivered).toEqual(["https://web.push.apple.com/owner"]);
	});

	it("lists the phones for Calendar, with who they belong to", async () => {
		await savePhone(env, await phone("https://web.push.apple.com/staff"), { staffId: "test-staff", name: "Android · Pixel 7" });
		const ctx = createExecutionContext();
		const res = await worker.fetch(new Request(BASE + "/app/api/push/phones", { headers: { Cookie: STAFF_COOKIE } }), env, ctx);
		await waitOnExecutionContext(ctx);
		const body = await res.json();
		expect(body.phones).toEqual([expect.objectContaining({ id: await phoneId("https://web.push.apple.com/staff"), name: "Android · Pixel 7", staffId: "test-staff", who: "Test Staff" })]);
		expect(await listPhones(env)).toHaveLength(1);
	});
});

describe("a reminder only counts as sent once a phone took it", () => {
	it("is sent once, and marked sent", async () => {
		await savePhone(env, await phone("https://web.push.apple.com/owner"), { staffId: "test-admin" });
		await addEvent();
		await sendCalendarReminders(withKeys(), localToMs(due) + 1000);
		await sendCalendarReminders(withKeys(), localToMs(due) + 61000);
		expect(delivered).toHaveLength(1);
		expect(await status()).toEqual({ status: "sent", tries: 1 });
	});

	it("is tried again the next minute when no phone took it, and goes once one does", async () => {
		await savePhone(env, await phone("https://web.push.apple.com/owner"), { staffId: "test-admin" });
		await addEvent();
		refusing = true;
		await sendCalendarReminders(withKeys(), localToMs(due) + 1000);
		expect(await status()).toEqual({ status: "retrying", tries: 1 });
		refusing = false;
		await sendCalendarReminders(withKeys(), localToMs(due) + 61000);
		expect(delivered).toHaveLength(1);
		expect(await status()).toEqual({ status: "sent", tries: 2 });
		expect(await alerts()).toEqual([expect.objectContaining({ title: "Mix review", phones: 1 })]);
	});

	it("gives up after 15 minutes, and says so in Portal's Alerts", async () => {
		await addEvent(); // no phones at all
		for (let m = 0; m < RETRY_MS / 60000; m++) await sendCalendarReminders(withKeys(), localToMs(due) + 1000 + m * 60000);
		const s = await status();
		expect(s.status).toBe("failed");
		expect(s.tries).toBe(15);
		expect(await alerts()).toEqual([{ title: "Reminder didn't reach a phone: Mix review", phones: 0 }]);
		// and it isn't tried again
		await sendCalendarReminders(withKeys(), localToMs(due) + 16 * 60000);
		expect((await status()).tries).toBe(15);
	});
});

describe("edits always save", () => {
	it("a change made to the latest version saves even when the device's clock is behind", async () => {
		await addEvent({ updated: "2026-10-08T10:00:00.000Z" });
		const slow = await saveItem(env, { kind: "event", id: "ev-1", title: "Mix review", start: "2026-10-09T14:00", end: "2026-10-09T15:00", reminders: [10, 60], updated: "2026-10-08T09:58:00.000Z", base: "2026-10-08T10:00:00.000Z" });
		expect(slow.ok).toBe(true);
		expect(slow.item.reminders).toEqual([10, 60]);
		expect(slow.item.updated > "2026-10-08T10:00:00.000Z").toBe(true);
	});

	it("a change made to an older version still loses to a later one", async () => {
		await addEvent({ updated: "2026-10-08T10:00:00.000Z" });
		const stale = await saveItem(env, { kind: "event", id: "ev-1", title: "Old", start: "2026-10-09T14:00", end: "2026-10-09T15:00", updated: "2026-10-08T09:00:00.000Z", base: "2026-10-07T09:00:00.000Z" });
		expect(stale.ok).toBe(false);
		expect(stale.current.title).toBe("Mix review");
	});
});

describe("Nova Quests' reminders reach their own phones too", () => {
	async function notify(body) {
		const ctx = createExecutionContext();
		const res = await worker.fetch(
			new Request(BASE + "/nova-agent/notify", { method: "POST", headers: { "Content-Type": "application/json", Authorization: "Bearer agent-nova-test-key" }, body: JSON.stringify(body) }),
			{ ...env, ...keys, AGENT_NOVA_KEY: "agent-nova-test-key" },
			ctx
		);
		await waitOnExecutionContext(ctx);
		return res.status;
	}
	beforeEach(async () => {
		await savePhone(env, await phone("https://web.push.apple.com/owner"), { staffId: "test-admin" });
		await savePhone(env, await phone("https://web.push.apple.com/staff"), { staffId: "test-staff" });
	});

	it("a quest's reminder goes to the owner's phones when it picked none", async () => {
		expect(await notify({ title: "Mix the EP", message: "Starting now", source: "quest", kind: "starting" })).toBe(200);
		expect(delivered).toEqual(["https://web.push.apple.com/owner"]);
	});

	it("a quest's reminder goes to just the phone it picked", async () => {
		await notify({ title: "Mix the EP", message: "Starting now", source: "quest", kind: "starting", phones: [await phoneId("https://web.push.apple.com/staff")] });
		expect(delivered).toEqual(["https://web.push.apple.com/staff"]);
	});

	it("the Fixer's pings (a fix to approve) reach only the admins' phones", async () => {
		expect(await notify({ title: "A fix is ready for you", message: "Nothing changes until you tap Approve", source: "fixer", kind: "fixer" })).toBe(200);
		expect(delivered).toEqual(["https://web.push.apple.com/owner"]);
	});

	it("P0-4: a quest's reminder for A reaches only A's phones, never B's", async () => {
		// A is test-staff (not the studio owner); B is test-admin
		await notify({ title: "Practise scales", message: "Starting now", source: "quest", kind: "starting", owner: "test-staff" });
		expect(delivered).toEqual(["https://web.push.apple.com/staff"]);
		delivered = [];
		await notify({ title: "Mix the EP", message: "Starting now", source: "quest", kind: "starting", owner: "test-admin" });
		expect(delivered).toEqual(["https://web.push.apple.com/owner"]);
		delivered = [];
		// An old Nova Agent's mission news too (Missions went from Nova: it's treated as a quest's)
		await notify({ title: "Mission planned", message: "12 quests", source: "mission", kind: "mission", owner: "test-staff" });
		expect(delivered).toEqual(["https://web.push.apple.com/staff"]);
	});

	it("P0-4: someone with no phone gets nothing (it never falls back to another person's phone)", async () => {
		await notify({ title: "Practise scales", message: "Starting now", source: "quest", kind: "starting", owner: "someone-new" });
		expect(delivered).toEqual([]);
	});

	it("P0-4: phones picked on the quest still win over its owner's", async () => {
		await notify({ title: "Mix the EP", message: "Starting now", source: "quest", kind: "starting", owner: "test-staff", phones: [await phoneId("https://web.push.apple.com/owner")] });
		expect(delivered).toEqual(["https://web.push.apple.com/owner"]);
	});

	it("Nova Agent's own alerts (its own problems) still reach every phone", async () => {
		await notify({ title: "Can't log in", message: "Run npm run login" });
		expect(delivered.sort()).toEqual(["https://web.push.apple.com/owner", "https://web.push.apple.com/staff"]);
	});
});

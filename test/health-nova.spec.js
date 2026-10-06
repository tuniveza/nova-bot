import { createExecutionContext, env, waitOnExecutionContext } from "cloudflare:test";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import worker from "../src";
import { dailyHealthCheck } from "../src/nova/health.js";
import { clearTables, connectGoogle, installFakes } from "./fakes.js";
import { savePhone } from "../src/push.js";

const BASE = "https://novacane-worker.test";

// ----- Fake push keys and one signed-up phone (as in push.spec.js) -----

const b64url = (bytes) => btoa(String.fromCharCode(...new Uint8Array(bytes))).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");

async function vapidKeys() {
	const pair = await crypto.subtle.generateKey({ name: "ECDSA", namedCurve: "P-256" }, true, ["sign", "verify"]);
	const jwk = await crypto.subtle.exportKey("jwk", pair.privateKey);
	const raw = await crypto.subtle.exportKey("raw", pair.publicKey);
	return { VAPID_PUBLIC_KEY: b64url(raw), VAPID_PRIVATE_KEY: jwk.d };
}

async function phone(endpoint) {
	const pair = await crypto.subtle.generateKey({ name: "ECDH", namedCurve: "P-256" }, true, ["deriveBits"]);
	return { endpoint, keys: { p256dh: b64url(await crypto.subtle.exportKey("raw", pair.publicKey)), auth: b64url(crypto.getRandomValues(new Uint8Array(16))) } };
}

let keys;
let fakes;

beforeEach(async () => {
	keys = await vapidKeys();
	await clearTables();
	fakes = installFakes();
	await connectGoogle();
	await savePhone(env, await phone("https://web.push.apple.com/staff-phone"));
});

afterEach(() => {
	vi.restoreAllMocks();
});

const alerts = async () => (await env.DB.prepare("SELECT title, body FROM notifications ORDER BY id").all()).results;
const sent = () => fakes.push.length;

// 06:00 UK on 5 October 2026 (British Summer Time, so 05:00 UTC)
const SIX_AM = new Date("2026-10-05T05:00:00Z");

describe("daily Google and Stripe check", () => {
	it("does nothing when both answer", async () => {
		await dailyHealthCheck({ ...env, ...keys }, SIX_AM);
		expect(fakes.google.calls.some((c) => c.includes("/freeBusy"))).toBe(true);
		expect(sent()).toBe(0);
	});

	it("tells staff phones when Google stops working", async () => {
		fakes.google.failCalendar = true;
		await dailyHealthCheck({ ...env, ...keys }, SIX_AM);
		expect(sent()).toBe(1);
		const [alert] = await alerts();
		expect(alert.title).toBe("Bookings need attention");
		expect(alert.body).toContain("Google:");
	});

	it("tells staff phones when the Stripe key stops working", async () => {
		fakes.stripe.fail = true;
		await dailyHealthCheck({ ...env, ...keys }, SIX_AM);
		const [alert] = await alerts();
		expect(alert.body).toContain("Stripe: Stripe: Invalid API Key provided");
	});

	it("only runs at 06:00 UK", async () => {
		fakes.google.failCalendar = true;
		await dailyHealthCheck({ ...env, ...keys }, new Date("2026-10-05T06:00:00Z"));
		expect(sent()).toBe(0);
	});
});

describe("alerts from Nova Agent", () => {
	async function notify(body, key) {
		const ctx = createExecutionContext();
		const headers = { "Content-Type": "application/json" };
		if (key !== undefined) headers.Authorization = `Bearer ${key}`;
		const res = await worker.fetch(
			new Request(BASE + "/hub/notify", { method: "POST", headers, body: JSON.stringify(body) }),
			{ ...env, ...keys, AGENT_NOVA_KEY: "agent-nova-test-key" },
			ctx
		);
		await waitOnExecutionContext(ctx);
		return { status: res.status, data: await res.json() };
	}

	it("sends them to staff phones with the right key", async () => {
		const res = await notify({ title: "Can't log in", message: "Run npm run login" }, "agent-nova-test-key");
		expect(res.status).toBe(200);
		expect(sent()).toBe(1);
		expect(await alerts()).toEqual([{ title: "Nova Agent: Can't log in", body: "Run npm run login" }]);
	});

	it("turns away a wrong or missing key", async () => {
		expect((await notify({ title: "Hi" }, "wrong")).status).toBe(401);
		expect((await notify({ title: "Hi" })).status).toBe(401);
		expect(sent()).toBe(0);
	});

	it("needs a title", async () => {
		expect((await notify({ message: "no title" }, "agent-nova-test-key")).status).toBe(400);
	});
});

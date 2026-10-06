import { createExecutionContext, env, waitOnExecutionContext } from "cloudflare:test";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import worker from "../src";
import { dailyAcuityCheck } from "../src/health.js";
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
let pushes = 0; // notifications handed to "Apple"
let acuityStatus = 200; // what "Acuity's API" answers
let acuityCalls = 0;

beforeEach(async () => {
	pushes = 0;
	acuityStatus = 200;
	acuityCalls = 0;
	keys = await vapidKeys();
	vi.spyOn(globalThis, "fetch").mockImplementation(async (url) => {
		if (String(url).startsWith("https://web.push.apple.com/")) {
			pushes++;
			return new Response(null, { status: 201 });
		}
		if (String(url).startsWith("https://acuityscheduling.com/api/v1/appointments")) {
			acuityCalls++;
			return new Response(JSON.stringify(acuityStatus === 200 ? [] : { error: "unauthorized" }), { status: acuityStatus });
		}
		throw new Error("Unexpected fetch in test: " + url);
	});
	await env.DB.batch([env.DB.prepare("DELETE FROM push_subscriptions"), env.DB.prepare("DELETE FROM notifications")]);
	await savePhone(env, await phone("https://web.push.apple.com/staff-phone"));
});

afterEach(() => {
	vi.restoreAllMocks();
});

const alerts = async () => (await env.DB.prepare("SELECT title, body FROM notifications ORDER BY id").all()).results;

// 06:00 UK on 5 October 2026 (British Summer Time, so 05:00 UTC)
const SIX_AM = new Date("2026-10-05T05:00:00Z");

describe("daily Acuity API check", () => {
	it("does nothing when Acuity answers", async () => {
		await dailyAcuityCheck({ ...env, ...keys }, SIX_AM);
		expect(acuityCalls).toBe(1);
		expect(pushes).toBe(0);
	});

	it("tells staff phones when the API key stops working", async () => {
		acuityStatus = 401;
		await dailyAcuityCheck({ ...env, ...keys }, SIX_AM);
		expect(pushes).toBe(1);
		const [alert] = await alerts();
		expect(alert.title).toBe("NovaBot can't reach Acuity");
		expect(alert.body).toContain("refused the API key");
	});

	it("only runs at 06:00 UK, once a day", async () => {
		acuityStatus = 401;
		await dailyAcuityCheck({ ...env, ...keys }, new Date("2026-10-05T05:01:00Z"));
		await dailyAcuityCheck({ ...env, ...keys }, new Date("2026-10-05T06:00:00Z"));
		expect(acuityCalls).toBe(0);
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
		expect(pushes).toBe(1);
		expect(await alerts()).toEqual([{ title: "Nova Agent: Can't log in", body: "Run npm run login" }]);
	});

	it("labels Nova Quest and Nova Mission alerts, and treats an unknown source as Nova Agent", async () => {
		await notify({ title: "Up next at 19:30: Vocals", message: "Ready when you are.", source: "quest", kind: "starting", tag: "q1", ttl: 600 }, "agent-nova-test-key");
		await notify({ title: "Mission complete", message: "Release the EP", source: "mission", kind: "mission", urgent: true }, "agent-nova-test-key");
		await notify({ title: "Odd", message: "x", source: "<script>" }, "agent-nova-test-key");
		expect(pushes).toBe(3);
		const titles = (await alerts()).map((a) => a.title).sort();
		expect(titles).toEqual(["Nova Agent: Odd", "Nova Mission: Mission complete", "Nova Quest: Up next at 19:30: Vocals"]);
	});

	it("turns away a wrong or missing key", async () => {
		expect((await notify({ title: "Hi" }, "wrong")).status).toBe(401);
		expect((await notify({ title: "Hi" })).status).toBe(401);
		expect(pushes).toBe(0);
	});

	it("needs a title", async () => {
		expect((await notify({ message: "no title" }, "agent-nova-test-key")).status).toBe(400);
	});
});

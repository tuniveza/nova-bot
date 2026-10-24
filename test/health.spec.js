import { createExecutionContext, env, waitOnExecutionContext } from "cloudflare:test";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import worker from "../src";
import { savePhone } from "../src/push.js";
import { questsForPortal, queueQuestAction } from "../src/agent-nova.js";

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

beforeEach(async () => {
	pushes = 0;
	keys = await vapidKeys();
	vi.spyOn(globalThis, "fetch").mockImplementation(async (url) => {
		if (String(url).startsWith("https://web.push.apple.com/")) {
			pushes++;
			return new Response(null, { status: 201 });
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

describe("alerts from Nova Agent", () => {
	async function notify(body, key) {
		const ctx = createExecutionContext();
		const headers = { "Content-Type": "application/json" };
		if (key !== undefined) headers.Authorization = `Bearer ${key}`;
		const res = await worker.fetch(
			new Request(BASE + "/nova-agent/notify", { method: "POST", headers, body: JSON.stringify(body) }),
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

	it("labels Quest alerts (an old Nova Agent's \"mission\" one too), and treats an unknown source as Nova Agent", async () => {
		await notify({ title: "Up next at 19:30: Vocals", message: "Ready when you are.", source: "quest", kind: "starting", tag: "q1", ttl: 600 }, "agent-nova-test-key");
		await notify({ title: "Mission complete", message: "Release the EP", source: "mission", kind: "mission", urgent: true }, "agent-nova-test-key");
		await notify({ title: "Odd", message: "x", source: "<script>" }, "agent-nova-test-key");
		expect(pushes).toBe(3);
		const titles = (await alerts()).map((a) => a.title).sort();
		expect(titles).toEqual(["Nova Agent: Odd", "Quest: Mission complete", "Quest: Up next at 19:30: Vocals"]);
	});

	it("rings the phone for quick repeats without filling the Alerts list", async () => {
		await notify({ title: "Drink water", message: "every 2 s", source: "quest", kind: "pulse", tag: "q1", keep: false }, "agent-nova-test-key");
		expect(pushes).toBe(1);
		expect(await alerts()).toEqual([]);
	});

	it("keeps Nova Agent's plan for Portal, and hands taps back to Nova Agent once", async () => {
		const call = async (path, body) => {
			const ctx = createExecutionContext();
			const res = await worker.fetch(
				new Request(BASE + path, { method: "POST", headers: { "Content-Type": "application/json", Authorization: "Bearer agent-nova-test-key" }, body: JSON.stringify(body) }),
				{ ...env, ...keys, AGENT_NOVA_KEY: "agent-nova-test-key" },
				ctx
			);
			await waitOnExecutionContext(ctx);
			return res.json();
		};
		expect((await call("/nova-agent/quests", { state: { quests: [{ id: "q1", title: "Vocals" }] } })).actions).toEqual([]);
		expect((await questsForPortal(env)).state.quests[0].title).toBe("Vocals");
		await queueQuestAction(env, { kind: "quest", id: "q1", action: "done", minutes: 15 });
		const next = await call("/nova-agent/next", { wait: 0 });
		expect(next.questActions.map((a) => [a.id, a.action])).toEqual([["q1", "done"]]);
		expect((await call("/nova-agent/next", { wait: 0 })).questActions).toEqual([]);
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

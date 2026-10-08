// Google, set up from inside Nova Agent (Admin → Google), and "Sign in with Google"
import { createExecutionContext, env, waitOnExecutionContext } from "cloudflare:test";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import worker from "../src";
import { STAFF_COOKIE } from "./sign-in.js";
import { googleClient, refreshToken, seal, unseal } from "../src/nova/google-keys.js";
import { challengeOf } from "../src/portal/google-signin.js";
import { sha256 } from "../src/portal/auth.js";

const BASE = "https://novacane-worker.test";
const ID = "123-abc.apps.googleusercontent.com";
const SECRET = "GOCSPX-a-test-client-secret";
// The same Worker, with no Google secrets set (the way production is): keys come from Admin → Google
const bare = () => ({ ...env, GOOGLE_CLIENT_ID: undefined, GOOGLE_CLIENT_SECRET: undefined });

async function call(path, { e = bare(), method = "GET", cookie = "", form, json, headers = {} } = {}) {
	const h = { ...headers };
	if (cookie) h.Cookie = cookie;
	let body;
	if (form) {
		body = new URLSearchParams(form);
		h["Content-Type"] = "application/x-www-form-urlencoded";
	}
	if (json) {
		body = JSON.stringify(json);
		h["Content-Type"] = "application/json";
	}
	if (method !== "GET") h.Origin = BASE;
	const ctx = createExecutionContext();
	const res = await worker.fetch(new Request(BASE + path, { method, headers: h, body, redirect: "manual" }), e, ctx);
	await waitOnExecutionContext(ctx);
	return res;
}

// The page a sign-in lands on, as words
const words = async (res) => (await res.text()).replace(/&#39;/g, "'");
const idToken = (claims) => "x." + btoa(JSON.stringify(claims)).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "") + ".y";
function googleAnswers(claims) {
	vi.spyOn(globalThis, "fetch").mockImplementation(async (url, init) => {
		if (String(url) === "https://oauth2.googleapis.com/token") {
			const sent = new URLSearchParams(init.body);
			googleAnswers.sent = sent;
			return Response.json({ access_token: "a", id_token: idToken(claims) });
		}
		throw new Error("Unexpected fetch " + url);
	});
}
const good = (email) => ({ iss: "https://accounts.google.com", aud: ID, exp: Math.floor(Date.now() / 1000) + 600, email, email_verified: true });

async function addPerson(id, email, role = "staff", status = "active") {
	await env.DB.prepare("INSERT OR REPLACE INTO staff (id, email, password_hash, display_name, role, status, created_at, planet_seed, index_partition) VALUES (?, ?, NULL, ?, ?, ?, ?, ?, ?)")
		.bind(id, email, id.toUpperCase(), role, status, new Date().toISOString(), id, `staff:${id}`)
		.run();
}
async function staffCookie(id) {
	const token = "session-" + id;
	const now = new Date().toISOString();
	await env.DB.prepare("INSERT OR REPLACE INTO sessions (id, staff_id, kind, created_at, expires_at, last_seen_at) VALUES (?, ?, 'cookie', ?, ?, ?)")
		.bind(await sha256(token), id, now, new Date(Date.now() + 86_400_000).toISOString(), now)
		.run();
	return `nova_session=${token}`;
}

// Start a sign-in, then come back from Google with the cookie it set
async function signInWithGoogle(claims, start = "/auth/google/start?return=/agent/") {
	const go = await call(start);
	const cookie = (go.headers.get("Set-Cookie") || "").split(";")[0];
	const state = new URL(go.headers.get("Location")).searchParams.get("state");
	googleAnswers(claims);
	return call(`/auth/google/callback?code=c0de&state=${state}`, { cookie });
}

beforeEach(async () => {
	await env.DB.prepare("DELETE FROM settings WHERE key LIKE 'google_%'").run();
	await env.DB.prepare("DELETE FROM sessions WHERE staff_id != 'test-admin'").run();
	await env.DB.prepare("DELETE FROM staff WHERE id NOT IN ('test-admin')").run();
});
afterEach(() => vi.restoreAllMocks());

describe("Google's key, pasted into Admin → Google", () => {
	it("is kept with the secret encrypted, and every feature reads it", async () => {
		expect((await googleClient(bare())).id).toBe("");
		const res = await call("/admin/google/setup", { method: "POST", cookie: STAFF_COOKIE, form: { client_id: ID, client_secret: SECRET } });
		expect(decodeURIComponent(res.headers.get("Location"))).toContain("Saved ✓");
		const kept = await env.DB.prepare("SELECT value FROM settings WHERE key = 'google_client_secret_enc'").first("value");
		expect(kept).not.toContain(SECRET);
		expect(await googleClient(bare())).toEqual({ id: ID, secret: SECRET, from: "app" });
		// The page never shows the secret again
		const page = await (await call("/admin/google/setup", { cookie: STAFF_COOKIE })).text();
		expect(page).toContain("Key saved ✓");
		expect(page).not.toContain(SECRET);
	});

	it("turns down things that aren't a Google key", async () => {
		const res = await call("/admin/google/setup", { method: "POST", cookie: STAFF_COOKIE, form: { client_id: "nope", client_secret: SECRET } });
		expect(decodeURIComponent(res.headers.get("Location"))).toContain("doesn't look right");
		expect((await googleClient(bare())).id).toBe("");
	});

	it("is for admins only", async () => {
		await addPerson("sam", "sam@novacane.test");
		const cookie = await staffCookie("sam");
		expect((await call("/admin/google/setup", { method: "POST", cookie, form: { client_id: ID, client_secret: SECRET } })).status).toBe(403);
		expect((await call("/admin/google/setup", { cookie })).status).toBe(403);
	});

	it("Cloudflare secrets, if set, still win", async () => {
		await call("/admin/google/setup", { method: "POST", cookie: STAFF_COOKIE, form: { client_id: ID, client_secret: SECRET } });
		expect((await googleClient(env)).from).toBe("secrets");
	});

	it("can't be read with a different AGENT_NOVA_KEY", async () => {
		const sealed = await seal(env, "hello");
		expect(await unseal(env, sealed)).toBe("hello");
		expect(await unseal({ ...env, AGENT_NOVA_KEY: "another-key" }, sealed)).toBe("");
	});

	it("still reads a refresh token kept the old way", async () => {
		await env.DB.prepare("INSERT INTO settings (key, value) VALUES ('google_refresh_token', 'rt-old')").run();
		expect(await refreshToken(bare())).toBe("rt-old");
	});

	it("can be removed", async () => {
		await call("/admin/google/setup", { method: "POST", cookie: STAFF_COOKIE, form: { client_id: ID, client_secret: SECRET } });
		await call("/admin/google/setup/remove", { method: "POST", cookie: STAFF_COOKIE, form: {} });
		expect((await googleClient(bare())).id).toBe("");
	});
});

describe("Sign in with Google", () => {
	beforeEach(async () => {
		await call("/admin/google/setup", { method: "POST", cookie: STAFF_COOKIE, form: { client_id: ID, client_secret: SECRET } });
		await addPerson("ana", "Ana@Novacane.test");
	});

	it("says whether it's available (and the public client ID)", async () => {
		expect(await (await call("/auth/google/available")).json()).toEqual({ available: true, clientId: ID });
		await call("/admin/google/setup/remove", { method: "POST", cookie: STAFF_COOKIE, form: {} });
		expect((await (await call("/auth/google/available")).json()).available).toBe(false);
	});

	it("goes to Google asking only who you are, with PKCE", async () => {
		const go = await call("/auth/google/start?return=/agent/");
		const to = new URL(go.headers.get("Location"));
		expect(to.hostname).toBe("accounts.google.com");
		expect(to.searchParams.get("scope")).toBe("openid email");
		expect(to.searchParams.get("code_challenge_method")).toBe("S256");
		expect(to.searchParams.get("redirect_uri")).toBe(`${BASE}/auth/google/callback`);
		expect(go.headers.get("Set-Cookie")).toMatch(/HttpOnly; Secure; SameSite=Lax/);
	});

	it("signs in the person whose Portal email matches (any capitals)", async () => {
		const res = await signInWithGoogle(good("ana@novacane.test"));
		expect(res.status).toBe(303);
		expect(res.headers.get("Location")).toBe("/agent/");
		const cookies = res.headers.getSetCookie().join("\n");
		expect(cookies).toMatch(/nova_session=/);
		expect(googleAnswers.sent.get("code_verifier")).toMatch(/^[\w-]{43}$/);
	});

	it("tells a popup to let Nova Agent know, and close", async () => {
		const res = await signInWithGoogle(good("ana@novacane.test"), "/auth/google/start?popup=1");
		expect(res.status).toBe(200);
		const html = await res.text();
		expect(html).toContain('new BroadcastChannel("nova-portal")');
		expect(html).toContain("window.close");
	});

	it("turns away a Google account that isn't on the team", async () => {
		const res = await signInWithGoogle(good("stranger@gmail.com"));
		expect(res.status).toBe(400);
		expect(await words(res)).toContain("isn't on the team yet");
		expect(res.headers.getSetCookie().join("\n")).not.toMatch(/nova_session=[^;]/);
	});

	it("turns away an email Google hasn't verified", async () => {
		const res = await signInWithGoogle({ ...good("ana@novacane.test"), email_verified: false });
		expect(await words(res)).toContain("isn't verified");
	});

	it("turns away an answer meant for another app", async () => {
		const res = await signInWithGoogle({ ...good("ana@novacane.test"), aud: "someone-else.apps.googleusercontent.com" });
		expect(await words(res)).toContain("didn't check out");
	});

	it("turns away a callback that didn't start here", async () => {
		await call("/auth/google/start");
		googleAnswers(good("ana@novacane.test"));
		const res = await call("/auth/google/callback?code=c0de&state=forged");
		expect(await words(res)).toContain("didn't start here");
	});

	it("uses a Google email an admin linked to someone", async () => {
		await call("/admin/google/logins", { method: "POST", cookie: STAFF_COOKIE, form: { g_ana: "ana.personal@gmail.com" } });
		const res = await signInWithGoogle(good("ana.personal@gmail.com"));
		expect(res.status).toBe(303);
	});

	it("leaves out someone switched off", async () => {
		await addPerson("old", "old@novacane.test", "staff", "disabled");
		expect(await words(await signInWithGoogle(good("old@novacane.test")))).toContain("switched off");
	});
});

describe("Sign in with Google on the studio PC", () => {
	const verifier = "v".repeat(43);
	beforeEach(async () => {
		await call("/admin/google/setup", { method: "POST", cookie: STAFF_COOKIE, form: { client_id: ID, client_secret: SECRET } });
		await addPerson("ana", "ana@novacane.test");
	});

	async function pcCode() {
		const challenge = await challengeOf(verifier);
		const res = await signInWithGoogle(good("ana@novacane.test"), `/auth/google/start?pc=${challenge}&back=${encodeURIComponent("http://localhost:4545")}`);
		expect(res.status).toBe(303);
		const to = new URL(res.headers.get("Location"));
		expect(to.origin + to.pathname).toBe("http://localhost:4545/auth/google/done");
		return new URLSearchParams(to.hash.slice(1)).get("code");
	}

	it("hands the PC a one-time code it swaps for its own sign-in", async () => {
		const code = await pcCode();
		const res = await call("/auth/google/exchange", { method: "POST", json: { code, verifier, client: "app" } });
		const data = await res.json();
		expect(res.status).toBe(200);
		expect(data.token).toMatch(/^nsess_/);
		expect(data.staff.id).toBe("ana");
		// Once only
		expect((await call("/auth/google/exchange", { method: "POST", json: { code, verifier, client: "app" } })).status).toBe(401);
	});

	it("won't swap the code without the PC's verifier", async () => {
		const code = await pcCode();
		const res = await call("/auth/google/exchange", { method: "POST", json: { code, verifier: "w".repeat(43), client: "app" } });
		expect(res.status).toBe(401);
	});

	it("only sends a code back to Nova Agent on the PC itself", async () => {
		const challenge = await challengeOf(verifier);
		const res = await call(`/auth/google/start?pc=${challenge}&back=${encodeURIComponent("https://evil.example")}`);
		expect(await words(res)).toContain("didn't come from Nova Agent");
	});
});

// Google, set up from inside Nova Agent (Admin → Google). Google is a connection for Docs,
// Calendar and Gmail, never a way to sign in: Portal is the one sign-in.
import { createExecutionContext, env, waitOnExecutionContext } from "cloudflare:test";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import worker from "../src";
import { STAFF_COOKIE } from "./sign-in.js";
import { googleClient, refreshToken, seal, unseal } from "../src/nova/google-keys.js";
import { sha256 } from "../src/portal/auth.js";

const BASE = "https://novacane-worker.test";
const ID = "123-abc.apps.googleusercontent.com";
const SECRET = "GOCSPX-a-test-client-secret";
// The same Worker, with no Google secrets set (the way production is): keys come from Admin → Google
const bare = () => ({ ...env, GOOGLE_CLIENT_ID: undefined, GOOGLE_CLIENT_SECRET: undefined });

async function call(path, { e = bare(), method = "GET", cookie = "", form, headers = {} } = {}) {
	const h = { ...headers };
	if (cookie) h.Cookie = cookie;
	let body;
	if (form) {
		body = new URLSearchParams(form);
		h["Content-Type"] = "application/x-www-form-urlencoded";
	}
	if (method !== "GET") h.Origin = BASE;
	const ctx = createExecutionContext();
	const res = await worker.fetch(new Request(BASE + path, { method, headers: h, body, redirect: "manual" }), e, ctx);
	await waitOnExecutionContext(ctx);
	return res;
}

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


describe("Portal is the one sign-in", () => {
	it.each(["/auth/google/available", "/auth/google/start", "/auth/google/callback?code=x&state=y"])("%s isn't a way in", async (path) => {
		const res = await call(path);
		expect(res.status).not.toBe(200);
		expect(res.headers.get("Set-Cookie") || "").not.toContain("nova_session=");
	});

	it("Admin → Google offers no Google sign-in", async () => {
		const res = await call("/admin/google/setup", { cookie: STAFF_COOKIE });
		const page = await res.text();
		expect(page).not.toContain("Sign in with Google");
		expect(page).not.toContain("/auth/google/callback");
		expect(page).toContain("/admin/google/callback");
	});
});

describe("Google's status, for Portal and Notes", () => {
	it("is for signed-in staff only", async () => {
		expect((await call("/auth/google-status")).status).toBe(401);
	});

	it("says whether Google is set up, as whom, and gives the public client ID", async () => {
		let d = await (await call("/auth/google-status", { cookie: STAFF_COOKIE })).json();
		expect(d).toMatchObject({ setUp: false, clientId: "", admin: true });
		await call("/admin/google/setup", { method: "POST", cookie: STAFF_COOKIE, form: { client_id: ID, client_secret: SECRET } });
		await env.DB.prepare("INSERT OR REPLACE INTO settings (key, value) VALUES ('google_account', 'studio@example.com')").run();
		d = await (await call("/auth/google-status", { cookie: STAFF_COOKIE })).json();
		expect(d).toMatchObject({ setUp: true, clientId: ID, account: "studio@example.com", admin: true });
		expect(JSON.stringify(d)).not.toContain(SECRET);
	});
});

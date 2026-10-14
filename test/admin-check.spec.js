// GET /app/api/admin-check: what Caddy asks before letting a browser through to the VPS's desktop
// (Computer panel). Admins signed in with Portal's cookie only: not staff, not the looks account,
// not signed out.
import { createExecutionContext, env, waitOnExecutionContext } from "cloudflare:test";
import { STAFF_COOKIE } from "./sign-in.js";
import { describe, expect, it } from "vitest";
import worker from "../src";
import { sha256 } from "../src/portal/auth.js";
import { LOOKS_ID } from "../src/looks-account.js";

const BASE = "https://novacane-worker.test";

async function status(headers = {}) {
	const ctx = createExecutionContext();
	const res = await worker.fetch(new Request(`${BASE}/app/api/admin-check`, { headers }), env, ctx);
	await waitOnExecutionContext(ctx);
	return res.status;
}

async function signIn(id, role, token) {
	const now = new Date().toISOString();
	const later = new Date(Date.now() + 86_400_000).toISOString();
	await env.DB.batch([
		env.DB.prepare("INSERT OR REPLACE INTO staff (id, email, password_hash, display_name, role, status, created_at, planet_seed, index_partition) VALUES (?, ?, NULL, ?, ?, 'active', ?, ?, ?)").bind(id, `${id}@novacane.test`, id, role, now, id, `staff:${id}`),
		env.DB.prepare("INSERT OR REPLACE INTO sessions (id, staff_id, kind, created_at, expires_at, last_seen_at) VALUES (?, ?, 'cookie', ?, ?, ?)").bind(await sha256(token), id, now, later, now),
	]);
	return `nova_session=${token}`;
}

describe("the desktop's admin check", () => {
	it("lets a signed-in admin through", async () => {
		expect(await status({ Cookie: STAFF_COOKIE })).toBe(204);
	});
	it("turns away signed-out browsers, staff who aren't admins, and the looks account", async () => {
		expect(await status()).toBe(401);
		expect(await status({ Cookie: await signIn("test-staff", "staff", "staff-session") })).toBe(403);
		expect(await status({ Cookie: await signIn(LOOKS_ID, "admin", "looks-session") })).toBe(403);
	});
});

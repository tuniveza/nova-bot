// Signed in the one way there is: a Portal account and its session. Before every test
// a test admin is signed in; send STAFF_COOKIE (or STAFF_AUTH as headers) to be them.
import { env } from "cloudflare:test";
import { beforeEach } from "vitest";
import { sha256 } from "../src/portal/auth.js";

export const STAFF_TOKEN = "test-admin-portal-session";
export const STAFF_COOKIE = `nova_session=${STAFF_TOKEN}`;
export const STAFF_AUTH = { Cookie: STAFF_COOKIE };

beforeEach(async () => {
	const now = new Date().toISOString();
	const later = new Date(Date.now() + 86_400_000).toISOString();
	await env.DB.batch([
		env.DB.prepare("INSERT OR IGNORE INTO staff (id, email, password_hash, display_name, role, status, created_at, planet_seed, index_partition) VALUES ('test-admin', 'test-admin@novacane.test', NULL, 'Test Admin', 'admin', 'active', ?, 'test-admin', 'staff:test-admin')").bind(now),
		env.DB.prepare("INSERT OR REPLACE INTO sessions (id, staff_id, kind, created_at, expires_at, last_seen_at) VALUES (?, 'test-admin', 'cookie', ?, ?, ?)").bind(await sha256(STAFF_TOKEN), now, later, now),
	]);
});

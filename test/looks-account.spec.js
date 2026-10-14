// The Fixer's looks check account (src/looks-account.js): made by Nova Agent with its key, signs in
// for one check, can only look, isn't listed with the team, and is gone when the check ends.
import { createExecutionContext, env, waitOnExecutionContext } from "cloudflare:test";
import { describe, expect, it } from "vitest";
import worker from "../src";
import { STAFF_AUTH } from "./sign-in.js";

const BASE = "https://novacane-worker.test";
const KEY = "agent-nova-test-key";

async function call(path, { method = "GET", headers = {}, body } = {}) {
	const ctx = createExecutionContext();
	const init = { method, headers: { ...headers } };
	if (body !== undefined) {
		init.body = JSON.stringify(body);
		init.headers["Content-Type"] = "application/json";
	}
	const res = await worker.fetch(new Request(BASE + path, init), { ...env, AGENT_NOVA_KEY: KEY }, ctx);
	await waitOnExecutionContext(ctx);
	return { status: res.status, data: await res.json().catch(() => null) };
}
const start = (key = KEY) => call("/nova-agent/looks-session", { method: "POST", headers: { Authorization: `Bearer ${key}` }, body: { action: "start" } });
const end = () => call("/nova-agent/looks-session", { method: "POST", headers: { Authorization: `Bearer ${KEY}` }, body: { action: "end" } });

describe("The Fixer's looks check account", () => {
	it("only Nova Agent (its key) can start one", async () => {
		expect((await start("wrong-key")).status).toBe(401);
		expect(await env.DB.prepare("SELECT 1 FROM staff WHERE id = 'fixer-looks'").first()).toBeNull();
	});

	it("signs in as an admin with no password, for a short time", async () => {
		const { status, data } = await start();
		expect(status).toBe(200);
		expect(data.cookie).toBe("nova_session");
		expect(data.token).toMatch(/^[\w-]{20,}$/);
		const row = await env.DB.prepare("SELECT role, status, password_hash FROM staff WHERE id = 'fixer-looks'").first();
		expect(row).toEqual({ role: "admin", status: "active", password_hash: null });
		const s = await env.DB.prepare("SELECT expires_at FROM sessions WHERE staff_id = 'fixer-looks'").first();
		expect(Date.parse(s.expires_at) - Date.now()).toBeLessThanOrEqual(46 * 60_000);
		const me = await call("/auth/me", { headers: { Cookie: `nova_session=${data.token}` } });
		expect(me.status).toBe(200);
		expect(me.data.staff.role).toBe("admin");
	});

	it("can only look: a write is treated as signed out", async () => {
		const { data } = await start();
		const cookie = { Cookie: `nova_session=${data.token}` };
		const pw = await call("/auth/password", { method: "POST", headers: { ...cookie, Origin: BASE }, body: { password: "a long enough new password 123" } });
		expect(pw.status).toBe(401);
		expect((await env.DB.prepare("SELECT password_hash FROM staff WHERE id = 'fixer-looks'").first()).password_hash).toBeNull();
		const ws = await call("/auth/me", { headers: { ...cookie, Upgrade: "websocket" } });
		expect(ws.status).toBe(401);
	});

	it("isn't listed with the team", async () => {
		await start();
		const team = await call("/staff", { headers: STAFF_AUTH });
		expect(team.status).toBe(200);
		expect(team.data.staff.map((s) => s.id)).not.toContain("fixer-looks");
	});

	it("is gone when the check ends", async () => {
		const { data } = await start();
		expect((await end()).status).toBe(200);
		expect(await env.DB.prepare("SELECT 1 FROM staff WHERE id = 'fixer-looks'").first()).toBeNull();
		expect(await env.DB.prepare("SELECT 1 FROM sessions WHERE staff_id = 'fixer-looks'").first()).toBeNull();
		expect((await call("/auth/me", { headers: { Cookie: `nova_session=${data.token}` } })).status).toBe(401);
	});
});

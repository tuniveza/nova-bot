// P0-4: Portal's Quests are each person's own. Nova Agent sends everyone's plan with whose each
// quest and mission is; Portal shows the signed-in person theirs, and an admin can switch to
// everyone's. Taps say who tapped (Nova Agent lets staff change only their own).
import { createExecutionContext, env, waitOnExecutionContext } from "cloudflare:test";
import { beforeEach, describe, expect, it } from "vitest";
import worker from "../src";
import { sha256 } from "../src/portal/auth.js";
import { studioOwner } from "../src/push.js";
import { STAFF_COOKIE } from "./sign-in.js";

const BASE = "https://novacane-worker.test";
const KEY = "agent-nova-test-key";
const STAFF_TOKEN = "test-staff-portal-session";
const STAFF_ONLY_COOKIE = `nova_session=${STAFF_TOKEN}`;

async function call(path, { cookie, body, key } = {}) {
	const ctx = createExecutionContext();
	const headers = { "Content-Type": "application/json" };
	if (cookie) Object.assign(headers, { Cookie: cookie, Origin: BASE });
	if (key) headers.Authorization = `Bearer ${key}`;
	const res = await worker.fetch(new Request(BASE + path, { method: body ? "POST" : "GET", headers, body: body ? JSON.stringify(body) : undefined }), env, ctx);
	await waitOnExecutionContext(ctx);
	return { status: res.status, data: await res.json().catch(() => ({})) };
}

// What Nova Agent sends: everyone's, each with its owner (and an old one with none)
const plan = {
	now: "2026-10-11T09:00",
	people: {
		"test-admin": { name: "Test Admin", current: { id: "a1", title: "Mix the EP", owner: "test-admin" }, next: [] },
		"test-staff": { name: "Test Staff", current: { id: "s1", title: "Practise scales", owner: "test-staff" }, next: [{ id: "s2", title: "Edit the video", owner: "test-staff" }] },
	},
	missions: [
		{ id: "m-admin", title: "Release the EP", owner: "test-admin" },
		{ id: "m-staff", title: "Learn piano", owner: "test-staff" },
	],
	quests: [
		{ id: "a1", title: "Mix the EP", owner: "test-admin", status: "doing" },
		{ id: "s1", title: "Practise scales", owner: "test-staff", status: "doing" },
		{ id: "s2", title: "Edit the video", owner: "test-staff", status: "todo" },
		{ id: "old", title: "From before owners", status: "todo" },
	],
	pulses: [{ id: "p-staff", title: "Drink water", owner: "test-staff" }],
	current: { id: "a1", title: "Mix the EP", owner: "test-admin" },
	next: [],
};

beforeEach(async () => {
	const now = new Date().toISOString();
	const later = new Date(Date.now() + 86_400_000).toISOString();
	await env.DB.batch([
		env.DB.prepare("INSERT OR IGNORE INTO staff (id, email, password_hash, display_name, role, status, created_at, planet_seed, index_partition) VALUES ('test-staff', 'test-staff@novacane.test', NULL, 'Test Staff', 'staff', 'active', ?, 'test-staff', 'staff:test-staff')").bind(now),
		env.DB.prepare("INSERT OR REPLACE INTO sessions (id, staff_id, kind, created_at, expires_at, last_seen_at) VALUES (?, 'test-staff', 'cookie', ?, ?, ?)").bind(await sha256(STAFF_TOKEN), now, later, now),
		env.DB.prepare("DELETE FROM settings WHERE key IN ('nova_quests', 'nova_quest_actions')"),
	]);
	expect((await call("/nova-agent/quests", { key: KEY, body: { state: plan } })).status).toBe(200);
});

const titles = (list) => list.map((x) => x.title).sort();

describe("Portal's Quests: each person's own", () => {
	it("a member of staff sees only their own quests, missions, pulses and 'now'", async () => {
		const { status, data } = await call("/app/api/quests", { cookie: STAFF_ONLY_COOKIE });
		expect(status).toBe(200);
		expect(data.scope).toBe("mine");
		expect(data.canSeeEveryone).toBe(false);
		expect(titles(data.state.quests)).toEqual(["Edit the video", "Practise scales"]);
		expect(titles(data.state.missions)).toEqual(["Learn piano"]);
		expect(titles(data.state.pulses)).toEqual(["Drink water"]);
		expect(data.state.current.title).toBe("Practise scales");
		expect(titles(data.state.next)).toEqual(["Edit the video"]);
	});

	it("staff can't ask for everyone's", async () => {
		const { data } = await call("/app/api/quests?who=everyone", { cookie: STAFF_ONLY_COOKIE });
		expect(data.scope).toBe("mine");
		expect(titles(data.state.quests)).toEqual(["Edit the video", "Practise scales"]);
	});

	it("an admin sees their own by default, and everyone's when they ask", async () => {
		const owner = (await studioOwner(env))?.id;
		const mine = await call("/app/api/quests", { cookie: STAFF_COOKIE });
		expect(mine.data.canSeeEveryone).toBe(true);
		expect(mine.data.scope).toBe("mine");
		// Quests from before owners are the studio owner's
		expect(titles(mine.data.state.quests)).toEqual(owner === "test-admin" ? ["From before owners", "Mix the EP"] : ["Mix the EP"]);
		expect(mine.data.state.current.title).toBe("Mix the EP");
		const all = await call("/app/api/quests?who=everyone", { cookie: STAFF_COOKIE });
		expect(all.data.scope).toBe("everyone");
		expect(titles(all.data.state.quests)).toEqual(["Edit the video", "From before owners", "Mix the EP", "Practise scales"]);
		expect(titles(all.data.state.missions)).toEqual(["Learn piano", "Release the EP"]);
		// "Now" is still their own
		expect(all.data.state.current.title).toBe("Mix the EP");
	});

	it("a tap says who made it, so Nova Agent can keep staff to their own", async () => {
		expect((await call("/app/api/quests/action", { cookie: STAFF_ONLY_COOKIE, body: { id: "s1", action: "done" } })).status).toBe(200);
		const queued = JSON.parse((await env.DB.prepare("SELECT value FROM settings WHERE key = 'nova_quest_actions'").first("value")) || "[]");
		expect(queued).toEqual([expect.objectContaining({ id: "s1", action: "done", by: "test-staff", admin: false })]);
	});
});

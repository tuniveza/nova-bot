import { createExecutionContext, env, waitOnExecutionContext } from "cloudflare:test";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import worker from "../src";
import { queueQuestAction } from "../src/agent-nova.js";

const BASE = "https://novacane-worker.test";
const KEY = "agent-nova-test-key";

beforeEach(async () => {
	vi.spyOn(globalThis, "fetch").mockImplementation(async (url) => {
		throw new Error("Unexpected fetch in test: " + url);
	});
	await env.DB.batch([env.DB.prepare("DELETE FROM agent_jobs"), env.DB.prepare("DELETE FROM settings"), env.DB.prepare("DELETE FROM notifications")]);
});

afterEach(() => {
	vi.restoreAllMocks();
});

// Nova Agent calling the Worker
async function agent(path, body = {}, key = KEY) {
	const ctx = createExecutionContext();
	const headers = { "Content-Type": "application/json" };
	if (key) headers.Authorization = `Bearer ${key}`;
	const res = await worker.fetch(new Request(BASE + path, { method: "POST", headers, body: JSON.stringify(body) }), { ...env, AGENT_NOVA_KEY: KEY }, ctx);
	await waitOnExecutionContext(ctx);
	return { status: res.status, data: await res.json() };
}

const setting = (key) => env.DB.prepare("SELECT value FROM settings WHERE key = ?").bind(key).first("value");

describe("Nova Agent checking in", () => {
	it("with wait, answers once the wait is over, with no job (the Acuity jobs went with Acuity)", async () => {
		const started = Date.now();
		const { data } = await agent("/nova-agent/next", { wait: 1 });
		expect(data.job).toBeNull();
		expect(data.questActions).toEqual([]);
		expect(Date.now() - started).toBeGreaterThanOrEqual(900);
	});

	it("a Quests tap ends the wait", async () => {
		setTimeout(() => void queueQuestAction(env, { action: "done", id: "q1" }), 300);
		const started = Date.now();
		const { data } = await agent("/nova-agent/next", { wait: 5 });
		expect(Date.now() - started).toBeLessThan(3000);
		expect(data.questActions).toEqual([expect.objectContaining({ action: "done", id: "q1" })]);
	});

	it("notes that Nova Agent checked in, and whether it's live", async () => {
		await agent("/nova-agent/next", { dryRun: true });
		expect(await setting("agent_nova_seen")).toBeTruthy();
		expect(await setting("agent_nova_mode")).toBe("rehearsal");
		await agent("/nova-agent/next", { dryRun: false });
		expect(await setting("agent_nova_mode")).toBe("live");
	});

	it("takes the booking limit from Nova Agent's check-in", async () => {
		const { bookingsPerVisitor } = await import("../src/agent-nova.js");
		expect(await bookingsPerVisitor(env)).toBe(2); // default
		await agent("/nova-agent/next", { bookingsPerVisitor: "unlimited" });
		expect(await bookingsPerVisitor(env)).toBe(Infinity);
		await agent("/nova-agent/next", { bookingsPerVisitor: "5" });
		expect(await bookingsPerVisitor(env)).toBe(5);
		await agent("/nova-agent/next", { bookingsPerVisitor: "lots" }); // nonsense -> safe default
		expect(await bookingsPerVisitor(env)).toBe(2);
	});

	it("there's nothing to report a job's result to any more", async () => {
		expect((await agent("/nova-agent/result", { id: 1, ok: true, message: "Done." })).status).toBe(404);
	});

	it("turns away a wrong or missing key", async () => {
		expect((await agent("/nova-agent/next", {}, "wrong")).status).toBe(401);
		expect((await agent("/nova-agent/next", {}, "")).status).toBe(401);
		expect(await setting("agent_nova_seen")).toBeNull();
	});
});

describe("who Nova Agent works for (its Nova Agent badge)", () => {
	it("returns the Portal profile, or a stand-in before there is one", async () => {
		await env.DB.prepare("DELETE FROM staff").run();
		const before = (await agent("/nova-agent/me", { staff_id: "kai-m" })).data;
		expect(before).toMatchObject({ via: "nova-agent", linked: false, staff: { id: "kai-m", display_name: "Kai M" } });
		expect(before.staff.planet.name).toBeTruthy();
		await env.DB.prepare("INSERT INTO staff (id, email, display_name, role, status, created_at, planet_seed, index_partition) VALUES ('kai-m', 'kai@example.com', 'Kai Mensah', 'admin', 'active', '2026-10-01', 'kai-m', 'staff:kai-m')").run();
		const after = (await agent("/nova-agent/me", { staff_id: "kai-m" })).data;
		expect(after).toMatchObject({ linked: true, staff: { display_name: "Kai Mensah", role: "admin" } });
		expect(after.staff.email).toBeUndefined();
	});

	it("picks the studio's first admin by itself, and hands it what Nova Agent learned as \"owner\"", async () => {
		await env.DB.batch(["DELETE FROM staff", "DELETE FROM memory_files"].map((q) => env.DB.prepare(q)));
		// Nobody in Portal yet: a stand-in
		expect((await agent("/nova-agent/me", {})).data).toMatchObject({ linked: false, auto: true, staff: { id: "owner" } });
		await env.DB.batch([
			env.DB.prepare("INSERT INTO staff (id, email, display_name, role, status, created_at, planet_seed, index_partition) VALUES ('kai-m', 'kai@example.com', 'Kai Mensah', 'staff', 'active', '2026-09-01', 'kai-m', 'staff:kai-m')"),
			env.DB.prepare("INSERT INTO staff (id, email, display_name, role, status, created_at, planet_seed, index_partition) VALUES ('dana-h', 'dana@example.com', 'Dana Hollis', 'admin', 'active', '2026-09-02', 'dana-h', 'staff:dana-h')"),
			env.DB.prepare("INSERT INTO staff (id, email, display_name, role, status, created_at, planet_seed, index_partition) VALUES ('eric-a', 'eric@example.com', 'Eric A', 'admin', 'active', '2026-09-03', 'eric-a', 'staff:eric-a')"),
			env.DB.prepare("INSERT INTO memory_files (id, scope, owner_id, path, name, description, aliases, body, version, source_app, updated_at) VALUES ('m1', 'staff', 'owner', 'profile', 'profile', '', '', '- [stated] mixes late', 'v1', 'agent', 1759300000000)"),
		]);
		const me = (await agent("/nova-agent/me", {})).data;
		expect(me).toMatchObject({ linked: true, auto: true, staff: { id: "dana-h", role: "admin" } });
		const moved = await env.DB.prepare("SELECT owner_id FROM memory_files WHERE id = 'm1'").first("owner_id");
		expect(moved).toBe("dana-h");
		// Asking for someone (connected, or NOVA_STAFF_ID) gets them
		expect((await agent("/nova-agent/me", { staff_id: "kai-m" })).data.staff.id).toBe("kai-m");
	});
});

describe("Portal quest taps", () => {
	const tap = (n, extra = {}) => queueQuestAction(env, { kind: "quest", id: `q${n}`, action: "done", minutes: 15, ...extra });

	it("hands each tap over exactly once, even to two collectors at the same moment", async () => {
		await Promise.all([1, 2, 3].map((n) => tap(n)));
		const [next, quests] = await Promise.all([agent("/nova-agent/next", { wait: 0 }), agent("/nova-agent/quests", { state: { quests: [] } })]);
		const handed = [...(next.data.questActions || []), ...(quests.data.actions || [])].map((a) => a.id).sort();
		expect(handed).toEqual(["q1", "q2", "q3"]);
	});

	it("loses no tap when several are made at once", async () => {
		await Promise.all(Array.from({ length: 10 }, (_, n) => tap(n)));
		const { data } = await agent("/nova-agent/next", { wait: 0 });
		expect(data.questActions).toHaveLength(10);
	});

	it("gives each tap an id, and keeps the session it was tapped on", async () => {
		await tap(1, { session: "2026-10-07T10:30" });
		const { data } = await agent("/nova-agent/next", { wait: 0 });
		expect(data.questActions[0]).toMatchObject({ id: "q1", action: "done", session: "2026-10-07T10:30" });
		expect(data.questActions[0].tapId).toMatch(/^[\w-]{8,}$/);
	});
});

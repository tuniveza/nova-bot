import { createExecutionContext, env, waitOnExecutionContext } from "cloudflare:test";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import worker from "../src";
import { agentNovaProblem, queueAgentJob } from "../src/agent-nova.js";

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

const addJob = (extra = {}) =>
	queueAgentJob(env, { appointmentId: 1001, clientName: "Dana Hollis", changes: { paid: true }, summary: "Dana Hollis, Saturday 31 October 17:00:\n- Paid: yes", ...extra });

const status = async (id) => env.DB.prepare("SELECT status, result FROM agent_jobs WHERE id = ?").bind(id).first();

describe("Nova Agent collecting jobs", () => {
	it("with wait, hands over a job queued while it waits", async () => {
		setTimeout(() => void addJob(), 300);
		const started = Date.now();
		const { data } = await agent("/hub/agent/next", { wait: 5 });
		expect(data.job?.kind).toBe("change");
		expect(Date.now() - started).toBeLessThan(3000);
	});

	it("with wait, answers no job once the wait is over", async () => {
		const started = Date.now();
		const { data } = await agent("/hub/agent/next", { wait: 1 });
		expect(data.job).toBeNull();
		expect(Date.now() - started).toBeGreaterThanOrEqual(900);
	});

	it("hands over the oldest waiting job, once", async () => {
		const first = await addJob();
		await addJob({ changes: { price: "80.00" } });

		const { data } = await agent("/hub/agent/next");
		expect(data.job).toEqual({ id: first, kind: "change", appointmentId: 1001, clientName: "Dana Hollis", changes: { paid: true } });
		expect((await status(first)).status).toBe("working");

		// The next check-in gets the other job, not the same one again
		expect((await agent("/hub/agent/next")).data.job.changes).toEqual({ price: "80.00" });
		expect((await agent("/hub/agent/next")).data.job).toBeNull();
	});

	it("notes that Nova Agent checked in, and whether it's live", async () => {
		const withKey = { ...env, AGENT_NOVA_KEY: KEY };
		expect(await agentNovaProblem(withKey)).toContain("never checked in");
		await agent("/hub/agent/next", { dryRun: true });
		expect(await agentNovaProblem(withKey)).toBe("");
		expect(await agentNovaProblem(withKey, { needLive: true })).toContain("rehearsal mode");
		await agent("/hub/agent/next", { dryRun: false });
		expect(await agentNovaProblem(withKey, { needLive: true })).toBe("");
		expect(await agentNovaProblem(withKey, { now: Date.now() + 10 * 60000 })).toContain("10 minutes ago");
	});

	it("takes the booking limit from Nova Agent's check-in", async () => {
		const { bookingsPerVisitor } = await import("../src/agent-nova.js");
		expect(await bookingsPerVisitor(env)).toBe(2); // default
		await agent("/hub/agent/next", { bookingsPerVisitor: "unlimited" });
		expect(await bookingsPerVisitor(env)).toBe(Infinity);
		await agent("/hub/agent/next", { bookingsPerVisitor: "5" });
		expect(await bookingsPerVisitor(env)).toBe(5);
		await agent("/hub/agent/next", { bookingsPerVisitor: "lots" }); // nonsense -> safe default
		expect(await bookingsPerVisitor(env)).toBe(2);
	});

	it("hands over bookings with their details", async () => {
		const id = await queueAgentJob(env, {
			kind: "book",
			clientName: "Sam Singer",
			changes: { type: "Rap Package - 1 song", date: "2026-11-05", time: "15:00", firstName: "Sam", lastName: "Singer", email: "sam@example.com", phone: "07700 900123" },
			summary: "Rap Package - 1 song",
		});
		const { data } = await agent("/hub/agent/next", { dryRun: false });
		expect(data.job).toEqual({
			id,
			kind: "book",
			clientName: "Sam Singer",
			details: { type: "Rap Package - 1 song", date: "2026-11-05", time: "15:00", firstName: "Sam", lastName: "Singer", email: "sam@example.com", phone: "07700 900123" },
		});
	});

	it("records the result", async () => {
		const id = await addJob();
		await agent("/hub/agent/next");
		const res = await agent("/hub/agent/result", { id, ok: true, message: "Marked as paid." });
		expect(res.status).toBe(200);
		expect(await status(id)).toEqual({ status: "done", result: "Marked as paid." });

		// Can't report on it twice
		expect((await agent("/hub/agent/result", { id, ok: false, message: "again" })).status).toBe(404);
	});

	it("offers a job again if Nova Agent took it but never reported back", async () => {
		const id = await addJob();
		await agent("/hub/agent/next");
		await env.DB.prepare("UPDATE agent_jobs SET picked_at = ? WHERE id = ?").bind(new Date(Date.now() - 20 * 60000).toISOString(), id).run();
		expect((await agent("/hub/agent/next")).data.job.id).toBe(id);
	});

	it("doesn't queue the same change twice while it's waiting", async () => {
		expect(await addJob()).toBe(await addJob());
	});

	it("turns away a wrong or missing key", async () => {
		await addJob();
		expect((await agent("/hub/agent/next", {}, "wrong")).status).toBe(401);
		expect((await agent("/hub/agent/next", {}, "")).status).toBe(401);
		const { results } = await env.DB.prepare("SELECT status FROM agent_jobs").all();
		expect(results).toEqual([{ status: "waiting" }]);
	});
});

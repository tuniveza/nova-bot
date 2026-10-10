// Portal's quest mode chip: the change waits for Nova Agent (like every Portal quest tap)
import { createExecutionContext, env, waitOnExecutionContext } from "cloudflare:test";
import { beforeEach, describe, expect, it } from "vitest";
import worker from "../src";
import { STAFF_COOKIE } from "./sign-in.js";

const BASE = "https://novacane-worker.test";
async function tap(body) {
	const ctx = createExecutionContext();
	const res = await worker.fetch(new Request(BASE + "/app/api/quests/action", { method: "POST", headers: { Cookie: STAFF_COOKIE, Origin: BASE, "Content-Type": "application/json" }, body: JSON.stringify(body) }), env, ctx);
	await waitOnExecutionContext(ctx);
	return res.status;
}
const queued = async () => JSON.parse((await env.DB.prepare("SELECT value FROM settings WHERE key = 'nova_quest_actions'").first("value")) || "[]");

beforeEach(async () => {
	await env.DB.prepare("DELETE FROM settings WHERE key = 'nova_quest_actions'").run();
});

describe("quest modes from Portal", () => {
	it("a mode is queued for Nova Agent with the tap", async () => {
		expect(await tap({ id: "q1", action: "mode", mode: "nearly" })).toBe(200);
		expect(await queued()).toEqual([expect.objectContaining({ kind: "quest", id: "q1", action: "mode", mode: "nearly" })]);
	});
	it("a mode that isn't one is turned away", async () => {
		expect(await tap({ id: "q1", action: "mode", mode: "wait" })).toBe(400);
		expect(await queued()).toEqual([]);
	});
});

// Ask Index (src/memory/ask.js): a plain-English question, answered only from the facts the
// asker may read, typos forgiven, with its sources; cached until the memory changes.
import { createExecutionContext, env, waitOnExecutionContext } from "cloudflare:test";
import { STAFF_COOKIE } from "./sign-in.js";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import worker from "../src";
import { alike, askIndex, near, pickFacts } from "../src/memory/ask.js";
import { putFile } from "../src/memory/store.js";

const BASE = "https://novacane-worker.test";
const AGENT = { Authorization: "Bearer agent-nova-test-key", "Content-Type": "application/json" };

// Claude stands in: each call takes the next prepared answer (a tool call's input)
let answers = [];
let calls = [];
beforeEach(async () => {
	answers = [];
	calls = [];
	await env.DB.batch(["DELETE FROM memory_files", "DELETE FROM memory_pending"].map((q) => env.DB.prepare(q)));
	vi.spyOn(globalThis, "fetch").mockImplementation(async (url, init) => {
		if (String(url) === "https://api.anthropic.com/v1/messages") {
			const body = JSON.parse(init.body);
			calls.push(body);
			const input = answers.shift();
			if (!input) return new Response("down", { status: 529 });
			return Response.json({ content: [{ type: "tool_use", id: "t", name: body.tools[0].name, input }], stop_reason: "tool_use" });
		}
		throw new Error("Unexpected fetch: " + url);
	});
	await putFile(e, { scope: "studio", path: "people/kai", name: "Kai", description: "Kai: regular artist, session prefs", aliases: ["Kai M"], body: "- [stated] prefers evening sessions\n- [observed] usually books the Live Room", if_version: "new" });
	await putFile(e, { scope: "studio", path: "topics/pricing", description: "Pricing and deposits", body: "- [stated] deposits are 25%", if_version: "new" });
	await putFile(e, { scope: "staff", owner_id: "sam", path: "profile", description: "Sam", body: "- [stated] starts at 9am on weekdays", if_version: "new" });
	await putFile(e, { scope: "customer", owner_id: "dana@example.com", path: "profile", description: "Dana", body: "- [stated] records vocals for an EP", if_version: "new" });
});
afterEach(() => vi.restoreAllMocks());

const e = { ...env, ANTHROPIC_API_KEY: "test-key" };

async function call(path, init = {}) {
	const ctx = createExecutionContext();
	const res = await worker.fetch(new Request(BASE + path, init), e, ctx);
	await waitOnExecutionContext(ctx);
	return { status: res.status, data: await res.json() };
}

describe("picking the facts (no model)", () => {
	it("forgives a typo or two, and knows a word from its stem", () => {
		expect(alike("evenings", "evening")).toBe(true); // the same stem
		expect(alike("evning", "evening")).toBe(true); // a letter missing
		expect(near("deposit", "depost")).toBe(true);
		expect(near("pricnig", "pricing")).toBe(true);
		expect(near("kai", "kat")).toBe(false); // short words must match exactly
		expect(near("live", "liverpool")).toBe(true); // the start of a longer word
	});

	it("brings back a whole file when the question is about it, best first", () => {
		const files = [
			{ scope: "studio", path: "people/kai", name: "Kai", description: "Kai: regular artist", aliases: ["Kai M"], body: "- [stated] prefers evening sessions\n- [observed] usually books the Live Room", updated_at: 1 },
			{ scope: "studio", path: "topics/pricing", name: "topics/pricing", description: "Pricing", body: "- [stated] deposits are 25%", updated_at: 2 },
		];
		const facts = pickFacts(files, "What do we know about Kai?");
		expect(facts.map((f) => f.fact)).toEqual(["prefers evening sessions", "usually books the Live Room"]);
		expect(pickFacts(files, "how much is the depost?").map((f) => f.fact)).toEqual(["deposits are 25%"]);
		expect(pickFacts(files, "what?")).toEqual([]);
	});
});

describe("asking", () => {
	it("answers only from the facts, with the ones it used, and keeps the answer until memory changes", async () => {
		answers = [{ answer: "Kai likes evening sessions [1].", used: [1, 99] }];
		const first = await askIndex(e, { q: "When does Kai like to record?", readers: [{ scope: "studio" }] });
		expect(first.ai).toBe(true);
		expect(first.answer).toBe("Kai likes evening sessions [1].");
		expect(first.used).toEqual([1]); // a number that isn't a fact is dropped
		expect(first.facts[0]).toMatchObject({ n: 1, path: "people/kai" });
		expect(first.facts.map((f) => f.fact)).toContain("prefers evening sessions");
		expect(first.facts.map((f) => f.path)).not.toContain("topics/pricing");
		expect(calls[0].system).toContain("Use ONLY the numbered facts");
		// Asked again: no second model call
		expect((await askIndex(e, { q: "when does kai like to record?", readers: [{ scope: "studio" }] })).cached).toBe(true);
		expect(calls).toHaveLength(1);
		// Memory changes: asked afresh
		await putFile(e, { scope: "studio", path: "topics/gear", description: "Gear", body: "- [stated] the Neve is in Room A", if_version: "new" });
		answers = [{ answer: "Evenings [1].", used: [1] }];
		expect((await askIndex(e, { q: "When does Kai like to record?", readers: [{ scope: "studio" }] })).cached).toBeUndefined();
		expect(calls).toHaveLength(2);
	});

	it("without a match it says so and never calls the model; if the model is down the facts still come back", async () => {
		const none = await askIndex(e, { q: "Who tunes the piano?", readers: [{ scope: "studio" }] });
		expect(none).toMatchObject({ answer: null, facts: [], ai: false });
		expect(calls).toHaveLength(0);
		const down = await askIndex(e, { q: "deposit amount", readers: [{ scope: "studio" }] });
		expect(down.ai).toBe(false);
		expect(down.facts.map((f) => f.fact)).toEqual(["deposits are 25%"]);
		expect(down.note).toContain("couldn't be reached");
	});

	it("only reads what the door may read: Nova Agent's key never sees customers'", async () => {
		answers = [{ answer: "Index doesn't remember that yet.", used: [] }];
		const res = await call("/memory/ask", { method: "POST", headers: AGENT, body: JSON.stringify({ q: "Dana vocals EP" }) });
		expect(res.status).toBe(200);
		expect(res.data.facts).toEqual([]);
		expect(calls).toHaveLength(0);
	});

	it("an admin signed in to Portal can ask about everything", async () => {
		answers = [{ answer: "Dana is recording vocals for an EP [1].", used: [1] }];
		const res = await call("/app/api/memory/ask", { method: "POST", headers: { Cookie: STAFF_COOKIE, Origin: BASE, "Content-Type": "application/json" }, body: JSON.stringify({ q: "What is Dana recording?" }) });
		expect(res.status).toBe(200);
		expect(res.data.facts.map((f) => f.owner_id)).toContain("dana@example.com");
		expect(res.data.answer).toContain("EP");
		// From another website: refused
		expect((await call("/app/api/memory/ask", { method: "POST", headers: { Cookie: STAFF_COOKIE, Origin: "https://evil.test", "Content-Type": "application/json" }, body: JSON.stringify({ q: "Dana" }) })).status).toBe(403);
		expect((await call("/app/api/memory/ask", { method: "POST", headers: { Cookie: STAFF_COOKIE, Origin: BASE, "Content-Type": "application/json" }, body: JSON.stringify({ q: "" }) })).status).toBe(400);
	});
});

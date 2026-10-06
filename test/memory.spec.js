// Nova Index: the suite's shared memory (src/memory/)
import { createExecutionContext, env, waitOnExecutionContext } from "cloudflare:test";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import worker from "../src";
import { approve, learn, PATHS } from "../src/memory/extract.js";
import { learnFromWebsiteChats, readForWebsite } from "../src/memory/routes.js";
import { addPending, allowed, cleanBody, cleanPath, context, deleteFile, getFile, isForbidden, listFiles, listPending, putFile } from "../src/memory/store.js";

const BASE = "https://novacane-worker.test";
const AGENT = { Authorization: "Bearer agent-nova-test-key", "Content-Type": "application/json" };

// Claude stands in: each call takes the next prepared answer (a tool call's input)
let answers = [];
let calls = [];
beforeEach(async () => {
	answers = [];
	calls = [];
	await env.DB.batch(["DELETE FROM memory_files", "DELETE FROM memory_pending", "DELETE FROM memory_progress", "DELETE FROM chat_messages"].map((q) => env.DB.prepare(q)));
	vi.spyOn(globalThis, "fetch").mockImplementation(async (url, init) => {
		if (String(url) === "https://api.anthropic.com/v1/messages") {
			const body = JSON.parse(init.body);
			calls.push(body);
			const input = answers.shift() || { facts: [] };
			return Response.json({ content: [{ type: "tool_use", id: "t", name: body.tools[0].name, input }], stop_reason: "tool_use" });
		}
		throw new Error("Unexpected fetch: " + url);
	});
});
afterEach(() => vi.restoreAllMocks());

const e = { ...env, ANTHROPIC_API_KEY: "test-key" };

async function call(path, init = {}) {
	const ctx = createExecutionContext();
	const res = await worker.fetch(new Request(BASE + path, init), e, ctx);
	await waitOnExecutionContext(ctx);
	return { status: res.status, data: await res.json() };
}

describe("files of facts", () => {
	it("keeps only tidy fact lines, never card, bank or ID numbers, and no repeats", () => {
		const body = cleanBody(["- [stated] prefers evening sessions", "- [stated] prefers evening sessions", "random note", "- [stated] card 4111 1111 1111 1111", "- [observed] sort code 12-34-56 account 12345678", "- [inferred] usually books the Live Room"].join("\n"));
		expect(body.split("\n")).toEqual(["- [stated] prefers evening sessions", "- [inferred] usually books the Live Room"]);
		expect(isForbidden("my NI number is QQ 12 34 56 C")).toBe(true);
	});

	it("only allows the four kinds of path", () => {
		expect(cleanPath("People/Kai M")).toBe("people/kai-m");
		expect(cleanPath("profile")).toBe("profile");
		expect(cleanPath("../etc/passwd")).toBe("");
		expect(cleanPath("secrets/x")).toBe("");
	});

	it("writes with a version token, and refuses a stale write (409 with what's there now)", async () => {
		const made = await putFile(e, { scope: "staff", owner_id: "owner", path: "profile", body: "- [stated] up at 7:30", if_version: "new" }, "Nova Agent");
		expect(made.ok).toBe(true);
		const stale = await putFile(e, { scope: "staff", owner_id: "owner", path: "profile", body: "- [stated] up at 9", if_version: "new" });
		expect(stale.conflict).toBe(true);
		expect(stale.current.body).toBe("- [stated] up at 7:30");
		const next = await putFile(e, { scope: "staff", owner_id: "owner", path: "profile", body: "- [stated] up at 8", if_version: made.file.version });
		expect(next.ok).toBe(true);
		expect((await getFile(e, "staff", "owner", "profile")).source_app).toBe("unknown");
	});

	it("keeps each caller to its own scopes", () => {
		expect(allowed("website", "read", "staff")).toBe(false);
		expect(allowed("website", "read", "studio")).toBe(false);
		expect(allowed("agent", "write", "customer")).toBe(false);
		expect(allowed("staff", "write", "customer")).toBe(true);
	});
});

describe("what goes into a prompt", () => {
	beforeEach(async () => {
		await putFile(e, { scope: "studio", path: "studio", description: "How the studio runs", body: "- [stated] the Live Room needs 15 minutes' changeover", if_version: "new" });
		await putFile(e, { scope: "studio", path: "public", description: "What customers may be told", body: "- [stated] open 10am to 11pm every day", if_version: "new" });
		await putFile(e, { scope: "studio", path: "people/kai", description: "Kai: regular artist, session prefs", aliases: ["Kai M"], body: "- [stated] prefers evening sessions", if_version: "new" });
		await putFile(e, { scope: "studio", path: "topics/pricing", description: "Pricing and deposits", body: "- [stated] deposits are 25%", if_version: "new" });
		await putFile(e, { scope: "customer", owner_id: "dana@example.com", path: "profile", description: "Dana", body: "- [stated] records vocals for an EP", if_version: "new" });
	});

	it("loads the studio file and only the files the turn is about", async () => {
		const ctx = await context(e, { readers: [{ scope: "studio", owner_id: null }], q: "Can you book Kai in next week?" });
		expect(ctx.files).toEqual(["studio:studio", "studio:public", "studio:people/kai"]);
		expect(ctx.text).toContain("prefers evening sessions");
		expect(ctx.text).not.toContain("deposits are 25%");
	});

	it("keeps to the budget", async () => {
		const ctx = await context(e, { readers: [{ scope: "studio", owner_id: null }], q: "Kai pricing", budget: 260 });
		expect(ctx.text.length).toBeLessThanOrEqual(260);
	});

	it("on the website: only public studio facts and that customer's own file", async () => {
		await env.DB.prepare("INSERT INTO enquiries (created_at, name, email, details, chat_id, status) VALUES (?, 'Dana', 'dana@example.com', 'x', 'chat-dana-001', 'new')").bind(new Date().toISOString()).run();
		const ctx = await readForWebsite(e, "chat-dana-001", "Can Kai and I book?");
		expect(ctx.text).toContain("open 10am to 11pm");
		expect(ctx.text).toContain("records vocals for an EP");
		expect(ctx.text).not.toContain("changeover");
		expect(ctx.text).not.toContain("prefers evening sessions");
	});
});

describe("learning", () => {
	it("merges new facts into a file instead of piling them up", async () => {
		await putFile(e, { scope: "staff", owner_id: "owner", path: "profile", body: "- [stated] up at 7:30", if_version: "new" });
		answers = [
			{ facts: [{ path: "profile", tag: "stated", fact: "gets up at 8 now" }, { path: "studio", tag: "stated", fact: "Thursdays are for mixing" }] },
			{ description: "The owner: rhythm and preferences", lines: ["- [stated] gets up at 8"] },
		];
		const r = await learn(e, { transcript: "Staff: I get up at 8 now. Thursdays are for mixing.", scope: "staff", owner_id: "owner", mode: "auto", source_app: "Nova Agent", who: "staff", paths: PATHS.staff });
		expect(r.facts).toBe(2);
		expect((await getFile(e, "staff", "owner", "profile")).body).toBe("- [stated] gets up at 8");
		expect((await getFile(e, "studio", null, "studio")).body).toBe("- [stated] Thursdays are for mixing");
	});

	it("holds customers' facts for approval, then merges an approved one", async () => {
		answers = [{ facts: [{ path: "profile", tag: "stated", fact: "wants a mix by December" }, { path: "profile", tag: "stated", fact: "card 4111111111111111" }] }];
		await learn(e, { transcript: "Customer: ...", scope: "customer", owner_id: "dana@example.com", mode: "pending", source_app: "NovaBot", who: "customer", paths: PATHS.customer });
		const pending = await listPending(e);
		expect(pending.map((p) => p.fact)).toEqual(["wants a mix by December"]);
		expect(await getFile(e, "customer", "dana@example.com", "profile")).toBeNull();
		await approve(e, pending[0]);
		expect((await getFile(e, "customer", "dana@example.com", "profile")).body).toBe("- [stated] wants a mix by December");
	});

	it("reads a quiet website chat once, and never again", async () => {
		const old = new Date(Date.now() - 20 * 60_000).toISOString();
		const add = env.DB.prepare("INSERT INTO chat_messages (chat_id, created_at, role, content) VALUES ('chat-q-0001', ?, ?, ?)");
		await env.DB.batch([add.bind(old, "user", "I always record in the evenings"), add.bind(old, "assistant", "Noted!")]);
		answers = [{ facts: [{ path: "profile", tag: "stated", fact: "records in the evenings" }] }];
		await learnFromWebsiteChats(e);
		await learnFromWebsiteChats(e);
		const pending = await listPending(e);
		expect(pending).toHaveLength(1);
		expect(pending[0].owner_id).toBe("chat:chat-q-0001");
		expect(calls).toHaveLength(1);
	});
});

describe("the engine's doors", () => {
	it("gives Nova Agent its context, and keeps it out of customers' files", async () => {
		await putFile(e, { scope: "staff", owner_id: "owner", path: "profile", body: "- [stated] up at 7:30", if_version: "new" });
		const ok = await call("/memory/context?scope=staff&owner_id=owner&q=morning", { headers: AGENT });
		expect(ok.status).toBe(200);
		expect(ok.data.text).toContain("up at 7:30");
		expect((await call("/memory/context?scope=customer&owner_id=x", { headers: AGENT })).status).toBe(403);
		expect((await call("/memory/context?scope=staff", { headers: { Authorization: "Bearer wrong" } })).status).toBe(401);
		const put = await call("/memory/file", { method: "PUT", headers: AGENT, body: JSON.stringify({ scope: "customer", owner_id: "x", path: "profile", body: "", if_version: "new" }) });
		expect(put.status).toBe(403);
	});

	it("queues extraction without making the caller wait", async () => {
		answers = [{ facts: [] }];
		const res = await call("/memory/extract", { method: "POST", headers: AGENT, body: JSON.stringify({ scope: "staff", owner_id: "owner", transcript: "Staff: hello" }) });
		expect(res.status).toBe(202);
	});

	it("lets signed-in staff approve and reject in Nova Index", async () => {
		const login = await worker.fetch(new Request(BASE + "/app/api/login", { method: "POST", headers: { Origin: BASE, "Content-Type": "application/json" }, body: JSON.stringify({ password: "test-admin-password" }) }), e, createExecutionContext());
		const cookie = login.headers.get("Set-Cookie").split(";")[0];
		answers = [{ facts: [{ path: "profile", tag: "stated", fact: "likes the Booth" }, { path: "profile", tag: "observed", fact: "books on Sundays" }] }];
		await learn(e, { transcript: "x", scope: "customer", owner_id: "sam@example.com", mode: "pending", source_app: "NovaBot", who: "customer", paths: PATHS.customer });
		const list = await call("/app/api/memory/pending", { headers: { Cookie: cookie } });
		expect(list.data.pending).toHaveLength(2);
		const [a, b] = list.data.pending;
		expect((await call(`/app/api/memory/pending/${a.id}`, { method: "POST", headers: { Cookie: cookie, Origin: BASE, "Content-Type": "application/json" }, body: JSON.stringify({ action: "approve" }) })).status).toBe(200);
		expect((await call(`/app/api/memory/pending/${b.id}`, { method: "POST", headers: { Cookie: cookie, Origin: BASE, "Content-Type": "application/json" }, body: JSON.stringify({ action: "reject" }) })).data.rejected).toBe(true);
		const index = await call("/app/api/memory/index", { headers: { Cookie: cookie } });
		expect(index.data.files.map((f) => `${f.scope}:${f.owner_id}:${f.path}`)).toEqual(["customer:sam@example.com:profile"]);
		// Not signed in: nothing
		expect((await call("/app/api/memory/index")).status).toBe(401);
	});
});

describe("the helper's fixes", () => {
	it("searches fact text on the server, and lists only what changed since", async () => {
		await putFile(e, { scope: "studio", path: "people/kai", description: "Kai", body: "- [stated] loves the Neve desk", if_version: "new" });
		const t = Date.now();
		await putFile(e, { scope: "studio", path: "topics/gear", description: "Gear", body: "- [stated] two vocal booths", if_version: "new" });
		const found = await listFiles(e, { q: "neve" });
		expect(found.map((f) => f.path)).toEqual(["people/kai"]);
		expect(found[0].matches).toEqual(["- [stated] loves the Neve desk"]);
		expect((await listFiles(e, { since: t - 1 })).map((f) => f.path)).toContain("topics/gear");
	});

	it("says how many lines a save left out", async () => {
		const r = await putFile(e, { scope: "studio", path: "studio", body: "- [stated] open late\nnot a fact\n- [stated] card 4111 1111 1111 1111", if_version: "new" });
		expect(r.dropped).toBe(2);
		expect(r.note).toContain("left out");
	});

	it("won't delete a file someone has just changed", async () => {
		const a = await putFile(e, { scope: "studio", path: "studio", body: "- [stated] one", if_version: "new" });
		await putFile(e, { scope: "studio", path: "studio", body: "- [stated] two", if_version: a.file.version });
		expect((await deleteFile(e, "studio", null, "studio", a.file.version)).conflict).toBe(true);
		expect(await getFile(e, "studio", null, "studio")).not.toBeNull();
	});

	it("keeps a pending fact in the queue when approving it fails", async () => {
		const login = await worker.fetch(new Request(BASE + "/app/api/login", { method: "POST", headers: { Origin: BASE, "Content-Type": "application/json" }, body: JSON.stringify({ password: "test-admin-password" }) }), e, createExecutionContext());
		const cookie = login.headers.get("Set-Cookie").split(";")[0];
		await addPending(e, { scope: "customer", owner_id: "x@example.com", target: "profile", tag: "stated", fact: "likes evenings", source_app: "NovaBot" });
		const [row] = await listPending(e);
		const res = await call(`/app/api/memory/pending/${row.id}`, { method: "POST", headers: { Cookie: cookie, Origin: BASE, "Content-Type": "application/json" }, body: JSON.stringify({ action: "approve", fact: "passport 123456789" }) });
		expect(res.status).toBe(400);
		expect(res.data.kept).toBe(true);
		expect((await listPending(e)).map((p) => p.id)).toEqual([row.id]);
	});
});

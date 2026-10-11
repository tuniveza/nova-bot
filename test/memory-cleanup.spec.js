// Index cleanup (P0-5): validation and repeats on every write, a dry-run report before any
// cleanup, applying exactly that report, the 30-day bin, and who may change what
import { createExecutionContext, env, waitOnExecutionContext } from "cloudflare:test";
import { STAFF_COOKIE } from "./sign-in.js";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import worker from "../src";
import { sha256 } from "../src/portal/auth.js";
import { approve, learn, PATHS } from "../src/memory/extract.js";
import { addPending, checkBody, getFile, junkReason, listPending, normalFact, putFile } from "../src/memory/store.js";

const BASE = "https://novacane-worker.test";
const AGENT = { Authorization: "Bearer agent-nova-test-key", "Content-Type": "application/json" };
const MEMBER_TOKEN = "test-member-portal-session";
const MEMBER_COOKIE = `nova_session=${MEMBER_TOKEN}`;

let answers = [];
beforeEach(async () => {
	answers = [];
	const now = new Date().toISOString();
	const later = new Date(Date.now() + 86_400_000).toISOString();
	await env.DB.batch([
		...["memory_files", "memory_pending", "memory_cleanups", "memory_removed"].map((t) => env.DB.prepare(`DELETE FROM ${t}`)),
		// Kai: signed in to Portal, staff but not an admin
		env.DB.prepare("INSERT OR IGNORE INTO staff (id, email, password_hash, display_name, role, status, created_at, planet_seed, index_partition) VALUES ('kai', 'kai@novacane.test', NULL, 'Kai', 'staff', 'active', ?, 'kai', 'staff:kai')").bind(now),
		env.DB.prepare("INSERT OR REPLACE INTO sessions (id, staff_id, kind, created_at, expires_at, last_seen_at) VALUES (?, 'kai', 'cookie', ?, ?, ?)").bind(await sha256(MEMBER_TOKEN), now, later, now),
	]);
	vi.spyOn(globalThis, "fetch").mockImplementation(async (url, init) => {
		if (String(url) === "https://api.anthropic.com/v1/messages") {
			const body = JSON.parse(init.body);
			return Response.json({ content: [{ type: "tool_use", id: "t", name: body.tools[0].name, input: answers.shift() || { facts: [] } }], stop_reason: "tool_use" });
		}
		throw new Error("Unexpected fetch: " + url);
	});
});
afterEach(() => vi.restoreAllMocks());

const e = { ...env, ANTHROPIC_API_KEY: "test-key" };

async function call(path, { method = "GET", cookie = STAFF_COOKIE, headers = {}, body } = {}) {
	const ctx = createExecutionContext();
	const h = { ...(cookie ? { Cookie: cookie } : {}), ...headers };
	if (method !== "GET") h.Origin = BASE;
	if (body !== undefined) h["Content-Type"] = "application/json";
	const res = await worker.fetch(new Request(BASE + path, { method, headers: h, body: body === undefined ? undefined : JSON.stringify(body) }), e, ctx);
	await waitOnExecutionContext(ctx);
	return { status: res.status, data: await res.json() };
}

// Junk as it might already be in D1 (written before there were checks)
async function rawFile(id, scope, owner, path, body) {
	await env.DB.prepare("INSERT INTO memory_files (id, scope, owner_id, path, name, description, aliases, body, version, source_app, updated_at) VALUES (?, ?, ?, ?, ?, ?, '[]', ?, ?, 'test', ?)")
		.bind(id, scope, owner, path, path.split("/").pop(), "x", body, "v-" + id, Date.now())
		.run();
}
async function rawPending(id, owner, target, fact, at) {
	await env.DB.prepare("INSERT INTO memory_pending (id, scope, owner_id, target, tag, fact, source_app, source_ref, created_at) VALUES (?, 'customer', ?, ?, 'stated', ?, 'NovaBot', NULL, ?)")
		.bind(id, owner, target, fact, at)
		.run();
}
const snapshot = async () => ({
	files: (await env.DB.prepare("SELECT id, body, version FROM memory_files ORDER BY id").all()).results,
	pending: (await env.DB.prepare("SELECT id, fact FROM memory_pending ORDER BY id").all()).results,
});

describe("validation on write", () => {
	it("rejects empty, placeholder, punctuation-only, too-short and cut-off facts, with a reason", () => {
		expect(junkReason("")).toBe("it's empty");
		expect(junkReason("   ")).toBe("it's empty");
		expect(junkReason("...!?")).toBe("it's only punctuation or symbols");
		expect(junkReason("N/A")).toBe("it's placeholder text, not a fact");
		expect(junkReason("TBD")).toBe("it's placeholder text, not a fact");
		expect(junkReason("Lorem ipsum dolor sit amet")).toBe("it's placeholder text, not a fact");
		expect(junkReason("[object Object]")).toBe("it's placeholder text, not a fact");
		expect(junkReason("x")).toBe("it has no words in it");
		expect(junkReason("12345")).toBe("it has no words in it");
		expect(junkReason("prefers evening sessions and")).toBe("it looks cut off mid-sentence");
		expect(junkReason("usually books the…")).toBe("it looks cut off mid-sentence");
		expect(junkReason("likes working with Kai,")).toBe("it looks cut off mid-sentence");
		expect(junkReason("a".repeat(241))).toMatch(/too long/);
		// Real facts pass, short ones included
		for (const ok of ["vegan", "up at 7:30", "prefers Studio A", "codes in C++", "likes rock, pop, etc...", "two vocal booths", "one"]) expect(junkReason(ok)).toBeNull();
	});

	it("normalises spaces and treats case, punctuation and the tag as the same fact", () => {
		expect(normalFact("- [stated] Prefers  evening sessions.")).toBe(normalFact("prefers evening sessions"));
		const { body, refused } = checkBody("- [stated]   Prefers   evening sessions.\n- [observed] prefers evening sessions\n- [stated] n/a\n- [stated] ?!");
		expect(body).toBe("- [stated] Prefers evening sessions.");
		expect(refused.map((r) => r.reason)).toEqual(['it repeats "Prefers evening sessions."', "it's placeholder text, not a fact", "it's only punctuation or symbols"]);
	});

	it("refuses a save with nothing worth keeping, and an empty file, saying why", async () => {
		const junk = await putFile(e, { scope: "studio", path: "studio", body: "- [stated] TBD\n- [stated] ...", if_version: "new" });
		expect(junk.status).toBe(400);
		expect(junk.error).toContain("Nothing was saved");
		expect(junk.error).toContain("placeholder");
		const empty = await putFile(e, { scope: "studio", path: "studio", body: "   ", if_version: "new" });
		expect(empty.error).toContain("at least one fact");
		expect(await getFile(e, "studio", null, "studio")).toBeNull();
		// Through Index's door too
		const res = await call("/app/api/memory/file", { method: "PUT", body: { scope: "studio", path: "studio", body: "- [stated] test", if_version: "new" } });
		expect(res.status).toBe(400);
		expect(res.data.refused[0].reason).toBe("it's placeholder text, not a fact");
	});

	it("keeps the good lines of a save and says which were left out and why", async () => {
		const r = await putFile(e, { scope: "studio", path: "studio", body: "- [stated] open late\n- [stated] Open late.\n- [stated] none", if_version: "new" });
		expect(r.ok).toBe(true);
		expect(r.file.body).toBe("- [stated] open late");
		expect(r.dropped).toBe(2);
		expect(r.note).toContain('it repeats "open late"');
		expect(r.note).toContain("placeholder");
	});
});

describe("repeats on write", () => {
	it("an AI-learned fact that's junk, or already known, isn't saved again", async () => {
		await putFile(e, { scope: "staff", owner_id: "owner", path: "profile", body: "- [stated] gets up at 8", if_version: "new" });
		answers = [
			{ facts: [{ path: "profile", tag: "stated", fact: "Gets up at 8." }, { path: "profile", tag: "stated", fact: "n/a" }, { path: "profile", tag: "stated", fact: "mixes on Thursdays" }] },
			// The model's merge repeats a line and lets junk through: neither is kept
			{ description: "The owner", lines: ["- [stated] gets up at 8", "- [observed] Gets up at 8.", "- [stated] mixes on Thursdays", "- [stated] ???"] },
		];
		const r = await learn(e, { transcript: "Staff: ...", scope: "staff", owner_id: "owner", mode: "auto", source_app: "Nova Agent", who: "staff", paths: PATHS.staff });
		expect(r.facts).toBe(2); // "n/a" never got past distilling
		expect((await getFile(e, "staff", "owner", "profile")).body).toBe("- [stated] gets up at 8\n- [stated] mixes on Thursdays");
	});

	it("website facts wait for approval once: not again while waiting, and not if already remembered", async () => {
		await putFile(e, { scope: "customer", owner_id: "dana@example.com", path: "profile", body: "- [stated] records vocals for an EP", if_version: "new" });
		const base = { scope: "customer", owner_id: "dana@example.com", target: "profile", tag: "stated", source_app: "NovaBot" };
		expect((await addPending(e, { ...base, fact: "wants a mix by December" })).ok).toBe(true);
		expect((await addPending(e, { ...base, fact: "Wants a mix by December." })).refused).toBe("the same fact is already waiting for approval");
		expect((await addPending(e, { ...base, fact: "records vocals for an EP!" })).refused).toBe("it's already remembered");
		expect((await addPending(e, { ...base, fact: "?" })).refused).toBe("it's only punctuation or symbols");
		// For someone else, the same words are a different fact
		expect((await addPending(e, { ...base, owner_id: "sam@example.com", fact: "wants a mix by December" })).ok).toBe(true);
		expect(await listPending(e)).toHaveLength(2);
		// Learning the same thing twice from a chat queues it once
		answers = [{ facts: [{ path: "profile", tag: "stated", fact: "likes the Booth" }] }, { facts: [{ path: "profile", tag: "stated", fact: "Likes the booth" }] }];
		const run = () => learn(e, { transcript: "x", scope: "customer", owner_id: "dana@example.com", mode: "pending", source_app: "NovaBot", who: "customer", paths: PATHS.customer });
		expect((await run()).queued).toBe(1);
		expect((await run()).queued).toBe(0);
		expect(await listPending(e)).toHaveLength(3);
	});

	it("approving: a junk edit is refused (the fact stays waiting), an already-known one changes nothing", async () => {
		await putFile(e, { scope: "customer", owner_id: "x@example.com", path: "profile", body: "- [stated] likes evenings", if_version: "new" });
		await rawPending("p-1", "x@example.com", "profile", "books on Sundays", 1);
		const res = await call("/app/api/memory/pending/p-1", { method: "POST", body: { action: "approve", fact: "..." } });
		expect(res.status).toBe(400);
		expect(res.data.error).toContain("only punctuation");
		expect(res.data.kept).toBe(true);
		const same = await approve(e, { scope: "customer", owner_id: "x@example.com", target: "profile", tag: "stated", fact: "Likes evenings." });
		expect(same.already).toBe(true);
		expect((await getFile(e, "customer", "x@example.com", "profile")).body).toBe("- [stated] likes evenings");
	});
});

describe("the cleanup", () => {
	// The same junk every time: what the report must list, exactly
	async function seed() {
		await rawFile("f-empty", "studio", null, "topics/old", "");
		await rawFile("f-alljunk", "staff", "kai", "areas/x", "- [stated] TBD\n- [stated] ...");
		await rawFile("f-mixed", "studio", null, "studio", ["- [stated] open late", "- [stated] n/a", "- [observed] Open late.", "- [stated] two vocal booths", "- [stated] open late", "- [stated] deposits are 25% and"].join("\n"));
		// The same words in two people's files are two different facts: never repeats
		await rawFile("f-kai", "studio", null, "people/kai", "- [stated] prefers evening sessions");
		await rawFile("f-sam", "studio", null, "people/sam", "- [stated] prefers evening sessions");
		await rawFile("f-dana", "customer", "dana@example.com", "profile", "- [stated] records vocals for an EP");
		await rawPending("p-old", "dana@example.com", "profile", "wants a mix by December", 100);
		await rawPending("p-again", "dana@example.com", "profile", "Wants a mix by December!", 200);
		await rawPending("p-known", "dana@example.com", "profile", "records vocals for an EP", 300);
		await rawPending("p-junk", "dana@example.com", "profile", "   ", 400);
		await rawPending("p-good", "dana@example.com", "profile", "likes the Booth", 500);
	}
	const line = (r, text) => r.items.find((i) => i.text === text && i.id.startsWith("line:f-mixed"));

	it("the dry run lists exactly the empties, junk and repeats, and changes nothing", async () => {
		await seed();
		const before = await snapshot();
		const res = await call("/app/api/memory/cleanup/check", { method: "POST" });
		expect(res.status).toBe(200);
		const r = res.data.report;
		expect(r.counts).toEqual({ empty_files: 1, junk_files: 1, junk_lines: 2, repeat_lines: 2, junk_pending: 1, repeat_pending: 2, total: 9 });
		expect(r.items.filter((i) => i.id.startsWith("file:")).map((i) => [i.id, i.kind])).toEqual([
			["file:f-alljunk", "junk-file"],
			["file:f-empty", "empty-file"],
		]);
		expect(r.items.filter((i) => i.id.startsWith("line:")).map((i) => [i.text, i.kind])).toEqual([
			["- [stated] n/a", "junk-line"],
			["- [observed] Open late.", "repeat-line"],
			["- [stated] open late", "repeat-line"],
			["- [stated] deposits are 25% and", "junk-line"],
		]);
		// The first copy stays, and the report says which
		expect(line(r, "- [observed] Open late.").kept).toBe("- [stated] open late");
		expect(r.keeps).toContain("first copy stays");
		expect(r.items.filter((i) => i.id.startsWith("pending:")).map((i) => [i.id, i.kind])).toEqual([
			["pending:p-again", "repeat-pending"],
			["pending:p-known", "repeat-pending"],
			["pending:p-junk", "junk-pending"],
		]);
		// Nothing changed, and the check is on record
		expect(await snapshot()).toEqual(before);
		const run = await env.DB.prepare("SELECT * FROM memory_cleanups").first();
		expect(run.checked_by).toBe("Test Admin");
		expect(run.applied_at).toBeNull();
	});

	it("applying removes only what the report listed, each into the bin, and records who and when", async () => {
		await seed();
		const { report } = (await call("/app/api/memory/cleanup/check", { method: "POST" })).data;
		const res = await call("/app/api/memory/cleanup/apply", { method: "POST", body: { report_id: report.id, ids: [...report.items.map((i) => i.id), "file:f-kai"] } });
		expect(res.status).toBe(200);
		expect(res.data.removed).toBe(9);
		// An id that wasn't in the report is never touched
		expect(res.data.skipped).toEqual([{ id: "file:f-kai", why: "it wasn't in the report" }]);
		const after = await snapshot();
		expect(after.files.map((f) => f.id)).toEqual(["f-dana", "f-kai", "f-mixed", "f-sam"]);
		expect(after.files.find((f) => f.id === "f-mixed").body).toBe("- [stated] open late\n- [stated] two vocal booths");
		expect(after.files.find((f) => f.id === "f-kai").body).toBe("- [stated] prefers evening sessions");
		expect(after.pending.map((p) => p.id)).toEqual(["p-good", "p-old"]);
		// The record: every removed entry, why, by whom and when, tied to this cleanup
		const bin = (await env.DB.prepare("SELECT * FROM memory_removed").all()).results;
		expect(bin).toHaveLength(9);
		expect(bin.every((b) => b.removed_by === "Test Admin" && b.cleanup_id === report.id && b.removed_at > 0)).toBe(true);
		const run = await env.DB.prepare("SELECT * FROM memory_cleanups WHERE id = ?").bind(report.id).first();
		expect(run.applied_by).toBe("Test Admin");
		expect(run.removed).toBe(9);
		// A report is applied once
		expect((await call("/app/api/memory/cleanup/apply", { method: "POST", body: { report_id: report.id, ids: [report.items[0].id] } })).status).toBe(409);
	});

	it("re-checks each entry: anything that changed since the report stays, and nothing new is removed", async () => {
		await seed();
		const { report } = (await call("/app/api/memory/cleanup/check", { method: "POST" })).data;
		// Since the check: the empty file got a fact, a new junk line appeared, a waiting fact was approved away
		await env.DB.prepare("UPDATE memory_files SET body = '- [stated] now has a fact', version = 'v2' WHERE id = 'f-empty'").run();
		await env.DB.prepare("UPDATE memory_files SET body = body || char(10) || '- [stated] null', version = 'v3' WHERE id = 'f-mixed'").run();
		await env.DB.prepare("DELETE FROM memory_pending WHERE id = 'p-old'").run();
		const res = await call("/app/api/memory/cleanup/apply", { method: "POST", body: { report_id: report.id, ids: report.items.map((i) => i.id) } });
		expect(res.data.skipped.map((s) => s.id).sort()).toEqual(["file:f-empty", "pending:p-again"]);
		expect(res.data.removed).toBe(7);
		expect((await getFile(e, "studio", null, "topics/old")).body).toBe("- [stated] now has a fact");
		// The new junk line wasn't in the report: still there for the next check
		expect((await getFile(e, "studio", null, "studio")).body).toBe("- [stated] open late\n- [stated] two vocal booths\n- [stated] null");
		expect((await listPending(e)).map((p) => p.id).sort()).toEqual(["p-again", "p-good"]);
	});

	it("only admins: not other staff, not Nova Agent's key, not signed out", async () => {
		await seed();
		const { report } = (await call("/app/api/memory/cleanup/check", { method: "POST" })).data;
		const before = await snapshot();
		for (const [path, method, body] of [
			["/app/api/memory/cleanup/check", "POST"],
			["/app/api/memory/cleanup/apply", "POST", { report_id: report.id, ids: report.items.map((i) => i.id) }],
			["/app/api/memory/cleanup/removed", "GET"],
		]) {
			const res = await call(path, { method, body, cookie: MEMBER_COOKIE });
			expect(res.status).toBe(403);
			expect(res.data.error).toContain("admins");
		}
		expect((await call("/memory/cleanup/check", { method: "POST", cookie: null, headers: AGENT })).status).toBe(403);
		expect((await call("/app/api/memory/cleanup/check", { method: "POST", cookie: null })).status).toBe(401);
		expect(await snapshot()).toEqual(before);
	});

	it("puts things back from the bin for 30 days", async () => {
		await seed();
		const { report } = (await call("/app/api/memory/cleanup/check", { method: "POST" })).data;
		await call("/app/api/memory/cleanup/apply", { method: "POST", body: { report_id: report.id, ids: report.items.map((i) => i.id) } });
		const { data } = await call("/app/api/memory/cleanup/removed");
		expect(data.days).toBe(30);
		expect(data.runs[0]).toMatchObject({ id: report.id, applied_by: "Test Admin", removed: 9 });
		const two = data.removed.find((r) => r.text === "- [stated] deposits are 25% and");
		expect((await call(`/app/api/memory/cleanup/removed/${two.id}/restore`, { method: "POST" })).status).toBe(200);
		expect((await getFile(e, "studio", null, "studio")).body).toContain("deposits are 25% and");
		expect((await call(`/app/api/memory/cleanup/removed/${two.id}/restore`, { method: "POST" })).status).toBe(409);
		const empty = data.removed.find((r) => r.kind === "file" && r.path === "areas/x");
		expect((await call(`/app/api/memory/cleanup/removed/${empty.id}/restore`, { method: "POST" })).status).toBe(200);
		expect((await getFile(e, "staff", "kai", "areas/x")).body).toBe("- [stated] TBD\n- [stated] ...");
		const pend = data.removed.find((r) => r.kind === "pending" && r.text === "Wants a mix by December!");
		await call(`/app/api/memory/cleanup/removed/${pend.id}/restore`, { method: "POST" });
		expect((await listPending(e)).map((p) => p.id)).toContain("p-again");
		// Older than 30 days: gone for good
		await env.DB.prepare("UPDATE memory_removed SET removed_at = ? WHERE restored_at IS NULL").bind(Date.now() - 31 * 86_400_000).run();
		const old = data.removed.find((r) => !r.restored_at && r.id !== two.id && r.id !== empty.id && r.id !== pend.id);
		expect((await call(`/app/api/memory/cleanup/removed/${old.id}/restore`, { method: "POST" })).status).toBe(410);
	});
});

describe("editing and deleting in Index: who may", () => {
	beforeEach(async () => {
		await putFile(e, { scope: "studio", path: "studio", body: "- [stated] open late", if_version: "new" });
		await putFile(e, { scope: "staff", owner_id: "kai", path: "profile", body: "- [stated] mixes in the mornings", if_version: "new" });
		await putFile(e, { scope: "staff", owner_id: "dominic", path: "profile", body: "- [stated] runs the studio", if_version: "new" });
		await putFile(e, { scope: "customer", owner_id: "dana@example.com", path: "profile", body: "- [stated] EP in December", if_version: "new" });
	});

	it("the listing says what each person may change", async () => {
		const kai = (await call("/app/api/memory/index", { cookie: MEMBER_COOKIE })).data;
		expect(kai.admin).toBe(false);
		expect(kai.files.map((f) => `${f.scope}:${f.editable}`).sort()).toEqual(["staff:true", "studio:false"]);
		const admin = (await call("/app/api/memory/index")).data;
		expect(admin.admin).toBe(true);
		expect(admin.files.every((f) => f.editable)).toBe(true);
		expect((await call("/app/api/memory/stats")).data.admin).toBe(true);
		expect((await call("/app/api/memory/stats", { cookie: MEMBER_COOKIE })).data.admin).toBe(false);
	});

	it("a staff member edits and deletes their own memory only; studio-wide and others' are for admins", async () => {
		const own = await getFile(e, "staff", "kai", "profile");
		const edit = await call("/app/api/memory/file", { method: "PUT", cookie: MEMBER_COOKIE, body: { scope: "staff", owner_id: "kai", path: "profile", body: "- [stated] mixes in the afternoons", if_version: own.version } });
		expect(edit.status).toBe(200);
		const studio = await getFile(e, "studio", null, "studio");
		expect((await call("/app/api/memory/file", { method: "PUT", cookie: MEMBER_COOKIE, body: { scope: "studio", path: "studio", body: "- [stated] closed", if_version: studio.version } })).status).toBe(403);
		expect((await call("/app/api/memory/file?scope=studio&path=studio", { method: "DELETE", cookie: MEMBER_COOKIE })).status).toBe(403);
		expect((await call("/app/api/memory/file?scope=staff&owner_id=dominic&path=profile", { method: "DELETE", cookie: MEMBER_COOKIE })).status).toBe(403);
		expect((await call("/app/api/memory/file?scope=customer&owner_id=dana@example.com&path=profile", { method: "DELETE", cookie: MEMBER_COOKIE })).status).toBe(403);
		expect(await getFile(e, "studio", null, "studio")).not.toBeNull();
		expect(await getFile(e, "staff", "dominic", "profile")).not.toBeNull();
		// Their own: yes, and it goes to the bin
		expect((await call("/app/api/memory/file?scope=staff&owner_id=kai&path=profile", { method: "DELETE", cookie: MEMBER_COOKIE })).status).toBe(200);
		expect(await getFile(e, "staff", "kai", "profile")).toBeNull();
		const bin = await env.DB.prepare("SELECT * FROM memory_removed").first();
		expect(bin).toMatchObject({ kind: "file", removed_by: "Kai", reason: "deleted in Index", cleanup_id: null });
		// An admin: studio-wide memory and anyone's
		const s2 = await getFile(e, "studio", null, "studio");
		expect((await call("/app/api/memory/file", { method: "PUT", body: { scope: "studio", path: "studio", body: "- [stated] open until 11pm", if_version: s2.version } })).status).toBe(200);
		expect((await call("/app/api/memory/file?scope=staff&owner_id=dominic&path=profile", { method: "DELETE" })).status).toBe(200);
		// …and can put the deleted file back
		const { data } = await call("/app/api/memory/cleanup/removed");
		const back = data.removed.find((r) => r.owner_id === "dominic");
		expect((await call(`/app/api/memory/cleanup/removed/${back.id}/restore`, { method: "POST" })).status).toBe(200);
		expect((await getFile(e, "staff", "dominic", "profile")).body).toBe("- [stated] runs the studio");
	});
});

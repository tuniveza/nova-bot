// Social posts on Facebook and Instagram, with an admin's approval (src/social.js, the
// /nova-agent/social/* routes, Portal's /app/api/social and Meta's /social/media/ addresses).
// Nothing reaches Meta unless an admin, signed in to Portal in a browser, pressed Approve on
// exactly what's saved. Without Meta connected, approved posts wait to be posted by hand.
import { createExecutionContext, env, waitOnExecutionContext } from "cloudflare:test";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import worker from "../src";
import { socialOnSchedule } from "../src/social.js";
import { sha256 } from "../src/portal/auth.js";
import { STAFF_COOKIE } from "./sign-in.js";

const BASE = "https://novacane-worker.test";
const KEY = "agent-nova-test-key";
const TOKEN = "EAAtestPageToken123";
const META = { META_PAGE_TOKEN: TOKEN, META_PAGE_ID: "111", META_IG_USER_ID: "222", SOCIAL_MEDIA_BASE: "https://media.test" };
const NO_META = { SOCIAL_MEDIA_BASE: "https://media.test" };
const PIC = { id: "a".repeat(32), ext: "jpg", name: "cover.jpg", size: 1234 };
const PIC2 = { id: "b".repeat(32), ext: "jpg", name: "back.jpg", size: 2345 };
const VID = { id: "c".repeat(32), ext: "mp4", name: "clip.mp4", size: 99999 };

// ----- A fake Meta (and the store the pictures are in) -----

let calls; // { method, path, params }
let containers; // id -> { status, params }
let comments; // object id -> [comment]
let failNext; // { path: RegExp, message }
let nextId;
let fetchedMedia; // files the store was asked for

const reply = (data, status = 200) => new Response(JSON.stringify(data), { status, headers: { "Content-Type": "application/json" } });

beforeEach(async () => {
	await env.DB.batch([
		env.DB.prepare("DELETE FROM social_comments"),
		env.DB.prepare("DELETE FROM social_post_log"),
		env.DB.prepare("DELETE FROM social_posts"),
		env.DB.prepare("DELETE FROM social_followers"),
		env.DB.prepare("DELETE FROM settings"),
	]);
	calls = [];
	containers = new Map();
	comments = new Map();
	failNext = null;
	nextId = 1000;
	fetchedMedia = [];
	vi.spyOn(globalThis, "fetch").mockImplementation(async (url, init = {}) => {
		const u = new URL(String(url));
		if (u.origin === "https://media.test") {
			fetchedMedia.push(u.pathname);
			return new Response(new Uint8Array([0xff, 0xd8, 0xff, 1, 2, 3]), { headers: { "Content-Type": "image/jpeg", "Content-Length": "6" } });
		}
		if (u.origin !== "https://graph.facebook.com") return reply({ error: "not_found" }, 404);
		const method = init.method || "GET";
		const path = u.pathname.replace(/^\/v[\d.]+/, "");
		const params = method === "GET" ? Object.fromEntries(u.searchParams) : Object.fromEntries(new URLSearchParams(String(init.body || "")));
		expect(params.access_token).toBe(TOKEN);
		delete params.access_token;
		calls.push({ method, path, params });
		if (failNext && failNext.path.test(path)) {
			const message = failNext.message;
			failNext = null;
			return reply({ error: { message, code: 100 } }, 400);
		}
		const id = () => String(nextId++);
		if (method === "POST" && path === "/111/feed") return reply({ id: `111_${id()}` });
		if (method === "POST" && path === "/111/photos") return reply(params.published === "false" ? { id: id() } : { id: id(), post_id: `111_${id()}` });
		if (method === "POST" && path === "/111/videos") return reply({ id: id() });
		if (method === "POST" && path === "/222/media") {
			const c = id();
			containers.set(c, { status: params.video_url ? "IN_PROGRESS" : "FINISHED", params });
			return reply({ id: c });
		}
		if (method === "POST" && path === "/222/media_publish") {
			if (containers.get(params.creation_id)?.status !== "FINISHED") return reply({ error: { message: "Media not ready", code: 9007 } }, 400);
			return reply({ id: `ig${id()}` });
		}
		const one = path.match(/^\/([\w]+)$/);
		if (method === "GET" && one && containers.has(one[1])) return reply({ status_code: containers.get(one[1]).status });
		if (method === "GET" && one && one[1].startsWith("ig") && params.fields === "permalink") return reply({ permalink: `https://www.instagram.com/p/${one[1]}/` });
		if (method === "GET" && one && params.fields === "followers_count") return reply({ followers_count: one[1] === "111" ? 500 : 800 });
		if (method === "GET" && one && one[1].startsWith("ig")) return reply({ like_count: 12, comments_count: 3 });
		if (method === "GET" && one) return reply({ shares: { count: 2 }, reactions: { summary: { total_count: 9 } }, comments: { summary: { total_count: 1 } } });
		const listed = path.match(/^\/([\w]+)\/comments$/);
		if (method === "GET" && listed) return reply({ data: comments.get(listed[1]) || [] });
		if (method === "GET" && /\/insights$/.test(path)) return reply({ data: params.metric.split(",").map((name) => ({ name, values: [{ value: name === "reach" || name === "post_impressions_unique" ? 321 : 4 }] })) });
		if (method === "POST" && /\/(comments|replies)$/.test(path)) return reply({ id: `r${id()}` });
		return reply({ error: { message: `unknown route ${method} ${path}` } }, 404);
	});
});

afterEach(() => {
	vi.restoreAllMocks();
});

// ----- Calling the Worker -----

async function call(request, extraEnv = META) {
	const ctx = createExecutionContext();
	const res = await worker.fetch(request, { ...env, AGENT_NOVA_KEY: KEY, ...extraEnv }, ctx);
	await waitOnExecutionContext(ctx);
	const text = await res.text();
	let data = null;
	try {
		data = JSON.parse(text);
	} catch {}
	return { status: res.status, data, text, headers: res.headers };
}

const agent = (path, body = {}, extraEnv) =>
	call(new Request(BASE + path, { method: "POST", headers: { "Content-Type": "application/json", Authorization: `Bearer ${KEY}` }, body: JSON.stringify(body) }), extraEnv);

function portal(route, { body, headers = { Cookie: STAFF_COOKIE }, extraEnv } = {}) {
	const init = body === undefined ? { headers } : { method: "POST", headers: { "Content-Type": "application/json", Origin: BASE, ...headers }, body: JSON.stringify(body) };
	return call(new Request(`${BASE}/app/api/${route}`, init), extraEnv);
}

const row = (id) => env.DB.prepare("SELECT * FROM social_posts WHERE id = ?").bind(id).first();
const posts = (path) => calls.filter((c) => c.method === "POST" && (!path || c.path === path));
const later = (hours) => new Date(Date.now() + hours * 3600000).toISOString();
const ENV = (extra = META) => ({ ...env, AGENT_NOVA_KEY: KEY, ...extra });

async function staffPost(fields = {}, extraEnv = META) {
	const { status, data } = await portal("social", { body: { caption: "New single out Friday 🎶 #novacane", platforms: ["facebook"], ...fields }, extraEnv });
	expect(status).toBe(200);
	return data.post;
}

async function otherSignIns() {
	const now = new Date().toISOString();
	const until = new Date(Date.now() + 86_400_000).toISOString();
	await env.DB.batch([
		env.DB.prepare(
			"INSERT OR IGNORE INTO staff (id, email, password_hash, display_name, role, status, created_at, planet_seed, index_partition) VALUES ('test-staff', 'test-staff@novacane.test', NULL, 'Test Staff', 'staff', 'active', ?, 'test-staff', 'staff:test-staff')"
		).bind(now),
		env.DB.prepare("INSERT OR REPLACE INTO sessions (id, staff_id, kind, created_at, expires_at, last_seen_at) VALUES (?, 'test-staff', 'cookie', ?, ?, ?)").bind(await sha256("test-staff-session"), now, until, now),
		env.DB.prepare("INSERT OR REPLACE INTO sessions (id, staff_id, kind, created_at, expires_at, last_seen_at) VALUES (?, 'test-admin', 'token', ?, ?, ?)").bind(await sha256("nsess_test-admin-app"), now, until, now),
	]);
	return { staff: { Cookie: "nova_session=test-staff-session" }, adminToken: { Authorization: "Bearer nsess_test-admin-app" } };
}

// ===== 1. APPROVAL IS ENFORCED =====

describe("approval", () => {
	it("the AI's draft waits for approval; no agent-key route can approve or post", async () => {
		const { status, data } = await agent("/nova-agent/social/draft", { caption: "Studio's open late this week", platforms: ["facebook"], status: "approved", approved_hash: "x" });
		expect(status).toBe(200);
		const p = data.post;
		expect(p).toMatchObject({ status: "pending_approval", createdBy: "agent", decidedBy: null, platforms: ["facebook"] });
		expect(p.portalUrl).toBe(`${BASE}/portal/?view=social&post=${p.id}`);
		for (const path of [`/nova-agent/social/${p.id}/approve`, `/nova-agent/social/${p.id}/post`, `/nova-agent/social/${p.id}/posted`, "/nova-agent/social/approve", "/nova-agent/social/comments/1/approve"]) {
			expect((await agent(path, { id: p.id })).status).toBe(404);
		}
		const viaKey = await call(new Request(`${BASE}/app/api/social/${p.id}/approve`, { method: "POST", headers: { Origin: BASE, Authorization: `Bearer ${KEY}` }, body: "{}" }));
		expect(viaKey.status).toBe(401);
		expect((await row(p.id)).status).toBe("pending_approval");
		expect((await row(p.id)).approved_hash).toBeNull();
		// The cron does nothing with it
		await socialOnSchedule(ENV(), Date.now());
		expect(posts()).toEqual([]);
	});

	it("only an admin with the browser cookie can approve or reject; staff can write and edit", async () => {
		const p = await staffPost();
		const { staff, adminToken } = await otherSignIns();
		expect((await portal("social", { headers: staff })).data.canDecide).toBe(false);
		expect((await portal("social", { headers: adminToken })).data.canDecide).toBe(false);
		expect((await portal("social")).data.canDecide).toBe(true);
		for (const headers of [staff, adminToken]) {
			expect((await portal(`social/${p.id}/approve`, { body: {}, headers })).status).toBe(403);
			expect((await portal(`social/${p.id}/reject`, { body: {}, headers })).status).toBe(403);
		}
		expect((await portal(`social/${p.id}/approve`, { body: {}, headers: { Cookie: STAFF_COOKIE, Origin: "https://evil.example" } })).status).toBe(403);
		expect((await portal(`social/${p.id}/approve`, { body: {}, headers: {} })).status).toBe(401);
		const edited = await portal(`social/${p.id}/edit`, { body: { caption: "New single out THIS Friday" }, headers: staff });
		expect(edited.status).toBe(200);
		expect(edited.data.post.status).toBe("pending_approval");
		expect(posts()).toEqual([]);
	});

	it("an admin's Approve posts it once; a second press does nothing more", async () => {
		const p = await staffPost();
		const first = await portal(`social/${p.id}/approve`, { body: {} });
		expect(first.status).toBe(200);
		expect(first.data.post.status).toBe("posted");
		expect(first.data.post.targets.facebook).toMatchObject({ mode: "auto", state: "posted" });
		expect(first.data.post.targets.facebook.url).toMatch(/^https:\/\/www\.facebook\.com\/111_\d+$/);
		expect(posts("/111/feed")).toHaveLength(1);
		expect(posts("/111/feed")[0].params.message).toBe("New single out Friday 🎶 #novacane");
		const again = await portal(`social/${p.id}/approve`, { body: {} });
		expect(again.data.repeated).toBe(true);
		await socialOnSchedule(ENV(), Date.now() + 120_000);
		expect(posts("/111/feed")).toHaveLength(1);
		const log = (await portal(`social/${p.id}`)).data.log.map((e) => e.event);
		expect(log).toEqual(["created", "submitted", "approved", "posting", "posted"]);
	});

	it("anything changed after approval isn't posted: it goes back to waiting", async () => {
		const p = await staffPost({ postAt: later(3) });
		expect((await portal(`social/${p.id}/approve`, { body: {} })).data.post.status).toBe("scheduled");
		// Changed behind Portal's back (not through an edit)
		await env.DB.prepare("UPDATE social_posts SET caption = 'Something else entirely' WHERE id = ?").bind(p.id).run();
		await socialOnSchedule(ENV(), Date.now() + 4 * 3600000);
		const r = await row(p.id);
		expect(r.status).toBe("pending_approval");
		expect(r.approved_hash).toBeNull();
		expect(posts()).toEqual([]);
	});

	it("an edit clears the approval; a post being posted, or posted, can't be edited", async () => {
		const p = await staffPost({ postAt: later(3) });
		await portal(`social/${p.id}/approve`, { body: {} });
		const edited = await portal(`social/${p.id}/edit`, { body: { caption: "Changed my mind" } });
		expect(edited.data.post).toMatchObject({ status: "pending_approval", decidedBy: null });
		expect((await row(p.id)).approved_hash).toBeNull();
		await portal(`social/${p.id}/edit`, { body: { postAt: "" } });
		await portal(`social/${p.id}/approve`, { body: {} });
		expect((await row(p.id)).status).toBe("posted");
		expect((await portal(`social/${p.id}/edit`, { body: { caption: "Too late" } })).status).toBe(409);
	});
});

// ===== 2. CHECKS =====

describe("what a post can be", () => {
	it("Instagram's limits, Facebook's video rule, and Instagram needing a picture before approval", async () => {
		const long = await portal("social", { body: { caption: "x".repeat(2201), platforms: ["instagram"] } });
		expect(long.status).toBe(400);
		const tags = await portal("social", { body: { caption: Array.from({ length: 31 }, (_, i) => `#t${i}`).join(" "), platforms: ["instagram"] } });
		expect(tags.status).toBe(400);
		expect((await portal("social", { body: { caption: "Hi", platforms: ["facebook"], media: [VID, PIC] } })).status).toBe(400);
		expect((await portal("social", { body: { caption: "Hi", platforms: ["tiktok"] } })).status).toBe(400);
		expect((await portal("social", { body: { caption: "Hi", platforms: ["facebook"], media: [{ id: "../../etc", ext: "jpg" }] } })).status).toBe(400);
		// An AI draft for Instagram has no picture yet: it can wait, but can't be approved
		const { data } = await agent("/nova-agent/social/draft", { caption: "Behind the scenes", platforms: ["instagram"] });
		const approve = await portal(`social/${data.post.id}/approve`, { body: {} });
		expect(approve.status).toBe(409);
		expect(approve.data.error).toMatch(/Instagram needs at least one picture or video/);
	});
});

// ===== 3. WITHOUT META: POSTED BY HAND =====

describe("posting by hand (Meta not connected)", () => {
	it("an approved post waits as 'manual'; \"I posted it\" finishes it; nothing reaches Meta", async () => {
		const p = await staffPost({ platforms: ["facebook", "instagram"], media: [PIC] }, NO_META);
		const approved = await portal(`social/${p.id}/approve`, { body: {}, extraEnv: NO_META });
		expect(approved.data.post.status).toBe("manual");
		expect(approved.data.post.targets).toMatchObject({ facebook: { mode: "manual", state: "waiting" }, instagram: { mode: "manual", state: "waiting" } });
		const { staff } = await otherSignIns();
		const bad = await portal(`social/${p.id}/posted`, { body: { platform: "facebook", url: "javascript:alert(1)" }, headers: staff, extraEnv: NO_META });
		expect(bad.status).toBe(400);
		const fb = await portal(`social/${p.id}/posted`, { body: { platform: "facebook", url: "https://www.facebook.com/novacane/posts/1" }, headers: staff, extraEnv: NO_META });
		expect(fb.data.post.status).toBe("manual");
		const ig = await portal(`social/${p.id}/posted`, { body: { platform: "instagram" }, headers: staff, extraEnv: NO_META });
		expect(ig.data.post.status).toBe("posted");
		expect(ig.data.post.targets.facebook).toMatchObject({ state: "posted", url: "https://www.facebook.com/novacane/posts/1", by: "test-staff" });
		expect(calls).toEqual([]);
		// The files can't be fetched by anyone now (it's no longer being posted)
		const sig = await call(new Request(`${BASE}/social/media/${p.id}/${PIC.id}.jpg?t=x`), NO_META);
		expect(sig.status).toBe(404);
	});

	it("only Facebook connected: Facebook posts by itself, Instagram waits for a person", async () => {
		const p = await staffPost({ platforms: ["facebook", "instagram"], media: [PIC] });
		const only = { ...META, META_IG_USER_ID: "" };
		const approved = await portal(`social/${p.id}/approve`, { body: {}, extraEnv: only });
		expect(approved.data.post.status).toBe("manual");
		expect(approved.data.post.targets.facebook).toMatchObject({ mode: "auto", state: "posted" });
		expect(approved.data.post.targets.instagram).toMatchObject({ mode: "manual", state: "waiting" });
		expect(posts("/111/photos")).toHaveLength(1);
		expect(posts("/222/media")).toHaveLength(0);
	});
});

// ===== 4. META'S ADDRESSES FOR THE FILES =====

describe("the files' addresses for Meta", () => {
	it("are signed for exactly this approval, and only answer while it's being posted", async () => {
		const p = await staffPost({ platforms: ["instagram"], media: [VID], caption: "Clip" });
		const before = await call(new Request(`${BASE}/social/media/${p.id}/${VID.id}.mp4?t=nothing`));
		expect(before.status).toBe(404);
		await portal(`social/${p.id}/approve`, { body: {} });
		const r = await row(p.id);
		expect(r.status).toBe("posting");
		const container = posts("/222/media")[0];
		expect(container.params.media_type).toBe("REELS");
		const url = new URL(container.params.video_url);
		expect(url.origin + url.pathname).toBe(`${BASE}/social/media/${p.id}/${VID.id}.mp4`);
		const ok = await call(new Request(url.toString()));
		expect(ok.status).toBe(200);
		expect(ok.headers.get("Content-Type")).toBe("video/mp4");
		expect(fetchedMedia).toEqual([`/${VID.id}.mp4`]);
		// A wrong signature, another file, or another post: nothing
		expect((await call(new Request(url.toString().replace(/t=[0-9a-f]/, "t=0")))).status).toBe(404);
		expect((await call(new Request(`${BASE}/social/media/${p.id}/${PIC.id}.jpg${url.search}`))).status).toBe(404);
		expect((await call(new Request(`${BASE}/social/media/${p.id + 1}/${VID.id}.mp4${url.search}`))).status).toBe(404);
		// The video is still being prepared: it waits; then Instagram has it and it's published
		await socialOnSchedule(ENV(), Date.now() + 60_000);
		expect((await row(p.id)).status).toBe("posting");
		expect(posts("/222/media_publish")).toHaveLength(0);
		[...containers.values()][0].status = "FINISHED";
		await socialOnSchedule(ENV(), Date.now() + 120_000);
		const done = await row(p.id);
		expect(done.status).toBe("posted");
		expect(JSON.parse(done.targets).instagram.url).toMatch(/^https:\/\/www\.instagram\.com\/p\/ig\d+\/$/);
		expect(posts("/222/media_publish")).toHaveLength(1);
		// Posted: the address stops working
		expect((await call(new Request(url.toString()))).status).toBe(404);
	});

	it("several pictures: an Instagram carousel and one Facebook post with them all", async () => {
		const p = await staffPost({ platforms: ["facebook", "instagram"], media: [PIC, PIC2], caption: "Two" });
		const approved = await portal(`social/${p.id}/approve`, { body: {} });
		expect(approved.data.post.status).toBe("posted");
		const photos = posts("/111/photos");
		expect(photos.map((c) => c.params.published)).toEqual(["false", "false"]);
		const feed = posts("/111/feed")[0];
		expect(JSON.parse(feed.params["attached_media[0]"])).toEqual({ media_fbid: expect.any(String) });
		expect(feed.params["attached_media[1]"]).toBeTruthy();
		const ig = posts("/222/media");
		expect(ig.slice(0, 2).every((c) => c.params.is_carousel_item === "true")).toBe(true);
		expect(ig[2].params).toMatchObject({ media_type: "CAROUSEL", caption: "Two" });
		expect(posts("/222/media_publish")).toHaveLength(1);
	});
});

// ===== 5. SCHEDULED, FAILED, AND NEVER TWICE =====

describe("scheduled and failed posts", () => {
	it("a scheduled post goes out at its time from the minute's check", async () => {
		const p = await staffPost({ postAt: later(2) });
		expect((await portal(`social/${p.id}/approve`, { body: {} })).data.post.status).toBe("scheduled");
		await socialOnSchedule(ENV(), Date.now());
		expect(posts()).toEqual([]);
		await socialOnSchedule(ENV(), Date.now() + 2 * 3600000 + 1000);
		expect((await row(p.id)).status).toBe("posted");
		expect(posts("/111/feed")).toHaveLength(1);
	});

	it("Meta saying no: failed with its reason; after an edit and a new approval only the platform that failed goes again", async () => {
		const p = await staffPost({ platforms: ["facebook", "instagram"], media: [PIC] });
		failNext = { path: /^\/222\/media$/, message: "The image format isn't supported" };
		const approved = await portal(`social/${p.id}/approve`, { body: {} });
		expect(approved.data.post.status).toBe("failed");
		expect(approved.data.post.error).toMatch(/Instagram: The image format isn't supported/);
		expect(approved.data.post.error).toMatch(/It did go out on Facebook/);
		expect(posts("/111/photos")).toHaveLength(1);
		expect((await portal(`social/${p.id}/approve`, { body: {} })).status).toBe(409);
		await portal(`social/${p.id}/edit`, { body: { caption: "Fixed" } });
		const again = await portal(`social/${p.id}/approve`, { body: {} });
		expect(again.data.post.status).toBe("posted");
		expect(posts("/111/photos")).toHaveLength(1);
		expect(posts("/222/media_publish")).toHaveLength(1);
	});

	it("stopped half-way through posting to Facebook: never posted again by itself", async () => {
		const p = await staffPost();
		await env.DB.prepare("UPDATE social_posts SET status = 'approved', approved_hash = ?, updated_at = ? WHERE id = ?")
			.bind(null, new Date().toISOString(), p.id)
			.run();
		// (no hash: it goes back to waiting rather than posting)
		await socialOnSchedule(ENV(), Date.now() + 10 * 60_000);
		expect((await row(p.id)).status).toBe("pending_approval");
		await portal(`social/${p.id}/approve`, { body: {} });
		expect(posts("/111/feed")).toHaveLength(1);
		// A post left in 'sending' (Nova Bot stopped mid-call) is marked failed, not re-sent
		const q = await staffPost({ caption: "Second" });
		expect((await portal(`social/${q.id}/approve`, { body: {}, extraEnv: NO_META })).data.post.status).toBe("manual");
		const r = await row(q.id);
		await env.DB.prepare("UPDATE social_posts SET status = 'posting', targets = ? WHERE id = ?").bind(JSON.stringify({ facebook: { mode: "auto", state: "sending" } }), q.id).run();
		await socialOnSchedule(ENV(), Date.now() + 60_000);
		const after = await row(q.id);
		expect(after.status).toBe("failed");
		expect(after.error).toMatch(/Check the Page before posting it again/);
		expect(posts("/111/feed")).toHaveLength(1);
		expect(r.approved_hash).toBeTruthy();
	});
});

// ===== 6. RESULTS, FOLLOWERS AND COMMENTS =====

describe("every hour", () => {
	it("reads results, followers and new comments; a reply goes only after an admin approves it", async () => {
		const p = await staffPost({ platforms: ["facebook", "instagram"], media: [PIC] });
		await portal(`social/${p.id}/approve`, { body: {} });
		const t = JSON.parse((await row(p.id)).targets);
		comments.set(t.facebook.objectId, [
			{ id: "c1", message: "When's the next open mic?", from: { id: "999", name: "Sam Fan" }, created_time: "2026-10-12T10:00:00+0000" },
			{ id: "c2", message: "Thanks all!", from: { id: "111", name: "Novacane Studios" }, created_time: "2026-10-12T10:05:00+0000" },
		]);
		comments.set(t.instagram.objectId, [{ id: "c3", text: "🔥🔥", username: "beatmaker", timestamp: "2026-10-12T11:00:00+0000" }]);
		await socialOnSchedule(ENV(), Date.now() + 60_000);
		const list = (await portal("social")).data;
		expect(list.followers).toMatchObject({ facebook: { followers: 500 }, instagram: { followers: 800 } });
		const stats = list.posts.find((x) => x.id === p.id).stats;
		expect(stats.facebook).toMatchObject({ likes: 9, comments: 1, shares: 2, reach: 321 });
		expect(stats.instagram).toMatchObject({ likes: 12, comments: 3, reach: 321 });
		expect(list.comments.map((c) => c.author).sort()).toEqual(["@beatmaker", "Sam Fan"]);
		// Reading again doesn't add them twice
		await env.DB.prepare("DELETE FROM settings").run();
		await socialOnSchedule(ENV(), Date.now() + 2 * 3600000);
		expect((await portal("social")).data.comments).toHaveLength(2);

		const sam = list.comments.find((c) => c.author === "Sam Fan");
		const drafted = await agent(`/nova-agent/social/comments/${sam.id}/reply`, { text: "Every Thursday from 7pm! 🎤" });
		expect(drafted.data.comment.replyStatus).toBe("pending_approval");
		expect(posts("/c1/comments")).toHaveLength(0);
		const { staff } = await otherSignIns();
		expect((await portal(`social/comments/${sam.id}/approve`, { body: {}, headers: staff })).status).toBe(403);
		const sent = await portal(`social/comments/${sam.id}/approve`, { body: {} });
		expect(sent.data.comment).toMatchObject({ replyStatus: "sent", handled: true });
		expect(posts("/c1/comments")[0].params.message).toBe("Every Thursday from 7pm! 🎤");
		const fire = list.comments.find((c) => c.author === "@beatmaker");
		await portal(`social/comments/${fire.id}/reply`, { body: { text: "🙏" }, headers: staff });
		await portal(`social/comments/${fire.id}/approve`, { body: {} });
		expect(posts("/c3/replies")).toHaveLength(1);
		const handled = await portal(`social/comments/${fire.id}/handled`, { body: { handled: true }, headers: staff });
		expect(handled.data.comment.handled).toBe(true);
	});
});

// Aria, the social media manager (src/aria.js, Portal's /app/api/funnel/aria): she asks one question
// at a time, writes posts (three captions, hashtags, a day and time) and outreach in three angles,
// follows up (tweak, full script, outreach sequence), and a person sends things on: into Social
// (waiting for an admin's approval there), onto Metricool (a draft for anyone; posting by itself is
// an admin's), or by hand. Nothing here messages anyone.
import { createExecutionContext, env, waitOnExecutionContext } from "cloudflare:test";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import worker from "../src";
import { postText, readBestTimes } from "../src/aria.js";
import { STAFF_COOKIE } from "./sign-in.js";
import { sha256 } from "../src/portal/auth.js";

const BASE = "https://novacane-worker.test";
const AI = { ANTHROPIC_API_KEY: "sk-test" };
const MC = { METRICOOL_USER_TOKEN: "mc-test", METRICOOL_USER_ID: "1", METRICOOL_BLOG_ID: "2" };

let claude; // { replies: [...], calls: [...] }
let metricool; // { calls: [...] }

const day = (n) => new Date(Date.now() + n * 86400000).toLocaleDateString("en-CA", { timeZone: "Europe/London" });
const post = (over = {}) => ({
	platform: "instagram",
	format: "Reel",
	pillar: "story",
	title: "A night in the live room",
	hook: "This is what 11pm sounds like here",
	body: "0:00–0:02 [the mic, close up] …",
	captions: ["Late session energy.", "Where the take finally lands.", "The room after dark."],
	cta: "Come and make something.",
	hashtags: ["#ForestHill", "studio life", "#LondonMusic"],
	visual: "A slow pan across the desk",
	date: day(2),
	time: "18:00",
	time_why: "A usual good time",
	...over,
});
const reach = (over = {}) => ({ platform: "instagram", kind: "dm", target_name: "Maya", target_handle: "@maya", why: "Posts her own songs", angle_a: "A", angle_b: "B", angle_c: "C", ...over });

beforeEach(async () => {
	await env.DB.batch(["settings", "social_comments", "social_post_log", "social_posts"].map((t) => env.DB.prepare(`DELETE FROM ${t}`)));
	claude = { replies: [], calls: [] };
	metricool = { calls: [] };
	vi.spyOn(globalThis, "fetch").mockImplementation(async (url, init = {}) => {
		const u = new URL(String(url));
		if (String(url) === "https://api.anthropic.com/v1/messages") {
			claude.calls.push(JSON.parse(init.body));
			const next = claude.replies.shift();
			return next ? Response.json({ stop_reason: "end_turn", content: [{ type: "text", text: JSON.stringify(next) }] }) : new Response("overloaded", { status: 529 });
		}
		if (u.hostname === "app.metricool.com") {
			metricool.calls.push({ path: u.pathname, params: Object.fromEntries(u.searchParams), headers: init.headers, body: init.body ? JSON.parse(init.body) : null });
			if (u.pathname.includes("besttimes")) return Response.json({ data: [{ dayOfWeek: 2, hour: 18, value: 9 }, { dayOfWeek: 5, hour: 12, value: 4 }] });
			return Response.json({ data: { id: 777 } });
		}
		return new Response("{}", { status: 404 });
	});
});

afterEach(() => vi.restoreAllMocks());

async function call(request, extra = {}) {
	const ctx = createExecutionContext();
	const res = await worker.fetch(request, { ...env, ANTHROPIC_API_KEY: "", METRICOOL_USER_TOKEN: "", ...extra }, ctx);
	await waitOnExecutionContext(ctx);
	const text = await res.text();
	let data = null;
	try {
		data = JSON.parse(text);
	} catch {}
	return { status: res.status, data };
}
function portal(route, { body, headers = { Cookie: STAFF_COOKIE }, extra = AI } = {}) {
	const init = body === undefined ? { headers } : { method: "POST", headers: { "Content-Type": "application/json", Origin: BASE, ...headers }, body: JSON.stringify(body) };
	return call(new Request(`${BASE}/app/api/funnel/${route}`, init), extra);
}
async function staffSignIn() {
	const now = new Date().toISOString();
	const until = new Date(Date.now() + 86_400_000).toISOString();
	await env.DB.batch([
		env.DB.prepare("INSERT OR IGNORE INTO staff (id, email, password_hash, display_name, role, status, created_at, planet_seed, index_partition) VALUES ('test-staff', 'test-staff@novacane.test', NULL, 'Test Staff', 'staff', 'active', ?, 'test-staff', 'staff:test-staff')").bind(now),
		env.DB.prepare("INSERT OR REPLACE INTO sessions (id, staff_id, kind, created_at, expires_at, last_seen_at) VALUES (?, 'test-staff', 'cookie', ?, ?, ?)").bind(await sha256("test-staff-session"), now, until, now),
	]);
	return { Cookie: "nova_session=test-staff-session" };
}

describe("Aria", () => {
	it("needs a sign-in, and shows the dashboard with the studio's brand profile", async () => {
		expect((await call(new Request(`${BASE}/app/api/funnel/aria`))).status).toBe(401);
		const { status, data } = await portal("aria");
		expect(status).toBe(200);
		expect(data.profile.brand).toBe("Novacane Studios");
		expect(data.profile.voice).toMatch(/No famous names/);
		expect(data.counts).toMatchObject({ ideas: 0, planned: 0, toSend: 0 });
		expect(data.ready).toMatchObject({ claude: true, metricool: false });
		expect(data.closing).toMatch(/tweak these ideas/);
	});

	it("asks one question first when she needs to, then writes with the answer", async () => {
		claude.replies.push({ question: "What's the campaign for?", intro: "", posts: [], outreach: [] });
		const first = await portal("aria/ask", { body: { mode: "ideas", brief: "a campaign", platforms: ["instagram", "tiktok"], count: 2 } });
		expect(first.status).toBe(200);
		expect(first.data.ask.question).toBe("What's the campaign for?");
		expect(first.data.items).toEqual([]);
		// The brand, the rules and the request go to Claude (the request as data)
		expect(claude.calls[0].system).toMatch(/You are Aria/);
		expect(claude.calls[0].system).toMatch(/never name artists/);
		expect(claude.calls[0].messages[0].content).toMatch(/<data name="the request">\na campaign/);

		claude.replies.push({ question: "", intro: "Two story posts.", posts: [post(), post({ platform: "tiktok", pillar: "value", hook: "Three vocal tips" })], outreach: [] });
		const second = await portal("aria/ask", { body: { askId: first.data.ask.id, answer: "Winter open days" } });
		expect(second.status).toBe(200);
		expect(second.data.items).toHaveLength(2);
		expect(second.data.closing).toMatch(/full script\/caption for option/);
		expect(claude.calls[1].messages[0].content).toMatch(/You asked: What's the campaign for\?/);
		const [a] = second.data.items;
		expect(a).toMatchObject({ kind: "post", status: "planned", platform: "instagram", chosen: 0 });
		expect(a.hashtags).toEqual(["#ForestHill", "#studiolife", "#LondonMusic"]);

		const dash = (await portal("aria")).data;
		expect(dash.counts.planned).toBe(2);
		expect(dash.counts.week).toBe(2);
		expect(dash.next).toHaveLength(2);
		expect(dash.mix.actual).toMatchObject({ story: 1, value: 1 });
	});

	it("stops asking after three questions", async () => {
		let askId;
		for (let i = 0; i < 3; i++) {
			claude.replies.push({ question: `Question ${i}?`, intro: "", posts: [], outreach: [] });
			const r = await portal("aria/ask", { body: askId ? { askId, answer: `Answer ${i}` } : { brief: "posts" } });
			askId = r.data.ask.id;
		}
		claude.replies.push({ question: "One more?", intro: "", posts: [post()], outreach: [] });
		const last = await portal("aria/ask", { body: { askId, answer: "Answer 3" } });
		expect(last.data.ask.question).toBeNull();
		expect(last.data.items).toHaveLength(1);
		expect(claude.calls.at(-1).messages[0].content).toMatch(/You've asked enough/);
	});

	it("says so plainly without Claude", async () => {
		const r = await portal("aria/ask", { body: { brief: "posts" }, extra: {} });
		expect(r.status).toBe(409);
		expect(r.data.error).toMatch(/Aria needs Claude/);
	});

	it("writes outreach in three angles, to be sent by hand, and tracks it", async () => {
		claude.replies.push({ question: "", intro: "Three ways in.", posts: [], outreach: [reach()] });
		const r = await portal("aria/ask", { body: { mode: "outreach", target: { name: "Maya", handle: "@maya", notes: "Sings soul covers" } } });
		expect(r.status).toBe(200);
		const [o] = r.data.items;
		expect(o).toMatchObject({ kind: "outreach", status: "drafted", chosen: "A", angles: { A: "A", B: "B", C: "C" } });
		expect(o.target.notes).toBe("Sings soul covers");
		expect(claude.calls[0].messages[0].content).toMatch(/<data name="who to reach">/);
		expect((await portal(`aria/${o.id}/edit`, { body: { chosen: "C" } })).data.item.chosen).toBe("C");
		expect((await portal(`aria/${o.id}/status`, { body: { status: "sent" } })).data.item.status).toBe("sent");
		expect((await portal("aria")).data.counts).toMatchObject({ sent: 1, toSend: 0 });
		// The follow-up sequence: steps saved on it
		claude.replies.push({ intro: "", steps: [{ day: 3, text: "A friendly nudge" }, { day: 9, text: "Last one" }], outreach: [] });
		const seq = await portal(`aria/${o.id}/sequence`, { body: {} });
		expect(seq.data.item.sequence).toEqual([{ day: 3, text: "A friendly nudge" }, { day: 9, text: "Last one" }]);
		// Outreach needs someone to reach
		expect((await portal("aria/ask", { body: { mode: "outreach" } })).status).toBe(400);
	});

	it("tweaks, writes the full script, and drafts the outreach sequence for a post", async () => {
		claude.replies.push({ question: "", intro: "", posts: [post()], outreach: [] });
		const [p] = (await portal("aria/ask", { body: { brief: "one post", count: 1 } })).data.items;
		claude.replies.push({ question: "", intro: "", posts: [post({ hook: "Funnier hook", date: "" })], outreach: [] });
		const t = await portal(`aria/${p.id}/tweak`, { body: { note: "funnier" } });
		expect(t.data.item.hook).toBe("Funnier hook");
		expect(t.data.item.date).toBe(p.date); // the day it had stays
		expect((await portal(`aria/${p.id}/tweak`, { body: {} })).status).toBe(400);
		claude.replies.push({ question: "", intro: "", posts: [post({ body: "0:00 full script" })], outreach: [] });
		expect((await portal(`aria/${p.id}/full`, { body: {} })).data.item.body).toBe("0:00 full script");
		expect(claude.calls.at(-1).messages[0].content).toMatch(/timestamps/);
		claude.replies.push({ intro: "", steps: [{ day: 0, text: "Reply to every comment" }], outreach: [reach(), reach({ target_name: "Tom" })] });
		const s = await portal(`aria/${p.id}/sequence`, { body: {} });
		expect(s.data.items).toHaveLength(2);
		expect(s.data.items[0].forPost).toBe(p.id);
		expect((await portal("aria")).data.counts.toSend).toBe(2);
	});

	it("plans, edits, marks posted, drops and removes", async () => {
		claude.replies.push({ question: "", intro: "", posts: [post({ date: "", time: "" })], outreach: [] });
		const [p] = (await portal("aria/ask", { body: { brief: "one" } })).data.items;
		expect(p.status).toBe("idea");
		expect((await portal(`aria/${p.id}/edit`, { body: { date: "2020-01-01", time: "10:00" } })).status).toBe(400);
		const planned = await portal(`aria/${p.id}/edit`, { body: { date: day(3), time: "12:30", chosen: 2, hashtags: "#one two" } });
		expect(planned.data.item).toMatchObject({ status: "planned", time: "12:30", chosen: 2, hashtags: ["#one", "#two"] });
		const posted = await portal(`aria/${p.id}/status`, { body: { status: "posted", url: "https://www.instagram.com/p/abc" } });
		expect(posted.data.item).toMatchObject({ status: "posted", url: "https://www.instagram.com/p/abc" });
		expect((await portal(`aria/${p.id}/status`, { body: { status: "sent" } })).status).toBe(400);
		expect((await portal(`aria/${p.id}/remove`, { body: {} })).status).toBe(200);
		expect((await portal("aria")).data.items).toEqual([]);
	});

	it("puts an Instagram post into Social, waiting for an admin's approval there", async () => {
		claude.replies.push({ question: "", intro: "", posts: [post(), post({ platform: "tiktok" })], outreach: [] });
		const [ig, tt] = (await portal("aria/ask", { body: { brief: "two" } })).data.items;
		const r = await portal(`aria/${ig.id}/social`, { body: {} });
		expect(r.status).toBe(200);
		expect(r.data.item).toMatchObject({ status: "in_social", socialId: r.data.post.id });
		expect(r.data.post.status).toBe("pending_approval");
		expect(r.data.post.platforms).toEqual(["instagram"]);
		expect(r.data.post.caption).toBe(postText(ig));
		expect((await portal(`aria/${ig.id}/social`, { body: {} })).status).toBe(409);
		const no = await portal(`aria/${tt.id}/social`, { body: {} });
		expect(no.status).toBe(400);
		expect(no.data.error).toMatch(/Facebook and Instagram/);
	});

	it("puts posts on the Metricool calendar: a draft for anyone, posting by itself only for an admin", async () => {
		const extra = { ...AI, ...MC };
		claude.replies.push({ question: "", intro: "", posts: [post(), post({ platform: "x" }), post({ platform: "x" })], outreach: [] });
		const [ig, x1, x2] = (await portal("aria/ask", { body: { brief: "three" }, extra })).data.items;
		const draft = await portal(`aria/${ig.id}/metricool`, { body: {}, extra });
		expect(draft.status).toBe(200);
		expect(draft.data.item).toMatchObject({ status: "metricool", metricoolId: "777", metricoolAuto: false });
		const sent = metricool.calls.find((c) => c.path === "/api/v2/scheduler/posts");
		expect(sent.headers["X-Mc-Auth"]).toBe("mc-test");
		expect(sent.params).toMatchObject({ userId: "1", blogId: "2" });
		expect(sent.body).toMatchObject({ publicationDate: { dateTime: `${ig.date}T18:00:00`, timezone: "Europe/London" }, providers: [{ network: "instagram" }], draft: true, autoPublish: false });
		// Instagram can't post by itself (it needs the picture)
		expect((await portal(`aria/${x1.id}/metricool`, { body: { autoPublish: true }, extra })).status).toBe(200);
		expect(metricool.calls.filter((c) => c.path === "/api/v2/scheduler/posts").at(-1).body).toMatchObject({ providers: [{ network: "twitter" }], autoPublish: true, draft: false });
		// Staff can't set one to post by itself
		const staff = await portal(`aria/${x2.id}/metricool`, { body: { autoPublish: true }, headers: await staffSignIn(), extra });
		expect(staff.status).toBe(403);
		// Without the keys: said plainly
		expect((await portal(`aria/${x2.id}/metricool`, { body: {} })).data.error).toMatch(/Metricool isn't connected/);
	});

	it("reads Metricool's best times loosely", () => {
		expect(readBestTimes({ data: [{ dayOfWeek: 2, hour: 18, value: 9 }, { day: "friday", hour: 12, score: 4 }, { hour: 30 }] })).toEqual([
			{ day: "Tuesday", hour: 18, score: 9 },
			{ day: "Friday", hour: 12, score: 4 },
		]);
		expect(readBestTimes(null)).toEqual([]);
	});

	it("keeps the brand profile an admin's, and the mix adding up to 100", async () => {
		const staff = await portal("aria/profile", { body: { brand: "X" }, headers: await staffSignIn() });
		expect(staff.status).toBe(403);
		expect((await portal("aria/profile", { body: { mix: { value: 50 } } })).data.error).toMatch(/add up to 100/);
		const ok = await portal("aria/profile", { body: { brand: "Novacane", platforms: ["x", "nope"], mix: { value: 40, story: 30, engagement: 20, conversion: 10 } } });
		expect(ok.data.profile).toMatchObject({ brand: "Novacane", platforms: ["x"], mix: { value: 40, conversion: 10 } });
	});
});

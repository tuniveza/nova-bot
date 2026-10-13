// The status page (src/status.js): public, nothing personal, a light per part, the chat tested for
// real (and the test chat removed), the button rate limited, 503 for an outside watchdog when red.
import { createExecutionContext, env, waitOnExecutionContext } from "cloudflare:test";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import worker from "../src";
import { ago, chatRoundTrip, computeStatus, cronHeartbeat, setTidyDelay, statusPage } from "../src/status.js";

const BASE = "https://novacane-worker.test";
async function call(path, { method = "GET", headers = { "Sec-Fetch-Dest": "document", Accept: "text/html" } } = {}) {
	const ctx = createExecutionContext();
	const res = await worker.fetch(new Request(BASE + path, { method, headers, redirect: "manual" }), env, ctx);
	await waitOnExecutionContext(ctx);
	return res;
}
const setting = (key, value) =>
	env.DB.prepare("INSERT INTO settings (key, value) VALUES (?, ?) ON CONFLICT (key) DO UPDATE SET value = excluded.value").bind(key, value).run();
const clearStatus = () => env.DB.prepare("DELETE FROM settings WHERE key IN ('status_cache','status_chat_test','status_laptop_off_test','cron_heartbeat_at')").run();

// A stand-in for the outside world: the website chat answers, the VPS reports, Acuity's feed answers
function world({ chat = true, vps = true, feed = true } = {}) {
	const calls = [];
	globalThis.fetch = vi.fn(async (url, init) => {
		const u = String(url);
		calls.push({ url: u, method: init?.method || "GET", body: init?.body });
		if (u.includes("/desk-status/status"))
			return vps
				? Response.json({ uptimeSeconds: 86400 * 3, memory: { total: 4e9, free: 2e9 }, disk: { total: 50e9, free: 30e9 }, lastBackup: new Date().toISOString(), mail: { sender: "active", postfix: "active", queue: 0, lastSent: new Date().toISOString() } })
				: new Response("no", { status: 502 });
		if (u.startsWith("https://acuity.test/")) return feed ? new Response("BEGIN:VCALENDAR\nEND:VCALENDAR") : new Response("gone", { status: 404 });
		if (u === `${env.PUBLIC_URL}/`) return chat ? Response.json({ reply: "OK" }) : Response.json({ error: "Claude is down" }, { status: 500 });
		return new Response("unexpected", { status: 599 });
	});
	return calls;
}

const real = globalThis.fetch;
beforeEach(async () => {
	setTidyDelay(0);
	env.ACUITY_CALENDAR_URL = "https://acuity.test/feed.ics";
	await clearStatus();
});
afterEach(() => {
	globalThis.fetch = real;
	delete env.ACUITY_CALENDAR_URL;
});

describe("status page", () => {
	it("opens without signing in, as a page (not sent into Nova Agent), and the data has a light per part", async () => {
		world();
		await setting("status_chat_test", JSON.stringify({ ok: true, ms: 1200, at: new Date().toISOString() }));
		await cronHeartbeat(env, Date.now(), globalThis.fetch);
		const page = await call("/status", { headers: { "Sec-Fetch-Dest": "document" } });
		expect(page.status).toBe(200);
		expect(page.headers.get("Content-Type")).toMatch(/text\/html/);
		const html = await page.text();
		expect(html).toContain("If something&#39;s red, do this".replace("&#39;", "'"));
		expect(html).toContain("Test the chat now");
		expect(html).toContain('http-equiv="refresh" content="60"');

		const res = await call("/status.json");
		const data = await res.json();
		const ids = data.parts.map((p) => p.id);
		expect(ids).toEqual(expect.arrayContaining(["chat", "portal", "signin", "email", "feed", "jobs", "backups", "server", "google", "pc"]));
		for (const p of data.parts) expect(["green", "amber", "red"]).toContain(p.state);
		expect(data.parts.find((p) => p.id === "chat").state).toBe("green");
		expect(data.parts.find((p) => p.id === "email").state).toBe("green");
		expect(data.parts.find((p) => p.id === "feed").state).toBe("green");
		expect(data.parts.find((p) => p.id === "jobs").state).toBe("green");
	});

	it("leaves Nova Agent's own fetch('/status') to the studio PC", async () => {
		world();
		const res = await call("/status", { headers: { "Sec-Fetch-Dest": "empty", Accept: "*/*" } });
		expect(res.headers.get("Content-Type") || "").not.toMatch(/text\/html/);
		const curl = await call("/status", { headers: {} });
		expect(curl.headers.get("Content-Type") || "").not.toMatch(/text\/html/);
	});

	it("never shows anything personal: no emails, names, keys or the calendar link", async () => {
		world();
		await env.DB.prepare("INSERT OR IGNORE INTO settings (key, value) VALUES ('google_account', 'owner@example.com')").run();
		const text = await (await call("/status.json")).text();
		const html = await (await call("/status")).text();
		for (const out of [text, html]) {
			expect(out).not.toMatch(/[\w.+-]+@[a-z-]+(\.[a-z-]+)*\.[a-z]{2,}/i); // (the ssh line root@<IP> is fine)
			expect(out).not.toContain(env.AGENT_NOVA_KEY);
			expect(out).not.toContain("acuity.test");
		}
	});

	it("says what keeps working when the studio PC is off, and what waits for it", async () => {
		world();
		const data = await (await call("/status.json")).json();
		const pc = data.parts.find((p) => p.id === "pc");
		expect(pc.state).toBe("amber");
		expect(pc.text).toMatch(/Still working without it: the website chat/);
		expect(pc.text).toMatch(/Waiting for it: Agent, quests, Calendar's own notes, Board, Console's terminals and the Fixer/);
	});

	it("answers 503 when something is red, so an outside watchdog notices", async () => {
		world({ feed: false });
		const res = await call("/status.json");
		expect(res.status).toBe(503);
		const data = await res.json();
		expect(data.ok).toBe(false);
		expect(data.overall).toBe("Something needs attention");
		expect(data.parts.find((p) => p.id === "feed").state).toBe("red");
	});

	it("keeps the answer for a minute, so refreshing costs nothing", async () => {
		const calls = world();
		await call("/status.json");
		const n = calls.length;
		await call("/status.json");
		await call("/status");
		expect(calls.length).toBe(n);
	});

	it("tests the chat for real through the public address and removes the test chat", async () => {
		const calls = world();
		const ids = [];
		const fetcher = async (url, init) => {
			const body = JSON.parse(init.body);
			ids.push(body.chatId);
			await env.DB.prepare("INSERT INTO chat_messages (chat_id, created_at, role, content, page) VALUES (?, ?, 'user', 'x', '/status')").bind(body.chatId, new Date().toISOString()).run();
			return globalThis.fetch(url, init);
		};
		const r = await chatRoundTrip(env, fetcher);
		expect(r.ok).toBe(true);
		expect(ids[0]).toMatch(/^claude-test-status-[a-z0-9]+$/);
		const post = calls.find((c) => c.method === "POST");
		expect(post.url).toBe(`${env.PUBLIC_URL}/`);
		const left = await env.DB.prepare("SELECT COUNT(*) AS n FROM chat_messages WHERE chat_id = ?").bind(ids[0]).first("n");
		expect(left).toBe(0);
	});

	it("shows red when the test chat didn't get an answer", async () => {
		world({ chat: false });
		const r = await computeStatus(env, { forceChat: true });
		const chat = r.parts.find((p) => p.id === "chat");
		expect(chat.state).toBe("red");
		expect(r.ok).toBe(false);
	});

	it("the timed jobs test the chat every 6 hours, not every minute", async () => {
		const calls = world();
		const t = Date.now();
		await cronHeartbeat(env, t, globalThis.fetch);
		await cronHeartbeat(env, t + 60_000, globalThis.fetch);
		await cronHeartbeat(env, t + 3 * 3600_000, globalThis.fetch);
		expect(calls.filter((c) => c.method === "POST").length).toBe(1);
		await cronHeartbeat(env, t + 7 * 3600_000, globalThis.fetch);
		expect(calls.filter((c) => c.method === "POST").length).toBe(2);
	});

	it("'Test the chat now' works once every 5 minutes for everyone", async () => {
		const calls = world();
		const first = await call("/status/test-chat", { method: "POST" });
		expect(first.status).toBe(303);
		expect(decodeURIComponent(first.headers.get("Location"))).toMatch(/the website chat answered/);
		const second = await call("/status/test-chat", { method: "POST" });
		expect(decodeURIComponent(second.headers.get("Location"))).toMatch(/less than 5 minutes ago/);
		expect(calls.filter((c) => c.method === "POST").length).toBe(1);
	});

	it("only shows its own notices (a made-up message in the link is dropped)", async () => {
		world();
		const html = await (await call("/status?n=" + encodeURIComponent("<script>alert(1)</script>"))).text();
		expect(html).not.toContain("<script>alert");
		const ok = await (await call("/status?n=" + encodeURIComponent("Tested just now: the website chat answered."))).text();
		expect(ok).toContain("Tested just now: the website chat answered.");
	});

	it("shows the last laptop-off test", async () => {
		world();
		await setting("status_laptop_off_test", JSON.stringify({ at: "2026-10-13T20:00:00Z", passed: false, failed: ["Bookings feed"] }));
		const html = await (await call("/status")).text();
		expect(html).toContain('Last "laptop off" test:');
		expect(html).toContain("didn't pass: Bookings feed");
	});

	it("says times in plain words", () => {
		const now = Date.parse("2026-10-13T12:00:00Z");
		expect(ago("2026-10-13T11:59:30Z", now)).toBe("just now");
		expect(ago("2026-10-13T11:50:00Z", now)).toBe("10 min ago");
		expect(ago("2026-10-13T07:00:00Z", now)).toBe("5 h ago");
		expect(ago(null, now)).toBe("never");
	});

	it("the page escapes what it shows", () => {
		const html = statusPage({ ok: true, overall: "x", at: new Date().toISOString(), parts: [{ id: "a", name: "<b>", state: "green", text: "<i>" }], laptopOffTest: null });
		expect(html).toContain("&lt;b&gt;");
		expect(html).not.toContain("<i>");
	});
});

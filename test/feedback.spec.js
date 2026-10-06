import { env } from "cloudflare:test";
import { beforeEach, describe, expect, it } from "vitest";
import worker from "../src";

const BASE = "https://novacane-worker.test";
let ipNumber = 0;

beforeEach(async () => {
	await env.DB.prepare("DELETE FROM feedback").run();
});

async function send(body, origin = "https://novacane.co.uk") {
	const res = await worker.fetch(
		new Request(BASE + "/feedback", {
			method: "POST",
			headers: { "Content-Type": "application/json", Origin: origin, "CF-Connecting-IP": `192.0.2.${++ipNumber}` },
			body: JSON.stringify(body),
		}),
		env,
		{ waitUntil() {} }
	);
	return { status: res.status, data: await res.json() };
}

const admin = (path) =>
	worker.fetch(new Request(BASE + path, { headers: { Authorization: "Basic " + btoa("studio:test-admin-password") } }), env, {}).then((r) => r.text());

describe("Feedback about NovaBot", () => {
	it("saves typed or spoken feedback with the recent chat", async () => {
		const recent = Array.from({ length: 15 }, (_, i) => ({ role: i % 2 ? "assistant" : "user", content: `message ${i}` }));
		const { status, data } = await send({ chatId: "chat-feedback-01", page: "/", rating: "bad", message: "It kept asking for my email", spoken: true, recent });
		expect(status).toBe(200);
		expect(data.ok).toBe(true);
		const row = await env.DB.prepare("SELECT * FROM feedback").first();
		expect(row.rating).toBe("bad");
		expect(row.spoken).toBe(1);
		expect(row.chat_id).toBe("chat-feedback-01");
		expect(JSON.parse(row.recent)).toHaveLength(12);
	});

	it("takes just a thumbs up", async () => {
		expect((await send({ rating: "good" })).data.ok).toBe(true);
	});

	it("needs something to say", async () => {
		const { status, data } = await send({ rating: "meh", message: "   " });
		expect(status).toBe(400);
		expect(data.ok).toBe(false);
	});

	it("only from the studio's website", async () => {
		expect((await send({ rating: "good" }, "https://evil.example")).status).toBe(403);
	});

	it("shows on the admin page, filtered by rating", async () => {
		await send({ rating: "good", message: "Loved the booking card" });
		await send({ rating: "bad", message: "Too slow <b>really</b>" });
		const all = await admin("/admin/feedback");
		expect(all).toContain("Loved the booking card");
		expect(all).toContain("Too slow &lt;b&gt;really&lt;/b&gt;");
		const bad = await admin("/admin/feedback?show=bad");
		expect(bad).not.toContain("Loved the booking card");
	});
});

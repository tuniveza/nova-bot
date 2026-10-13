// Portal → Admin → Desk (src/desk.js): Nova Bot here and the VPS side by side, admins only,
// the VPS asked with a token made from AGENT_NOVA_KEY, actions only from a browser sign-in.
import { createExecutionContext, env, waitOnExecutionContext } from "cloudflare:test";
import { afterEach, describe, expect, it, vi } from "vitest";
import worker from "../src";
import { STAFF_COOKIE } from "./sign-in.js";
import { deskToken } from "../src/desk.js";
import { createHmac } from "node:crypto";

const BASE = "https://novacane-worker.test";
async function call(path, { method = "GET", cookie = STAFF_COOKIE, body, headers = {} } = {}) {
	const h = { ...headers };
	if (cookie) h.Cookie = cookie;
	if (method !== "GET") {
		h.Origin = BASE;
		h["Content-Type"] = "application/json";
	}
	const ctx = createExecutionContext();
	const res = await worker.fetch(new Request(BASE + path, { method, headers: h, body: body === undefined ? undefined : JSON.stringify(body) }), env, ctx);
	await waitOnExecutionContext(ctx);
	return res;
}

const real = globalThis.fetch;
afterEach(() => {
	globalThis.fetch = real;
});

describe("Desk", () => {
	it("makes the same token as the VPS's status service (HMAC-SHA256 of desk-status)", async () => {
		const want = createHmac("sha256", "k-123").update("desk-status").digest("hex");
		expect(await deskToken("k-123")).toBe(want);
	});

	it("shows here and the VPS, asking the VPS with the token", async () => {
		const seen = [];
		globalThis.fetch = vi.fn(async (url, init) => {
			if (String(url).includes("/desk-status/")) {
				seen.push({ url: String(url), auth: new Headers(init?.headers).get("Authorization") });
				return Response.json({ host: "odysi", services: { nova: "active" }, jobsOn: false, problems: [] });
			}
			return real(url, init);
		});
		const res = await call("/app/api/desk");
		expect(res.status).toBe(200);
		const data = await res.json();
		expect(data.here.where).toBe("cloudflare");
		expect(data.vps).toMatchObject({ reachable: true, host: "odysi", jobsOn: false });
		expect(seen[0].url).toMatch(/\/desk-status\/status$/);
		expect(seen[0].auth).toBe(`Bearer ${await deskToken(env.AGENT_NOVA_KEY)}`);
	});

	it("says plainly when the VPS turns it down or can't be reached", async () => {
		globalThis.fetch = vi.fn(async () => Response.json({ error: "Not allowed" }, { status: 401 }));
		let data = await (await call("/app/api/desk")).json();
		expect(data.vps.reachable).toBe(false);
		expect(data.vps.reason).toMatch(/AGENT_NOVA_KEY/);
		globalThis.fetch = vi.fn(async () => {
			throw new TypeError("network");
		});
		data = await (await call("/app/api/desk")).json();
		expect(data.vps.reason).toMatch(/couldn't be reached/);
	});

	it("passes actions to the VPS, only known ones, only for admins signed in", async () => {
		const asked = [];
		globalThis.fetch = vi.fn(async (url, init) => {
			asked.push(JSON.parse(init.body).do);
			return Response.json({ ok: true });
		});
		expect((await call("/app/api/desk/action", { method: "POST", body: { do: "backup" } })).status).toBe(200);
		expect((await call("/app/api/desk/action", { method: "POST", body: { do: "rm -rf" } })).status).toBe(400);
		expect(asked).toEqual(["backup"]);
		expect((await call("/app/api/desk", { cookie: "" })).status).toBe(401);
	});
});

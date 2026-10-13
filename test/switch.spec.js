// The switch-over to the VPS: the pass-through Worker on Cloudflare (src/passthrough.js), the VPS's
// front door that trusts only its signature (src/vps-front.js), the keys both make from
// AGENT_NOVA_KEY (src/pass-sign.js), and what Computer says about which side is live.
import { createExecutionContext, env, waitOnExecutionContext } from "cloudflare:test";
import { afterEach, describe, expect, it, vi } from "vitest";
import { createHmac } from "node:crypto";
import worker from "../src";
import passthrough, { passOn } from "../src/passthrough.js";
import { vpsFront } from "../src/vps-front.js";
import { derivedKey, passSignature } from "../src/pass-sign.js";
import { STAFF_COOKIE } from "./sign-in.js";

const LIVE = "https://novacane-worker.novacane-studio.workers.dev";
const KEY = "agent-key-for-tests";
const ptEnv = (extra = {}) => ({ AGENT_NOVA_KEY: KEY, VPS_ORIGIN: "https://vps.test", ...extra });
const vpsEnv = (extra = {}) => ({ AGENT_NOVA_KEY: KEY, DESK_HOST: "vps", PUBLIC_URL: LIVE, ...extra });

const real = globalThis.fetch;
afterEach(() => {
	globalThis.fetch = real;
});

// What the pass-through sends to the VPS, captured
function capture(answer = () => new Response("ok", { headers: { "Content-Type": "text/plain" } })) {
	const sent = [];
	globalThis.fetch = vi.fn(async (url, init) => {
		sent.push({ url: String(url), init, headers: new Headers(init?.headers), body: init?.body ? await new Response(init.body).text() : null });
		return answer();
	});
	return sent;
}

describe("the keys both sides make from AGENT_NOVA_KEY", () => {
	it("match what the VPS's switch-keys makes with Node (HMAC-SHA256, hex)", async () => {
		for (const label of ["acuity-webhook-v1", "acuity-email-v1", "nova-pass-v1"]) {
			expect(await derivedKey({ AGENT_NOVA_KEY: KEY }, label)).toBe(createHmac("sha256", KEY).update(label).digest("hex"));
		}
		expect(await derivedKey({}, "x")).toBe("");
	});
});

describe("the pass-through", () => {
	it("forwards method, path, query and body to the VPS, signed with when, who and which address", async () => {
		const sent = capture();
		const req = new Request(`${LIVE}/app/api/thing?x=1`, { method: "POST", headers: { "CF-Connecting-IP": "203.0.113.9", "Content-Type": "application/json", Cookie: "a=b" }, body: '{"hi":1}' });
		const res = await passOn(req, ptEnv(), 1_700_000_000_000);
		expect(await res.text()).toBe("ok");
		expect(sent).toHaveLength(1);
		const s = sent[0];
		expect(s.url).toBe("https://vps.test/app/api/thing?x=1");
		expect(s.init.method).toBe("POST");
		expect(s.init.redirect).toBe("manual");
		expect(s.body).toBe('{"hi":1}');
		expect(s.headers.get("Cookie")).toBe("a=b");
		expect(s.headers.get("X-Nova-Pass-Ts")).toBe("1700000000000");
		expect(s.headers.get("X-Nova-Pass-Ip")).toBe("203.0.113.9");
		expect(s.headers.get("X-Nova-Pass-Host")).toBe("novacane-worker.novacane-studio.workers.dev");
		expect(s.headers.get("X-Nova-Pass-Sig")).toBe(await passSignature({ AGENT_NOVA_KEY: KEY }, "1700000000000", "203.0.113.9", "novacane-worker.novacane-studio.workers.dev"));
	});

	it("never passes on signature headers a visitor sent", async () => {
		const sent = capture();
		await passOn(new Request(`${LIVE}/`, { headers: { "X-Nova-Pass-Sig": "forged", "X-Nova-Pass-Host": "evil.test", "CF-Connecting-IP": "1.2.3.4" } }), ptEnv());
		expect(sent[0].headers.get("X-Nova-Pass-Host")).toBe("novacane-worker.novacane-studio.workers.dev");
		expect(sent[0].headers.get("X-Nova-Pass-Sig")).not.toBe("forged");
	});

	it("passes a WebSocket request on as it is (the Upgrade header), and returns the VPS's answer untouched", async () => {
		const answer = new Response(null, { status: 204 });
		const sent = capture(() => answer);
		const res = await passOn(new Request(`${LIVE}/nova-agent/link`, { headers: { Upgrade: "websocket", Authorization: "Bearer k" } }), ptEnv());
		expect(sent[0].headers.get("Upgrade")).toBe("websocket");
		expect(sent[0].headers.get("Authorization")).toBe("Bearer k");
		expect(sent[0].body).toBe(null);
		expect(res).toBe(answer);
	});

	it("swaps Cloudflare's Acuity webhook key for the VPS's, and leaves a wrong one alone", async () => {
		const sent = capture();
		await passOn(new Request(`${LIVE}/acuity/webhook?key=old-cf-key&id=5`, { method: "POST", body: "a=1" }), ptEnv({ ACUITY_WEBHOOK_KEY: "old-cf-key" }));
		const url = new URL(sent[0].url);
		expect(url.searchParams.get("key")).toBe(createHmac("sha256", KEY).update("acuity-webhook-v1").digest("hex"));
		expect(url.searchParams.get("id")).toBe("5");
		await passOn(new Request(`${LIVE}/acuity/webhook?key=guess`, { method: "POST", body: "a=1" }), ptEnv({ ACUITY_WEBHOOK_KEY: "old-cf-key" }));
		expect(new URL(sent[1].url).searchParams.get("key")).toBe("guess");
	});

	it("swaps the Google script's Acuity email key for the VPS's", async () => {
		const sent = capture();
		await passOn(new Request(`${LIVE}/acuity/email`, { method: "POST", headers: { "X-Nova-Key": "old-email-key" }, body: "{}" }), ptEnv({ ACUITY_EMAIL_KEY: "old-email-key" }));
		expect(sent[0].headers.get("X-Nova-Key")).toBe(createHmac("sha256", KEY).update("acuity-email-v1").digest("hex"));
	});

	it("says calmly that Nova is restarting when the VPS can't be reached, or Caddy has no Nova Bot behind it", async () => {
		globalThis.fetch = vi.fn(async () => {
			throw new Error("connect failed");
		});
		const page = await passOn(new Request(`${LIVE}/agent/`, { headers: { Accept: "text/html" } }), ptEnv());
		expect(page.status).toBe(503);
		expect(page.headers.get("Retry-After")).toBe("30");
		expect(await page.text()).toContain("Nova is restarting");
		const api = await passOn(new Request(`${LIVE}/app/api/me`), ptEnv());
		expect(api.status).toBe(503);
		expect(await api.json()).toMatchObject({ restarting: true });
		capture(() => new Response(null, { status: 502 }));
		expect((await passOn(new Request(`${LIVE}/x`), ptEnv())).status).toBe(503);
		// Nova Bot's own 502 (JSON) passes through as it is
		capture(() => Response.json({ error: "The studio computer couldn't answer that" }, { status: 502 }));
		const own = await passOn(new Request(`${LIVE}/quests/state`), ptEnv());
		expect(own.status).toBe(502);
		expect(await own.json()).toMatchObject({ error: expect.stringContaining("studio computer") });
	});

	it("has no timed jobs of its own", () => {
		expect(passthrough.scheduled).toBeUndefined();
	});
});

describe("the VPS's front door", () => {
	const signed = async (url, { ts = Date.now(), ip = "198.51.100.7", host = "novacane-worker.novacane-studio.workers.dev", sig, extra = {} } = {}) => {
		const s = sig ?? (await passSignature({ AGENT_NOVA_KEY: KEY }, String(ts), ip, host));
		return new Request(url, { headers: { "CF-Connecting-IP": "10.0.0.1", "X-Nova-Pass-Ts": String(ts), "X-Nova-Pass-Ip": ip, "X-Nova-Pass-Host": host, "X-Nova-Pass-Sig": s, ...extra } });
	};

	it("sees a signed request as Cloudflare did: that address (https) and that visitor", async () => {
		const out = await vpsFront(await signed("http://185-185-126-195.sslip.io/app/api/me?x=1"), vpsEnv());
		expect(out.url).toBe(`${LIVE}/app/api/me?x=1`);
		expect(out.headers.get("CF-Connecting-IP")).toBe("198.51.100.7");
		for (const h of ["X-Nova-Pass-Ts", "X-Nova-Pass-Ip", "X-Nova-Pass-Host", "X-Nova-Pass-Sig"]) expect(out.headers.get(h)).toBe(null);
	});

	it("doesn't trust a wrong, old or other-address signature (keeps Caddy's caller and the VPS's own address)", async () => {
		const cases = [
			await signed("http://vps.test/a", { sig: "0".repeat(64) }),
			await signed("http://vps.test/a", { ts: Date.now() - 10 * 60 * 1000 }),
			await signed("http://vps.test/a", { host: "evil.test" }),
		];
		for (const req of cases) {
			const out = await vpsFront(req, vpsEnv());
			expect(out.url).toBe("https://vps.test/a");
			expect(out.headers.get("CF-Connecting-IP")).toBe("10.0.0.1");
			expect(out.headers.get("X-Nova-Pass-Sig")).toBe(null);
		}
	});

	it("is always https on the VPS, and does nothing at all on Cloudflare", async () => {
		const plain = new Request("http://vps.test/privacy");
		expect((await vpsFront(plain, vpsEnv())).url).toBe("https://vps.test/privacy");
		const cf = new Request(`${LIVE}/privacy`, { headers: { "X-Nova-Pass-Sig": "x" } });
		expect(await vpsFront(cf, {})).toBe(cf);
	});

	it("takes what the pass-through sends, end to end", async () => {
		const sent = capture();
		await passOn(new Request(`${LIVE}/portal/?view=today`, { headers: { "CF-Connecting-IP": "192.0.2.44" } }), ptEnv());
		const arrived = new Request(sent[0].url.replace("https://vps.test", "http://185-185-126-195.sslip.io"), { headers: sent[0].headers });
		const out = await vpsFront(arrived, vpsEnv());
		expect(out.url).toBe(`${LIVE}/portal/?view=today`);
		expect(out.headers.get("CF-Connecting-IP")).toBe("192.0.2.44");
	});
});

describe("Computer says which side is live", () => {
	async function desk(extraEnv = {}) {
		const ctx = createExecutionContext();
		const res = await worker.fetch(new Request("https://novacane-worker.test/app/api/desk", { headers: { Cookie: STAFF_COOKIE } }), { ...env, ...extraEnv }, ctx);
		await waitOnExecutionContext(ctx);
		return res.json();
	}

	it("on Cloudflare: Cloudflare is live, with the switch commands", async () => {
		globalThis.fetch = vi.fn(async () => Response.json({}, { status: 401 }));
		const d = await desk();
		expect(d.here.live).toBe("cloudflare");
		expect(d.here.switchHelp).toMatchObject({ to: "vps/switch.sh", back: "vps/switch-back.sh" });
	});

	it("warns when the newsletters' Resend key can't send as the studio's domain", async () => {
		await env.DB.prepare("DELETE FROM settings WHERE key = 'desk_resend_domains'").run();
		globalThis.fetch = vi.fn(async (url) => (String(url).includes("api.resend.com/domains") ? Response.json({ data: [] }) : Response.json({}, { status: 401 })));
		const d = await desk({ RESEND_MARKETING_KEY: "re_x", CAMPAIGN_FROM: "Novacane <hello@novacane.co.uk>" });
		expect(d.here.warnings.join(" ")).toContain("without novacane.co.uk");
		await env.DB.prepare("DELETE FROM settings WHERE key = 'desk_resend_domains'").run();
		globalThis.fetch = vi.fn(async (url) => (String(url).includes("api.resend.com/domains") ? Response.json({ data: [{ name: "novacane.co.uk", status: "verified" }] }) : Response.json({}, { status: 401 })));
		const ok = await desk({ RESEND_MARKETING_KEY: "re_y", CAMPAIGN_FROM: "Novacane <hello@novacane.co.uk>" });
		expect(ok.here.warnings).toEqual([]);
	});
});

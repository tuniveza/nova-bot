// The VPS's own mail server (vps/mail): single emails go to RESEND_API_URL when it's set (the same
// request Resend takes), Resend otherwise; with MAIL_FIRST=vps, approved emails try it before Gmail.
import { env } from "cloudflare:test";
import { afterEach, describe, expect, it, vi } from "vitest";
import { mailApiUrl, ownMailServer, sendEmail } from "../src/enquiries.js";
import { sendStudioEmail } from "../src/google/gmail.js";

const LOCAL = { RESEND_API_URL: "http://127.0.0.1:8790/", RESEND_API_KEY: "local", ENQUIRY_EMAIL_FROM: "Novacane Studios <hello@novacane.co.uk>", ENQUIRY_EMAIL_TO: "admin@example.com" };
const msg = { to: ["sam@example.com"], subject: "Hello", text: "Hi Sam" };

afterEach(() => vi.restoreAllMocks());

describe("where single emails go", () => {
	it("Resend unless RESEND_API_URL is set (and a bad address is ignored)", () => {
		expect(mailApiUrl({})).toBe("https://api.resend.com");
		expect(mailApiUrl({ RESEND_API_URL: "ftp://nope" })).toBe("https://api.resend.com");
		expect(mailApiUrl(LOCAL)).toBe("http://127.0.0.1:8790");
		expect(ownMailServer({})).toBe(false);
		expect(ownMailServer(LOCAL)).toBe(true);
	});

	it("posts the same request to the VPS's mail server, and says who refused it", async () => {
		const calls = [];
		vi.spyOn(globalThis, "fetch").mockImplementation(async (url, init) => {
			calls.push({ url: String(url), body: JSON.parse(init.body), auth: init.headers.Authorization });
			return Response.json({ id: "vps-1" });
		});
		const ok = await sendEmail({ ...env, ...LOCAL }, msg);
		expect(ok).toEqual({ ok: true, id: "vps-1" });
		expect(calls[0].url).toBe("http://127.0.0.1:8790/emails");
		expect(calls[0].body).toMatchObject({ from: "Novacane Studios <hello@novacane.co.uk>", to: ["sam@example.com"], subject: "Hello" });
		expect(calls[0].auth).toBe("Bearer local");

		globalThis.fetch.mockImplementation(async () => Response.json({ message: "no" }, { status: 502 }));
		const no = await sendEmail({ ...env, ...LOCAL }, msg);
		expect(no.ok).toBe(false);
		expect(no.message).toMatch(/studio's mail server didn't send it: no/);
	});

	it("MAIL_FIRST=vps: approved emails go through the VPS first; without Gmail its answer stands", async () => {
		const urls = [];
		vi.spyOn(globalThis, "fetch").mockImplementation(async (url) => {
			urls.push(String(url));
			return Response.json({ id: "vps-2" });
		});
		const sent = await sendStudioEmail({ ...env, ...LOCAL, MAIL_FIRST: "vps" }, msg, { kind: "enquiry", id: 1 });
		expect(sent).toMatchObject({ ok: true, id: "vps-2", via: "vps" });
		expect(urls).toEqual(["http://127.0.0.1:8790/emails"]);

		globalThis.fetch.mockImplementation(async () => {
			throw new Error("connection refused");
		});
		const failed = await sendStudioEmail({ ...env, ...LOCAL, MAIL_FIRST: "vps" }, msg, { kind: "enquiry", id: 1 });
		expect(failed.ok).toBe(false);
		expect(failed.message).toMatch(/Couldn't reach the studio's mail server/);
	});
});

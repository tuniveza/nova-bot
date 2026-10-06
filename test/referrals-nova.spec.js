import { env } from "cloudflare:test";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import worker from "../src";
import { clearTables, connectGoogle, installFakes, ukDay } from "./fakes.js";

const BASE = "https://novacane-worker.test";

// ----- Bookings in the referral report -----
// Every booking is copied into the appointments table when it's made (bookings.js)

async function appointment(id, extra = {}) {
	const a = { firstName: "Sam", lastName: "Singer", email: "sam@example.com", phone: "07700 900123", type: "Singer Package (4 hours)", datetime: "2026-10-03T13:00:00.000Z", ...extra };
	const now = new Date().toISOString();
	await env.DB.prepare(
		"INSERT OR REPLACE INTO appointments (id, first_name, last_name, email, phone, appointment_type, starts_at, status, booked_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, 'scheduled', ?, ?)"
	)
		.bind(id, a.firstName, a.lastName, a.email, a.phone, a.type, a.datetime, now, now)
		.run();
	return a;
}

let fakes;
beforeEach(async () => {
	await clearTables();
	await env.DB.prepare("DELETE FROM referral_codes").run();
	fakes = installFakes();
});

afterEach(() => {
	vi.restoreAllMocks();
});

// ----- Helpers -----

async function refer(answer) {
	const res = await worker.fetch(
		new Request(`${BASE}/referral`, {
			method: "POST",
			headers: { "Content-Type": "application/json" },
			body: JSON.stringify(answer),
		}),
		env
	);
	return { status: res.status, data: await res.json() };
}

const row = (id) => env.DB.prepare("SELECT * FROM appointments WHERE id = ?").bind(id).first();

async function addCode(code, referrer, active = 1) {
	await env.DB.prepare("INSERT OR REPLACE INTO referral_codes (code, referrer, active, created_at) VALUES (?, ?, ?, ?)")
		.bind(code, referrer, active, new Date().toISOString())
		.run();
}

const auth = (password = "test-admin-password") => ({ Authorization: "Basic " + btoa("studio:" + password) });

function admin(path, init = {}) {
	return worker.fetch(new Request(BASE + path, { ...init, headers: { ...auth(), ...(init.headers || {}) } }), env);
}

// ----- Tests -----

describe("Referral page", () => {
	it("serves the page with the booking details safely embedded", async () => {
		const res = await worker.fetch(new Request(`${BASE}/referral?id=2001&email=a+b@example.com&x=</script><script>alert(1)</script>`), env);
		const html = await res.text();
		expect(res.status).toBe(200);
		expect(html).toContain("Did anyone refer you to Novacane?");
		expect(html).toContain('"a+b@example.com"'); // "+" survives
		expect(html).not.toContain("<script>alert(1)</script>");
	});

	it("records 'nobody referred me', once", async () => {
		await appointment(2002);

		let res = await refer({ id: "2002", email: "SAM@example.com", referred: false });
		expect(res.data.ok).toBe(true);
		expect(await row(2002)).toMatchObject({ referral_answer: "no", referral_source: "after booking" });

		res = await refer({ id: "2002", email: "sam@example.com", referred: true, code: "ANY" });
		expect(res.data.message).toMatch(/already/);
		expect((await row(2002)).referral_answer).toBe("no");
	});

	it("saves a valid code however it's typed, with who it belongs to", async () => {
		await addCode("JAMES10", "James Smith");
		await appointment(2003);

		const { status, data } = await refer({ id: "2003", email: "sam@example.com", referred: true, code: " james 10 ", name: "James" });
		expect(status).toBe(200);
		expect(data.ok).toBe(true);
		expect(await row(2003)).toMatchObject({
			referral_answer: "yes",
			referral_code: "JAMES10",
			referrer_name: "James Smith",
			referred_by: "James",
		});
	});

	it("accepts 'yes' with no code (the code is optional)", async () => {
		await appointment(2004);
		const { data } = await refer({ id: "2004", email: "sam@example.com", referred: true, code: "", name: "A friend" });
		expect(data.ok).toBe(true);
		expect(await row(2004)).toMatchObject({ referral_answer: "yes", referral_code: null, referred_by: "A friend" });
	});

	it("rejects inactive codes and limits guessing to 5 tries", async () => {
		await addCode("OLD1", "Retired Person", 0);
		await appointment(2005);

		const retired = await refer({ id: "2005", email: "sam@example.com", referred: true, code: "OLD1" });
		expect(retired.status).toBe(422);
		expect(retired.data.error).toMatch(/isn't active/);

		for (let i = 0; i < 4; i++) {
			expect((await refer({ id: "2005", email: "sam@example.com", referred: true, code: "GUESS" + i })).status).toBe(422);
		}
		await addCode("REAL1", "Someone");
		const blocked = await refer({ id: "2005", email: "sam@example.com", referred: true, code: "REAL1" });
		expect(blocked.status).toBe(429);
		expect((await row(2005)).referral_answer).toBeNull();
	});

	it("won't attach a referral without the booking's matching email", async () => {
		await appointment(2006);
		const { status } = await refer({ id: "2006", email: "someone-else@example.com", referred: false });
		expect(status).toBe(404);
		expect((await row(2006)).referral_answer).toBeNull();
	});

	it("says it can't find bookings that don't exist", async () => {
		const { status } = await refer({ id: "2999", email: "sam@example.com", referred: false });
		expect(status).toBe(404);
	});
});

describe("Admin page", () => {
	it("needs the password", async () => {
		let res = await worker.fetch(new Request(`${BASE}/admin`), env);
		expect(res.status).toBe(401);
		expect(res.headers.get("WWW-Authenticate")).toMatch(/Basic/);

		res = await admin("/admin", { headers: auth("wrong") });
		expect(res.status).toBe(401);

		res = await admin("/admin");
		expect(res.status).toBe(200);
	});

	it("adds and retires codes, only from the admin page itself", async () => {
		const form = (fields) => new URLSearchParams(fields);
		const post = (path, fields, origin = BASE) =>
			admin(path, {
				method: "POST",
				headers: { "Content-Type": "application/x-www-form-urlencoded", ...(origin ? { Origin: origin } : {}) },
				body: form(fields),
			});

		expect((await post("/admin/codes", { code: "EVIL1", referrer: "x" }, "https://evil.example")).status).toBe(403);
		expect((await post("/admin/codes", { code: "EVIL2", referrer: "x" }, null)).status).toBe(403);

		let res = await post("/admin/codes", { code: "new code1", referrer: "Nia", note: "Instagram" });
		expect(res.status).toBe(303);
		expect(await env.DB.prepare("SELECT * FROM referral_codes WHERE code = 'NEWCODE1'").first()).toMatchObject({ referrer: "Nia", active: 1 });

		res = await post("/admin/codes", { code: "x!", referrer: "Nia" });
		expect(decodeURIComponent(res.headers.get("Location"))).toMatch(/3 to 32/);

		await post("/admin/codes/toggle", { code: "NEWCODE1" });
		expect((await env.DB.prepare("SELECT active FROM referral_codes WHERE code = 'NEWCODE1'").first()).active).toBe(0);
	});

	it("lists appointments with their referrals, safely", async () => {
		await addCode("SHOW1", "Report Person");
		await appointment(3001, { firstName: "<script>alert(1)</script>" });
		await refer({ id: "3001", email: "sam@example.com", referred: true, code: "SHOW1" });

		const html = await (await admin("/admin?show=referred")).text();
		expect(html).toContain("SHOW1");
		expect(html).toContain("Report Person");
		expect(html).toContain("&lt;script&gt;alert(1)&lt;/script&gt;");
		expect(html).not.toContain("<script>alert(1)</script>");
	});

	it("downloads a CSV report that spreadsheets can't run formulas from", async () => {
		await addCode("CSV1", "Spreadsheet Fan");
		await appointment(3002, { firstName: "=HYPERLINK(\"http://evil\")", lastName: "O'Brien, Jr" });
		await refer({ id: "3002", email: "sam@example.com", referred: true, code: "CSV1" });

		const res = await admin("/admin/report.csv");
		expect(res.headers.get("Content-Type")).toMatch(/text\/csv/);
		const csv = await res.text();
		expect(csv.split("\r\n")[0]).toMatch(/^Appointment ID,Appointment date,/);
		const line = csv.split("\r\n").find((l) => l.startsWith("3002,"));
		expect(line).toContain(`"'=HYPERLINK(""http://evil"")"`);
		expect(line).toContain(`"O'Brien, Jr"`);
		expect(line).toContain("CSV1,Spreadsheet Fan");
	});
});

describe("Chat routes", () => {
	it("still answers the chat widget's health check", async () => {
		const res = await worker.fetch(new Request(`${BASE}/`), env);
		expect(await res.text()).toBe("Novacane chatbot is running.");
	});
});

describe("referral codes on the booking page", () => {
	it("saves a valid code typed when booking, with who it belongs to", async () => {
		await connectGoogle();
		await addCode("JAMES10", "James Smith");
		const res = await worker.fetch(
			new Request(`${BASE}/book/api/checkout`, {
				method: "POST",
				headers: { Origin: BASE, "Content-Type": "application/json", "CF-Connecting-IP": "198.18.0.7" },
				body: JSON.stringify({ session: 12738216, date: ukDay(10), time: "11:00", first: "Sam", last: "Singer", email: "sam@example.com", phone: "1", referral: "james 10" }),
			}),
			env
		);
		expect((await res.json()).ok).toBe(true);
		const b = await env.DB.prepare("SELECT id FROM bookings").first();
		expect(await row(b.id)).toMatchObject({ referral_answer: "yes", referral_code: "JAMES10", referrer_name: "James Smith", referral_source: "booking form" });
	});

	it("keeps a code that isn't active, so the customer can correct it on the referral page", async () => {
		await connectGoogle();
		await worker.fetch(
			new Request(`${BASE}/book/api/checkout`, {
				method: "POST",
				headers: { Origin: BASE, "Content-Type": "application/json", "CF-Connecting-IP": "198.18.0.8" },
				body: JSON.stringify({ session: 12738216, date: ukDay(10), time: "11:00", first: "Sam", last: "Singer", email: "sam@example.com", phone: "1", referral: "nope1" }),
			}),
			env
		);
		const b = await env.DB.prepare("SELECT id FROM bookings").first();
		expect(await row(b.id)).toMatchObject({ referral_code: null, invalid_code: "NOPE1" });
		await addCode("REAL1", "Real Person");
		const fixed = await refer({ id: String(b.id), email: "sam@example.com", referred: true, code: "REAL1" });
		expect(fixed.data.ok).toBe(true);
		expect((await row(b.id)).referral_code).toBe("REAL1");
	});
});

describe("admin: connections", () => {
	it("shows Google and Stripe, the webhook address and recent emails", async () => {
		await connectGoogle();
		const html = await (await admin("/admin/connections")).text();
		expect(html).toContain("studio@novacane.test");
		expect(html).toContain(`${BASE}/admin/google/callback`);
		expect(html).toContain(`${BASE}/stripe/webhook`);
		expect(html).toContain("test mode");
	});

	it("starts connecting Google with a one-off check value, and refuses a callback without it", async () => {
		const start = await admin("/admin/google");
		expect(start.status).toBe(302);
		const location = new URL(start.headers.get("Location"));
		expect(location.hostname).toBe("accounts.google.com");
		expect(location.searchParams.get("scope")).toContain("https://www.googleapis.com/auth/gmail.send");
		expect(location.searchParams.get("access_type")).toBe("offline");
		const state = location.searchParams.get("state");
		expect(start.headers.get("Set-Cookie")).toContain(`nv_gstate=${state}`);

		const forged = await admin(`/admin/google/callback?code=abc&state=${state}`);
		expect(decodeURIComponent(forged.headers.get("Location"))).toContain("didn't start here");
	});

	it("finishes connecting: keeps the refresh token and the account's email", async () => {
		const idToken = "x." + btoa(JSON.stringify({ email: "studio@novacane.co.uk" })).replace(/=+$/, "") + ".y";
		globalThis.fetch.mockImplementation(async (url) => {
			if (String(url) === "https://oauth2.googleapis.com/token") {
				return Response.json({ access_token: "a", refresh_token: "rt-new", id_token: idToken, scope: "https://www.googleapis.com/auth/calendar https://www.googleapis.com/auth/gmail.send openid email" });
			}
			throw new Error("Unexpected fetch " + url);
		});
		const state = "0f8fad5b-d9cb-469f-a165-70867728950e";
		const res = await admin(`/admin/google/callback?code=abc&state=${state}`, { headers: { Cookie: `nv_gstate=${state}` } });
		expect(decodeURIComponent(res.headers.get("Location"))).toContain("Connected as studio@novacane.co.uk");
		expect(await env.DB.prepare("SELECT value FROM settings WHERE key = 'google_refresh_token'").first("value")).toBe("rt-new");
	});
});

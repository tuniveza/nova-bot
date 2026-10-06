import { env } from "cloudflare:test";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import worker from "../src";

const BASE = "https://novacane-worker.test";

// ----- A fake Acuity API -----

const acuity = new Map(); // appointment id -> appointment JSON

function appointment(id, extra = {}) {
	const appt = {
		id,
		firstName: "Sam",
		lastName: "Singer",
		email: "sam@example.com",
		phone: "07700 900123",
		type: "Singer Package (4 hours)",
		datetime: "2026-10-03T14:00:00+0100",
		datetimeCreated: "2026-09-30T10:00:00+0100",
		canceled: false,
		forms: [],
		...extra,
	};
	acuity.set(String(id), appt);
	return appt;
}

beforeEach(() => {
	vi.spyOn(globalThis, "fetch").mockImplementation(async (url, init) => {
		const match = String(url).match(/^https:\/\/acuityscheduling\.com\/api\/v1\/appointments\/(\d+)$/);
		if (!match) throw new Error("Unexpected fetch in test: " + url);
		expect(init.headers.Authorization).toBe("Basic " + btoa("12345:test-acuity-key"));
		const appt = acuity.get(match[1]);
		return appt
			? new Response(JSON.stringify(appt), { headers: { "Content-Type": "application/json" } })
			: new Response(JSON.stringify({ status_code: 404, error: "not_found" }), { status: 404 });
	});
});

afterEach(() => {
	vi.restoreAllMocks();
});

// ----- Helpers -----

async function sign(body, key = "test-acuity-key") {
	const cryptoKey = await crypto.subtle.importKey("raw", new TextEncoder().encode(key), { name: "HMAC", hash: "SHA-256" }, false, ["sign"]);
	const mac = await crypto.subtle.sign("HMAC", cryptoKey, new TextEncoder().encode(body));
	return btoa(String.fromCharCode(...new Uint8Array(mac)));
}

async function webhook(action, id, { signature } = {}) {
	const body = `action=${action}&id=${id}&calendarID=1&appointmentTypeID=2`;
	return worker.fetch(
		new Request(`${BASE}/acuity/webhook`, {
			method: "POST",
			headers: {
				"Content-Type": "application/x-www-form-urlencoded",
				"x-acuity-signature": signature ?? (await sign(body)),
			},
			body,
		}),
		env
	);
}

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

describe("Acuity webhook", () => {
	it("rejects notifications that aren't signed by Acuity", async () => {
		appointment(1001);
		const res = await webhook("scheduled", 1001, { signature: await sign("something else") });
		expect(res.status).toBe(401);
		expect(await row(1001)).toBeNull();
	});

	it("saves a new booking with its details from the Acuity API", async () => {
		appointment(1002);
		const res = await webhook("scheduled", 1002);
		expect(res.status).toBe(200);
		expect(await row(1002)).toMatchObject({
			first_name: "Sam",
			email: "sam@example.com",
			appointment_type: "Singer Package (4 hours)",
			starts_at: "2026-10-03T14:00:00+0100",
			status: "scheduled",
			referral_answer: null,
		});
	});

	it("marks a cancelled booking but keeps its referral", async () => {
		await addCode("KEEP1", "Alex");
		appointment(1003);
		await webhook("scheduled", 1003);
		await refer({ id: "1003", email: "sam@example.com", referred: true, code: "KEEP1" });

		appointment(1003, { canceled: true });
		await webhook("canceled", 1003);
		expect(await row(1003)).toMatchObject({ status: "canceled", referral_code: "KEEP1" });
	});

	it("ignores order notifications (packages, gift certificates)", async () => {
		const res = await webhook("order.completed", 1004);
		expect(res.status).toBe(200);
		expect(await row(1004)).toBeNull();
	});

	it("returns 500 so Acuity retries when the Acuity API is down", async () => {
		globalThis.fetch.mockImplementation(async () => new Response("down", { status: 503 }));
		const res = await webhook("scheduled", 1005);
		expect(res.status).toBe(500);
	});

	it("picks up a valid code typed into a referral field on the booking form", async () => {
		await addCode("FORM1", "Priya");
		appointment(1006, { forms: [{ id: 1, name: "Intake", values: [{ fieldID: 9, name: "Referral code", value: " form1 " }] }] });
		await webhook("scheduled", 1006);
		expect(await row(1006)).toMatchObject({
			referral_answer: "yes",
			referral_code: "FORM1",
			referrer_name: "Priya",
			referral_source: "booking form",
			invalid_code: null,
		});
	});

	it("flags an invalid code typed on the booking form, which the customer can then correct", async () => {
		await addCode("RIGHT1", "Jo");
		appointment(1007, { forms: [{ id: 1, name: "Intake", values: [{ fieldID: 9, name: "Who referred you / referral code", value: "wrong1" }] }] });
		await webhook("scheduled", 1007);
		expect(await row(1007)).toMatchObject({ referral_answer: "yes", referral_code: null, invalid_code: "wrong1" });

		const { data } = await refer({ id: "1007", email: "sam@example.com", referred: true, code: "RIGHT1" });
		expect(data.ok).toBe(true);
		expect(await row(1007)).toMatchObject({ referral_code: "RIGHT1", invalid_code: null, referral_source: "after booking" });
	});
});

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
		appointment(2002);
		await webhook("scheduled", 2002);

		let res = await refer({ id: "2002", email: "SAM@example.com", referred: false });
		expect(res.data.ok).toBe(true);
		expect(await row(2002)).toMatchObject({ referral_answer: "no", referral_source: "after booking" });

		res = await refer({ id: "2002", email: "sam@example.com", referred: true, code: "ANY" });
		expect(res.data.message).toMatch(/already/);
		expect((await row(2002)).referral_answer).toBe("no");
	});

	it("saves a valid code however it's typed, with who it belongs to", async () => {
		await addCode("JAMES10", "James Smith");
		appointment(2003);
		await webhook("scheduled", 2003);

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
		appointment(2004);
		await webhook("scheduled", 2004);
		const { data } = await refer({ id: "2004", email: "sam@example.com", referred: true, code: "", name: "A friend" });
		expect(data.ok).toBe(true);
		expect(await row(2004)).toMatchObject({ referral_answer: "yes", referral_code: null, referred_by: "A friend" });
	});

	it("rejects inactive codes and limits guessing to 5 tries", async () => {
		await addCode("OLD1", "Retired Person", 0);
		appointment(2005);
		await webhook("scheduled", 2005);

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
		appointment(2006);
		await webhook("scheduled", 2006);
		const { status } = await refer({ id: "2006", email: "someone-else@example.com", referred: false });
		expect(status).toBe(404);
		expect((await row(2006)).referral_answer).toBeNull();
	});

	it("works even if the customer answers before Acuity's webhook arrives", async () => {
		await addCode("FAST1", "Quick Friend");
		appointment(2007); // exists in Acuity, not yet in our database
		const { data } = await refer({ id: "2007", email: "sam@example.com", referred: true, code: "FAST1" });
		expect(data.ok).toBe(true);
		expect(await row(2007)).toMatchObject({ first_name: "Sam", referral_code: "FAST1" });
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
		appointment(3001, { firstName: "<script>alert(1)</script>" });
		await webhook("scheduled", 3001);
		await refer({ id: "3001", email: "sam@example.com", referred: true, code: "SHOW1" });

		const html = await (await admin("/admin?show=referred")).text();
		expect(html).toContain("SHOW1");
		expect(html).toContain("Report Person");
		expect(html).toContain("&lt;script&gt;alert(1)&lt;/script&gt;");
		expect(html).not.toContain("<script>alert(1)</script>");
	});

	it("downloads a CSV report that spreadsheets can't run formulas from", async () => {
		await addCode("CSV1", "Spreadsheet Fan");
		appointment(3002, { firstName: "=HYPERLINK(\"http://evil\")", lastName: "O'Brien, Jr" });
		await webhook("scheduled", 3002);
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

describe("admin: Acuity connection check", () => {
	it("shows which account the secrets belong to", async () => {
		globalThis.fetch.mockImplementation(async (url, init) => {
			expect(String(url)).toBe("https://acuityscheduling.com/api/v1/me");
			expect(init.headers.Authorization).toBe("Basic " + btoa("12345:test-acuity-key"));
			return new Response(JSON.stringify({ id: 12345, name: "Novacane", email: "studio@example.com", plan: "Powerhouse" }));
		});
		const html = await (await admin("/admin/acuity")).text();
		expect(html).toContain("Connected");
		expect(html).toContain("Powerhouse");
	});

	it("explains a rejected key or a plan without the API", async () => {
		globalThis.fetch.mockImplementation(async () => new Response("{}", { status: 401 }));
		expect(await (await admin("/admin/acuity")).text()).toContain("didn&#39;t accept");
		globalThis.fetch.mockImplementation(async () => new Response("{}", { status: 403 }));
		expect(await (await admin("/admin/acuity")).text()).toContain("Powerhouse");
	});
});

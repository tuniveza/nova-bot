import { createExecutionContext, env, waitOnExecutionContext } from "cloudflare:test";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import worker from "../src";
import { forgetSessionTypes } from "../src/booking.js";
import { notifyPhones, savePhone } from "../src/push.js";
import { BOOKING_PAGE_HTML } from "./acuity-page.js";

const BASE = "https://novacane-worker.test";

// ----- Real keys, made fresh for the tests -----

const b64url = (bytes) => btoa(String.fromCharCode(...new Uint8Array(bytes))).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");

// Our "wax seal" (VAPID keys), in the same format as the real secrets
async function vapidKeys() {
	const pair = await crypto.subtle.generateKey({ name: "ECDSA", namedCurve: "P-256" }, true, ["sign", "verify"]);
	const jwk = await crypto.subtle.exportKey("jwk", pair.privateKey);
	const raw = await crypto.subtle.exportKey("raw", pair.publicKey);
	return { VAPID_PUBLIC_KEY: b64url(raw), VAPID_PRIVATE_KEY: jwk.d };
}

// A phone's notification address, like the one an iPhone gives Nova Hub
async function phone(endpoint) {
	const pair = await crypto.subtle.generateKey({ name: "ECDH", namedCurve: "P-256" }, true, ["deriveBits"]);
	return { endpoint, keys: { p256dh: b64url(await crypto.subtle.exportKey("raw", pair.publicKey)), auth: b64url(crypto.getRandomValues(new Uint8Array(16))) } };
}

// ----- A fake Apple push service -----

let delivered = []; // what was handed to "Apple"
let gone = new Set(); // addresses Apple says no longer exist
let keys;
let calendarFeed = ""; // what "Acuity's calendar feed" says
let lastClaude = null; // the last request sent to "Claude"

beforeEach(async () => {
	delivered = [];
	gone = new Set();
	calendarFeed = "BEGIN:VCALENDAR\r\nEND:VCALENDAR\r\n";
	forgetSessionTypes();
	keys = await vapidKeys();
	vi.spyOn(globalThis, "fetch").mockImplementation(async (url, init) => {
		if (String(url).startsWith("https://web.push.apple.com/")) {
			delivered.push({ url: String(url), init });
			return new Response(null, { status: gone.has(String(url)) ? 410 : 201 });
		}
		if (String(url).startsWith("https://app.acuityscheduling.com/schedule.php")) return new Response(BOOKING_PAGE_HTML);
		if (String(url) === "https://calendar.test/feed") return new Response(calendarFeed, { headers: { "Content-Type": "text/calendar" } });
		if (String(url) === "https://api.anthropic.com/v1/messages") {
			lastClaude = JSON.parse(init.body);
			return new Response(JSON.stringify({ stop_reason: "end_turn", content: [{ type: "text", text: "ok" }] }));
		}
		throw new Error("Unexpected fetch in test: " + url);
	});
	await env.DB.batch([env.DB.prepare("DELETE FROM push_subscriptions"), env.DB.prepare("DELETE FROM enquiries"), env.DB.prepare("DELETE FROM notifications"), env.DB.prepare("DELETE FROM booking_details"), env.DB.prepare("DELETE FROM booking_events"), env.DB.prepare("DELETE FROM settings")]);
});

afterEach(() => {
	vi.restoreAllMocks();
});

const phones = async () => (await env.DB.prepare("SELECT endpoint FROM push_subscriptions ORDER BY endpoint").all()).results.map((r) => r.endpoint);

let ip = 0;
async function call(path, { body, cookie, extraEnv = {}, method } = {}) {
	const ctx = createExecutionContext();
	const headers = { "CF-Connecting-IP": `198.51.100.${(++ip % 250) + 1}` };
	if (body !== undefined) {
		headers["Content-Type"] = "application/json";
		headers.Origin = BASE;
	}
	if (cookie) headers.Cookie = cookie;
	const res = await worker.fetch(
		new Request(BASE + path, { method: method || (body !== undefined ? "POST" : "GET"), headers, body: body !== undefined ? JSON.stringify(body) : undefined }),
		{ ...env, ...keys, ...extraEnv },
		ctx
	);
	await waitOnExecutionContext(ctx);
	return res;
}

async function signIn() {
	const res = await call("/app/api/login", { body: { password: "test-admin-password" } });
	return res.headers.get("Set-Cookie").split(";")[0];
}

// ----- Tests -----

describe("sending notifications", () => {
	it("seals the message the way Apple accepts and posts it to each phone", async () => {
		await savePhone(env, await phone("https://web.push.apple.com/phone-1"));
		const count = await notifyPhones({ ...env, ...keys }, { title: "New booking", body: "Rap Package" });
		expect(count).toBe(1);
		const { init } = delivered[0];
		expect(init.method.toUpperCase()).toBe("POST");
		expect(init.headers["content-encoding"] || init.headers["Content-Encoding"]).toBe("aes128gcm"); // the format Apple needs
		expect(String(init.headers.authorization || init.headers.Authorization)).toMatch(/^vapid t=.+, k=/); // our seal
		expect(String(init.headers.authorization || init.headers.Authorization)).toContain(keys.VAPID_PUBLIC_KEY);
		expect(init.body.byteLength).toBeGreaterThan(0); // the sealed message (unreadable without the phone's key)
	});

	it("forgets phones Apple says are gone, and keeps going", async () => {
		await savePhone(env, await phone("https://web.push.apple.com/old-phone"));
		await savePhone(env, await phone("https://web.push.apple.com/new-phone"));
		gone.add("https://web.push.apple.com/old-phone");
		expect(await notifyPhones({ ...env, ...keys }, { title: "Hi", body: "There" })).toBe(1);
		expect(await phones()).toEqual(["https://web.push.apple.com/new-phone"]);
	});

	it("does nothing until the keys are set up", async () => {
		await savePhone(env, await phone("https://web.push.apple.com/phone-1"));
		expect(await notifyPhones(env, { title: "Hi", body: "There" })).toBe(0);
		expect(delivered).toHaveLength(0);
	});
});

describe("Nova Hub: turning notifications on", () => {
	it("only lets signed-in staff add a phone", async () => {
		const address = await phone("https://web.push.apple.com/phone-1");
		expect((await call("/app/api/push/subscribe", { body: { subscription: address } })).status).toBe(401);
		const cookie = await signIn();
		expect((await call("/app/api/push/key", { cookie }).then((r) => r.json())).publicKey).toBe(keys.VAPID_PUBLIC_KEY);
		expect((await call("/app/api/push/subscribe", { cookie, body: { subscription: address } })).status).toBe(200);
		expect(await phones()).toEqual(["https://web.push.apple.com/phone-1"]);
		// Saving the same phone again doesn't make a second copy
		await call("/app/api/push/subscribe", { cookie, body: { subscription: address } });
		expect(await phones()).toHaveLength(1);
	});

	it("refuses addresses that aren't real push addresses", async () => {
		const cookie = await signIn();
		for (const subscription of [{}, { endpoint: "http://insecure.example", keys: { p256dh: "a", auth: "b" } }, { endpoint: "https://x.example" }]) {
			expect((await call("/app/api/push/subscribe", { cookie, body: { subscription } })).status).toBe(400);
		}
	});

	it("sends a test, and turns a phone off", async () => {
		const cookie = await signIn();
		const address = await phone("https://web.push.apple.com/phone-1");
		await call("/app/api/push/subscribe", { cookie, body: { subscription: address } });
		expect(await (await call("/app/api/push/test", { cookie, body: {} })).json()).toEqual({ delivered: 1 });
		await call("/app/api/push/unsubscribe", { cookie, body: { endpoint: address.endpoint } });
		expect(await phones()).toEqual([]);
	});
});

describe("what triggers a notification", () => {
	it("a new enquiry from NovaBot", async () => {
		await savePhone(env, await phone("https://web.push.apple.com/phone-1"));
		const { sendEnquiry } = await import("../src/enquiries.js");
		const pending = [];
		await sendEnquiry(
			{ ...env, ...keys },
			{ name: "Jordan Test", email: "jordan@example.com", subject: "Album recording", details: "Six tracks with a band, November weekends." },
			{ chatId: "chat-push-0001", page: "/services", ip: "203.0.113.9" },
			(work) => pending.push(work)
		);
		await Promise.all(pending);
		expect(delivered).toHaveLength(1);
	});

	it("an Acuity booking, when the webhook address has the right key", async () => {
		await savePhone(env, await phone("https://web.push.apple.com/phone-1"));
		const body = "action=scheduled&id=123&calendarID=3360708&appointmentTypeID=64806309";
		const send = (key) =>
			worker.fetch(
				new Request(`${BASE}/acuity/webhook${key ? "?key=" + key : ""}`, { method: "POST", headers: { "Content-Type": "application/x-www-form-urlencoded" }, body }),
				{ ...env, ...keys, ACUITY_WEBHOOK_KEY: "the-right-key", ACUITY_API_KEY: "", BOOKING_DETAILS_WAIT_SECONDS: "0" }
			);
		expect((await send("")).status).toBe(401);
		expect((await send("a-wrong-key")).status).toBe(401);
		expect(delivered).toHaveLength(0);
		expect((await send("the-right-key")).status).toBe(200);
		expect(delivered).toHaveLength(1);
		// Packages and gift certificates aren't bookings: no notification
		const order = await worker.fetch(
			new Request(`${BASE}/acuity/webhook?key=the-right-key`, { method: "POST", headers: { "Content-Type": "application/x-www-form-urlencoded" }, body: "action=order.completed&id=5" }),
			{ ...env, ...keys, ACUITY_WEBHOOK_KEY: "the-right-key" }
		);
		expect(order.status).toBe(200);
		expect(delivered).toHaveLength(1);
	});
});

describe("Nova Hub: the Alerts tab", () => {
	const alerts = async (cookie) => (await (await call("/app/api/notifications", { cookie })).json()).notifications;

	it("lists only notifications that went through to a phone, newest first", async () => {
		const cookie = await signIn();
		// No phone signed up yet: nothing reaches anyone, so nothing is listed
		await notifyPhones({ ...env, ...keys }, { title: "New booking", body: "Nobody to tell" });
		expect(await alerts(cookie)).toEqual([]);
		// A phone signs up: now they go through and are listed
		await savePhone(env, await phone("https://web.push.apple.com/phone-1"));
		await notifyPhones({ ...env, ...keys }, { title: "New enquiry", body: "Jordan: Album", url: "/app/" });
		await notifyPhones({ ...env, ...keys }, { title: "New booking", body: "Rap Package", url: "https://secure.acuityscheduling.com/" });
		const list = await alerts(cookie);
		expect(list.map((n) => n.title)).toEqual(["New booking", "New enquiry"]);
		expect(list[0]).toMatchObject({ body: "Rap Package", url: "https://secure.acuityscheduling.com/", phones: 1 });
	});

	it("leaves out notifications Apple refused, and test notifications", async () => {
		const cookie = await signIn();
		await savePhone(env, await phone("https://web.push.apple.com/old-phone"));
		gone.add("https://web.push.apple.com/old-phone");
		await notifyPhones({ ...env, ...keys }, { title: "New booking", body: "Refused" });
		await savePhone(env, await phone("https://web.push.apple.com/phone-1"));
		await call("/app/api/push/test", { cookie, body: {} });
		expect(delivered.length).toBeGreaterThan(0);
		expect(await alerts(cookie)).toEqual([]);
	});

	it("needs a staff login", async () => {
		expect((await call("/app/api/notifications")).status).toBe(401);
	});
});

describe("booking details in notifications", () => {
	const hookEnv = () => ({ ...env, ...keys, ACUITY_WEBHOOK_KEY: "the-right-key", ACUITY_API_KEY: "", BOOKING_DETAILS_WAIT_SECONDS: "0" });
	// Acuity's webhook (the trusted half)
	const webhook = (action, id = 777) =>
		worker.fetch(
			new Request(`${BASE}/acuity/webhook?key=the-right-key`, {
				method: "POST",
				headers: { "Content-Type": "application/x-www-form-urlencoded" },
				body: `action=${action}&id=${id}&calendarID=3360708&appointmentTypeID=64806309`,
			}),
			hookEnv()
		);
	// Acuity's confirmation page (the customer's browser)
	const pixel = (params) => call("/acuity/booked?" + new URLSearchParams({ type: "appointment", id: "777", session: "Rap Package – 2 songs", date: "October 4, 2026", time: "2:00pm", price: "120.00", email: "fanny@example.com", calendar: "Studio", ...params }));
	// What the Alerts tab shows
	const alerts = async () => (await (await call("/app/api/notifications", { cookie: await signIn() })).json()).notifications;

	beforeEach(async () => {
		await savePhone(env, await phone("https://web.push.apple.com/phone-1"));
	});

	it("puts every detail in the notification, with the name and phone from their enquiry", async () => {
		await env.DB.prepare("INSERT INTO enquiries (created_at, name, email, phone, details, sender) VALUES (?, 'Fanny Winters', 'Fanny@Example.com', '07700 900123', 'Hi', 'x')").bind(new Date().toISOString()).run();
		const res = await pixel();
		expect(res.headers.get("Content-Type")).toBe("image/gif");
		expect((await webhook("scheduled")).status).toBe(200);
		const [alert] = await alerts();
		expect(alert.title).toBe("New booking: Fanny Winters");
		expect(alert.body).toBe("Rap Package – 2 songs\nOctober 4, 2026 at 2:00pm\nPrice: £120.00\nName: Fanny Winters\nPhone: 07700 900123\nEmail: fanny@example.com");
		expect(alert.contact).toEqual({ name: "Fanny Winters", email: "fanny@example.com", phone: "07700 900123" });
		// Cancelling it later still has the details
		await webhook("canceled");
		expect((await alerts())[0]).toMatchObject({ title: "Booking cancelled: Fanny Winters" });
		expect((await alerts())[0].body).toContain("October 4, 2026 at 2:00pm");
	});

	it("fills the details into the Alerts tab when they arrive after the notification", async () => {
		await webhook("scheduled");
		const before = (await alerts())[0];
		expect(before.title).toBe("New booking");
		expect(before.body).toMatch(/^Rap Package - 2 songs [^\n]*$/);
		await pixel();
		expect((await alerts())[0].body).toContain("Email: fanny@example.com");
	});

	it("marks the old time when a booking moves", async () => {
		await pixel();
		await webhook("scheduled");
		await webhook("rescheduled");
		expect((await alerts())[0].body).toContain("Was: October 4, 2026 at 2:00pm");
		expect((await alerts())[0].body).toContain("Tap to see the new time in Acuity.");
	});

	it("ignores details that no real booking confirms", async () => {
		// Sent long before Acuity's webhook: someone guessing a future booking number
		await pixel({ email: "fake@example.com" });
		await env.DB.prepare("UPDATE booking_details SET details_at = '2020-01-01T00:00:00.000Z' WHERE id = 777").run();
		await webhook("scheduled");
		expect((await alerts())[0].body).not.toContain("fake@example.com");
		// The first details win: a second sender can't replace them
		await pixel({ id: "778" });
		await pixel({ id: "778", email: "other@example.com" });
		await webhook("scheduled", 778);
		expect((await alerts())[0].body).toContain("fanny@example.com");
		// Orders and junk are ignored, but the page still gets its picture
		const order = await pixel({ type: "order", id: "779" });
		expect(order.status).toBe(200);
		expect(await env.DB.prepare("SELECT COUNT(*) AS n FROM booking_details WHERE id = 779").first("n")).toBe(0);
	});

	it("puts every detail of an enquiry in its notification", async () => {
		const { sendEnquiry } = await import("../src/enquiries.js");
		const pending = [];
		await sendEnquiry(
			{ ...env, ...keys },
			{ name: "Jordan Test", email: "jordan@example.com", phone: "07700 900456", subject: "Album recording", details: "Six tracks with a band." },
			{ chatId: "chat-push-0002", page: "/services", ip: "203.0.113.10" },
			(work) => pending.push(work)
		);
		await Promise.all(pending);
		const [alert] = await alerts();
		expect(alert.title).toBe("New enquiry: Jordan Test");
		expect(alert.body).toBe("Album recording\nPhone: 07700 900456\nEmail: jordan@example.com\nSix tracks with a band.");
		expect(alert.contact.phone).toBe("07700 900456");
	});
});

// ----- Acuity's booking emails -----

// Laid out like Acuity's real emails (the customer's copy), with a made-up customer
const CUSTOMER_EMAIL = {
	subject: "New Appointment: Rap Package - 1 song (1 hour recording with engineer + 1 hour mixing) (Billard Testical) on Monday, September 28, 2026 11:15 with Novacane Studios",
	html: `<style>.x{color:red}</style><table><tbody><tr><td style="font-size:30px">Appointment Scheduled\r\n</td></tr><tr><td>for Billard Testical\r\n</td></tr></tbody></table>
<table><tbody><tr><td width="60">What\r\n</td><td>Rap Package - 1 song (1 hour recording with engineer + 1 hour mixing) (Novacane Studios)\r\n</td></tr>
<tr><td width="60">When\r\n</td><td>Monday, September 28, 2026 11:15 (2 hours)\r\n</td></tr></tbody></table>
<table><tr><td><a href="https://app.acuityscheduling.com/schedule.php?owner=18510650&action=appt&id%5B%5D=e1237&apptId=1781153081&ref=email">Change/Cancel Appointment</a></td></tr></table>`,
	text: "Appointment Scheduled\nfor Billard Testical\nWhat\nRap Package",
};

// Laid out like the studio's own copy, with every detail and a form answer
const STAFF_EMAIL = (kind = "New Appointment", id = 555123) => ({
	subject: `${kind}: Fanny Winters on Saturday, October 4, 2026 2:00pm`,
	html: `<table>
<tr><td>Name:</td><td>Fanny Winters</td></tr>
<tr><td>Phone:</td><td><a href="tel:07700900123">07700 900123</a></td></tr>
<tr><td>Email:</td><td><a href="mailto:fanny@example.com">fanny@example.com</a></td></tr>
<tr><td>What:</td><td>Rap Package - 2 songs (Novacane Studios)</td></tr>
<tr><td>When:</td><td>Saturday, October 4, 2026 2:00pm</td></tr>
${kind.includes("Reschedul") ? "<tr><td>Old Time:</td><td>Friday, October 3, 2026 1:00pm</td></tr>" : ""}
<tr><td>Price:</td><td>£120.00 (paid)</td></tr>
<tr><td>How did you hear about us?</td><td>Instagram &amp; TikTok</td></tr>
</table><a href="https://secure.acuityscheduling.com/appointments.php?action=detail&amp;id=${id}">View</a>`,
	text: "",
});

describe("reading Acuity's emails", () => {
	it("reads the customer's copy", async () => {
		const { parseAcuityEmail } = await import("../src/booking-emails.js");
		expect(parseAcuityEmail(CUSTOMER_EMAIL)).toMatchObject({
			id: "1781153081",
			kind: "scheduled",
			name: "Billard Testical",
			session: "Rap Package - 1 song (1 hour recording with engineer + 1 hour mixing)",
			when: "Monday, September 28, 2026 11:15 (2 hours)",
			phone: null,
		});
	});

	it("reads every detail of the studio's copy", async () => {
		const { parseAcuityEmail } = await import("../src/booking-emails.js");
		expect(parseAcuityEmail(STAFF_EMAIL("Appointment Rescheduled"))).toEqual({
			id: "555123",
			kind: "rescheduled",
			name: "Fanny Winters",
			phone: "07700 900123",
			email: "fanny@example.com",
			session: "Rap Package - 2 songs",
			when: "Saturday, October 4, 2026 2:00pm",
			was: "Friday, October 3, 2026 1:00pm",
			price: "£120.00 (paid)",
			extra: [["How did you hear about us?", "Instagram & TikTok"]],
		});
	});
});

describe("booking notifications with Acuity's emails", () => {
	const hookEnv = () => ({ ...env, ...keys, ACUITY_WEBHOOK_KEY: "the-right-key", ACUITY_EMAIL_KEY: "the-email-key" });
	const webhook = (action, id = 555123) =>
		worker.fetch(
			new Request(`${BASE}/acuity/webhook?key=the-right-key`, {
				method: "POST",
				headers: { "Content-Type": "application/x-www-form-urlencoded" },
				body: `action=${action}&id=${id}&calendarID=3360708&appointmentTypeID=64806309`,
			}),
			hookEnv()
		);
	const sendEmail = (email, key = "the-email-key") =>
		worker.fetch(new Request(`${BASE}/acuity/email`, { method: "POST", headers: { "X-Nova-Key": key }, body: JSON.stringify(email) }), hookEnv());
	const alerts = async () => (await (await call("/app/api/notifications", { cookie: await signIn() })).json()).notifications;
	// Every minute's check, as Cloudflare runs it
	const everyMinute = async () => {
		const ctx = createExecutionContext();
		await worker.scheduled({ cron: "* * * * *" }, hookEnv(), ctx);
		await waitOnExecutionContext(ctx);
	};
	// Pretend the waiting changes arrived 5 minutes ago
	const fiveMinutesPass = () => env.DB.prepare("UPDATE booking_events SET received_at = ?").bind(new Date(Date.now() - 5 * 60000).toISOString()).run();

	beforeEach(async () => {
		await savePhone(env, await phone("https://web.push.apple.com/phone-1"));
	});

	it("only takes emails with the right key", async () => {
		expect((await sendEmail(STAFF_EMAIL(), "wrong")).status).toBe(401);
		expect((await sendEmail(STAFF_EMAIL(), "")).status).toBe(401);
	});

	it("before any email has come through, notifications go out straight away", async () => {
		await webhook("scheduled");
		expect(delivered).toHaveLength(1);
		// The email arriving afterwards fills in the Alerts tab (no second notification)
		await sendEmail(STAFF_EMAIL());
		expect(delivered).toHaveLength(1);
		const [alert] = await alerts();
		expect(alert.title).toBe("New booking: Fanny Winters");
		expect(alert.body).toContain("Phone: 07700 900123");
	});

	it("once emails come through, the notification waits for the email and has everything", async () => {
		await sendEmail(STAFF_EMAIL("New Appointment", 10001)); // an earlier booking's email: emails are set up
		await webhook("scheduled");
		expect(delivered).toHaveLength(0); // waiting for the email
		expect(await (await sendEmail(STAFF_EMAIL())).json()).toEqual({ ok: true, matched: true, id: 555123 });
		expect(delivered).toHaveLength(1);
		const [alert] = await alerts();
		expect(alert.title).toBe("New booking: Fanny Winters");
		expect(alert.body).toBe(
			"Rap Package - 2 songs\nSaturday, October 4, 2026 2:00pm\nPrice: £120.00 (paid)\nName: Fanny Winters\nPhone: 07700 900123\nEmail: fanny@example.com\nHow did you hear about us?: Instagram & TikTok"
		);
		expect(alert.contact).toEqual({ name: "Fanny Winters", email: "fanny@example.com", phone: "07700 900123" });
		// A moved booking: the new time and the old one
		await webhook("rescheduled");
		await sendEmail(STAFF_EMAIL("Appointment Rescheduled"));
		expect((await alerts())[0]).toMatchObject({ title: "Booking moved: Fanny Winters" });
		expect((await alerts())[0].body).toContain("Saturday, October 4, 2026 2:00pm\nWas: Friday, October 3, 2026 1:00pm");
		expect(delivered).toHaveLength(2);
	});

	it("an email that came before the webhook is used straight away", async () => {
		await sendEmail(STAFF_EMAIL("Appointment Cancelled"));
		await webhook("canceled");
		expect(delivered).toHaveLength(1);
		expect((await alerts())[0].title).toBe("Booking cancelled: Fanny Winters");
	});

	it("if the email never comes, the notification goes out after 3 minutes with what we have, once", async () => {
		await sendEmail(STAFF_EMAIL("New Appointment", 10001));
		await webhook("scheduled", 99999);
		await everyMinute();
		expect(delivered).toHaveLength(0); // not 3 minutes yet
		await fiveMinutesPass();
		await everyMinute();
		expect(delivered).toHaveLength(1);
		expect((await alerts())[0]).toMatchObject({ title: "New booking" });
		expect((await alerts())[0].body).toMatch(/^Rap Package - 2 songs/);
		// A late email doesn't send it again
		await sendEmail(STAFF_EMAIL("New Appointment", 99999));
		await everyMinute();
		expect(delivered).toHaveLength(1);
	});

	it("an email without a booking number matches the only booking waiting for one", async () => {
		await sendEmail(STAFF_EMAIL("New Appointment", 10001));
		await webhook("scheduled", 42424);
		const email = STAFF_EMAIL();
		email.html = email.html.replace(/<a href="https:\/\/secure[^>]*>View<\/a>/, "");
		expect(await (await sendEmail(email)).json()).toEqual({ ok: true, matched: true, id: 42424 });
		expect(delivered).toHaveLength(1);
	});

	it("shows the latest email in the Alerts tab, with a link to it in Gmail", async () => {
		await webhook("scheduled");
		const gmail = { messageId: "18f2a9c4d1e0b7a3", account: "info@novacane.co.uk" };
		await sendEmail({ ...STAFF_EMAIL(), ...gmail });
		let [alert] = await alerts();
		expect(alert.email).toMatchObject({ kind: "scheduled", same: true, gmail: "https://mail.google.com/mail/?authuser=info%40novacane.co.uk#all/18f2a9c4d1e0b7a3" });
		// A cancellation email later: the alert's box shows the latest email
		await webhook("canceled");
		await sendEmail({ ...STAFF_EMAIL("Appointment Cancelled"), ...gmail });
		alert = (await alerts()).find((a) => a.title.startsWith("New booking"));
		expect(alert.email.kind).toBe("canceled");
		expect(alert.email.lines).toContain("Phone: 07700 900123");
		// Odd Gmail details: no link
		await sendEmail({ ...STAFF_EMAIL("Appointment Cancelled"), messageId: "javascript:alert(1)", account: "x" });
		expect((await alerts())[0].email.gmail).toBeNull();
	});
});

// ----- Acuity's calendar feed -----

// Laid out exactly like Acuity's real feed (folded lines and all), with a made-up customer
const feedWith = (start = "20261022T131500Z", end = "20261022T151500Z") =>
	[
		"BEGIN:VCALENDAR",
		"BEGIN:VEVENT",
		"UID:1782089433@scheduling",
		"DTSTAMP:20261003T165531Z",
		"DESCRIPTION:Client time zone: Europe/London\\nName: Eric Test\\nPhone: 01",
		" 632960202\\nEmail: eric@example.com\\nPrice: £60.00\\nHow did you hear about us?: A friend\\, Jo\\n",
		`DTSTART:${start}`,
		`DTEND:${end}`,
		"LOCATION:",
		"SUMMARY:Eric Test: Studio Rental without Engineer - 2 hours (Novacane S",
		" tudios)",
		"END:VEVENT",
		"BEGIN:VEVENT",
		"UID:unavailable-1@scheduling",
		"SUMMARY:Busy",
		"END:VEVENT",
		"END:VCALENDAR",
	].join("\r\n");

describe("booking details from Acuity's calendar feed", () => {
	const hookEnv = () => ({ ...env, ...keys, ACUITY_WEBHOOK_KEY: "the-right-key", ACUITY_CALENDAR_URL: "https://calendar.test/feed" });
	const webhook = (action) =>
		worker.fetch(
			new Request(`${BASE}/acuity/webhook?key=the-right-key`, {
				method: "POST",
				headers: { "Content-Type": "application/x-www-form-urlencoded" },
				body: `action=${action}&id=1782089433&calendarID=3360708&appointmentTypeID=64806309`,
			}),
			hookEnv()
		);
	const alerts = async () => (await (await call("/app/api/notifications", { cookie: await signIn() })).json()).notifications;

	beforeEach(async () => {
		await savePhone(env, await phone("https://web.push.apple.com/phone-1"));
	});

	it("reads the feed the way Acuity writes it", async () => {
		const { parseCalendar } = await import("../src/booking-calendar.js");
		expect(parseCalendar(feedWith())).toEqual({
			1782089433: {
				name: "Eric Test",
				phone: "01632960202",
				email: "eric@example.com",
				session: "Studio Rental without Engineer - 2 hours",
				price: "£60.00",
				when: "Thursday, 22 October 2026, 14:15–16:15",
				start: "20261022T131500Z",
				end: "20261022T151500Z",
				extra: [["How did you hear about us?", "A friend, Jo"]],
			},
		});
	});

	it("sends every detail straight away, even for bookings staff add themselves", async () => {
		calendarFeed = feedWith();
		await webhook("scheduled");
		expect(delivered).toHaveLength(1);
		const [alert] = await alerts();
		expect(alert.title).toBe("New booking: Eric Test");
		expect(alert.body).toBe(
			"Studio Rental without Engineer - 2 hours\nThursday, 22 October 2026, 14:15–16:15\nPrice: £60.00\nName: Eric Test\nPhone: 01632960202\nEmail: eric@example.com\nHow did you hear about us?: A friend, Jo"
		);
		expect(alert.email.source).toBe("calendar");
		expect(alert.contact).toEqual({ name: "Eric Test", email: "eric@example.com", phone: "01632960202" });
	});

	it("shows the new and old time when a booking moves, and keeps the details when it's cancelled", async () => {
		calendarFeed = feedWith();
		await webhook("scheduled");
		calendarFeed = feedWith("20261023T090000Z", "20261023T110000Z");
		await webhook("rescheduled");
		let [alert] = await alerts();
		expect(alert.title).toBe("Booking moved: Eric Test");
		expect(alert.body).toContain("Friday, 23 October 2026, 10:00–12:00\nWas: Thursday, 22 October 2026, 14:15–16:15");
		// Cancelled: it's gone from the feed, but we still have the details
		calendarFeed = "BEGIN:VCALENDAR\r\nEND:VCALENDAR\r\n";
		await webhook("canceled");
		[alert] = await alerts();
		expect(alert.title).toBe("Booking cancelled: Eric Test");
		expect(alert.body).toContain("Phone: 01632960202");
		expect(delivered).toHaveLength(3);
	});
});

describe("Nova Hub: deleting alerts, auto-delete and voice", () => {
	const list = async (cookie) => (await (await call("/app/api/notifications", { cookie })).json());
	const addAlerts = async () => {
		await savePhone(env, await phone("https://web.push.apple.com/phone-1"));
		await notifyPhones({ ...env, ...keys }, { title: "Old one", body: "From last week" });
		await notifyPhones({ ...env, ...keys }, { title: "New one", body: "From today" });
		await env.DB.prepare("UPDATE notifications SET created_at = ? WHERE title = 'Old one'").bind(new Date(Date.now() - 5 * 86400000).toISOString()).run();
	};

	it("deletes one alert, or all of them", async () => {
		const cookie = await signIn();
		await addAlerts();
		const [newest] = (await list(cookie)).notifications;
		await call("/app/api/notifications/delete", { cookie, body: { id: newest.id } });
		expect((await list(cookie)).notifications.map((n) => n.title)).toEqual(["Old one"]);
		await call("/app/api/notifications/delete", { cookie, body: { all: true } });
		expect((await list(cookie)).notifications).toEqual([]);
		expect((await call("/app/api/notifications/delete", { cookie, body: { id: "everything" } })).status).toBe(400);
	});

	it("the auto-delete switch removes alerts older than the chosen days", async () => {
		const cookie = await signIn();
		await addAlerts();
		expect((await list(cookie)).autoDeleteDays).toBe(0);
		expect((await call("/app/api/notifications/settings", { cookie, body: { days: 5 } })).status).toBe(400); // not a choice
		await call("/app/api/notifications/settings", { cookie, body: { days: 3 } });
		const after = await list(cookie);
		expect(after.autoDeleteDays).toBe(3);
		expect(after.notifications.map((n) => n.title)).toEqual(["New one"]);
		// Off again: nothing more is deleted
		await call("/app/api/notifications/settings", { cookie, body: { days: 0 } });
		expect((await list(cookie)).autoDeleteDays).toBe(0);
	});

	it("the every-minute check also applies the switch", async () => {
		await addAlerts();
		await env.DB.prepare("INSERT INTO settings (key, value) VALUES ('alerts_auto_delete_days', '1')").run();
		const ctx = createExecutionContext();
		await worker.scheduled({ cron: "* * * * *" }, { ...env, ...keys }, ctx);
		await waitOnExecutionContext(ctx);
		expect((await env.DB.prepare("SELECT title FROM notifications").all()).results.map((r) => r.title)).toEqual(["New one"]);
	});

	it("voice commands: only for signed-in staff, and returns the words", async () => {
		const AI = { run: async () => ({ text: " Show alerts. " }) };
		const send = (cookie) =>
			worker.fetch(
				new Request(BASE + "/app/api/voice", { method: "POST", headers: { Origin: BASE, "Content-Type": "audio/wav", ...(cookie ? { Cookie: cookie } : {}) }, body: new Uint8Array([1, 2, 3]) }),
				{ ...env, AI }
			);
		expect((await send()).status).toBe(401);
		const res = await send(await signIn());
		expect(await res.json()).toEqual({ text: "Show alerts." });
	});
});

describe("Nova Hub: calendar and questions", () => {
	const feedEnv = { ACUITY_CALENDAR_URL: "https://calendar.test/feed", ANTHROPIC_API_KEY: "test-key" };

	it("the calendar lists every booking in Acuity's diary, for staff only", async () => {
		calendarFeed = feedWith();
		expect((await call("/app/api/calendar", { extraEnv: feedEnv })).status).toBe(401);
		const cookie = await signIn();
		const data = await (await call("/app/api/calendar", { cookie, extraEnv: feedEnv })).json();
		expect(data.setUp).toBe(true);
		expect(data.bookings).toEqual([expect.objectContaining({ id: 1782089433, name: "Eric Test", start: "20261022T131500Z", phone: "01632960202" })]);
		// No feed set up
		expect(await (await call("/app/api/calendar", { cookie })).json()).toEqual({ bookings: [], setUp: false });
	});

	it("answers questions using the bookings, enquiries and alerts", async () => {
		calendarFeed = feedWith("20991022T131500Z", "20991022T151500Z");
		await env.DB.prepare("INSERT INTO enquiries (created_at, name, email, details, subject, sender) VALUES (?, 'Jordan Test', 'jordan@example.com', 'Six tracks', 'Album', 'x')").bind(new Date().toISOString()).run();
		const cookie = await signIn();
		expect((await call("/app/api/ask", { body: { question: "When is Eric's session?" }, extraEnv: feedEnv })).status).toBe(401);
		const res = await call("/app/api/ask", { cookie, body: { question: "When is Eric's session?", history: [{ role: "assistant", content: "hi" }] }, extraEnv: feedEnv });
		expect(await res.json()).toEqual({ answer: "ok" });
		const data = lastClaude.system.map((part) => part.text).join("\n");
		expect(data).toContain("Eric Test");
		expect(data).toContain("2099");
		expect(data).toContain("Jordan Test");
		expect(lastClaude.messages).toEqual([{ role: "user", content: "When is Eric's session?" }]);
		expect((await call("/app/api/ask", { cookie, body: { question: "  " }, extraEnv: feedEnv })).status).toBe(400);
	});
});

import { createExecutionContext, env, waitOnExecutionContext } from "cloudflare:test";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import worker from "../src";
import { forgetSessionTypes } from "../src/nova/booking.js";
import { notifyPhones, savePhone } from "../src/push.js";
import { bookSession } from "../src/nova/book-session.js";
import { cancelBooking, getBooking, moveBooking, paymentReceived } from "../src/nova/bookings.js";
import { clearTables, connectGoogle, makeGoogle, makeStripe, ukDay } from "./fakes.js";

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
let google; // a fake Google (calendar and Gmail)
let stripe;
let lastClaude = null; // the last request sent to "Claude"

beforeEach(async () => {
	delivered = [];
	gone = new Set();
	google = makeGoogle();
	stripe = makeStripe();
	forgetSessionTypes();
	keys = await vapidKeys();
	vi.spyOn(globalThis, "fetch").mockImplementation(async (url, init) => {
		if (String(url).startsWith("https://web.push.apple.com/")) {
			delivered.push({ url: String(url), init });
			return new Response(null, { status: gone.has(String(url)) ? 410 : 201 });
		}
		const fake = (await google.handle(String(url), init || {})) || (await stripe.handle(String(url), init || {}));
		if (fake) return fake;
		if (String(url) === "https://api.anthropic.com/v1/messages") {
			lastClaude = JSON.parse(init.body);
			return new Response(JSON.stringify({ stop_reason: "end_turn", content: [{ type: "text", text: "ok" }] }));
		}
		throw new Error("Unexpected fetch in test: " + url);
	});
	await clearTables();
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

	it("a booking: made, paid, moved and cancelled", async () => {
		await savePhone(env, await phone("https://web.push.apple.com/phone-1"));
		await connectGoogle();
		const e = { ...env, ...keys };
		const out = await bookSession(e, { session_type_id: 64806309, date: ukDay(10), time: "14:00", first_name: "Eric", last_name: "Test", email: "eric@example.com", phone: "01632960202" }, { ip: "1.2.3.4" });
		await paymentReceived(e, { bookingId: out.booked.id, amountPence: 10000, stripeId: "pi_eric", purpose: "deposit" });
		await moveBooking(e, await getBooking(e, out.booked.id), { date: ukDay(12), time: "11:00", by: "staff", notify: false });
		await cancelBooking(e, await getBooking(e, out.booked.id), { by: "staff", notify: false, refundPence: 0 });
		const titles = (await env.DB.prepare("SELECT title, body, url, appointment_id FROM notifications ORDER BY id").all()).results;
		expect(titles.map((t) => t.title)).toEqual(["New booking: Eric Test", "Payment received: Eric Test", "Booking moved: Eric Test", "Booking cancelled: Eric Test"]);
		expect(titles[0].body).toContain("Phone: 01632960202");
		expect(titles[0].body).toContain("Email: eric@example.com");
		expect(titles[0].url).toMatch(/^https:\/\/calendar\.google\.com\//);
		expect(titles[2].body).toContain("Was:");
		expect(titles.every((t) => t.appointment_id === out.booked.id)).toBe(true);
		expect(delivered).toHaveLength(4);
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

describe("notification details", () => {
	const alerts = async () => (await (await call("/app/api/notifications", { cookie: await signIn() })).json()).notifications;

	it("puts every detail of an enquiry in its notification", async () => {
		await savePhone(env, await phone("https://web.push.apple.com/phone-1"));
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

	it("the Alerts tab shows each booking as it is now", async () => {
		await savePhone(env, await phone("https://web.push.apple.com/phone-1"));
		await connectGoogle();
		const e = { ...env, ...keys };
		const out = await bookSession(e, { session_type_id: 12738216, date: ukDay(10), time: "14:00", first_name: "Eric", last_name: "Test", email: "eric@example.com", phone: "01632960202" }, { ip: "1.2.3.5" });
		await paymentReceived(e, { bookingId: out.booked.id, amountPence: 4000, stripeId: "pi_eric2", purpose: "deposit" });
		const first = (await alerts()).find((n) => n.title === "New booking: Eric Test");
		expect(first.contact).toEqual({ name: "Eric Test", email: "eric@example.com", phone: "01632960202" });
		expect(first.email.lines).toContain("Paid: £40 (£40 to pay)");
		expect(first.email.link).toMatch(/^https:\/\/calendar\.google\.com\//);
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
	async function booked() {
		await connectGoogle();
		google.add({ summary: "Gear maintenance", start: { dateTime: new Date(Date.now() + 5 * 86400000).toISOString() }, end: { dateTime: new Date(Date.now() + 5 * 86400000 + 3600000).toISOString() } });
		return bookSession({ ...env, ...keys }, { session_type_id: 64806309, date: ukDay(10), time: "14:00", first_name: "Eric", last_name: "Test", email: "eric@example.com", phone: "01632960202" }, { ip: "1.2.3.6" });
	}

	it("the calendar lists every booking and calendar event, for staff only", async () => {
		expect((await call("/app/api/calendar")).status).toBe(401);
		const cookie = await signIn();
		// Not connected yet
		expect(await (await call("/app/api/calendar", { cookie })).json()).toEqual({ bookings: [], setUp: false });
		const out = await booked();
		const data = await (await call("/app/api/calendar", { cookie })).json();
		expect(data.setUp).toBe(true);
		const b = await getBooking(env, out.booked.id);
		const startFeed = new Date(b.starts_at).toISOString().replace(/[-:]/g, "").replace(/\.\d{3}/, "");
		expect(data.bookings).toEqual(
			expect.arrayContaining([
				expect.objectContaining({ id: b.id, kind: "booking", name: "Eric Test", start: startFeed, phone: "01632960202", price: "£200" }),
				expect.objectContaining({ id: null, kind: "event", name: "Gear maintenance" }),
			])
		);
	});

	it("answers questions using the bookings, enquiries and alerts", async () => {
		await booked();
		await env.DB.prepare("INSERT INTO enquiries (created_at, name, email, details, subject, sender) VALUES (?, 'Jordan Test', 'jordan@example.com', 'Six tracks', 'Album', 'x')").bind(new Date().toISOString()).run();
		const cookie = await signIn();
		const extraEnv = { ANTHROPIC_API_KEY: "test-key" };
		expect((await call("/app/api/ask", { body: { question: "When is Eric's session?" }, extraEnv })).status).toBe(401);
		const res = await call("/app/api/ask", { cookie, body: { question: "When is Eric's session?", history: [{ role: "assistant", content: "hi" }] }, extraEnv });
		expect(await res.json()).toEqual({ answer: "ok" });
		const data = lastClaude.system.map((part) => part.text).join("\n");
		expect(data).toContain("Eric Test");
		expect(data).toContain("Gear maintenance");
		expect(data).toContain("Jordan Test");
		expect(lastClaude.messages).toEqual([{ role: "user", content: "When is Eric's session?" }]);
		expect((await call("/app/api/ask", { cookie, body: { question: "  " }, extraEnv })).status).toBe(400);
	});
});

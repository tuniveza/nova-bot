import { createExecutionContext, env, waitOnExecutionContext } from "cloudflare:test";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import worker from "../src";
import { bookSession } from "../src/book-session.js";
import { forgetSessionTypes, makeBookingLink, ukToday } from "../src/booking.js";
import { BOOKING_PAGE_HTML } from "./acuity-page.js";

const BASE = "https://novacane-worker.test";
const TODAY = "2026-10-01"; // a Thursday
const RAP = 64806309; // a session type on the test booking page (calendar 3360708)

// ----- A fake Acuity: the public calendar and the API -----
// Open Monday to Saturday from Monday 5 October, start times 10:00 to 18:30
// every 30 minutes, except times in `taken`

let taken = new Set(); // "2026-10-06T14:00"
let availabilityLookups = 0;
let acuityBookings = []; // what the Worker asked Acuity's API to book
let acuityAnswer = null; // override what the API answers: { status, body }
let claudeReplies = [];
let claudeCalls = [];

function addDays(ymd, n) {
	const d = new Date(ymd + "T00:00:00Z");
	d.setUTCDate(d.getUTCDate() + n);
	return d.toISOString().slice(0, 10);
}

function fakeFreeTimes(startDate, maxDays) {
	const days = {};
	let day = startDate < "2026-10-05" ? "2026-10-05" : startDate;
	for (let i = 0; Object.keys(days).length < maxDays && i < 60; i++, day = addDays(day, 1)) {
		if (new Date(day + "T00:00:00Z").getUTCDay() === 0) continue;
		const slots = [];
		for (let m = 600; m <= 1110; m += 30) {
			const hhmm = `${String(Math.floor(m / 60)).padStart(2, "0")}:${String(m % 60).padStart(2, "0")}`;
			if (!taken.has(`${day}T${hhmm}`)) slots.push({ time: `${day}T${hhmm}:00+0100`, slotsAvailable: 1 });
		}
		days[day] = slots;
	}
	return days;
}

beforeEach(async () => {
	taken = new Set();
	availabilityLookups = 0;
	acuityBookings = [];
	acuityAnswer = null;
	claudeReplies = [];
	claudeCalls = [];
	forgetSessionTypes();
	vi.spyOn(globalThis, "fetch").mockImplementation(async (url, init) => {
		const u = new URL(String(url));
		if (u.pathname === "/schedule.php") return new Response(BOOKING_PAGE_HTML);
		if (u.pathname === "/api/scheduling/v1/availability/times") {
			availabilityLookups++;
			return new Response(JSON.stringify(fakeFreeTimes(u.searchParams.get("startDate"), Number(u.searchParams.get("maxDays")))));
		}
		if (String(url) === "https://acuityscheduling.com/api/v1/appointments" && init?.method === "POST") {
			const body = JSON.parse(init.body);
			acuityBookings.push({ body, auth: init.headers.Authorization });
			if (acuityAnswer) return new Response(JSON.stringify(acuityAnswer.body), { status: acuityAnswer.status });
			taken.add(body.datetime.slice(0, 16));
			const id = 900000 + acuityBookings.length;
			return new Response(
				JSON.stringify({
					id,
					confirmationPage: `https://app.acuityscheduling.com/schedule.php?owner=18510650&action=appt&id%5B%5D=${id}`,
					confirmationPagePaymentLink: `https://app.acuityscheduling.com/schedule.php?owner=18510650&action=appt&id%5B%5D=${id}&paymentLink=1`,
				})
			);
		}
		if (String(url) === "https://api.anthropic.com/v1/messages") {
			claudeCalls.push(JSON.parse(init.body));
			const next = claudeReplies.shift();
			return next ? new Response(JSON.stringify(next)) : new Response("overloaded", { status: 529 });
		}
		throw new Error("Unexpected fetch in test: " + url);
	});
	await env.DB.batch([env.DB.prepare("DELETE FROM chat_bookings"), env.DB.prepare("DELETE FROM agent_jobs"), env.DB.prepare("DELETE FROM settings")]);
	await agentNova({ mode: "live" });
});

// Pretend Nova Agent checked in `minutesAgo` ago, in live or rehearsal mode
async function agentNova({ mode, minutesAgo = 0 }) {
	await env.DB.batch([
		env.DB.prepare("INSERT OR REPLACE INTO settings (key, value) VALUES ('agent_nova_seen', ?)").bind(new Date(Date.now() - minutesAgo * 60000).toISOString()),
		env.DB.prepare("INSERT OR REPLACE INTO settings (key, value) VALUES ('agent_nova_mode', ?)").bind(mode),
	]);
}

afterEach(() => {
	vi.restoreAllMocks();
});

// ----- Helpers -----

const SAM = { first_name: "Sam", last_name: "Singer", email: "Sam@Example.com", phone: "07700 900123" };
const later = [];
const book = (input, { ip = "203.0.113.50", extraEnv = {} } = {}) =>
	bookSession({ ...env, ...extraEnv }, "18510650", { session_type_id: RAP, ...SAM, ...input }, { chatId: "chat-book-0001", ip }, (p) => later.push(p), TODAY);
const saved = async () => (await env.DB.prepare("SELECT * FROM chat_bookings ORDER BY id").all()).results;
const jobs = async () => (await env.DB.prepare("SELECT kind, client_name, changes, status FROM agent_jobs ORDER BY id").all()).results;

let ipNumber = 0;
async function chat(words) {
	const ctx = createExecutionContext();
	const res = await worker.fetch(
		new Request(BASE, {
			method: "POST",
			headers: { "Content-Type": "application/json", Origin: "https://novacane.co.uk", "CF-Connecting-IP": `198.51.100.${++ipNumber}` },
			body: JSON.stringify({ messages: [{ role: "user", content: words }], chatId: "chat-book-0002" }),
		}),
		env,
		ctx
	);
	await waitOnExecutionContext(ctx);
	return res.json();
}
const text = (words) => ({ stop_reason: "end_turn", content: [{ type: "text", text: words }] });
const toolCall = (name, input) => ({ stop_reason: "tool_use", content: [{ type: "tool_use", id: "toolu_" + name, name, input }] });
// A day the fake calendar has open, counting from the real today
const openDay = () => Object.keys(fakeFreeTimes(addDays(ukToday(), 1), 1))[0];

// ----- Booking it for them -----

describe("book_session (staff chat): never books, only gets it ready to pay for", () => {
	it("checks the time and gives Acuity's booking page with it selected and the details filled in", async () => {
		const result = await book({ date: "2026-10-06", time: "2pm" });
		expect(result.ok).toBe(true);
		expect(result.payFirst).toBe(true);
		expect(result.message).toMatch(/^Ready to pay for, NOT booked: ".*" on Tuesday 6 October at 14:00 \(UK time\) is free/);
		expect(result.message).toContain("Don't say it's booked");
		const url = new URL(result.url);
		expect(decodeURIComponent(url.pathname)).toContain(`/appointment/${RAP}/calendar/3360708/datetime/2026-10-06T14:00:00+01:00`);
		expect(url.searchParams.get("firstName")).toBe("Sam");
		expect(url.searchParams.get("email")).toBe("sam@example.com");
		// Nothing booked: no Nova Agent job, nothing sent to Acuity's API, nothing saved
		expect(await jobs()).toHaveLength(0);
		expect(acuityBookings).toHaveLength(0);
		expect(await saved()).toHaveLength(0);
	});

	it("asks the calendar afresh, not from a remembered answer", async () => {
		await makeBookingLink("18510650", { session_type_id: RAP, date: "2026-10-06", time: "14:00" }, TODAY);
		const before = availabilityLookups;
		taken.add("2026-10-06T14:00"); // someone else books it in the meantime
		const result = await book({ date: "2026-10-06", time: "14:00" });
		expect(availabilityLookups).toBeGreaterThan(before);
		expect(result.ok).toBe(false);
		expect(result.message).toMatch(/isn't showing as free .* any more/);
		expect(result.message).toMatch(/check_availability/);
	});

	it("needs a name, a real email and a phone number first", async () => {
		expect((await book({ date: "2026-10-06", time: "14:00", last_name: "" })).message).toMatch(/first and last name/);
		expect((await book({ date: "2026-10-06", time: "14:00", email: "sam@" })).message).toMatch(/email address doesn't look right/);
		expect((await book({ date: "2026-10-06", time: "14:00", phone: " " })).message).toMatch(/phone number is needed/);
		expect((await book({ date: "next tuesday", time: "14:00" })).message).toMatch(/YYYY-MM-DD/);
		expect((await book({ session_type_id: 1, date: "2026-10-06", time: "14:00" })).message).toMatch(/No session type with that ID/);
		expect(await jobs()).toHaveLength(0);
	});
});

// ----- The choice: book it for me, or book it myself -----

describe("asking how they want to book", () => {
	it("offers the choice for a free time when asked to and booking for them is available", async () => {
		const result = await makeBookingLink("18510650", { session_type_id: RAP, date: "2026-10-06", time: "14:00", ask_how_to_book: true }, TODAY, true);
		expect(result.choice).toBe(true);
		expect(result.message).toMatch(/"Book it for me"/);
		// Not when booking for them isn't available, or the time isn't free
		expect((await makeBookingLink("18510650", { session_type_id: RAP, date: "2026-10-06", time: "14:00", ask_how_to_book: true }, TODAY, false)).choice).toBeUndefined();
		expect((await makeBookingLink("18510650", { session_type_id: RAP, date: "2026-10-06", time: "20:00", ask_how_to_book: true }, TODAY, true)).choice).toBeUndefined();
	});

	it("in the chat: booking for them is the default, with no 'book it yourself?' buttons", async () => {
		const date = openDay();
		claudeReplies.push(toolCall("booking_link", { session_type_id: RAP, date, time: "14:00", ask_how_to_book: true }), text("14:00 shows as free right now."));
		const data = await chat("2pm works");
		expect(data.choice).toBeUndefined();
		expect(claudeCalls[0].system[1].text).toContain("BOOKING IT FOR THEM (available, and the DEFAULT)");
		expect(claudeCalls[0].system[1].text).toContain("open_booking_form");
	});

	it("in the chat: no buttons when they've already said how", async () => {
		claudeReplies.push(toolCall("booking_link", { session_type_id: RAP, date: openDay(), time: "14:00" }), text("Here you go."));
		expect((await chat("send me the link for 2pm")).choice).toBeUndefined();
	});

	it("on the website: book_session never books for free, even if NovaBot tries it", async () => {
		claudeReplies.push(toolCall("book_session", { session_type_id: RAP, date: openDay(), time: "14:00", ...SAM }), toolCall("open_booking_form", { session_type_id: RAP, date: openDay(), time: "14:00", ...SAM }), text("Your card's below: press Book, then pay the deposit."));
		const data = await chat("yes, book it");
		expect(claudeCalls[0].tools.map((tool) => tool.name)).not.toContain("book_session");
		const result = claudeCalls[1].messages.at(-1).content[0];
		expect(result.is_error).toBe(true);
		expect(result.content).toContain("deposit");
		expect(await jobs()).toHaveLength(0);
		expect(acuityBookings).toHaveLength(0);
		expect(data.form.time).toBe("14:00");
	});

	it("in the chat: never lets NovaBot say it's booked when it didn't book", async () => {
		claudeReplies.push(
			text("Your booking's going in now for Tuesday at 14:00."), // claims it, without the card
			toolCall("open_booking_form", { session_type_id: RAP, date: openDay(), time: "14:00", ...SAM }),
			text("Your card's below: press Book, then pay the deposit to confirm.")
		);
		const data = await chat("yes, correct");
		expect(claudeCalls).toHaveLength(3);
		expect(claudeCalls[1].messages.at(-1).content).toContain("NOTHING has been booked");
		expect(await jobs()).toHaveLength(0);
		expect(data.form.session_type_id).toBe(RAP);
	});

	it("in the chat: a correction replaces a false claim", async () => {
		claudeReplies.push(text("All booked for Tuesday!"), text("Before I book it, which session is it for?"));
		const data = await chat("book me in tuesday 2pm");
		expect(data.reply).toBe("Before I book it, which session is it for?");
		expect(await jobs()).toHaveLength(0);
	});

	it("in the chat: never says it's booked if Claude fails after trying book_session on the website", async () => {
		claudeReplies.push(toolCall("book_session", { session_type_id: RAP, date: openDay(), time: "14:00", ...SAM }));
		const data = await chat("yes, book it");
		expect(data.reply).not.toMatch(/being booked/);
		expect(await jobs()).toHaveLength(0);
	});

	it("in the chat: doesn't offer booking for them while Nova Agent is rehearsing", async () => {
		await agentNova({ mode: "rehearsal" });
		claudeReplies.push(text("Here's the link."));
		await chat("book me in");
		expect(claudeCalls[0].tools.map((tool) => tool.name)).not.toContain("book_session");
	});
});

it("tells NovaBot each session's total length, so '2 hours' finds the right one", async () => {
	const { sessionList, readSessionTypes } = await import("../src/booking.js");
	const list = sessionList(readSessionTypes(BOOKING_PAGE_HTML));
	expect(list).toContain("Rap Package - 1 song (1 hour recording with engineer + 1 hour mixing), 2 hours in total");
	expect(list).toContain("Rap Package - 2 songs (2 hours recording with engineer + 2 hours mixing), 4 hours in total");
});

// ----- The booking card -----

async function card(path, body, origin = "https://novacane.co.uk") {
	const ctx = createExecutionContext();
	const res = await worker.fetch(
		new Request(BASE + path, {
			method: "POST",
			headers: { "Content-Type": "application/json", Origin: origin, "CF-Connecting-IP": `198.51.100.${++ipNumber}` },
			body: JSON.stringify(body),
		}),
		env,
		ctx
	);
	await waitOnExecutionContext(ctx);
	return { status: res.status, data: await res.json() };
}

describe("The booking card", () => {
	it("NovaBot opens it filled in with what it knows, instead of asking one by one", async () => {
		const date = openDay();
		claudeReplies.push(
			toolCall("open_booking_form", { session_type_id: RAP, date, time: "2pm", first_name: "Sam" }),
			text("Your booking card is below: pick a time and press Book.")
		);
		const data = await chat("I want the rap package next week");
		expect(data.reply).toBe("Your booking card is below: pick a time and press Book.");
		expect(data.form.session_type_id).toBe(RAP);
		expect(data.form.date).toBe(date);
		expect(data.form.time).toBe("14:00");
		expect(data.form.first_name).toBe("Sam");
		expect(data.form.sessions.some((s) => s.id === RAP)).toBe(true);
		expect(claudeCalls[0].tools.map((t) => t.name)).toContain("open_booking_form");
		expect(claudeCalls[0].tools.map((t) => t.name)).not.toContain("book_session");
		expect(await jobs()).toHaveLength(0);
	});

	it("tells NovaBot to use the card when it asks for details in the chat", async () => {
		const date = openDay();
		claudeReplies.push(
			toolCall("check_availability", { session_type_id: RAP, from_date: date }),
			text("That day's free! What's your email and phone number?"),
			toolCall("open_booking_form", { session_type_id: RAP, date }),
			text("Your booking card is below.")
		);
		const data = await chat("rap package on " + date);
		expect(claudeCalls[2].messages.at(-1).content).toContain("Call open_booking_form now");
		expect(data.reply).toBe("Your booking card is below.");
		expect(data.form.date).toBe(date);
	});

	it("opens the card itself if NovaBot keeps asking", async () => {
		const date = openDay();
		claudeReplies.push(
			toolCall("check_availability", { session_type_id: RAP, from_date: date }),
			text("What's your email?"),
			text("And your phone number?")
		);
		const data = await chat("rap package on " + date);
		expect(data.form.session_type_id).toBe(RAP);
		expect(data.form.date).toBe(date);
		expect(data.reply).toContain("booking card is open below");
	});

	it("the Book a session button opens an empty card, or none when Nova Agent can't book", async () => {
		const { data } = await card("/booking-form/open", {});
		expect(data.form.sessions.length).toBeGreaterThan(0);
		expect(data.form.session_type_id).toBeNull();
		await agentNova({ mode: "rehearsal" });
		expect((await card("/booking-form/open", {})).data.form).toBeNull();
	});

	it("offers both choices, with each session's booking page for \"I'll book it myself\"", async () => {
		const { data } = await card("/booking-form/open", {});
		expect(data.form.choose).toBe(true);
		const rap = data.form.sessions.find((x) => x.id === RAP);
		expect(rap.page).toBe(`https://app.acuityscheduling.com/schedule.php?owner=18510650&appointmentType=${RAP}`);
	});

	it("shows the free start times for the day", async () => {
		const date = openDay();
		taken.add(`${date}T14:00`);
		const { status, data } = await card("/booking-form/times", { session_type_id: RAP, date });
		expect(status).toBe(200);
		expect(data.times[0]).toBe("10:00");
		expect(data.times).not.toContain("14:00");
	});

	it("never books for free: one press sends them to pay the deposit on Acuity, time and details filled in", async () => {
		const date = openDay();
		const { data } = await card("/booking-form/book", { chatId: "chat-card-0001", session_type_id: RAP, date, time: "14:00", ...SAM });
		expect(data.ok).toBe(true);
		expect(data.payFirst).toBe(true);
		expect(data.booked).toBeUndefined();
		expect(data.message).toContain("deposit");
		const pay = new URL(data.pay.url);
		expect(pay.hostname).toBe("app.acuityscheduling.com");
		expect(decodeURIComponent(pay.pathname)).toContain(`/appointment/${RAP}/calendar/3360708/datetime/${date}T14:00:00+01:00`);
		expect(pay.searchParams.get("firstName")).toBe("Sam");
		expect(pay.searchParams.get("email")).toBe("sam@example.com");
		expect(pay.searchParams.get("phone")).toBe("07700 900123");
		// Nothing handed to Nova Agent, nothing booked straight into Acuity
		expect(await jobs()).toHaveLength(0);
		expect(acuityBookings).toHaveLength(0);
	});

	it("says which box needs fixing, in words for the customer", async () => {
		const { data } = await card("/booking-form/book", { session_type_id: RAP, date: openDay(), time: "14:00", ...SAM, email: "nope" });
		expect(data.ok).toBe(false);
		expect(data.field).toBe("email");
		expect(data.message).toBe("That email address doesn't look right. Please check it.");
		expect(await jobs()).toHaveLength(0);
	});

	it("says when the time has just been taken", async () => {
		const date = openDay();
		taken.add(`${date}T14:00`);
		const { data } = await card("/booking-form/book", { session_type_id: RAP, date, time: "14:00", ...SAM });
		expect(data.ok).toBe(false);
		expect(data.field).toBe("time");
		expect(await jobs()).toHaveLength(0);
	});

	it("only works from the studio's website", async () => {
		const { status } = await card("/booking-form/book", { session_type_id: RAP, date: openDay(), time: "14:00", ...SAM }, "https://evil.example");
		expect(status).toBe(403);
	});
});

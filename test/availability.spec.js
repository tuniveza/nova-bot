import { createExecutionContext, env, waitOnExecutionContext } from "cloudflare:test";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import worker from "../src";
import {
	bookingLink,
	checkAvailability,
	makeBookingLink,
	normaliseTime,
	describeDay,
	describeTimes,
	forgetSessionTypes,
	readFreeTimes,
	ukToday,
	ukTodayInWords,
	upcomingDates,
} from "../src/booking.js";
import { BOOKING_PAGE_HTML } from "./acuity-page.js";

const BASE = "https://novacane-worker.test";
const TODAY = "2026-10-01"; // a Thursday

// ----- A fake Acuity calendar -----
// Open Monday to Saturday, start times 10:00 to 18:30 every 30 minutes,
// bookable from Monday 5 October (minimum notice), except:
const fullyBooked = new Set(["2026-10-07"]); // Wednesday 7th is full
let availabilityLookups = [];
let availabilityDown = false;
let availabilityAnswer = null; // override what the calendar answers

function addDays(ymd, n) {
	const d = new Date(ymd + "T00:00:00Z");
	d.setUTCDate(d.getUTCDate() + n);
	return d.toISOString().slice(0, 10);
}

function fakeFreeTimes(startDate, maxDays) {
	const days = {};
	let day = startDate < "2026-10-05" ? "2026-10-05" : startDate;
	for (let i = 0; Object.keys(days).length < maxDays && i < 60; i++, day = addDays(day, 1)) {
		if (new Date(day + "T00:00:00Z").getUTCDay() === 0 || fullyBooked.has(day) || day > "2026-12-31") continue;
		const slots = [];
		for (let m = 600; m <= 1110; m += 30) {
			const hh = String(Math.floor(m / 60)).padStart(2, "0");
			slots.push({ time: `${day}T${hh}:${String(m % 60).padStart(2, "0")}:00+0100`, slotsAvailable: 1 });
		}
		days[day] = slots;
	}
	return days;
}

let claudeReplies = [];
let claudeCalls = [];

beforeEach(() => {
	availabilityLookups = [];
	availabilityDown = false;
	availabilityAnswer = null;
	claudeReplies = [];
	claudeCalls = [];
	forgetSessionTypes();
	vi.spyOn(globalThis, "fetch").mockImplementation(async (url, init) => {
		const u = new URL(String(url));
		if (u.pathname === "/schedule.php") return new Response(BOOKING_PAGE_HTML);
		if (u.pathname === "/api/scheduling/v1/availability/times") {
			availabilityLookups.push(Object.fromEntries(u.searchParams));
			if (availabilityDown) return new Response('{"status_code":503}', { status: 503 });
			if (availabilityAnswer) return new Response(JSON.stringify(availabilityAnswer));
			return new Response(JSON.stringify(fakeFreeTimes(u.searchParams.get("startDate"), Number(u.searchParams.get("maxDays")))));
		}
		if (String(url) === "https://api.anthropic.com/v1/messages") {
			claudeCalls.push(JSON.parse(init.body));
			const next = claudeReplies.shift();
			return next ? new Response(JSON.stringify(next)) : new Response("overloaded", { status: 529 });
		}
		throw new Error("Unexpected fetch in test: " + url);
	});
});

afterEach(() => {
	vi.restoreAllMocks();
});

const check = (input, today = TODAY) => checkAvailability("18510650", input, today);

// ----- Reading Acuity's answer -----

describe("reading free times", () => {
	it("keeps free start times, sorted, by day", () => {
		expect(
			readFreeTimes({
				"2026-10-05": [
					{ time: "2026-10-05T11:00:00+0100", slotsAvailable: 1 },
					{ time: "2026-10-05T10:00:00+0100", slotsAvailable: 1 },
					{ time: "2026-10-05T12:00:00+0100", slotsAvailable: 0 },
				],
				"2026-10-06": [],
			})
		).toEqual({ "2026-10-05": ["10:00", "11:00"] });
	});

	it("refuses anything that isn't the expected shape", () => {
		for (const bad of [null, [], "text", { notadate: [] }, { "2026-10-05": "x" }, { "2026-10-05": [{ time: "2026-10-06T10:00" }] }, { "2026-10-05": [{ time: "garbage" }] }]) {
			expect(() => readFreeTimes(bad)).toThrow(/expected shape/);
		}
	});

	it("describes even times as a range, and uneven ones as a list", () => {
		expect(describeTimes(["10:00", "10:30", "11:00", "11:30"])).toBe("10:00 to 11:30 (every 30 minutes)");
		expect(describeTimes(["10:00", "13:00", "13:30"])).toBe("10:00, 13:00, 13:30");
		expect(describeTimes(["14:00"])).toBe("14:00");
	});

	it("works out when a session would finish", () => {
		// Saturday 10 October for a 4-hour hire: starts up to 14:00 include the afternoon
		expect(describeDay(["10:00", "10:30", "11:00", "11:30", "12:00", "12:30", "13:00", "13:30", "14:00"], 240)).toBe(
			"morning: starts 10:00 to 11:30 (every 30 minutes), finishing 14:00 to 15:30; afternoon: starts 12:00 to 14:00 (every 30 minutes), finishing 16:00 to 18:00; evening: none"
		);
		expect(describeDay(["21:30"], 60)).toBe("morning: none; afternoon: none; evening: starts 21:30, finishing 22:30");
	});

	it("lists the coming weeks with their weekdays", () => {
		expect(upcomingDates("2026-10-01", 3)).toBe("Thursday 1 October (today), Friday 2 October, Saturday 3 October");
		expect(upcomingDates("2026-10-01").split(", ")).toHaveLength(21);
	});

	it("knows today's date in the UK", () => {
		expect(ukToday(new Date("2026-10-01T23:30:00Z"))).toBe("2026-10-02"); // past midnight in London (BST)
		expect(ukTodayInWords(new Date("2026-10-01T12:00:00Z"))).toBe("Thursday 1 October 2026");
	});
});

// ----- Checking free times -----

describe("check_availability", () => {
	it("lists free start times in the range, using the public calendar only", async () => {
		const result = await check({ session_type_id: 64806309, from_date: "2026-10-05", to_date: "2026-10-09" });
		expect(result.ok).toBe(true);
		expect(result.message).toContain("Rap Package - 2 songs (2 hours recording with engineer + 2 hours mixing) (4 hours)");
		expect(result.message).toContain(
			"- Monday 5 October: morning: starts 10:00 to 11:30 (every 30 minutes), finishing 14:00 to 15:30; afternoon: starts 12:00 to 16:30 (every 30 minutes), finishing 16:00 to 20:30; evening: starts 17:00 to 18:30 (every 30 minutes), finishing 21:00 to 22:30"
		);
		expect(result.message).toContain("- Friday 9 October: morning: starts 10:00");
		expect(result.message).toContain("These are the times the session can START");
		expect(result.message).not.toContain("Wednesday 7 October"); // fully booked
		expect(result.message).toContain("aren't listed have no free times");
		expect(result.message).toMatch(/show as free right now\. Never promise or hold a time/);
		expect(result.url).toBe("https://app.acuityscheduling.com/schedule.php?owner=18510650&appointmentType=64806309");
		expect(availabilityLookups[0]).toEqual({
			owner: "abc123",
			appointmentTypeId: "64806309",
			calendarId: "3360708",
			startDate: "2026-10-05",
			maxDays: "5",
			timezone: "Europe/London",
		});
	});

	it("chains lookups to cover two weeks (Acuity answers 5 free days at a time)", async () => {
		const result = await check({ session_type_id: 64806309, from_date: "2026-10-05", to_date: "2026-10-18" });
		expect(availabilityLookups.map((l) => l.startDate)).toEqual(["2026-10-05", "2026-10-11", "2026-10-17"]);
		expect(result.message).toContain("Saturday 17 October");
		expect(result.message).not.toContain("Monday 19 October"); // outside the range
	});

	it("never looks back in time, too far ahead, or more than 14 days", async () => {
		let result = await check({ session_type_id: 64806309, from_date: "2026-09-01", to_date: "2026-09-03" });
		expect(availabilityLookups[0].startDate).toBe(TODAY); // from today instead
		expect(result.message).toMatch(/Thursday 1 October to Wednesday 7 October/);

		result = await check({ session_type_id: 64806309, from_date: "2027-06-01" });
		expect(result).toMatchObject({ ok: false });
		expect(result.message).toMatch(/too far ahead/);

		result = await check({ session_type_id: 64806309, from_date: "2026-10-05", to_date: "2026-12-31" });
		expect(result.message).toMatch(/Monday 5 October to Sunday 18 October/);

		result = await check({ session_type_id: 64806309, from_date: "next tuesday", to_date: "soon" });
		expect(result.message).toMatch(/Thursday 1 October to Wednesday 7 October/); // nonsense dates -> this week
	});

	it("only checks sessions on the list", async () => {
		for (const id of [99999901, 99999902, 123, "64806309; drop"]) {
			expect(await check({ session_type_id: id })).toMatchObject({ ok: false });
		}
		expect(availabilityLookups).toHaveLength(0);
	});

	it("says clearly when nothing is free", async () => {
		const result = await check({ session_type_id: 64806309, from_date: "2026-10-07", to_date: "2026-10-07" });
		expect(result.message).toMatch(/^No free start times for Rap Package - 2 songs/);
		expect(result.message).toMatch(/booked up, the studio is closed, or the calendar doesn't take bookings that far ahead/);
	});

	it("remembers a lookup for 2 minutes, so Acuity isn't asked again and again", async () => {
		await check({ session_type_id: 64806309, from_date: "2026-10-05", to_date: "2026-10-09" });
		await check({ session_type_id: 64806309, from_date: "2026-10-05", to_date: "2026-10-09" });
		expect(availabilityLookups).toHaveLength(1);
	});

	it("fills in the customer's details on the booking link", async () => {
		const result = await check({ session_type_id: 12738216, first_name: "Jo", email: "jo@example.com" });
		expect(result.url).toBe("https://app.acuityscheduling.com/schedule.php?owner=18510650&appointmentType=12738216&firstName=Jo&email=jo%40example.com");
	});

	it("fails safely if the calendar is down or answers something unexpected", async () => {
		availabilityDown = true;
		await expect(check({ session_type_id: 64806309 })).rejects.toThrow(/503/);
		availabilityDown = false;
		forgetSessionTypes();
		availabilityAnswer = { error: "changed" };
		await expect(check({ session_type_id: 64806309 })).rejects.toThrow(/expected shape/);
	});
});

// ----- In the chat -----

let ip = 0;
async function chat(words) {
	const ctx = createExecutionContext();
	const res = await worker.fetch(
		new Request(BASE, {
			method: "POST",
			headers: { "Content-Type": "application/json", Origin: "https://novacane.co.uk", "CF-Connecting-IP": `198.18.0.${++ip}` },
			body: JSON.stringify({ messages: [{ role: "user", content: words }], chatId: "chat-avail-0001" }),
		}),
		env,
		ctx
	);
	await waitOnExecutionContext(ctx);
	return (await res.json()).reply;
}

const toolCall = (input) => ({ stop_reason: "tool_use", content: [{ type: "tool_use", id: "toolu_av", name: "check_availability", input }] });
const text = (words) => ({ stop_reason: "end_turn", content: [{ type: "text", text: words }] });

describe("NovaBot and free times", () => {
	it("tells Claude today's date and offers the tool", async () => {
		claudeReplies.push(text("Hi"));
		await chat("hello");
		expect(claudeCalls[0].tools.map((t) => t.name)).toContain("check_availability");
		expect(claudeCalls[0].system.at(-1).text).toContain(`TODAY is ${ukTodayInWords()} (UK time).`);
		expect(claudeCalls[0].system.at(-1).text).toContain(`Dates for the next three weeks: ${upcomingDates()}.`);
	});

	it("passes the free times to Claude and keeps the booking link it gives", async () => {
		const from = ukToday();
		claudeReplies.push(toolCall({ session_type_id: 64806309, from_date: from }));
		claudeReplies.push(text("Monday shows as free right now from 10:00. Book here: https://app.acuityscheduling.com/schedule.php?owner=18510650&appointmentType=64806309"));
		const reply = await chat("Is Monday free for 2 rap songs?");
		const result = claudeCalls[1].messages.at(-1).content[0];
		expect(result).toMatchObject({ type: "tool_result", is_error: false });
		expect(result.content).toContain("show as free right now");
		// The link came from the tool, so it's left exactly as it is (not "fixed")
		expect(reply).toBe("Monday shows as free right now from 10:00. Book here: https://app.acuityscheduling.com/schedule.php?owner=18510650&appointmentType=64806309");
	});

	it("tells Claude not to say what's free if the calendar can't be checked", async () => {
		availabilityDown = true;
		claudeReplies.push(toolCall({ session_type_id: 64806309 }), text("I couldn't check just now, but you can see the free times on the calendar."));
		await chat("When's your next free slot?");
		const result = claudeCalls[1].messages.at(-1).content[0];
		expect(result).toMatchObject({ is_error: true });
		expect(result.content).toMatch(/Don't say whether anything is free/);
	});
});

// ----- Links with the time already selected -----

describe("booking links with a time selected", () => {
	const link = (input, today = TODAY) => makeBookingLink("18510650", input, today);

	it("understands the usual ways of writing a time", () => {
		const cases = { "2pm": "14:00", "14:00": "14:00", "14.30": "14:30", "1430": "14:30", "9:30am": "09:30", "12pm": "12:00", "12am": "00:00", "10": "10:00" };
		for (const [given, expected] of Object.entries(cases)) expect(normaliseTime(given)).toBe(expected);
		for (const bad of ["", "soon", "25:00", "14:75", "2 o'clock"]) expect(normaliseTime(bad)).toBe("");
	});

	it("builds the address Acuity uses for a chosen time, summer and winter", () => {
		const at = { ownerKey: "abc123", calendarId: 3360708 };
		expect(bookingLink("18510650", 64806309, { firstName: "Sam" }, { ...at, time: "2026-10-06T14:00:00+0100" })).toBe(
			"https://app.acuityscheduling.com/schedule/abc123/appointment/64806309/calendar/3360708/datetime/2026-10-06T14%3A00%3A00%2B01%3A00?appointmentTypeIds%5B%5D=64806309&firstName=Sam"
		);
		expect(bookingLink("18510650", 64806309, {}, { ...at, time: "2026-11-03T14:00:00+0000" })).toContain("/datetime/2026-11-03T14%3A00%3A00%2B00%3A00?");
	});

	it("selects the time if it shows as free", async () => {
		const result = await link({ session_type_id: 64806309, date: "2026-10-06", time: "2pm", first_name: "Sam" });
		expect(result.ok).toBe(true);
		expect(result.url).toBe(
			"https://app.acuityscheduling.com/schedule/abc123/appointment/64806309/calendar/3360708/datetime/2026-10-06T14%3A00%3A00%2B01%3A00?appointmentTypeIds%5B%5D=64806309&firstName=Sam"
		);
		expect(result.message).toMatch(/Tuesday 6 October at 14:00 shows as free right now/);
		expect(result.message).toMatch(/isn't held until they do/);
	});

	it("doesn't select a time that isn't free, and offers the free ones", async () => {
		let result = await link({ session_type_id: 64806309, date: "2026-10-06", time: "20:00" });
		expect(result.ok).toBe(false);
		expect(result.message).toMatch(/Tuesday 6 October at 20:00 isn't showing as free/);
		expect(result.message).toContain("Free start times that day: morning: starts 10:00");
		expect(result.url).toBe("https://app.acuityscheduling.com/schedule.php?owner=18510650&appointmentType=64806309");

		result = await link({ session_type_id: 64806309, date: "2026-10-07", time: "14:00" }); // fully booked day
		expect(result.message).toMatch(/Nothing shows as free that day/);
		// Real alternatives: the nearest days with free times, either side
		expect(result.message).toContain("Nearest days with free times (start times):");
		expect(result.message).toContain("- Monday 5 October: morning: starts 10:00");
		expect(result.message).toContain("- Tuesday 6 October:");
		expect(result.message).toContain("- Thursday 8 October:");
		expect(result.message).not.toContain("- Friday 9 October:");
		expect(result.message).toMatch(/offer alternatives ONLY from the free times listed here/);

		result = await link({ session_type_id: 64806309, date: "2026-10-04", time: "14:00" }); // a Sunday, closed
		expect(result.ok).toBe(false);
	});

	it("refuses past, far-off or unreadable dates and times", async () => {
		expect((await link({ session_type_id: 64806309, date: "2026-09-30", time: "14:00" })).message).toMatch(/in the past or too far ahead/);
		expect((await link({ session_type_id: 64806309, date: "2027-09-30", time: "14:00" })).message).toMatch(/in the past or too far ahead/);
		expect((await link({ session_type_id: 64806309, date: "next tuesday", time: "14:00" })).message).toMatch(/YYYY-MM-DD/);
		expect((await link({ session_type_id: 64806309, date: "2026-10-06", time: "afternoon" })).message).toMatch(/HH:MM/);
		expect(availabilityLookups).toHaveLength(0);
	});

	it("gives the plain link (and says it couldn't check) if the calendar is down", async () => {
		availabilityDown = true;
		const result = await link({ session_type_id: 64806309, date: "2026-10-06", time: "14:00" });
		expect(result.ok).toBe(true);
		expect(result.url).toBe("https://app.acuityscheduling.com/schedule.php?owner=18510650&appointmentType=64806309");
		expect(result.message).toMatch(/don't say whether it's free/);
	});

	it("in the chat: the selected-time link reaches the visitor untouched", async () => {
		const day = ukToday();
		// Pick a day that the fake calendar has open (from Monday 5 October, not Sunday)
		const open = fakeFreeTimes(day, 1);
		const date = Object.keys(open)[0];
		claudeReplies.push(
			{ stop_reason: "tool_use", content: [{ type: "tool_use", id: "toolu_bk", name: "booking_link", input: { session_type_id: 64806309, date, time: "14:00" } }] },
			text("Done, the link has 14:00 selected.")
		);
		const reply = await chat("2pm works for me, 2 rap songs");
		expect(reply).toMatch(/^Done, the link has 14:00 selected\.\n\nhttps:\/\/app\.acuityscheduling\.com\/schedule\/abc123\/appointment\/64806309\/calendar\/3360708\/datetime\//);
	});

	it("in the chat: the plain link given after a taken time isn't treated as made up", async () => {
		claudeReplies.push(
			{ stop_reason: "tool_use", content: [{ type: "tool_use", id: "toolu_bk", name: "booking_link", input: { session_type_id: 64806309, date: "2026-10-07", time: "14:00" } }] },
			text("14:00 on Wednesday isn't free. You can pick another time here: https://app.acuityscheduling.com/schedule.php?owner=18510650&appointmentType=64806309")
		);
		const reply = await chat("Wednesday 7th at 2pm please");
		expect(reply).toBe("14:00 on Wednesday isn't free. You can pick another time here: https://app.acuityscheduling.com/schedule.php?owner=18510650&appointmentType=64806309");
	});
});

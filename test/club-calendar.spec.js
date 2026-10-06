import { env } from "cloudflare:test";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import worker from "../src";
import { calendarChanged, feedTimes } from "../src/club-calendar.js";

const BASE = "https://novacane-worker.test";
const FEED = "https://acuity.test/feed.ics";
const WITH_FEED = { ...env, ACUITY_CALENDAR_URL: FEED };

// One event in Acuity's calendar feed
const event = (uid, start, end, extra = "") =>
	`BEGIN:VEVENT\r\nUID:${uid}\r\nSUMMARY:Secret Name: Rap Package\r\nDTSTART:${start}\r\nDTEND:${end}\r\n${extra}END:VEVENT\r\n`;
const feed = (...events) => `BEGIN:VCALENDAR\r\nVERSION:2.0\r\n${events.join("")}END:VCALENDAR\r\n`;

// What the feed says, and how many times it was read
let ics;
let reads;

beforeEach(async () => {
	reads = 0;
	ics = feed(
		event("1001@scheduling", "20261023T120000Z", "20261023T160000Z"),
		// A blocked-off time (no booking number), in UK time
		event("block-9@scheduling", "20261024T100000", "20261024T120000"),
		// Outside the dates asked for
		event("1002@scheduling", "20261201T100000Z", "20261201T120000Z")
	);
	vi.spyOn(globalThis, "fetch").mockImplementation(async (url) => {
		if (String(url) !== FEED) throw new Error("Unexpected fetch in test: " + url);
		reads++;
		return new Response(ics);
	});
	await env.DB.prepare("DELETE FROM club_calendar").run();
});

afterEach(() => {
	vi.restoreAllMocks();
});

async function busy(query = "from=2026-10-01&until=2026-11-01", e = WITH_FEED) {
	const res = await worker.fetch(new Request(`${BASE}/club/busy?${query}`), e, {});
	return { status: res.status, data: await res.json() };
}

describe("Nova Club calendar", () => {
	it("gives bookings and blocked-off time in those dates, as times only", async () => {
		const { status, data } = await busy();
		expect(status).toBe(200);
		expect(data.busy).toEqual([
			[Date.parse("2026-10-23T12:00:00Z"), Date.parse("2026-10-23T16:00:00Z")],
			[Date.parse("2026-10-24T09:00:00Z"), Date.parse("2026-10-24T11:00:00Z")],
		]);
		expect(data.cancelled).toEqual([]);
		expect(JSON.stringify(data)).not.toContain("Secret");
	});

	it("reuses its copy until Acuity says something changed", async () => {
		await busy();
		await busy();
		expect(reads).toBe(1);

		ics = feed();
		await calendarChanged(env);
		const { data } = await busy();
		expect(reads).toBe(2);
		expect(data.busy).toEqual([]);
		// Both times just came free
		expect(data.cancelled).toHaveLength(2);
	});

	it("marks the copy out of date when Acuity's webhook arrives", async () => {
		await busy();
		const form = new URLSearchParams({ action: "canceled", id: "1001", appointmentTypeID: "5" });
		const res = await worker.fetch(
			new Request(`${BASE}/acuity/webhook?key=hook`, { method: "POST", body: form, headers: { "Content-Type": "application/x-www-form-urlencoded" } }),
			{ ...env, ACUITY_WEBHOOK_KEY: "hook" },
			{ waitUntil() {} }
		);
		expect(res.status).toBe(200);
		await busy();
		expect(reads).toBe(2);
	});

	it("reports a moved booking's old time as cancelled, for an hour", async () => {
		await busy();
		ics = feed(event("1001@scheduling", "20261023T140000Z", "20261023T180000Z"));
		await calendarChanged(env);
		const oldTime = [Date.parse("2026-10-23T12:00:00Z"), Date.parse("2026-10-23T16:00:00Z")];
		const { data } = await busy();
		expect(data.busy).toEqual([[Date.parse("2026-10-23T14:00:00Z"), Date.parse("2026-10-23T18:00:00Z")]]);
		expect(data.cancelled).toContainEqual(oldTime);

		// Still reported on the next refresh
		await calendarChanged(env);
		expect((await busy()).data.cancelled).toContainEqual(oldTime);

		// Booked again: no longer reported as free
		ics = feed(event("1003@scheduling", "20261023T120000Z", "20261023T160000Z"));
		await calendarChanged(env);
		expect((await busy()).data.cancelled).not.toContainEqual(oldTime);
	});

	it("keeps the last copy if the feed can't be read, and doesn't keep retrying", async () => {
		await busy();
		await calendarChanged(env);
		globalThis.fetch.mockImplementation(async () => {
			reads++;
			return new Response("down", { status: 500 });
		});
		const { status, data } = await busy();
		expect(status).toBe(200);
		expect(data.busy).toHaveLength(2);
		await busy();
		expect(reads).toBe(2);
	});

	it("refuses bad dates and missing setup", async () => {
		expect((await busy("from=2026-10-01&until=2027-10-01")).status).toBe(400);
		expect((await busy("from=nope&until=2026-11-01")).status).toBe(400);
		expect((await busy(undefined, { ...env, ACUITY_CALENDAR_URL: "" })).status).toBe(503);
	});

	it("reads the feed's kinds of time", () => {
		const times = feedTimes(
			feed(
				event("1@scheduling", "20261023T120000Z", "20261023T160000Z"),
				// Summer (UK is an hour ahead) and winter (same as UTC)
				event("2@scheduling;", "20261023T130000", "20261023T140000").replace("DTSTART:", "DTSTART;TZID=Europe/London:"),
				event("3@scheduling", "20261201T100000", "20261201T110000"),
				// A whole day, folded over two lines
				event("4@scheduling", "20261202", "2026120\r\n 3"),
				event("5@scheduling", "20261204T100000Z", "20261204T110000Z", "STATUS:CANCELLED\r\n")
			)
		);
		expect(times).toEqual([
			[Date.parse("2026-10-23T12:00:00Z"), Date.parse("2026-10-23T16:00:00Z")],
			[Date.parse("2026-10-23T12:00:00Z"), Date.parse("2026-10-23T13:00:00Z")],
			[Date.parse("2026-12-01T10:00:00Z"), Date.parse("2026-12-01T11:00:00Z")],
			[Date.parse("2026-12-02T00:00:00Z"), Date.parse("2026-12-03T00:00:00Z")],
		]);
	});
});

// The Alerts tab: what kind each alert is, and checking a booking with Acuity
// so staff can tell a real booking from a test or a fake.
import { env } from "cloudflare:test";
import { afterEach, describe, expect, it, vi } from "vitest";
import { alertKind, verifyBooking } from "../src/push.js";

const ACUITY = { ACUITY_USER_ID: "1", ACUITY_API_KEY: "k" };
const answer = (status, body) => vi.spyOn(globalThis, "fetch").mockImplementation(async () => new Response(JSON.stringify(body), { status }));

afterEach(() => vi.restoreAllMocks());

describe("what kind of alert it is", () => {
	const a = (o) => ({ title: "", url: "/app/", appointment_id: null, enquiry_id: null, ...o });
	it("labels each source", () => {
		expect(alertKind(a({ title: "New booking: Dana", appointment_id: 5, url: "https://secure.acuityscheduling.com/" }))).toBe("booking");
		expect(alertKind(a({ title: "New booking: Dana", appointment_id: 5, url: "https://calendar.google.com/" }))).toBe("nova-booking");
		expect(alertKind(a({ title: "Nova Quest: Up next" }))).toBe("quest");
		expect(alertKind(a({ title: "Nova Mission: Mission planned" }))).toBe("mission");
		expect(alertKind(a({ title: "Nova Agent: Can't log in" }))).toBe("agent");
		expect(alertKind(a({ title: "New enquiry: Mixing", enquiry_id: "e1" }))).toBe("enquiry");
		expect(alertKind(a({ title: "Nova Mission: Test ✦ Nova Hub pings are live" }))).toBe("mission");
		expect(alertKind(a({ title: "Test booking", appointment_id: 5 }))).toBe("test");
	});
});

describe("checking a booking with Acuity", () => {
	it("confirms a real booking, with when it was made and what's been paid", async () => {
		answer(200, { id: 123, firstName: "Dana", lastName: "Hollis", email: "d@x.com", type: "Vocal Recording", datetime: "2026-10-08T14:00:00+0100", datetimeCreated: "2026-10-06T20:14:00+0100", price: "80.00", amountPaid: "20.00", paid: "no", canceled: false });
		const r = await verifyBooking({ ...env, ...ACUITY }, 123);
		expect(r.status).toBe("real");
		expect(r.lines.join("\n")).toContain("Acuity #123");
		expect(r.lines.join("\n")).toContain("Booked Tue 6 Oct");
		expect(r.lines.join("\n")).toContain("Deposit £20.00 of £80.00 paid");
	});
	it("says when it's been cancelled", async () => {
		answer(200, { id: 9, canceled: true, price: "80.00", amountPaid: "0" });
		expect((await verifyBooking({ ...env, ...ACUITY }, 9)).status).toBe("cancelled");
	});
	it("says when Acuity has never heard of it", async () => {
		answer(404, { status_code: 404 });
		const r = await verifyBooking({ ...env, ...ACUITY }, 999);
		expect(r.status).toBe("missing");
		expect(r.title).toBe("Not found in Acuity");
	});
	it("never asks Acuity about something that isn't a booking number", async () => {
		const spy = answer(200, {});
		expect((await verifyBooking({ ...env, ...ACUITY }, "1;DROP")).status).toBe("unknown");
		expect(spy).not.toHaveBeenCalled();
	});
});

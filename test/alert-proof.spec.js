// The Alerts tab: what kind each alert is.
import { describe, expect, it } from "vitest";
import { alertKind } from "../src/push.js";

describe("what kind of alert it is", () => {
	const a = (o) => ({ title: "", url: "/app/", appointment_id: null, enquiry_id: null, ...o });
	it("labels each source", () => {
		expect(alertKind(a({ title: "New booking: Dana", appointment_id: 5, url: "https://calendar.google.com/" }))).toBe("nova-booking");
		expect(alertKind(a({ title: "Booking moved: Dana", appointment_id: 5, url: "/portal/" }))).toBe("nova-booking");
		// An old alert from Acuity's days is a booking too (Acuity isn't asked about it any more)
		expect(alertKind(a({ title: "New booking: Dana", appointment_id: 1782089433, url: "https://secure.acuityscheduling.com/" }))).toBe("nova-booking");
		expect(alertKind(a({ title: "Bookings need attention" }))).toBe("health");
		expect(alertKind(a({ title: "Quest: Up next" }))).toBe("quest");
		// An old alert from before Missions went counts as a quest's
		expect(alertKind(a({ title: "Mission: Mission planned" }))).toBe("quest");
		expect(alertKind(a({ title: "Nova Agent: Can't log in" }))).toBe("agent");
		expect(alertKind(a({ title: "New enquiry: Mixing", enquiry_id: "e1" }))).toBe("enquiry");
		expect(alertKind(a({ title: "Mission: Test ✦ Portal pings are live" }))).toBe("quest");
		expect(alertKind(a({ title: "Test booking", appointment_id: 5 }))).toBe("test");
	});
});

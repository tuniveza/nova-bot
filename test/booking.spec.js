import { createExecutionContext, env, waitOnExecutionContext } from "cloudflare:test";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import worker from "../src";
import { bookingLink, forgetSessionTypes, readSessionTypes } from "../src/booking.js";
import { BOOKING_PAGE_HTML } from "./acuity-page.js";

const BASE = "https://novacane-worker.test";

let claudeReplies = [];
let claudeCalls = [];
let bookingPageUp = true;
let bookingPageFetches = 0;

beforeEach(async () => {
	claudeReplies = [];
	claudeCalls = [];
	bookingPageUp = true;
	bookingPageFetches = 0;
	forgetSessionTypes();
	vi.spyOn(globalThis, "fetch").mockImplementation(async (url, init) => {
		if (String(url).startsWith("https://app.acuityscheduling.com/schedule.php?owner=18510650")) {
			bookingPageFetches++;
			return bookingPageUp ? new Response(BOOKING_PAGE_HTML) : new Response("down", { status: 503 });
		}
		if (String(url) === "https://api.anthropic.com/v1/messages") {
			claudeCalls.push(JSON.parse(init.body));
			const next = claudeReplies.shift();
			return next ? new Response(JSON.stringify(next)) : new Response("overloaded", { status: 529 });
		}
		throw new Error("Unexpected fetch in test: " + url);
	});
	await env.DB.prepare("DELETE FROM enquiries").run();
});

afterEach(() => {
	vi.restoreAllMocks();
});

let ipNumber = 0;
async function chat(words) {
	const ctx = createExecutionContext();
	const res = await worker.fetch(
		new Request(BASE, {
			method: "POST",
			headers: { "Content-Type": "application/json", Origin: "https://novacane.co.uk", "CF-Connecting-IP": `192.0.2.${++ipNumber}` },
			body: JSON.stringify({ messages: [{ role: "user", content: words }], chatId: "chat-booking-01" }),
		}),
		env,
		ctx
	);
	await waitOnExecutionContext(ctx);
	return (await res.json()).reply;
}

const linkCall = (input) => ({
	stop_reason: "tool_use",
	content: [{ type: "tool_use", id: "toolu_link", name: "booking_link", input }],
});
const text = (words) => ({ stop_reason: "end_turn", content: [{ type: "text", text: words }] });

describe("reading the session types", () => {
	it("keeps bookable sessions and skips private and inactive ones", () => {
		expect(readSessionTypes(BOOKING_PAGE_HTML)).toEqual([
			{ id: 11846136, name: "Rap Package - 1 song (1 hour recording with engineer + 1 hour mixing)", price: "£100.00", duration: 120, calendarIds: [3360708] },
			{ id: 64806309, name: "Rap Package - 2 songs (2 hours recording with engineer + 2 hours mixing)", price: "£200.00", duration: 240, calendarIds: [3360708] },
			{ id: 12738216, name: "Voiceover Recording with Engineer - 1 hour", price: "£80.00", duration: 60, calendarIds: [3360708] },
		]);
	});

	it("copes with a page it doesn't recognise", () => {
		expect(readSessionTypes("<html>nothing here</html>")).toEqual([]);
		expect(readSessionTypes("var BUSINESS = {broken")).toEqual([]);
	});
});

describe("booking links", () => {
	it("open one session with the client's details filled in", () => {
		const url = new URL(bookingLink("18510650", 64806309, { name: "Sam  de la Cruz", email: "sam+test@example.com", phone: "07700 900123" }));
		expect(url.origin + url.pathname).toBe("https://app.acuityscheduling.com/schedule.php");
		expect(Object.fromEntries(url.searchParams)).toEqual({
			owner: "18510650",
			appointmentType: "64806309",
			firstName: "Sam",
			lastName: "de la Cruz",
			email: "sam+test@example.com",
			phone: "07700 900123",
		});
	});

	it("leave out details they don't have", () => {
		expect(bookingLink("18510650", 11846136)).toBe("https://app.acuityscheduling.com/schedule.php?owner=18510650&appointmentType=11846136");
	});
});

describe("NovaBot booking links", () => {
	it("gives Claude the live session list", async () => {
		claudeReplies.push(text("We do rap and singer packages."));
		await chat("What can I book?");
		const system = claudeCalls[0].system.map((block) => block.text).join("\n");
		expect(system).toContain("- 64806309: Rap Package - 2 songs");
		expect(system).not.toContain("Secret test session");
		expect(system).not.toContain("Old package");
	});

	it("makes the link and includes it in the reply", async () => {
		const url =
			"https://app.acuityscheduling.com/schedule.php?owner=18510650&appointmentType=64806309&firstName=Sam&email=sam%40example.com";
		claudeReplies.push(linkCall({ session_type_id: 64806309, first_name: "Sam", email: "sam@example.com" }), text(`Here you go: ${url}`));
		const reply = await chat("I'm a rapper, I want to record 2 songs. I'm Sam, sam@example.com");
		expect(reply).toBe(`Here you go: ${url}`);
		const result = claudeCalls[1].messages.at(-1).content[0];
		expect(result).toMatchObject({ type: "tool_result", is_error: false });
		expect(result.content).toContain(url);
	});

	it("adds the link if Claude forgets to include it", async () => {
		claudeReplies.push(linkCall({ session_type_id: 11846136 }), text("I've made you a link, pick a time on the calendar."));
		const reply = await chat("Book me 1 rap song");
		expect(reply).toBe(
			"I've made you a link, pick a time on the calendar.\n\nhttps://app.acuityscheduling.com/schedule.php?owner=18510650&appointmentType=11846136"
		);
	});

	it("still gives the link if Claude fails afterwards", async () => {
		claudeReplies.push(linkCall({ session_type_id: 11846136 })); // then Claude is down
		const reply = await chat("Book me 1 rap song");
		expect(reply).toContain("appointmentType=11846136");
		expect(reply).toMatch(/^Here's the link to book it/);
	});

	it("replaces a link Claude made up with the real one for that session", async () => {
		claudeReplies.push(text("Here's the link for the 2-song Rap Package: https://novacane.co.uk/bookings?session_type_id=64806309. Pick a time!"));
		const reply = await chat("I'm a rapper, 2 songs");
		expect(reply).toBe(
			"Here's the link for the 2-song Rap Package: https://app.acuityscheduling.com/schedule.php?owner=18510650&appointmentType=64806309. Pick a time!"
		);
	});

	it("keeps the details from a made-up Acuity link, but rebuilds it properly", async () => {
		claudeReplies.push(text("Book here: https://app.acuityscheduling.com/schedule.php?appointmentType=12738216&firstName=Jo&email=jo@example.com&owner=1"));
		const reply = await chat("voiceover please");
		expect(reply).toBe(
			"Book here: https://app.acuityscheduling.com/schedule.php?owner=18510650&appointmentType=12738216&firstName=Jo&email=jo%40example.com"
		);
	});

	it("sends any other made-up link to the booking page, and leaves real ones alone", async () => {
		claudeReplies.push(
			text(
				"Try https://novacane.co.uk/book-now, or the form at https://novacane.co.uk/bookings-contact#enquiry, or WhatsApp https://wa.me/447510108566."
			)
		);
		const reply = await chat("how do I book?");
		expect(reply).toBe(
			"Try https://novacane.co.uk/bookings-contact, or the form at https://novacane.co.uk/bookings-contact#enquiry, or WhatsApp https://wa.me/447510108566."
		);
	});

	it("refuses a session that isn't on the list", async () => {
		claudeReplies.push(linkCall({ session_type_id: 99999901 }), text("Let me check which session suits you."));
		const reply = await chat("Book the secret session");
		expect(claudeCalls[1].messages.at(-1).content[0]).toMatchObject({ is_error: true });
		expect(reply).not.toContain("schedule.php");
	});

	it("falls back to the booking page if Acuity's page can't be read", async () => {
		bookingPageUp = false;
		claudeReplies.push(text("You can book here: https://novacane.co.uk/bookings-contact"));
		const reply = await chat("How do I book?");
		expect(reply).toContain("bookings-contact");
		expect(claudeCalls[0].system[1].text).toMatch(/isn't available right now/);
	});

	it("only reads the booking page once an hour", async () => {
		claudeReplies.push(text("a"), text("b"));
		await chat("one");
		await chat("two");
		expect(bookingPageFetches).toBe(1);
	});
});

describe("admin: booking link for an enquiry", () => {
	const auth = { Authorization: "Basic " + btoa("studio:test-admin-password") };

	it("makes a link with the client's details and an email to send it", async () => {
		const { meta } = await env.DB.prepare(
			"INSERT INTO enquiries (created_at, name, email, phone, subject, details) VALUES (?, ?, ?, ?, ?, ?)"
		)
			.bind(new Date().toISOString(), "Sam Singer", "sam@example.com", "07700 900123", "Two songs", "Rapper, two songs, evenings")
			.run();
		const id = meta.last_row_id;

		let html = await (await worker.fetch(new Request(`${BASE}/admin/enquiries`, { headers: auth }), env)).text();
		expect(html).toContain("<summary>Booking link</summary>");
		expect(html).toContain('<option value="64806309"');
		expect(html).not.toContain("Secret test session");

		html = await (await worker.fetch(new Request(`${BASE}/admin/enquiries?link=${id}&type=64806309`, { headers: auth }), env)).text();
		const link =
			"https://app.acuityscheduling.com/schedule.php?owner=18510650&amp;appointmentType=64806309&amp;firstName=Sam&amp;lastName=Singer&amp;email=sam%40example.com&amp;phone=07700+900123";
		expect(html).toContain(`value="${link}"`);
		expect(html).toContain("Email it to them");
		expect(html).toContain("mailto:sam%40example.com?subject=Booking%20your%20session%20at%20Novacane");
	});
});

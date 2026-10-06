import { createExecutionContext, env, waitOnExecutionContext } from "cloudflare:test";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import worker from "../src";
import { forgetSessionTypes } from "../src/booking.js";
import { runManageBookingTool } from "../src/manage-bookings.js";
import { BOOKING_PAGE_HTML } from "./acuity-page.js";

const BASE = "https://novacane-worker.test";
const SITE = "https://novacane.co.uk";
const TODAY = "2026-10-05";
const API = "https://acuityscheduling.com/api/v1";

// ----- A fake Acuity API with a few bookings -----

function booking(id, extra) {
	return {
		id,
		firstName: "Dana",
		lastName: "Hollis",
		email: "dana@example.com",
		phone: "+447700900123",
		datetime: "2026-10-31T17:00:00+0000",
		date: "October 31, 2026",
		endTime: "9:00pm",
		type: "Rap Package - 2 songs",
		paid: "no",
		amountPaid: "0.00",
		notes: "",
		canceled: false,
		...extra,
	};
}

let bookings = [];
let changes = []; // every PUT the Worker sent to Acuity: { url, body }
let acuityAnswer = null; // override the answer to the next PUT: { status, body }
let claudeReplies = [];
let claudeCalls = [];

beforeEach(() => {
	bookings = [
		booking(1001, {}),
		booking(1002, { firstName: "Kai", lastName: "Fenwick", email: "kai@example.com", phone: "07700 900321", datetime: "2026-11-02T16:30:00+0000" }),
		booking(1003, { firstName: "Old", lastName: "Booking", canceled: true }),
	];
	changes = [];
	acuityAnswer = null;
	claudeReplies = [];
	claudeCalls = [];
	forgetSessionTypes();
	vi.spyOn(globalThis, "fetch").mockImplementation(async (url, init = {}) => {
		const u = new URL(String(url));
		if (u.pathname === "/schedule.php") return new Response(BOOKING_PAGE_HTML);
		if (String(url) === "https://api.anthropic.com/v1/messages") {
			claudeCalls.push(JSON.parse(init.body));
			const reply = claudeReplies.shift() || { stop_reason: "end_turn", content: [{ type: "text", text: "Done." }] };
			return new Response(JSON.stringify(reply));
		}
		if (String(url).startsWith(API + "/appointments")) {
			const method = init.method || "GET";
			if (method === "PUT") {
				changes.push({ url: String(url), body: JSON.parse(init.body || "{}") });
				if (acuityAnswer) return new Response(JSON.stringify(acuityAnswer.body), { status: acuityAnswer.status });
				return new Response(JSON.stringify({}));
			}
			const id = u.pathname.match(/\/appointments\/(\d+)$/)?.[1];
			if (id) {
				const found = bookings.find((b) => b.id === Number(id));
				return found ? new Response(JSON.stringify(found)) : new Response(JSON.stringify({ error: "not_found" }), { status: 404 });
			}
			// The list never includes cancelled bookings (like Acuity's default)
			const from = u.searchParams.get("minDate");
			const to = u.searchParams.get("maxDate");
			return new Response(JSON.stringify(bookings.filter((b) => !b.canceled && b.datetime.slice(0, 10) >= from && b.datetime.slice(0, 10) <= to)));
		}
		throw new Error("Unexpected fetch in test: " + url);
	});
});

afterEach(() => {
	vi.restoreAllMocks();
});

const run = (name, input, extraEnv = {}) => runManageBookingTool({ ...env, AGENT_NOVA_KEY: "agent-nova-test-key", ...extraEnv }, name, input, TODAY);

describe("find_bookings", () => {
	it("finds by part of a name, from today onwards", async () => {
		const result = await run("find_bookings", { name: "kai" });
		expect(result.ok).toBe(true);
		expect(result.message).toContain("1 booking(s)");
		expect(result.message).toContain("#1002: Monday 2 November 16:30");
		expect(result.message).toContain("Kai Fenwick");
		expect(result.message).not.toContain("Dana");
	});

	it("finds by phone, however it's written", async () => {
		const result = await run("find_bookings", { phone: "+44 7700 900321" });
		expect(result.message).toContain("Kai Fenwick");
		expect(result.message).not.toContain("Dana");
	});

	it("shows the end time and payment", async () => {
		const result = await run("find_bookings", { from: "2026-10-31", to: "2026-10-31" });
		expect(result.message).toContain("#1001: Saturday 31 October 17:00–21:00, Dana Hollis, Rap Package - 2 songs");
		expect(result.message).toContain("not paid");
	});

	it("says when nothing matches", async () => {
		const result = await run("find_bookings", { name: "nobody" });
		expect(result.ok).toBe(true);
		expect(result.message).toContain("No bookings found");
	});
});

describe("cancel_booking", () => {
	it("changes nothing until confirmed, and gives a summary to check", async () => {
		const result = await run("cancel_booking", { appointment_id: 1001, notify_client: true, confirmed: false });
		expect(result.message).toContain("Not cancelled yet");
		expect(result.message).toContain("Dana Hollis");
		expect(changes).toHaveLength(0);
	});

	it("cancels as staff once confirmed, with the note and email choice", async () => {
		const result = await run("cancel_booking", { appointment_id: 1001, notify_client: false, note: "Studio closed", confirmed: true });
		expect(result.ok).toBe(true);
		expect(result.message).toContain("Cancelled");
		expect(changes).toEqual([{ url: `${API}/appointments/1001/cancel?admin=true&noEmail=true`, body: { cancelNote: "Studio closed" } }]);
	});

	it("won't cancel a booking that's already cancelled, or one that doesn't exist", async () => {
		expect((await run("cancel_booking", { appointment_id: 1003, notify_client: true, confirmed: true })).message).toContain("already cancelled");
		expect((await run("cancel_booking", { appointment_id: 9999, notify_client: true, confirmed: true })).ok).toBe(false);
		expect((await run("cancel_booking", { appointment_id: "1001", notify_client: true, confirmed: true })).ok).toBe(false);
		expect(changes).toHaveLength(0);
	});
});

describe("reschedule_booking", () => {
	it("moves it once confirmed, checking the time is free (not as admin)", async () => {
		expect((await run("reschedule_booking", { appointment_id: 1001, date: "2026-11-04", time: "2pm", notify_client: true, confirmed: false })).message).toContain(
			"Not moved yet"
		);
		expect(changes).toHaveLength(0);

		const result = await run("reschedule_booking", { appointment_id: 1001, date: "2026-11-04", time: "2pm", notify_client: true, confirmed: true });
		expect(result.ok).toBe(true);
		expect(result.message).toContain("Wednesday 4 November at 14:00");
		expect(changes).toEqual([{ url: `${API}/appointments/1001/reschedule`, body: { datetime: "2026-11-04T14:00:00" } }]);
	});

	it("only overrides the calendar when asked", async () => {
		await run("reschedule_booking", { appointment_id: 1001, date: "2026-11-04", time: "14:00", notify_client: false, ignore_availability: true, confirmed: true });
		expect(changes[0].url).toBe(`${API}/appointments/1001/reschedule?admin=true&noEmail=true`);
	});

	it("explains when the new time isn't free, and refuses past days", async () => {
		acuityAnswer = { status: 400, body: { status_code: 400, error: "not_available", message: "The time is not available" } };
		const taken = await run("reschedule_booking", { appointment_id: 1001, date: "2026-11-04", time: "14:00", notify_client: true, confirmed: true });
		expect(taken.ok).toBe(false);
		expect(taken.message).toContain("isn't free");

		const past = await run("reschedule_booking", { appointment_id: 1001, date: "2026-10-01", time: "14:00", notify_client: true, confirmed: true });
		expect(past.ok).toBe(false);
		expect(past.message).toContain("in the past");
	});
});

describe("update_booking", () => {
	it("sends only the fields that change, once confirmed", async () => {
		const check = await run("update_booking", { appointment_id: 1001, phone: "07700 900789", notes: "Bringing a guitarist", confirmed: false });
		expect(check.message).toContain('phone: "+447700900123" → "07700 900789"');
		expect(changes).toHaveLength(0);

		const result = await run("update_booking", { appointment_id: 1001, phone: "07700 900789", notes: "Bringing a guitarist", confirmed: true });
		expect(result.ok).toBe(true);
		expect(changes).toEqual([{ url: `${API}/appointments/1001?admin=true`, body: { phone: "07700 900789", notes: "Bringing a guitarist" } }]);
	});

	it("says when there's nothing to change", async () => {
		expect((await run("update_booking", { appointment_id: 1001, confirmed: true })).ok).toBe(false);
		expect(changes).toHaveLength(0);
	});
});

describe("change_booking_extras (done by Nova Agent)", () => {
	beforeEach(async () => {
		await env.DB.batch([env.DB.prepare("DELETE FROM agent_jobs"), env.DB.prepare("DELETE FROM settings")]);
	});

	const jobs = async () => (await env.DB.prepare("SELECT appointment_id, client_name, changes, status FROM agent_jobs").all()).results;

	it("queues a job for Nova Agent once confirmed, and only once", async () => {
		const check = await run("change_booking_extras", { appointment_id: 1001, session_type: "Rap Package - 1 song", price: "£100", paid: true, confirmed: false });
		expect(check.message).toContain('Session type: "Rap Package - 2 songs" → "Rap Package - 1 song"');
		expect(check.message).toContain("Price: £? → £100.00");
		expect(check.message).toContain("Nova Agent has never checked in");
		expect(await jobs()).toHaveLength(0);

		const input = { appointment_id: 1001, session_type: "Rap Package - 1 song", price: "£100", paid: true, confirmed: true };
		const queued = await run("change_booking_extras", input);
		expect(queued.message).toContain("Queued for Nova Agent");
		await run("change_booking_extras", input); // asked twice
		expect(await jobs()).toEqual([
			{ appointment_id: 1001, client_name: "Dana Hollis", changes: '{"type":"Rap Package - 1 song","price":"100.00","paid":true}', status: "waiting" },
		]);
		expect(changes).toHaveLength(0); // nothing sent to Acuity's API
	});

	it("checks the price, and needs something to change", async () => {
		expect((await run("change_booking_extras", { appointment_id: 1001, price: "lots", confirmed: true })).ok).toBe(false);
		expect((await run("change_booking_extras", { appointment_id: 1001, confirmed: true })).ok).toBe(false);
		expect(await jobs()).toHaveLength(0);
	});

	it("isn't available without Nova Agent's key", async () => {
		const result = await run("change_booking_extras", { appointment_id: 1001, paid: true, confirmed: true }, { AGENT_NOVA_KEY: "" });
		expect(result.ok).toBe(false);
		expect(result.message).toContain("change it in Acuity");
	});
});

it("needs the Acuity API secrets", async () => {
	const result = await runManageBookingTool({ ...env, ACUITY_API_KEY: "" }, "find_bookings", {}, TODAY);
	expect(result.ok).toBe(false);
});

// ----- Only staff get these tools -----

let ip = 0;

async function post(path, body, headers = {}) {
	const ctx = createExecutionContext();
	const res = await worker.fetch(
		new Request(BASE + path, {
			method: "POST",
			headers: { "Content-Type": "application/json", "CF-Connecting-IP": `198.51.100.${(++ip % 250) + 1}`, ...headers },
			body: JSON.stringify(body),
		}),
		env,
		ctx
	);
	await waitOnExecutionContext(ctx);
	return { status: res.status, data: await res.json(), headers: res.headers };
}

const toolNames = (call) => (call.tools || []).map((tool) => tool.name);

describe("who gets these tools", () => {
	it("never offers them on the website", async () => {
		await post("/", { messages: [{ role: "user", content: "Cancel Dana's booking" }], chatId: "chat-manage-0001", page: "/" }, { Origin: SITE });
		expect(claudeCalls).toHaveLength(1);
		expect(toolNames(claudeCalls[0])).not.toContain("cancel_booking");
		expect(toolNames(claudeCalls[0])).not.toContain("find_bookings");
		expect(toolNames(claudeCalls[0])).not.toContain("change_booking_extras");
		// and the website's NovaBot talks to customers as normal
		expect(claudeCalls[0].system.map((s) => s.text).join("\n")).not.toContain("YOU ARE TALKING TO STAFF");
	});

	it("offers them in Nova Hub's staff chat, and runs them", async () => {
		const login = await post("/app/api/login", { password: "test-admin-password" }, { Origin: BASE });
		const cookie = login.headers.get("Set-Cookie").split(";")[0];

		claudeReplies = [
			{ stop_reason: "tool_use", content: [{ type: "tool_use", id: "t1", name: "find_bookings", input: { name: "dana" } }] },
			{ stop_reason: "end_turn", content: [{ type: "text", text: "Dana is in on Saturday 31 October at 17:00." }] },
		];
		const { status, data } = await post("/app/api/chat", { messages: [{ role: "user", content: "When is Dana in?" }] }, { Origin: BASE, Cookie: cookie });

		expect(status).toBe(200);
		expect(data.reply).toBe("Dana is in on Saturday 31 October at 17:00.");
		expect(toolNames(claudeCalls[0])).toEqual(expect.arrayContaining(["find_bookings", "cancel_booking", "reschedule_booking", "update_booking", "change_booking_extras"]));
		expect(claudeCalls[0].system[1].text).toContain("STAFF CHAT: MANAGING BOOKINGS");
		// It's told it's talking to the studio team, never a customer
		expect(claudeCalls[0].system[1].text).toContain("YOU ARE TALKING TO STAFF");
		// The tool's answer went back to Claude
		const toolResult = claudeCalls[1].messages.at(-1).content[0];
		expect(toolResult.content).toContain("#1001");
		expect(changes).toHaveLength(0);
	});
});

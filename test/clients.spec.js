// The client list (Quest 2, src/clients.js): built from Acuity's calendar feed, its webhook,
// enquiries and Acuity's spreadsheets; read and edited in Portal (/app/api/clients…), read by
// Nova Agent (/nova-agent/clients/…), plus Nova Agent's bookings from the feed
// (/nova-agent/bookings-feed).
import { createExecutionContext, env } from "cloudflare:test";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import worker from "../src";
import { importClientsCsv, listClients, parseCsv, syncClientsFromEnquiries, syncClientsFromFeed, syncClientsOnSchedule, ukLocalToUtc } from "../src/clients.js";
import { ukWallToUtc } from "../src/acuity/api.js";
import { sha256 } from "../src/portal/auth.js";
import { STAFF_COOKIE } from "./sign-in.js";

const BASE = "https://novacane-worker.test";
const FEED = "https://acuityscheduling.com/test-calendar-feed.ics";
const AGENT_KEY = "agent-nova-test-key";
const WEBHOOK_KEY = "test-webhook-key";
const STAFF_ONLY_COOKIE = "nova_session=test-staff-clients";

// ----- A fake calendar feed -----

let feed; // the bookings in it
let feedStatus; // what the feed answers (200, or a failure)

// One booking as Acuity's calendar feed writes it
function event({ id, name, email = "", phone = "", session = "Mixing", start, end, price = "50.00" }) {
	const lines = [`Name: ${name}`, phone && `Phone: ${phone}`, email && `Email: ${email}`, `Price: ${price}`].filter(Boolean).join("\\n");
	return `BEGIN:VEVENT\r\nUID:${id}@scheduling\r\nSUMMARY:${name}: ${session} (Novacane Studios)\r\nDTSTART:${start}\r\nDTEND:${end}\r\nDESCRIPTION:${lines}\r\nEND:VEVENT\r\n`;
}

const feedEnv = (extra = {}) => ({ ...env, ACUITY_CALENDAR_URL: FEED, ...extra });

beforeEach(async () => {
	feed = [];
	feedStatus = 200;
	vi.spyOn(globalThis, "fetch").mockImplementation(async (url) => {
		if (String(url) === FEED) {
			if (feedStatus !== 200) return new Response("nope", { status: feedStatus });
			return new Response(`BEGIN:VCALENDAR\r\nVERSION:2.0\r\n${feed.map(event).join("")}END:VCALENDAR\r\n`);
		}
		// Anything else (the booking page, push services) isn't needed here
		return new Response("not found", { status: 404 });
	});
	const now = new Date().toISOString();
	const later = new Date(Date.now() + 86_400_000).toISOString();
	await env.DB.batch([
		env.DB.prepare("DELETE FROM client_consent_log"),
		env.DB.prepare("DELETE FROM client_sessions"),
		env.DB.prepare("DELETE FROM clients"),
		env.DB.prepare("DELETE FROM enquiries"),
		env.DB.prepare("DELETE FROM booking_details"),
		env.DB.prepare("DELETE FROM booking_events"),
		env.DB.prepare("DELETE FROM settings"),
		env.DB.prepare(
			"INSERT OR IGNORE INTO staff (id, email, password_hash, display_name, role, status, created_at, planet_seed, index_partition) VALUES ('test-staff', 'test-staff@novacane.test', NULL, 'Test Staff', 'staff', 'active', ?, 'test-staff', 'staff:test-staff')"
		).bind(now),
		env.DB.prepare("INSERT OR REPLACE INTO sessions (id, staff_id, kind, created_at, expires_at, last_seen_at) VALUES (?, 'test-staff', 'cookie', ?, ?, ?)").bind(
			await sha256("test-staff-clients"),
			now,
			later,
			now
		),
	]);
});
afterEach(() => vi.restoreAllMocks());

// ----- Calling Nova Bot -----

// Portal, signed in (the test admin unless a cookie is given)
async function portal(path, { method = "GET", body, cookie = STAFF_COOKIE, e = env } = {}) {
	const res = await worker.fetch(
		new Request(BASE + "/app/api" + path, {
			method,
			headers: { Cookie: cookie, Origin: BASE, "Content-Type": "application/json" },
			body: body === undefined ? undefined : JSON.stringify(body),
		}),
		e,
		createExecutionContext()
	);
	return { status: res.status, data: await res.json() };
}

// Nova Agent, with its key
async function agent(path, body = {}, e = env) {
	const res = await worker.fetch(
		new Request(BASE + "/nova-agent" + path, { method: "POST", headers: { Authorization: `Bearer ${AGENT_KEY}`, "Content-Type": "application/json" }, body: JSON.stringify(body) }),
		e,
		createExecutionContext()
	);
	return { status: res.status, data: await res.json() };
}

// Acuity's webhook (the secret key in its address, as on plans without the API)
async function webhook(action, id) {
	const res = await worker.fetch(
		new Request(`${BASE}/acuity/webhook?key=${WEBHOOK_KEY}`, { method: "POST", headers: { "Content-Type": "application/x-www-form-urlencoded" }, body: `action=${action}&id=${id}&calendarID=1&appointmentTypeID=11` }),
		feedEnv({ ACUITY_WEBHOOK_KEY: WEBHOOK_KEY, ACUITY_API_KEY: "" })
	);
	expect(res.status).toBe(200);
}

const count = async (table) => env.DB.prepare(`SELECT COUNT(*) AS n FROM ${table}`).first("n");
const clientByEmail = (email) => env.DB.prepare("SELECT * FROM clients WHERE email = ?").bind(email).first();

// Every client, session and consent record, for "nothing changed" checks
async function snapshot() {
	const [c, s, l] = await env.DB.batch([
		env.DB.prepare("SELECT * FROM clients ORDER BY id"),
		env.DB.prepare("SELECT * FROM client_sessions ORDER BY id"),
		env.DB.prepare("SELECT * FROM client_consent_log ORDER BY id"),
	]);
	return JSON.stringify([c.results, s.results, l.results]);
}

// ----- Spreadsheets like Acuity's -----

const APPOINTMENTS_CSV = [
	'"Start Time","End Time","First Name","Last Name","Phone","Email","Type","Calendar","Appointment Price","Paid?","Amount Paid Online","Notes","Appointment ID","Canceled"',
	// British Summer Time (BST, UTC+1), a comma in the name and a note over two lines
	'"July 15, 2026 2:15 pm","July 15, 2026 4:15 pm","Ava","Stone, Jr.","07700 900222","Ava@Example.com","Mixing","Studio A","50.00","yes","50.00","Line one\nline two, with a comma","19001","no"',
	// Greenwich Mean Time (GMT, UTC+0), the other way of writing it
	'"2026-01-10 14:15","2026-01-10 16:15","Ava","Stone, Jr.","+44 7700 900222","ava@example.com","Recording","Studio A","120.00","no","0.00","","19002",""',
	// Cancelled
	'"December 1, 2026 10:00 am","December 1, 2026 11:00 am","Ben","Carter","07700 900333","ben@example.com","Mixing","Studio A","50.00","no","0.00","","19003","yes"',
	// Not a date: a problem, left out
	'"sometime soon","","Cal","Dunn","","cal@example.com","Mixing","Studio A","50.00","no","0.00","","19004","no"',
].join("\r\n");

// Columns in a different order, with quoted commas and new lines
const CLIENTS_CSV = [
	"Email,Phone,Last Name,First Name,Notes",
	'AVA@example.com,,"Stone, Jr.",Ava,"Prefers evenings, not mornings\nBrings own mic"',
	'dee@example.com,07700 900444,Evans,Dee,""',
	",,,,",
	',,,,"A note with nobody on it"',
	'"",07700 900555,Fox,Eli,"Said ""hi"" at the door"',
].join("\n");

// ===== SYNC FROM THE FEED =====

describe("syncing from Acuity's calendar feed", () => {
	it("adds each person once, and a second sync changes nothing", async () => {
		feed = [
			{ id: 15001, name: "Dana Hollis", email: "dana@example.com", phone: "07700 900123", start: "20261022T131500Z", end: "20261022T151500Z" },
			{ id: 15002, name: "Dana Hollis", email: "dana@example.com", phone: "07700 900123", start: "20261105T140000Z", end: "20261105T160000Z" },
			{ id: 15003, name: "Kai Fenwick", email: "kai@example.com", phone: "07700 900456", start: "20261023T100000Z", end: "20261023T120000Z" },
		];
		const first = await syncClientsFromFeed(feedEnv());
		expect(first).toEqual({ clients: { added: 2, updated: 0 }, sessions: { added: 3, updated: 0 } });
		const before = await snapshot();
		const second = await syncClientsFromFeed(feedEnv());
		expect(second).toEqual({ clients: { added: 0, updated: 0 }, sessions: { added: 0, updated: 0 } });
		expect(await snapshot()).toBe(before);
		expect(await count("clients")).toBe(2);
		expect(await count("client_sessions")).toBe(3);
		// Times are kept in UTC, and the session type without the name or calendar
		const s = await env.DB.prepare("SELECT * FROM client_sessions WHERE acuity_id = 15001").first();
		expect(s).toMatchObject({ starts_at: "2026-10-22T13:15:00.000Z", ends_at: "2026-10-22T15:15:00.000Z", session: "Mixing", status: "booked", source: "feed" });
		// Marketing consent is NO for everyone
		expect((await clientByEmail("dana@example.com")).marketing_consent).toBe(0);
	});

	it("knows the same person by email in any case, or by their mobile however it's written", async () => {
		feed = [
			{ id: 15011, name: "Dana Hollis", email: "Dana@Example.COM", phone: "07700 900123", start: "20261022T131500Z", end: "20261022T151500Z" },
			{ id: 15012, name: "Dana H", email: "dana@example.com", phone: "+44 7700 900123", start: "20261023T131500Z", end: "20261023T151500Z" },
			{ id: 15013, name: "D Hollis", phone: "+447700900123", start: "20261024T131500Z", end: "20261024T151500Z" },
			{ id: 15014, name: "Dana", email: "dana.work@example.com", phone: "(07700) 900-123", start: "20261025T131500Z", end: "20261025T151500Z" },
		];
		await syncClientsFromFeed(feedEnv());
		expect(await count("clients")).toBe(1);
		expect(await count("client_sessions")).toBe(4);
		expect(await clientByEmail("dana@example.com")).toMatchObject({ name: "Dana Hollis", phone: "07700 900123", phone_key: "+447700900123" });
	});

	it("never overwrites what staff typed", async () => {
		feed = [{ id: 15021, name: "Dana Hollis", email: "dana@example.com", phone: "07700 900123", start: "20261022T131500Z", end: "20261022T151500Z" }];
		await syncClientsFromFeed(feedEnv());
		const { id } = await clientByEmail("dana@example.com");
		const edit = await portal(`/clients/${id}`, {
			method: "POST",
			body: { name: "Dana Hollis (DH Beats)", email: "dana.new@example.com", phone: "07700 111222", notes: "Likes the big room", outstanding: "40.00" },
		});
		expect(edit.status).toBe(200);
		await syncClientsFromFeed(feedEnv());
		expect(await count("clients")).toBe(1);
		const after = await env.DB.prepare("SELECT * FROM clients WHERE id = ?").bind(id).first();
		expect(after).toMatchObject({ name: "Dana Hollis (DH Beats)", email: "dana.new@example.com", phone: "07700 111222", notes: "Likes the big room", outstanding_pence: 4000, updated_by: "test-admin" });
	});

	it("runs from the cron at most every 30 minutes", async () => {
		feed = [{ id: 15031, name: "Kai Fenwick", email: "kai@example.com", start: "20261022T131500Z", end: "20261022T151500Z" }];
		const at = Date.parse("2026-10-11T10:00:00Z");
		expect(await syncClientsOnSchedule(feedEnv(), at)).toMatchObject({ clients: { added: 1 }, feed: true });
		feed.push({ id: 15032, name: "Lu Park", email: "lu@example.com", start: "20261022T131500Z", end: "20261022T151500Z" });
		expect(await syncClientsOnSchedule(feedEnv(), at + 29 * 60000)).toBeNull();
		expect(await count("clients")).toBe(1);
		expect(await syncClientsOnSchedule(feedEnv(), at + 30 * 60000)).toMatchObject({ clients: { added: 1 } });
		expect(await count("clients")).toBe(2);
	});
});

// ===== THE WEBHOOK =====

describe("Acuity's webhook", () => {
	it("adds a new booking, and a cancellation marks its session cancelled", async () => {
		feed = [{ id: 16001, name: "Mo Reyes", email: "mo@example.com", phone: "07700 900777", start: "20261030T180000Z", end: "20261030T200000Z" }];
		await webhook("scheduled", 16001);
		const client = await clientByEmail("mo@example.com");
		expect(client).toMatchObject({ name: "Mo Reyes", source: "booking", marketing_consent: 0 });
		expect(await env.DB.prepare("SELECT * FROM client_sessions WHERE acuity_id = 16001").first()).toMatchObject({ client_id: client.id, status: "booked", source: "webhook" });
		// Cancelled in Acuity: it drops out of the feed
		feed = [];
		await webhook("canceled", 16001);
		expect(await env.DB.prepare("SELECT status, source FROM client_sessions WHERE acuity_id = 16001").first()).toEqual({ status: "cancelled", source: "webhook" });
		// A later sync doesn't bring it back or delete it
		await syncClientsFromFeed(feedEnv());
		expect(await env.DB.prepare("SELECT status FROM client_sessions WHERE acuity_id = 16001").first("status")).toBe("cancelled");
	});

	it("cancels a session the sync stored (no details saved by the webhook)", async () => {
		feed = [{ id: 16011, name: "Nia Cole", email: "nia@example.com", start: "20261030T180000Z", end: "20261030T200000Z" }];
		await syncClientsFromFeed(feedEnv());
		feed = [];
		await webhook("canceled", 16011);
		expect(await env.DB.prepare("SELECT status FROM client_sessions WHERE acuity_id = 16011").first("status")).toBe("cancelled");
	});

	it("still answers Acuity if the client list can't be written", async () => {
		feed = [{ id: 16021, name: "Oz Bell", email: "oz@example.com", start: "20261030T180000Z", end: "20261030T200000Z" }];
		const log = vi.spyOn(console, "log").mockImplementation(() => {});
		const prepare = env.DB.prepare.bind(env.DB);
		// The client list's tables are broken
		const broken = { ...feedEnv({ ACUITY_WEBHOOK_KEY: WEBHOOK_KEY, ACUITY_API_KEY: "" }), DB: new Proxy(env.DB, { get: (t, k) => (k === "prepare" ? (sql) => (/\bclient(s|_sessions|_consent_log)\b/.test(sql) ? prepare("SELECT * FROM no_such_table") : prepare(sql)) : t[k]?.bind ? t[k].bind(t) : t[k]) }) };
		const res = await worker.fetch(
			new Request(`${BASE}/acuity/webhook?key=${WEBHOOK_KEY}`, { method: "POST", headers: { "Content-Type": "application/x-www-form-urlencoded" }, body: "action=scheduled&id=16021&calendarID=1&appointmentTypeID=11" }),
			broken
		);
		expect(res.status).toBe(200);
		// The log says the booking's number, never the client's details
		const said = log.mock.calls.map((c) => c.join(" ")).join("\n");
		expect(said).toContain("#16021");
		expect(said).not.toContain("oz@example.com");
		expect(said).not.toContain("Oz Bell");
	});
});

// ===== ENQUIRIES =====

describe("enquiries", () => {
	async function enquiry(name, email, phone) {
		const now = new Date().toISOString();
		await env.DB.prepare("INSERT INTO enquiries (created_at, name, email, phone, details, consent_at, consent_source) VALUES (?, ?, ?, ?, 'Hi', ?, 'NovaBot chat')").bind(now, name, email, phone, now).run();
	}

	it("each enquirer becomes a client with no sessions and marketing consent NO", async () => {
		await enquiry("Pia Lowe", "pia@example.com", "07700 900888");
		await enquiry("Pia Lowe", "PIA@example.com", "07700 900888");
		feed = [{ id: 17001, name: "Kai Fenwick", email: "kai@example.com", start: "20261022T131500Z", end: "20261022T151500Z" }];
		await syncClientsFromFeed(feedEnv());
		// Kai enquired too: still one client
		await enquiry("Kai F", "kai@example.com", "");
		const result = await syncClientsFromEnquiries(env);
		expect(result.clients).toEqual({ added: 1, updated: 0 });
		expect(await count("clients")).toBe(2);
		const pia = await clientByEmail("pia@example.com");
		expect(pia).toMatchObject({ source: "enquiry", marketing_consent: 0, consent_at: null });
		expect(await env.DB.prepare("SELECT COUNT(*) AS n FROM client_sessions WHERE client_id = ?").bind(pia.id).first("n")).toBe(0);
		// "Enquiries only": enquirers who haven't booked
		const { data } = await portal("/clients?filter=enquiry");
		expect(data.clients.map((c) => c.name)).toEqual(["Pia Lowe"]);
		expect(data.clients[0]).toMatchObject({ consent: { yes: false, at: null, source: null }, sessionCount: 0, lastBooked: null, nextBooked: null, outstanding: "0.00" });
		// Twice changes nothing
		expect(await syncClientsFromEnquiries(env)).toEqual({ clients: { added: 0, updated: 0 }, sessions: { added: 0, updated: 0 } });
	});
});

// ===== IMPORTING ACUITY'S SPREADSHEETS =====

describe("importing Acuity's spreadsheets", () => {
	it("reads CSV with quoted commas, quotes and new lines", () => {
		const rows = parseCsv('a,"b, c","d ""e""\nf"\r\n\r\n1,2,3\n');
		expect(rows).toEqual([
			{ line: 1, cells: ["a", "b, c", 'd "e"\nf'] },
			{ line: 4, cells: ["1", "2", "3"] },
		]);
	});

	it("turns UK times into UTC with the right offset (BST in summer, GMT in winter)", () => {
		expect(ukLocalToUtc("October 22, 2026 2:15 pm")).toBe("2026-10-22T13:15:00.000Z");
		expect(ukLocalToUtc("2026-10-22 14:15")).toBe("2026-10-22T13:15:00.000Z");
		expect(ukLocalToUtc("2026-12-22 14:15")).toBe("2026-12-22T14:15:00.000Z");
		expect(ukLocalToUtc("January 5, 2026 12:00 am")).toBe("2026-01-05T00:00:00.000Z");
		expect(ukLocalToUtc("22/10/2026 09:05")).toBe("2026-10-22T08:05:00.000Z");
		expect(ukLocalToUtc("Thursday, 22 October 2026 14:15")).toBe("2026-10-22T13:15:00.000Z");
		// The clocks go back on 25 October 2026: 14:15 that afternoon is GMT
		expect(ukLocalToUtc("October 25, 2026 2:15 pm")).toBe("2026-10-25T14:15:00.000Z");
		// Not real times
		expect(ukLocalToUtc("February 30, 2026 2:15 pm")).toBeNull();
		expect(ukLocalToUtc("2026-03-29 01:30")).toBeNull();
		expect(ukLocalToUtc("soon")).toBeNull();
	});

	it("imports the appointments spreadsheet, and importing it again adds nothing", async () => {
		const first = await importClientsCsv(env, APPOINTMENTS_CSV);
		expect(first).toMatchObject({ kind: "appointments", clients: { added: 2, updated: 0 }, sessions: { added: 3, updated: 0 }, skipped: 1 });
		expect(first.problems).toEqual([expect.stringMatching(/^Line 6: the start time "sometime soon"/)]);
		const ava = await clientByEmail("ava@example.com");
		expect(ava).toMatchObject({ name: "Ava Stone, Jr.", phone: "07700 900222", source: "import", marketing_consent: 0 });
		const sessions = (await env.DB.prepare("SELECT acuity_id, starts_at, ends_at, session, price, status, source FROM client_sessions ORDER BY acuity_id").all()).results;
		expect(sessions).toEqual([
			{ acuity_id: 19001, starts_at: "2026-07-15T13:15:00.000Z", ends_at: "2026-07-15T15:15:00.000Z", session: "Mixing", price: "50.00", status: "booked", source: "import" },
			{ acuity_id: 19002, starts_at: "2026-01-10T14:15:00.000Z", ends_at: "2026-01-10T16:15:00.000Z", session: "Recording", price: "120.00", status: "booked", source: "import" },
			{ acuity_id: 19003, starts_at: "2026-12-01T10:00:00.000Z", ends_at: "2026-12-01T11:00:00.000Z", session: "Mixing", price: "50.00", status: "cancelled", source: "import" },
		]);
		const before = await snapshot();
		const again = await importClientsCsv(env, APPOINTMENTS_CSV);
		expect(again).toMatchObject({ clients: { added: 0, updated: 0 }, sessions: { added: 0, updated: 0 } });
		expect(await snapshot()).toBe(before);
	});

	it("imports the clients spreadsheet (any column order), and importing it again adds nothing", async () => {
		await importClientsCsv(env, APPOINTMENTS_CSV);
		const first = await importClientsCsv(env, CLIENTS_CSV);
		// Ava is already there (her notes are filled in); Dee and Eli are new; the row with nobody on it is skipped
		expect(first).toMatchObject({ kind: "clients", clients: { added: 2, updated: 1 }, sessions: { added: 0, updated: 0 }, skipped: 1 });
		expect(first.problems).toEqual(["Line 6: no name, email or phone, so it was left out."]);
		expect((await clientByEmail("ava@example.com")).notes).toBe("Prefers evenings, not mornings\nBrings own mic");
		expect(await env.DB.prepare("SELECT notes, phone_key, email FROM clients WHERE name = 'Eli Fox'").first()).toEqual({ notes: 'Said "hi" at the door', phone_key: "+447700900555", email: null });
		const before = await snapshot();
		const again = await importClientsCsv(env, CLIENTS_CSV);
		expect(again).toMatchObject({ clients: { added: 0, updated: 0 }, sessions: { added: 0, updated: 0 } });
		expect(await snapshot()).toBe(before);
		// Imports never give marketing consent
		expect(await env.DB.prepare("SELECT COUNT(*) AS n FROM clients WHERE marketing_consent != 0").first("n")).toBe(0);
	});

	it("matches a feed booking to the same booking imported earlier", async () => {
		await importClientsCsv(env, APPOINTMENTS_CSV);
		feed = [{ id: 19001, name: "Ava Stone", email: "ava@example.com", start: "20260715T131500Z", end: "20260715T151500Z" }];
		const result = await syncClientsFromFeed(feedEnv());
		expect(result).toEqual({ clients: { added: 0, updated: 0 }, sessions: { added: 0, updated: 0 } });
	});

	it("refuses something that isn't one of Acuity's spreadsheets", async () => {
		const { status, data } = await portal("/clients/import", { method: "POST", body: { csv: "colour,size\nred,big" } });
		expect(status).toBe(400);
		expect(data.error).toMatch(/doesn't look like Acuity's/);
	});
});

// ===== THE LIST =====

describe("the list", () => {
	// A client with these booked sessions (UK wall times) and cancelled ones
	const CSV_HEAD = '"Start Time","First Name","Last Name","Email","Type","Appointment ID","Canceled"';
	const row = (start, first, email, id, cancelled = "") => `"${start}","${first}","Test","${email}","Mixing","${id}","${cancelled}"`;

	it('"lapsed since 2026-07-01" is exactly who last booked before July and hasn\'t booked since', async () => {
		const csv = [
			CSV_HEAD,
			row("2026-06-10 12:00", "Amy", "amy@example.com", 1), // lapsed
			row("2026-03-01 12:00", "Bo", "bo@example.com", 2),
			row("2026-08-01 12:00", "Bo", "bo@example.com", 3), // booked since: not lapsed
			row("2026-08-01 12:00", "Cy", "cy@example.com", 4), // only since: not lapsed
			row("2026-05-01 12:00", "Di", "di@example.com", 5, "yes"), // only a cancelled one: not lapsed
			row("2026-06-30 23:30", "Ed", "ed@example.com", 6), // 23:30 on 30 June in the UK: lapsed
			row("2026-07-01 00:30", "Flo", "flo@example.com", 7), // 00:30 on 1 July in the UK (23:30 UTC the day before): not lapsed
			row("2026-04-01 12:00", "Gus", "gus@example.com", 8),
			row("2026-07-20 12:00", "Gus", "gus@example.com", 9, "yes"), // cancelled since: still lapsed
		].join("\n");
		expect((await importClientsCsv(env, csv)).skipped).toBe(0);
		const { status, data } = await portal("/clients?filter=lapsed&since=2026-07-01");
		expect(status).toBe(200);
		expect(data.clients.map((c) => c.name)).toEqual(["Amy Test", "Ed Test", "Gus Test"]);
		expect(data.total).toBe(3);
		expect(data.clients[0]).toMatchObject({ lastBooked: "2026-06-10T11:00:00.000Z", nextBooked: null, sessionCount: 1 });
		// Nova Agent asks the same
		const asked = await agent("/clients/lapsed", { since: "2026-07-01" });
		expect(asked.data.clients.map((c) => c.name)).toEqual(["Amy Test", "Ed Test", "Gus Test"]);
		expect((await portal("/clients?filter=lapsed")).status).toBe(400);
	});

	it('"owing" is who owes money, the most first', async () => {
		for (const [name, owed] of [["Ann", "20.00"], ["Bea", "150.50"], ["Cat", "0"], ["Dot", ""]]) {
			const { data } = await portal("/clients", { method: "POST", body: { name, email: `${name.toLowerCase()}@example.com` } });
			if (owed) expect((await portal(`/clients/${data.client.id}`, { method: "POST", body: { outstanding: owed } })).status).toBe(200);
		}
		const { data } = await portal("/clients?filter=owing");
		expect(data.clients.map((c) => [c.name, c.outstanding])).toEqual([
			["Bea", "150.50"],
			["Ann", "20.00"],
		]);
		const asked = await agent("/clients/owing");
		expect(asked.data.clients.map((c) => c.name)).toEqual(["Bea", "Ann"]);
	});

	it("searches by name, email or phone however it's written", async () => {
		await importClientsCsv(env, APPOINTMENTS_CSV);
		for (const search of ["stone", "AVA@", "07700900222", "+44 7700 900222"]) {
			const { data } = await portal("/clients?search=" + encodeURIComponent(search));
			expect(data.clients.map((c) => c.name)).toEqual(["Ava Stone, Jr."]);
		}
		const found = await agent("/clients/find", { search: "ben" });
		expect(found.data.clients.map((c) => c.name)).toEqual(["Ben Carter"]);
	});

	it("adding someone already on the list is refused with their id", async () => {
		const first = await portal("/clients", { method: "POST", body: { name: "Rae", email: "rae@example.com", phone: "07700 900999" } });
		expect(first.status).toBe(200);
		expect(first.data.client).toMatchObject({ name: "Rae", email: "rae@example.com", source: "staff" });
		const again = await portal("/clients", { method: "POST", body: { name: "Rae Smith", phone: "+447700900999" } });
		expect(again.status).toBe(409);
		expect(again.data.existingId).toBe(first.data.client.id);
	});

	it("a client's page has their sessions, newest first", async () => {
		await importClientsCsv(env, APPOINTMENTS_CSV);
		const { id } = await clientByEmail("ava@example.com");
		const { status, data } = await portal(`/clients/${id}`);
		expect(status).toBe(200);
		expect(data.sessions.map((s) => s.acuityId)).toEqual([19001, 19002]);
		expect(data.sessions[0]).toEqual({ id: expect.any(Number), acuityId: 19001, session: "Mixing", start: "2026-07-15T13:15:00.000Z", end: "2026-07-15T15:15:00.000Z", price: "50.00", status: "booked", source: "import" });
		expect(data.consentLog).toEqual([]);
		expect((await portal("/clients/999999")).status).toBe(404);
	});
});

// ===== MARKETING CONSENT =====

describe("marketing consent", () => {
	it("yes needs a source, and every change is logged with who made it", async () => {
		const { data } = await portal("/clients", { method: "POST", body: { name: "Sol", email: "sol@example.com" } });
		const id = data.client.id;
		expect(data.client.consent).toEqual({ yes: false, at: null, source: null });
		const noSource = await portal(`/clients/${id}`, { method: "POST", body: { consent: { yes: true, source: "  " } } });
		expect(noSource.status).toBe(400);
		// Ten days ago: stored as the start of that UK day, in UTC
		const day = new Date(Date.now() - 10 * 86400000).toLocaleDateString("en-CA", { timeZone: "Europe/London" });
		const at = ukWallToUtc(day + "T00:00").toISOString();
		const yes = await portal(`/clients/${id}`, { method: "POST", body: { consent: { yes: true, source: "Said yes in person", at: day } } });
		expect(yes.status).toBe(200);
		expect(yes.data.client.consent).toEqual({ yes: true, at, source: "Said yes in person" });
		// A staff member (not an admin) switches it off
		const off = await portal(`/clients/${id}`, { method: "POST", body: { consent: { yes: false, source: "Asked to stop by text" } }, cookie: STAFF_ONLY_COOKIE });
		expect(off.status).toBe(200);
		expect(off.data.client.consent.yes).toBe(false);
		const detail = await portal(`/clients/${id}`);
		expect(detail.data.consentLog).toMatchObject([
			{ consent: false, source: "Asked to stop by text", by: "test-staff", byName: "Test Staff" },
			{ consent: true, at, source: "Said yes in person", by: "test-admin", byName: "Test Admin" },
		]);
		// A future day isn't allowed
		expect((await portal(`/clients/${id}`, { method: "POST", body: { consent: { yes: true, source: "Form", at: "2099-01-01" } } })).status).toBe(400);
		// Nothing new: nothing logged
		await portal(`/clients/${id}`, { method: "POST", body: { consent: { yes: false } } });
		expect(await count("client_consent_log")).toBe(2);
	});

	it("money is entered in pounds and refused if it isn't an amount", async () => {
		const { data } = await portal("/clients", { method: "POST", body: { name: "Tam" } });
		const ok = await portal(`/clients/${data.client.id}`, { method: "POST", body: { depositsPaid: "£1,200.5", invoiced: 300, outstanding: "0.99" } });
		expect(ok.data.client).toMatchObject({ depositsPaid: "1200.50", invoiced: "300.00", outstanding: "0.99" });
		expect((await portal(`/clients/${data.client.id}`, { method: "POST", body: { outstanding: "-5" } })).status).toBe(400);
		expect((await portal(`/clients/${data.client.id}`, { method: "POST", body: { email: "not an email" } })).status).toBe(400);
	});
});

// ===== WHO CAN DO WHAT =====

describe("who can do what", () => {
	it("import and sync are for admins only (other staff get 403)", async () => {
		const asStaff = { method: "POST", cookie: STAFF_ONLY_COOKIE };
		expect((await portal("/clients/import", { ...asStaff, body: { csv: APPOINTMENTS_CSV } })).status).toBe(403);
		expect((await portal("/clients/sync", { ...asStaff, body: {} })).status).toBe(403);
		expect(await count("clients")).toBe(0);
		// Staff can still read the list
		expect((await portal("/clients", { cookie: STAFF_ONLY_COOKIE })).status).toBe(200);
		// An admin can
		expect((await portal("/clients/import", { method: "POST", body: { csv: APPOINTMENTS_CSV } })).data).toMatchObject({ kind: "appointments", clients: { added: 2 } });
		feed = [{ id: 18001, name: "Uma Ross", email: "uma@example.com", start: "20261022T131500Z", end: "20261022T151500Z" }];
		const synced = await portal("/clients/sync", { method: "POST", body: {}, e: feedEnv() });
		expect(synced.status).toBe(200);
		expect(synced.data).toMatchObject({ clients: { added: 1, updated: 0 }, sessions: { added: 1, updated: 0 }, feed: true });
		// The feed failing says so
		feedStatus = 500;
		const failed = await portal("/clients/sync", { method: "POST", body: {}, e: feedEnv() });
		expect(failed.status).toBe(503);
		expect(failed.data).toMatchObject({ unreachable: true });
		// Not signed in: nothing
		expect((await portal("/clients", { cookie: "" })).status).toBe(401);
	});

	it("Nova Agent's key can only read the client list", async () => {
		await importClientsCsv(env, APPOINTMENTS_CSV);
		const { id } = await clientByEmail("ava@example.com");
		const before = await snapshot();
		const sneaky = { id, name: "Changed", email: "x@example.com", notes: "x", outstanding: "99.00", consent: { yes: true, source: "Agent" }, csv: APPOINTMENTS_CSV, search: "ava", since: "2026-07-01" };
		for (const path of ["/clients/find", "/clients/history", "/clients/owing", "/clients/lapsed"]) expect((await agent(path, sneaky)).status).toBe(200);
		for (const path of [`/clients/${id}`, "/clients", "/clients/import", "/clients/sync", "/clients/edit", "/clients/add", "/clients/consent"]) expect((await agent(path, sneaky)).status).toBe(404);
		// The Portal routes don't take Nova Agent's key either
		const res = await worker.fetch(
			new Request(`${BASE}/app/api/clients/${id}`, { method: "POST", headers: { Authorization: `Bearer ${AGENT_KEY}`, Origin: BASE, "Content-Type": "application/json" }, body: JSON.stringify(sneaky) }),
			env,
			createExecutionContext()
		);
		expect(res.status).toBe(401);
		expect(await snapshot()).toBe(before);
		// What it reads
		const history = await agent("/clients/history", { id });
		expect(history.data.client).toMatchObject({ id, name: "Ava Stone, Jr.", consent: { yes: false } });
		expect(history.data.sessions).toHaveLength(2);
		expect(history.data.consentLog).toBeUndefined();
	});
});

// ===== NOVA AGENT'S BOOKINGS FROM THE FEED =====

describe("/nova-agent/bookings-feed", () => {
	it("lists the bookings on those UK days, in UTC", async () => {
		feed = [
			{ id: 19101, name: "Vi Moss", session: "Mixing", start: "20261022T131500Z", end: "20261022T151500Z" },
			// 00:30 on 22 October in the UK (BST) is 23:30 UTC on the 21st: on the 22nd
			{ id: 19102, name: "Wes Lin", session: "Recording", start: "20261021T233000Z", end: "20261022T013000Z" },
			// The day the clocks go back (GMT by the afternoon)
			{ id: 19103, name: "Xan Roe", session: "Mixing", start: "20261025T141500Z", end: "20261025T161500Z" },
			// Outside the days asked for
			{ id: 19104, name: "Yas Kerr", session: "Mixing", start: "20261026T100000Z", end: "20261026T120000Z" },
			{ id: 19105, name: "Zed Ash", session: "Mixing", start: "20261021T220000Z", end: "20261021T225900Z" },
		];
		const { status, data } = await agent("/bookings-feed", { from: "2026-10-22", to: "2026-10-25" }, feedEnv());
		expect(status).toBe(200);
		expect(data.appointments).toEqual([
			{ id: 19102, start: "2026-10-21T23:30:00.000Z", end: "2026-10-22T01:30:00.000Z", type: "Recording", name: "Wes Lin" },
			{ id: 19101, start: "2026-10-22T13:15:00.000Z", end: "2026-10-22T15:15:00.000Z", type: "Mixing", name: "Vi Moss" },
			{ id: 19103, start: "2026-10-25T14:15:00.000Z", end: "2026-10-25T16:15:00.000Z", type: "Mixing", name: "Xan Roe" },
		]);
	});

	it("says 409 without the feed, 503 when it can't be read, 400 for bad days", async () => {
		const unset = await agent("/bookings-feed", { from: "2026-10-22", to: "2026-10-25" }, { ...env, ACUITY_CALENDAR_URL: "" });
		expect(unset.status).toBe(409);
		feedStatus = 500;
		const down = await agent("/bookings-feed", { from: "2026-10-22", to: "2026-10-25" }, feedEnv());
		expect(down.status).toBe(503);
		expect(down.data).toMatchObject({ unreachable: true, error: expect.stringMatching(/^Acuity's calendar feed couldn't be read: /) });
		expect((await agent("/bookings-feed", { from: "2026-10-22", to: "2027-01-22" }, feedEnv())).status).toBe(400);
		expect((await agent("/bookings-feed", { from: "22/10/2026", to: "2026-10-25" }, feedEnv())).status).toBe(400);
	});
});

// The list helper on its own: a bad filter is refused
it("refuses a filter it doesn't know", async () => {
	expect(await listClients(env, { filter: "vip" })).toMatchObject({ status: 400 });
});

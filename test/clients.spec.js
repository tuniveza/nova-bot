// The client list (Quest 2, src/clients.js): built from Nova's own bookings and the enquiries; read
// and edited in Portal (/app/api/clients…), read by Nova Agent (/nova-agent/clients/…).
// (A booking's own updates to the list, as it's made, moved and cancelled: test/clients-nova.spec.js.)
import { createExecutionContext, env } from "cloudflare:test";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import worker from "../src";
import { listClients, syncClients, syncClientsFromEnquiries, syncClientsOnSchedule } from "../src/clients.js";
import { ukWallToUtc } from "../src/uk-time.js";
import { sha256 } from "../src/portal/auth.js";
import { STAFF_COOKIE } from "./sign-in.js";

const BASE = "https://novacane-worker.test";
const AGENT_KEY = "agent-nova-test-key";
const STAFF_ONLY_COOKIE = "nova_session=test-staff-clients";

// ----- Bookings (the bookings table, as Nova's booking system keeps it) -----

let n = 0;
// One booking. start/end: UTC ISO, or a UK wall clock "YYYY-MM-DD HH:MM" (end: two hours later)
async function booking({ name, email = "", phone = null, session = "Mixing", start, end = null, price = 5000, status = "booked", test = 0, source = "website", sender = null }) {
  const startIso = /Z$/.test(start) ? start : ukWallToUtc(start.replace(" ", "T")).toISOString();
  const endIso = end || new Date(Date.parse(startIso) + 2 * 3600_000).toISOString();
  const [first, ...rest] = name.split(" ");
  const now = new Date().toISOString();
  const { meta } = await env.DB.prepare(
    `INSERT INTO bookings (token, status, source, session, duration, starts_at, ends_at, first_name, last_name, email, phone, price_pence, deposit_pence, sender, created_at, updated_at, test)
     VALUES (?, ?, ?, ?, 120, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
  )
    .bind(`clients-test-token-${++n}-xxxxxxxxxx`, status, source, session, startIso, endIso, first, rest.join(" "), email, phone, price, Math.round(price / 2), sender, now, now, test)
    .run();
  return meta.last_row_id;
}
const bookAll = async (rows) => {
  const ids = [];
  for (const r of rows) ids.push(await booking(r));
  return ids;
};

beforeEach(async () => {
  vi.spyOn(globalThis, "fetch").mockImplementation(async () => new Response("not found", { status: 404 }));
  const now = new Date().toISOString();
  const later = new Date(Date.now() + 86_400_000).toISOString();
  await env.DB.batch([
    env.DB.prepare("DELETE FROM client_consent_log"),
    env.DB.prepare("DELETE FROM client_sessions"),
    env.DB.prepare("DELETE FROM clients"),
    env.DB.prepare("DELETE FROM enquiries"),
    env.DB.prepare("DELETE FROM bookings"),
    env.DB.prepare("DELETE FROM settings"),
    env.DB.prepare(
      "INSERT OR IGNORE INTO staff (id, email, password_hash, display_name, role, status, created_at, planet_seed, index_partition) VALUES ('test-staff', 'test-staff@novacane.test', NULL, 'Test Staff', 'staff', 'active', ?, 'test-staff', 'staff:test-staff')"
    ).bind(now),
    env.DB.prepare("INSERT OR REPLACE INTO sessions (id, staff_id, kind, created_at, expires_at, last_seen_at) VALUES (?, 'test-staff', 'cookie', ?, ?, ?)").bind(await sha256("test-staff-clients"), now, later, now),
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

// Ava (two sessions: summer and winter) and Ben (one, cancelled), synced into the list
async function avaAndBen() {
  const [summer, winter, ben] = await bookAll([
    { name: "Ava Stone", email: "Ava@Example.com", phone: "07700 900222", start: "2026-07-15 14:15" },
    { name: "Ava Stone", email: "ava@example.com", phone: "+44 7700 900222", session: "Recording", start: "2026-01-10 14:15", price: 12000 },
    { name: "Ben Carter", email: "ben@example.com", phone: "07700 900333", start: "2026-12-01 10:00", status: "cancelled" },
  ]);
  await syncClients(env);
  return { summer, winter, ben };
}

// ===== THE SYNC =====

describe("syncing from the bookings", () => {
  it("adds each person once, and a second sync changes nothing", async () => {
    const [first] = await bookAll([
      { name: "Dana Hollis", email: "dana@example.com", phone: "07700 900123", start: "2026-10-22T13:15:00.000Z", end: "2026-10-22T15:15:00.000Z" },
      { name: "Dana Hollis", email: "dana@example.com", phone: "07700 900123", start: "2026-11-05T14:00:00.000Z" },
      { name: "Kai Fenwick", email: "kai@example.com", phone: "07700 900456", start: "2026-10-23T10:00:00.000Z" },
      // Not clients: a test booking, an unpaid hold and one let go
      { name: "Nova TEST", email: "test@example.com", start: "2026-10-24T10:00:00.000Z", test: 1 },
      { name: "Holly Hold", email: "hold@example.com", start: "2026-10-24T12:00:00.000Z", status: "hold" },
      { name: "Ex Pired", email: "gone@example.com", start: "2026-10-24T14:00:00.000Z", status: "expired" },
    ]);
    const result = await syncClients(env);
    expect(result).toEqual({ clients: { added: 2, updated: 0 }, sessions: { added: 3, updated: 0 }, feed: true });
    const before = await snapshot();
    const second = await syncClients(env);
    expect(second).toEqual({ clients: { added: 0, updated: 0 }, sessions: { added: 0, updated: 0 }, feed: true });
    expect(await snapshot()).toBe(before);
    expect(await count("clients")).toBe(2);
    expect(await count("client_sessions")).toBe(3);
    // Times are kept in UTC; a session is known by minus its booking number
    const s = await env.DB.prepare("SELECT * FROM client_sessions WHERE acuity_id = ?").bind(-first).first();
    expect(s).toMatchObject({ starts_at: "2026-10-22T13:15:00.000Z", ends_at: "2026-10-22T15:15:00.000Z", session: "Mixing", price: "£50", status: "booked" });
    // Marketing consent is NO for everyone
    expect((await clientByEmail("dana@example.com")).marketing_consent).toBe(0);
  });

  it("knows the same person by email in any case, or by their mobile however it's written", async () => {
    await bookAll([
      { name: "Dana Hollis", email: "Dana@Example.COM", phone: "07700 900123", start: "2026-10-22T13:15:00.000Z" },
      { name: "Dana H", email: "dana@example.com", phone: "+44 7700 900123", start: "2026-10-23T13:15:00.000Z" },
      { name: "D Hollis", phone: "+447700900123", start: "2026-10-24T13:15:00.000Z" },
      { name: "Dana", email: "dana.work@example.com", phone: "(07700) 900-123", start: "2026-10-25T13:15:00.000Z" },
    ]);
    await syncClients(env);
    expect(await count("clients")).toBe(1);
    expect(await count("client_sessions")).toBe(4);
    expect(await clientByEmail("dana@example.com")).toMatchObject({ name: "Dana Hollis", phone: "07700 900123", phone_key: "+447700900123" });
  });

  it("never overwrites what staff typed", async () => {
    await booking({ name: "Dana Hollis", email: "dana@example.com", phone: "07700 900123", start: "2026-10-22T13:15:00.000Z" });
    await syncClients(env);
    const { id } = await clientByEmail("dana@example.com");
    const edit = await portal(`/clients/${id}`, {
      method: "POST",
      body: { name: "Dana Hollis (DH Beats)", email: "dana.new@example.com", phone: "07700 111222", notes: "Likes the big room", outstanding: "40.00" },
    });
    expect(edit.status).toBe(200);
    await syncClients(env);
    expect(await count("clients")).toBe(1);
    const after = await env.DB.prepare("SELECT * FROM clients WHERE id = ?").bind(id).first();
    expect(after).toMatchObject({ name: "Dana Hollis (DH Beats)", email: "dana.new@example.com", phone: "07700 111222", notes: "Likes the big room", outstanding_pence: 4000, updated_by: "test-admin" });
  });

  it("a cancelled booking's session stays cancelled", async () => {
    const id = await booking({ name: "Mo Reyes", email: "mo@example.com", start: "2026-10-30T18:00:00.000Z" });
    await syncClients(env);
    await env.DB.prepare("UPDATE bookings SET status = 'cancelled' WHERE id = ?").bind(id).run();
    await syncClients(env);
    expect(await env.DB.prepare("SELECT status FROM client_sessions WHERE acuity_id = ?").bind(-id).first("status")).toBe("cancelled");
  });

  it("runs from the cron at most every 30 minutes", async () => {
    await booking({ name: "Kai Fenwick", email: "kai@example.com", start: "2026-10-22T13:15:00.000Z" });
    const at = Date.parse("2026-10-11T10:00:00Z");
    expect(await syncClientsOnSchedule(env, at)).toMatchObject({ clients: { added: 1 }, feed: true });
    await booking({ name: "Lu Park", email: "lu@example.com", start: "2026-10-22T13:15:00.000Z" });
    expect(await syncClientsOnSchedule(env, at + 29 * 60000)).toBeNull();
    expect(await count("clients")).toBe(1);
    expect(await syncClientsOnSchedule(env, at + 30 * 60000)).toMatchObject({ clients: { added: 1 } });
    expect(await count("clients")).toBe(2);
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
    await booking({ name: "Kai Fenwick", email: "kai@example.com", start: "2026-10-22T13:15:00.000Z" });
    await syncClients(env);
    // Kai enquired too: still one client
    await enquiry("Kai F", "kai@example.com", "");
    const result = await syncClientsFromEnquiries(env);
    expect(result.clients).toEqual({ added: 0, updated: 0 });
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

// ===== THE LIST =====

describe("the list", () => {
	// A client with this booked session (a UK wall time), or a cancelled one
	const row = (start, first, email, cancelled = "") => ({ name: `${first} Test`, email, start, status: cancelled ? "cancelled" : "booked" });

	it('"lapsed since 2026-07-01" is exactly who last booked before July and hasn\'t booked since', async () => {
		await bookAll([
			row("2026-06-10 12:00", "Amy", "amy@example.com"), // lapsed
			row("2026-03-01 12:00", "Bo", "bo@example.com"),
			row("2026-08-01 12:00", "Bo", "bo@example.com"), // booked since: not lapsed
			row("2026-08-01 12:00", "Cy", "cy@example.com"), // only since: not lapsed
			row("2026-05-01 12:00", "Di", "di@example.com", "yes"), // only a cancelled one: not lapsed
			row("2026-06-30 23:30", "Ed", "ed@example.com"), // 23:30 on 30 June in the UK: lapsed
			row("2026-07-01 00:30", "Flo", "flo@example.com"), // 00:30 on 1 July in the UK (23:30 UTC the day before): not lapsed
			row("2026-04-01 12:00", "Gus", "gus@example.com"),
			row("2026-07-20 12:00", "Gus", "gus@example.com", "yes"), // cancelled since: still lapsed
		]);
		await syncClients(env);
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
		await avaAndBen();
		for (const search of ["stone", "AVA@", "07700900222", "+44 7700 900222"]) {
			const { data } = await portal("/clients?search=" + encodeURIComponent(search));
			expect(data.clients.map((c) => c.name)).toEqual(["Ava Stone"]);
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

	it("a client's page has their sessions, newest first, each with its booking number", async () => {
		const { summer, winter } = await avaAndBen();
		const { id } = await clientByEmail("ava@example.com");
		const { status, data } = await portal(`/clients/${id}`);
		expect(status).toBe(200);
		expect(data.sessions.map((s) => s.bookingId)).toEqual([summer, winter]);
		expect(data.sessions[0]).toEqual({ id: expect.any(Number), bookingId: summer, acuityId: null, session: "Mixing", start: "2026-07-15T13:15:00.000Z", end: "2026-07-15T15:15:00.000Z", price: "£50", status: "booked", source: null });
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
	it("sync is for admins only (other staff get 403); importing Acuity's spreadsheets has gone", async () => {
		await booking({ name: "Uma Ross", email: "uma@example.com", start: "2026-10-22T13:15:00.000Z" });
		const asStaff = { method: "POST", cookie: STAFF_ONLY_COOKIE };
		expect((await portal("/clients/sync", { ...asStaff, body: {} })).status).toBe(403);
		expect(await count("clients")).toBe(0);
		// Staff can still read the list
		expect((await portal("/clients", { cookie: STAFF_ONLY_COOKIE })).status).toBe(200);
		// An admin can
		const synced = await portal("/clients/sync", { method: "POST", body: {} });
		expect(synced.status).toBe(200);
		expect(synced.data).toMatchObject({ clients: { added: 1, updated: 0 }, sessions: { added: 1, updated: 0 }, feed: true });
		// An old Portal's "Import from Acuity" is told it's gone, and nothing changes
		const before = await snapshot();
		const imported = await portal("/clients/import", { method: "POST", body: { csv: "Start Time,First Name\n2026-01-01 10:00,Zed" } });
		expect(imported.status).toBe(410);
		expect(await snapshot()).toBe(before);
		// Not signed in: nothing
		expect((await portal("/clients", { cookie: "" })).status).toBe(401);
	});

	it("Nova Agent's key can only read the client list", async () => {
		await avaAndBen();
		const { id } = await clientByEmail("ava@example.com");
		const before = await snapshot();
		const sneaky = { id, name: "Changed", email: "x@example.com", notes: "x", outstanding: "99.00", consent: { yes: true, source: "Agent" }, csv: "x", search: "ava", since: "2026-07-01" };
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
		expect(history.data.client).toMatchObject({ id, name: "Ava Stone", consent: { yes: false } });
		expect(history.data.sessions).toHaveLength(2);
		expect(history.data.consentLog).toBeUndefined();
	});
});

// The list helper on its own: a bad filter is refused
it("refuses a filter it doesn't know", async () => {
	expect(await listClients(env, { filter: "vip" })).toMatchObject({ status: 400 });
});


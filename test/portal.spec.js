// Nova Portal: one sign-in for the Nova suite (src/portal/)
import { createExecutionContext, env, waitOnExecutionContext } from "cloudflare:test";
import { beforeEach, describe, expect, it } from "vitest";
import worker from "../src";
import { hashPassword, verifyPassword } from "../src/portal/auth.js";
import { putFile } from "../src/memory/store.js";

const BASE = "https://novacane-worker.test";
const PASS = "a-long-secret-1";

async function call(path, { method = "GET", body, cookie, token, origin = BASE, headers = {} } = {}) {
	const h = { ...headers };
	if (body !== undefined) h["Content-Type"] = "application/json";
	if (cookie) h.Cookie = cookie;
	if (token) h.Authorization = `Bearer ${token}`;
	if (origin && method !== "GET") h.Origin = origin;
	const ctx = createExecutionContext();
	const res = await worker.fetch(new Request(BASE + path, { method, headers: h, body: body === undefined ? undefined : JSON.stringify(body) }), env, ctx);
	await waitOnExecutionContext(ctx);
	const text = await res.text();
	let data = {};
	try {
		data = JSON.parse(text);
	} catch {}
	return { status: res.status, data, text, cookie: (res.headers.get("Set-Cookie") || "").split(";")[0], headers: res.headers };
}

// The first admin, set up with the studio's current password
async function setup() {
	const r = await call("/auth/setup", { method: "POST", body: { studio_password: "test-admin-password", email: "dom@novacane.co.uk", password: PASS, display_name: "Dominic Hughes" } });
	return r.cookie;
}

beforeEach(async () => {
	await env.DB.batch(["DELETE FROM sessions", "DELETE FROM staff", "DELETE FROM memory_files"].map((q) => env.DB.prepare(q)));
});

describe("passwords", () => {
	it("are salted and stretched, never stored as typed", async () => {
		const a = await hashPassword(PASS);
		const b = await hashPassword(PASS);
		expect(a).not.toBe(b);
		expect(a).not.toContain(PASS);
		expect(a.startsWith("pbkdf2$100000$")).toBe(true);
		expect(await verifyPassword(PASS, a)).toBe(true);
		expect(await verifyPassword("wrong-password-1", a)).toBe(false);
	});
});

describe("setting up and signing in", () => {
	it("makes the first admin only with the studio's current password, and only once", async () => {
		expect((await call("/auth/status")).data.setupNeeded).toBe(true);
		expect((await call("/auth/setup", { method: "POST", body: { studio_password: "nope", email: "x@y.co", password: PASS } })).status).toBe(401);
		const cookie = await setup();
		expect(cookie.startsWith("nova_session=")).toBe(true);
		const me = await call("/auth/me", { cookie });
		expect(me.data.staff).toMatchObject({ id: "dominic-hughes", role: "admin", planet_seed: "dominic-hughes", index_partition: "staff:dominic-hughes" });
		expect((await call("/auth/setup", { method: "POST", body: { studio_password: "test-admin-password", email: "z@y.co", password: PASS } })).status).toBe(409);
	});

	it("signs in with email and password, and signing out ends it everywhere", async () => {
		await setup();
		expect((await call("/auth/login", { method: "POST", body: { email: "dom@novacane.co.uk", password: "wrong-one-123" } })).status).toBe(401);
		const login = await call("/auth/login", { method: "POST", body: { email: "DOM@novacane.co.uk", password: PASS } });
		expect(login.status).toBe(200);
		const cookie = login.cookie;
		expect(login.headers.get("Set-Cookie")).toMatch(/HttpOnly; Secure; SameSite=Lax/);
		expect((await call("/auth/me", { cookie })).status).toBe(200);
		await call("/auth/logout", { method: "POST", cookie });
		expect((await call("/auth/me", { cookie })).status).toBe(401);
	});

	it("gives native apps a token instead of a cookie", async () => {
		await setup();
		const login = await call("/auth/login", { method: "POST", body: { email: "dom@novacane.co.uk", password: PASS, client: "app" } });
		expect(login.data.token).toMatch(/^nsess_/);
		expect((await call("/auth/me", { token: login.data.token })).data.staff.id).toBe("dominic-hughes");
		// An app's token can make changes without a browser Origin
		expect((await call("/auth/logout", { method: "POST", token: login.data.token, origin: null })).status).toBe(200);
	});

	it("refuses changes sent from another website", async () => {
		const cookie = await setup();
		expect((await call("/staff", { method: "POST", cookie, origin: "https://evil.example", body: { email: "a@b.co" } })).status).toBe(403);
	});
});

describe("staff and invites", () => {
	it("invites someone, who chooses their own password and is then signed in", async () => {
		const admin = await setup();
		const made = await call("/staff", { method: "POST", cookie: admin, body: { email: "kai@novacane.co.uk", display_name: "Kai" } });
		expect(made.status).toBe(201);
		expect(made.data.staff.status).toBe("invited");
		const token = new URL(made.data.invite_url).searchParams.get("invite");
		expect((await call(`/auth/invite?token=${encodeURIComponent(token)}`)).data.email).toBe("kai@novacane.co.uk");
		expect((await call("/auth/login", { method: "POST", body: { email: "kai@novacane.co.uk", password: PASS } })).status).toBe(401);
		expect((await call("/auth/invite/accept", { method: "POST", body: { token, password: "short" } })).status).toBe(400);
		const joined = await call("/auth/invite/accept", { method: "POST", body: { token, password: PASS } });
		expect(joined.status).toBe(200);
		expect((await call("/auth/me", { cookie: joined.cookie })).data.staff).toMatchObject({ id: "kai", role: "staff", status: "active" });
		// The link only works once
		expect((await call("/auth/invite/accept", { method: "POST", body: { token, password: PASS } })).status).toBe(404);
	});

	it("keeps admin things for admins, and never leaves the studio without one", async () => {
		const admin = await setup();
		const made = await call("/staff", { method: "POST", cookie: admin, body: { email: "kai@novacane.co.uk", display_name: "Kai" } });
		const joined = await call("/auth/invite/accept", { method: "POST", body: { token: new URL(made.data.invite_url).searchParams.get("invite"), password: PASS } });
		const kai = joined.cookie;
		expect((await call("/staff", { cookie: kai })).status).toBe(403);
		expect((await call("/staff/kai", { method: "PATCH", cookie: kai, body: { role: "admin" } })).status).toBe(403);
		// Kai can rename themselves and re-roll their planet
		const mine = await call("/staff/kai", { method: "PATCH", cookie: kai, body: { display_name: "Kai M", planet_seed: "reroll" } });
		expect(mine.data.staff.display_name).toBe("Kai M");
		expect(mine.data.staff.planet_seed).not.toBe("kai");
		// Others' emails stay private
		expect((await call("/staff/dominic-hughes", { cookie: kai })).data.staff.email).toBeUndefined();
		// The only admin can't demote themselves
		expect((await call("/staff/dominic-hughes", { method: "PATCH", cookie: admin, body: { role: "staff" } })).status).toBe(409);
		// Switching Kai off signs them out everywhere
		await call("/staff/kai", { method: "PATCH", cookie: admin, body: { status: "disabled" } });
		expect((await call("/auth/me", { cookie: kai })).status).toBe(401);
	});
});

describe("one sign-in for the suite", () => {
	it("opens Nova Hub, the admin pages and each person's Nova Index partition", async () => {
		const admin = await setup();
		// Nova Hub
		expect((await call("/app/api/me", { cookie: admin })).status).toBe(200);
		// The admin pages (no separate password)
		expect((await call("/admin/links", { cookie: admin })).status).toBe(200);
		// A staff member who isn't an admin: Nova Hub yes, admin pages no
		const made = await call("/staff", { method: "POST", cookie: admin, body: { email: "kai@novacane.co.uk", display_name: "Kai" } });
		const kai = (await call("/auth/invite/accept", { method: "POST", body: { token: new URL(made.data.invite_url).searchParams.get("invite"), password: PASS } })).cookie;
		expect((await call("/app/api/me", { cookie: kai })).status).toBe(200);
		expect((await call("/admin", { cookie: kai })).status).toBe(401);
		// Nova Index: Kai sees the studio's facts and their own partition, never someone else's or customers'
		await putFile(env, { scope: "studio", path: "studio", body: "- [stated] open late", if_version: "new" });
		await putFile(env, { scope: "staff", owner_id: "kai", path: "profile", body: "- [stated] mixes in the mornings", if_version: "new" });
		await putFile(env, { scope: "staff", owner_id: "dominic-hughes", path: "profile", body: "- [stated] runs the studio", if_version: "new" });
		await putFile(env, { scope: "customer", owner_id: "dana@example.com", path: "profile", body: "- [stated] EP in December", if_version: "new" });
		const seen = await call("/app/api/memory/index", { cookie: kai });
		expect(seen.data.files.map((f) => `${f.scope}:${f.owner_id}`).sort()).toEqual(["staff:kai", "studio:null"]);
		expect((await call("/app/api/memory/file?scope=staff&owner_id=dominic-hughes&path=profile", { cookie: kai })).status).toBe(403);
		expect((await call("/app/api/memory/file?scope=customer&owner_id=dana@example.com&path=profile", { cookie: kai })).status).toBe(403);
		const write = await call("/app/api/memory/file", { method: "PUT", cookie: kai, body: { scope: "staff", owner_id: "dominic-hughes", path: "profile", body: "- [stated] x", if_version: "new" } });
		expect(write.status).toBe(403);
		// The admin sees everything
		expect((await call("/app/api/memory/index", { cookie: admin })).data.files).toHaveLength(4);
		// And each person's own index view
		expect((await call("/staff/kai/index", { cookie: kai })).data.partition).toBe("staff:kai");
		expect((await call("/staff/dominic-hughes/index", { cookie: kai })).status).toBe(403);
	});
});

describe("planets", () => {
	it("draws the same planet for the same person, and a new one after a re-roll", async () => {
		const admin = await setup();
		const a = await call("/staff/dominic-hughes/planet.svg?size=96");
		expect(a.status).toBe(200);
		expect(a.headers.get("Content-Type")).toContain("image/svg+xml");
		expect(a.text).toContain("<svg");
		expect(a.text).toContain("Dominic Hughes");
		expect((await call("/staff/dominic-hughes/planet.svg?size=96")).text).toBe(a.text);
		await call("/staff/dominic-hughes", { method: "PATCH", cookie: admin, body: { planet_seed: "reroll" } });
		expect((await call("/staff/dominic-hughes/planet.svg?size=96")).text).not.toBe(a.text);
		// Anyone without an account still gets a planet (from the id), so badges never break
		expect((await call("/staff/someone-new/planet.svg?size=32")).status).toBe(200);
	});
});

describe("the Nova Portal badge on every app", () => {
	const NOTES = "https://nova-notes.novacane-studio.workers.dev";

	it("tells the badge who you are, with your planet's name and colour", async () => {
		const admin = await setup();
		const me = await call("/auth/me", { cookie: admin });
		expect(me.data.via).toBe("portal");
		expect(me.data.staff.planet.name).toBeTruthy();
		expect(me.data.staff.planet.glow).toMatch(/^#|^rgb|^hsl/);
	});

	it("connects another suite site with a read-only token, and only a suite site", async () => {
		const admin = await setup();
		expect((await call("/auth/connect", { method: "POST", cookie: admin, body: { return_to: "https://evil.example/" } })).status).toBe(400);
		expect((await call("/auth/connect", { method: "POST", body: { return_to: NOTES + "/" } })).status).toBe(401);
		const made = await call("/auth/connect", { method: "POST", cookie: admin, body: { return_to: NOTES + "/?x=1" } });
		expect(made.status).toBe(200);
		const token = /#nova_portal=(nprof_[\w-]+)$/.exec(made.data.redirect)[1];
		expect(made.data.redirect.startsWith(NOTES + "/?x=1#")).toBe(true);
		// The badge on Nova Notes: who you are, without the email, with CORS for that site only
		const me = await call("/auth/me", { token, headers: { Origin: NOTES } });
		expect(me.status).toBe(200);
		expect(me.data.via).toBe("connect");
		expect(me.data.staff.id).toBe("dominic-hughes");
		expect(me.data.staff.email).toBeUndefined();
		expect(me.headers.get("Access-Control-Allow-Origin")).toBe(NOTES);
		expect((await call("/auth/me", { token, headers: { Origin: "https://evil.example" } })).headers.get("Access-Control-Allow-Origin")).toBeNull();
		const pre = await call("/auth/me", { method: "OPTIONS", origin: NOTES, headers: { Origin: NOTES } });
		expect(pre.status).toBe(204);
		// It can't do anything else
		expect((await call("/staff/dominic-hughes", { token })).status).toBe(401);
		expect((await call("/app/api/me", { token })).status).toBe(401);
		expect((await call("/staff", { method: "POST", token, origin: null, body: { email: "x@y.co" } })).status).toBe(401);
		expect((await call("/auth/connect", { method: "POST", token, origin: null, body: { return_to: NOTES } })).status).toBe(401);
		// Disconnecting ends it
		expect((await call("/auth/logout", { method: "POST", token, origin: null, headers: { Origin: NOTES } })).status).toBe(200);
		expect((await call("/auth/me", { token })).status).toBe(401);
	});
});

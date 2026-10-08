// Changing your password from Portal's "You" page (POST /auth/password)
import { createExecutionContext, env, waitOnExecutionContext } from "cloudflare:test";
import { beforeEach, describe, expect, it } from "vitest";
import worker from "../src";
import { STAFF_COOKIE } from "./sign-in.js";
import { hashPassword, sha256, verifyPassword } from "../src/portal/auth.js";

const BASE = "https://novacane-worker.test";
const STAFF_TOKEN = "test-staff-portal-session";

async function call(path, { method = "GET", cookie = "", body } = {}) {
  const ctx = createExecutionContext();
  const headers = { Origin: BASE, "Content-Type": "application/json", "CF-Connecting-IP": `10.0.0.${Math.floor(Math.random() * 250)}` };
  if (cookie) headers.Cookie = cookie;
  const res = await worker.fetch(new Request(BASE + path, { method, headers, body: body ? JSON.stringify(body) : undefined }), env, ctx);
  await waitOnExecutionContext(ctx);
  return { status: res.status, data: await res.json().catch(() => ({})) };
}
const hashOf = (id) => env.DB.prepare("SELECT password_hash FROM staff WHERE id = ?").bind(id).first("password_hash");

beforeEach(async () => {
  const now = new Date().toISOString();
  const later = new Date(Date.now() + 86_400_000).toISOString();
  await env.DB.batch([
    env.DB.prepare("UPDATE staff SET password_hash = ? WHERE id = 'test-admin'").bind(await hashPassword("old admin password")),
    env.DB.prepare("INSERT OR REPLACE INTO staff (id, email, password_hash, display_name, role, status, created_at, planet_seed, index_partition) VALUES ('test-staff', 'test-staff@novacane.test', ?, 'Test Staff', 'staff', 'active', ?, 'test-staff', 'staff:test-staff')").bind(await hashPassword("old staff password"), now),
    env.DB.prepare("INSERT OR REPLACE INTO sessions (id, staff_id, kind, created_at, expires_at, last_seen_at) VALUES (?, 'test-staff', 'cookie', ?, ?, ?)").bind(await sha256(STAFF_TOKEN), now, later, now),
    env.DB.prepare("INSERT OR REPLACE INTO sessions (id, staff_id, kind, created_at, expires_at, last_seen_at) VALUES ('other-admin-session', 'test-admin', 'token', ?, ?, ?)").bind(now, later, now),
  ]);
});

describe("changing your password", () => {
  it("needs a sign-in", async () => {
    expect((await call("/auth/password", { method: "POST", body: { password: "a brand new password" } })).status).toBe(401);
  });

  it("an admin chooses a new one without the old one, and their other sign-ins end", async () => {
    const r = await call("/auth/password", { method: "POST", cookie: STAFF_COOKIE, body: { password: "a brand new password" } });
    expect(r.status).toBe(200);
    expect(await verifyPassword("a brand new password", await hashOf("test-admin"))).toBe(true);
    expect(await env.DB.prepare("SELECT COUNT(*) AS n FROM sessions WHERE id = 'other-admin-session'").first("n")).toBe(0);
    // This sign-in carries on
    expect((await call("/auth/me", { cookie: STAFF_COOKIE })).status).toBe(200);
  });

  it("staff confirm their current password", async () => {
    const cookie = `nova_session=${STAFF_TOKEN}`;
    expect((await call("/auth/password", { method: "POST", cookie, body: { password: "a brand new password" } })).status).toBe(401);
    expect((await call("/auth/password", { method: "POST", cookie, body: { password: "a brand new password", current: "wrong" } })).status).toBe(401);
    expect((await call("/auth/password", { method: "POST", cookie, body: { password: "a brand new password", current: "old staff password" } })).status).toBe(200);
    expect(await verifyPassword("a brand new password", await hashOf("test-staff"))).toBe(true);
  });

  it("turns down a weak password", async () => {
    const r = await call("/auth/password", { method: "POST", cookie: STAFF_COOKIE, body: { password: "short" } });
    expect(r.status).toBe(400);
    expect(await verifyPassword("old admin password", await hashOf("test-admin"))).toBe(true);
  });

  it("only from this site", async () => {
    const ctx = createExecutionContext();
    const res = await worker.fetch(new Request(BASE + "/auth/password", { method: "POST", headers: { Origin: "https://evil.example", Cookie: STAFF_COOKIE, "Content-Type": "application/json" }, body: JSON.stringify({ password: "a brand new password" }) }), env, ctx);
    expect(res.status).toBe(403);
  });
});

// Nova Portal: one sign-in for the whole Nova suite.
//
// Passwords: PBKDF2-SHA256, 100,000 rounds (the most Cloudflare Workers allow),
// with a random 16-byte salt per person; stored as "pbkdf2$100000$<salt>$<hash>".
// Sessions: a random 32-byte token, in an httpOnly, Secure cookie (web) or an
// app token (native apps, "Authorization: Bearer nsess_..."). Only the token's
// SHA-256 is stored, so the sessions table can't be used to sign in, and signing
// out deletes the row, so it stops working everywhere at once.
// A third kind, "profile" ("Bearer nprof_..."), is read-only: it lets a suite app
// on another site (Nova Notes, Nova Calendar) show who you are, and nothing else.

export const COOKIE = "nova_session";
export const SESSION_DAYS = 30;
const ROUNDS = 100_000;

const enc = new TextEncoder();
const b64url = (bytes) => btoa(String.fromCharCode(...new Uint8Array(bytes))).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
const fromB64url = (s) => Uint8Array.from(atob(s.replace(/-/g, "+").replace(/_/g, "/") + "===".slice((s.length + 3) % 4)), (c) => c.charCodeAt(0));

export async function sha256(text) {
  return b64url(await crypto.subtle.digest("SHA-256", enc.encode(String(text))));
}

// Compare without giving away how much matched
export async function sameText(a, b) {
  const hash = async (s) => new Uint8Array(await crypto.subtle.digest("SHA-256", enc.encode(String(s))));
  return crypto.subtle.timingSafeEqual(await hash(a), await hash(b));
}

async function pbkdf2(password, salt, rounds) {
  const key = await crypto.subtle.importKey("raw", enc.encode(password), "PBKDF2", false, ["deriveBits"]);
  return crypto.subtle.deriveBits({ name: "PBKDF2", hash: "SHA-256", salt, iterations: rounds }, key, 256);
}

export async function hashPassword(password) {
  const salt = crypto.getRandomValues(new Uint8Array(16));
  return `pbkdf2$${ROUNDS}$${b64url(salt)}$${b64url(await pbkdf2(password, salt, ROUNDS))}`;
}

export async function verifyPassword(password, stored) {
  const [kind, rounds, salt, hash] = String(stored || "").split("$");
  if (kind !== "pbkdf2" || !salt || !hash) {
    // Still take the time, so a missing account and a wrong password look the same
    await pbkdf2(String(password), new Uint8Array(16), ROUNDS);
    return false;
  }
  return sameText(b64url(await pbkdf2(String(password), fromB64url(salt), Number(rounds))), hash);
}

// A good-enough password: at least 10 characters, not all one kind of thing
export function passwordProblem(password) {
  const p = String(password || "");
  if (p.length < 10) return "Use at least 10 characters.";
  if (p.length > 200) return "That's too long.";
  if (/^(.)\1+$/.test(p) || /^(password|novacane|123456)/i.test(p)) return "Pick something harder to guess.";
  return "";
}

// ---- Sessions ----

export async function createSession(env, staffId, { kind = "cookie", userAgent = "" } = {}) {
  const token = (kind === "token" ? "nsess_" : kind === "profile" ? "nprof_" : "") + b64url(crypto.getRandomValues(new Uint8Array(32)));
  const now = new Date();
  const expires = new Date(now.getTime() + SESSION_DAYS * 864e5);
  await env.DB.prepare("INSERT INTO sessions (id, staff_id, kind, created_at, expires_at, last_seen_at, user_agent) VALUES (?, ?, ?, ?, ?, ?, ?)")
    .bind(await sha256(token), staffId, kind, now.toISOString(), expires.toISOString(), now.toISOString(), String(userAgent).slice(0, 200))
    .run();
  await env.DB.prepare("UPDATE staff SET last_login_at = ? WHERE id = ?").bind(now.toISOString(), staffId).run();
  // Now and then, clear out expired sessions
  if (Math.random() < 0.05) await env.DB.prepare("DELETE FROM sessions WHERE expires_at < ?").bind(now.toISOString()).run();
  return token;
}

export function sessionCookie(token) {
  return `${COOKIE}=${token}; Path=/; Max-Age=${SESSION_DAYS * 86400}; HttpOnly; Secure; SameSite=Lax`;
}
export const clearCookie = () => `${COOKIE}=; Path=/; Max-Age=0; HttpOnly; Secure; SameSite=Lax`;

// The token this request carries (the cookie, or an app's Bearer token)
export function tokenOf(request) {
  const auth = request.headers.get("Authorization") || "";
  if (auth.startsWith("Bearer nsess_")) return { token: auth.slice(7), kind: "token" };
  if (auth.startsWith("Bearer nprof_")) return { token: auth.slice(7), kind: "profile" };
  const cookie = (request.headers.get("Cookie") || "").split(/;\s*/).find((c) => c.startsWith(COOKIE + "="));
  return cookie ? { token: cookie.slice(COOKIE.length + 1), kind: "cookie" } : null;
}

// The signed-in staff member (active, session not expired), or null.
// Every protected route asks this; the staff record comes back attached.
// A read-only profile token only counts where the route says so ({ profile: true }).
export async function requireStaff(request, env, { admin = false, profile = false } = {}) {
  if (!env.DB) return null;
  const t = tokenOf(request);
  if (!t || !t.token) return null;
  const id = await sha256(t.token);
  const row = await env.DB.prepare(
    "SELECT s.id AS session_id, s.expires_at, s.last_seen_at, s.kind, st.* FROM sessions s JOIN staff st ON st.id = s.staff_id WHERE s.id = ?"
  )
    .bind(id)
    .first()
    .catch(() => null);
  if (!row || row.expires_at < new Date().toISOString() || row.status !== "active") return null;
  if (row.kind === "profile" && !profile) return null;
  if (admin && row.role !== "admin") return null;
  // Note it's in use (at most every 10 minutes, to keep writes down)
  if (Date.now() - Date.parse(row.last_seen_at) > 600_000) {
    await env.DB.prepare("UPDATE sessions SET last_seen_at = ? WHERE id = ?").bind(new Date().toISOString(), id).run().catch(() => {});
  }
  return { ...row, session_kind: row.kind };
}

export async function endSession(env, request) {
  const t = tokenOf(request);
  if (t && t.token) await env.DB.prepare("DELETE FROM sessions WHERE id = ?").bind(await sha256(t.token)).run();
}

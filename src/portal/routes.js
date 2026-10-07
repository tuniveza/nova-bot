// Nova Portal's API: signing in once for every Nova suite app, staff records,
// profiles and planets.
//
//   POST /auth/login            { email, password, client? }  → session cookie (or an app token with client: "app")
//   POST /auth/logout           ends this session everywhere
//   GET  /auth/me               who's signed in (every app uses this to start)
//   GET  /auth/status           { setupNeeded } (no staff yet)
//   POST /auth/setup            the first admin, proven with the studio's current password
//   GET  /auth/invite?token=    who an invite is for
//   POST /auth/invite/accept    { token, password } → choose a password, signed in
//   GET  /staff                 admin: everyone
//   POST /staff                 admin: invite someone { email, display_name, role } → an invite link
//   POST /staff/:id/invite      admin: a fresh invite link
//   GET  /staff/:id             a profile (name, role, planet; email for admins and yourself)
//   PATCH /staff/:id            admin: role, status, name, planet; yourself: name, planet
//   GET  /staff/:id/planet.svg  the planet badge (?size=, ?animate=1)
//   GET  /staff/:id/index       that person's Nova Index view (yourself or an admin)
//   POST /auth/connect          { return_to } → a read-only profile token for another suite site
//                               (Nova Notes, Nova Calendar...), so its Portal badge can show you
// /auth/me and /auth/logout also answer those sites (CORS), with a profile token.
// Changes from a browser must come from this site (the Origin header); apps
// using a token are exempt (a token can't be sent by another website).

import { clearCookie, createSession, endSession, hashPassword, passwordProblem, requireStaff, sameText, sessionCookie, sha256, tokenOf, verifyPassword } from "./auth.js";
import { listFiles } from "../memory/store.js";

const json = (data, status = 200, headers = {}) => Response.json(data, { status, headers: { "Cache-Control": "no-store", ...headers } });
const INVITE_DAYS = 7;
const ROLES = ["admin", "staff"];
const STATUSES = ["active", "invited", "disabled"];
const text = (v, max) => (typeof v === "string" ? v.trim().slice(0, max) : "");
const validEmail = (e) => /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(e);

// The other suite sites whose Portal badge may ask who you are (with a read-only token)
export const SUITE_ORIGINS = [
  "https://nova-notes.novacane-studio.workers.dev",
  "https://nova-calendar.novacane-studio.workers.dev",
  "http://localhost:4545",
  "http://localhost:4546",
  "http://localhost:4610",
];
const PROFILE_DAYS = 90;

// CORS for the badge on those sites: a Bearer token, never cookies
function suiteCors(request) {
  const origin = request.headers.get("Origin") || "";
  return SUITE_ORIGINS.includes(origin)
    ? { "Access-Control-Allow-Origin": origin, "Access-Control-Allow-Headers": "Authorization, Content-Type", "Access-Control-Allow-Methods": "GET, POST, OPTIONS", "Access-Control-Max-Age": "86400", Vary: "Origin" }
    : {};
}

// The planet's name, a short description and its glow colour (the badge's halo)
export async function planetFacts(seed, overrides) {
  const { generatePlanet, novaTheme } = await import("./planet/index.js");
  const p = generatePlanet(seed, novaTheme, overrides || undefined);
  return { name: p.name, description: p.description, surface: p.surface, glow: p.glow && p.glow.color };
}

// What anyone may see of a staff member (plus email for admins and themselves)
export function profile(row, { full = false } = {}) {
  if (!row) return null;
  let overrides = null;
  try {
    overrides = row.planet_overrides ? JSON.parse(row.planet_overrides) : null;
  } catch {}
  return {
    id: row.id,
    display_name: row.display_name,
    role: row.role,
    status: row.status,
    planet_seed: row.planet_seed,
    planet_overrides: overrides,
    planet_theme: "nova",
    index_partition: row.index_partition,
    created_at: row.created_at,
    ...(full ? { email: row.email, last_login_at: row.last_login_at } : {}),
  };
}

// A readable, unique id from a name or email ("Dominic Hughes" → "dominic-hughes")
async function newId(env, from) {
  const base = String(from || "staff").toLowerCase().split("@")[0].replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "").slice(0, 32) || "staff";
  for (let i = 0; i < 50; i++) {
    const id = i ? `${base}-${i + 1}` : base;
    if (!(await env.DB.prepare("SELECT 1 FROM staff WHERE id = ?").bind(id).first())) return id;
  }
  return `${base}-${crypto.randomUUID().slice(0, 6)}`;
}

async function inviteFor(env, id, origin) {
  const token = btoa(String.fromCharCode(...crypto.getRandomValues(new Uint8Array(24)))).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
  const expires = new Date(Date.now() + INVITE_DAYS * 864e5).toISOString();
  await env.DB.prepare("UPDATE staff SET invite_hash = ?, invite_expires = ? WHERE id = ?").bind(await sha256(token), expires, id).run();
  return { invite_url: `${origin}/portal/?invite=${encodeURIComponent(token)}`, invite_expires: expires };
}

async function staffByInvite(env, token) {
  if (!token) return null;
  const row = await env.DB.prepare("SELECT * FROM staff WHERE invite_hash = ?").bind(await sha256(token)).first();
  if (!row || !row.invite_expires || row.invite_expires < new Date().toISOString() || row.status === "disabled") return null;
  return row;
}

// A few tries a minute at most per address, so passwords can't be guessed by brute force
async function tooMany(env, request, what) {
  const ip = request.headers.get("CF-Connecting-IP") || "";
  if (!env.CHAT_LIMIT || !ip) return false;
  try {
    return !(await env.CHAT_LIMIT.limit({ key: `portal-${what}:${ip}` })).success;
  } catch {
    return false;
  }
}

async function signedIn(env, request, row, client) {
  const kind = client === "app" ? "token" : "cookie";
  const token = await createSession(env, row.id, { kind, userAgent: request.headers.get("User-Agent") || "" });
  // Read it back, so the profile shows this sign-in
  row = (await env.DB.prepare("SELECT * FROM staff WHERE id = ?").bind(row.id).first()) || row;
  return kind === "token" ? json({ ok: true, staff: profile(row, { full: true }), token }) : json({ ok: true, staff: profile(row, { full: true }) }, 200, { "Set-Cookie": sessionCookie(token) });
}

export async function handlePortal(request, env, ctx, pathname) {
  if (!env.DB) return json({ error: "No database" }, 503);
  const url = new URL(request.url);
  const method = request.method;
  // The Portal badge on other suite sites: who's signed in, and signing out
  const cors = pathname === "/auth/me" || pathname === "/auth/logout" ? suiteCors(request) : {};
  if (method === "OPTIONS") return new Response(null, { status: Object.keys(cors).length ? 204 : 404, headers: cors });
  // Changes from a browser must come from this site; app and profile tokens are exempt
  if (method !== "GET" && method !== "HEAD") {
    const t = tokenOf(request);
    if (!(t && (t.kind === "token" || t.kind === "profile")) && request.headers.get("Origin") !== url.origin) return json({ error: "Forbidden" }, 403);
  }
  const body = method === "POST" || method === "PATCH" ? await request.json().catch(() => ({})) : {};
  const count = async () => (await env.DB.prepare("SELECT COUNT(*) AS n FROM staff").first("n")) || 0;

  // ---- Signing in and out ----
  // Set up yet? And who's signed in (if anyone), in one go, so pages don't need a second request
  if (pathname === "/auth/status" && method === "GET") {
    const me = await requireStaff(request, env);
    return json({ setupNeeded: (await count()) === 0, signedIn: Boolean(me), staff: me ? profile(me, { full: true }) : null });
  }

  if (pathname === "/auth/login" && method === "POST") {
    if (await tooMany(env, request, "login")) return json({ error: "Too many tries. Wait a minute and try again." }, 429);
    const email = text(body.email, 200).toLowerCase();
    const row = email ? await env.DB.prepare("SELECT * FROM staff WHERE email = ?").bind(email).first() : null;
    const ok = await verifyPassword(String(body.password || ""), row && row.password_hash);
    if (!row || !ok) return json({ error: "That email and password don't match." }, 401);
    if (row.status !== "active") return json({ error: row.status === "disabled" ? "This account is switched off. Ask an admin." : "Accept your invite first (the link you were sent)." }, 403);
    return signedIn(env, request, row, body.client);
  }

  if (pathname === "/auth/logout" && method === "POST") {
    await endSession(env, request);
    return json({ ok: true }, 200, { ...cors, "Set-Cookie": clearCookie() });
  }

  // Who's signed in, with their planet's name and colour (every app's Portal badge starts here).
  // A profile token from another suite site gets the profile without the email.
  if (pathname === "/auth/me" && method === "GET") {
    const me = await requireStaff(request, env, { profile: true });
    if (!me) return json({ error: "Not signed in" }, 401, cors);
    const full = me.session_kind !== "profile";
    return json({ staff: { ...profile(me, { full }), planet: await planetFacts(me.planet_seed, profile(me).planet_overrides) }, via: full ? "portal" : "connect" }, 200, cors);
  }

  // Another suite site wants to show who you are: a read-only token, sent back only to a suite site
  if (pathname === "/auth/connect" && method === "POST") {
    const me = await requireStaff(request, env);
    if (!me) return json({ error: "Please sign in" }, 401);
    let to;
    try {
      to = new URL(String(body.return_to || ""));
    } catch {
      return json({ error: "Unknown site" }, 400);
    }
    if (!SUITE_ORIGINS.includes(to.origin)) return json({ error: "That isn't a Nova suite site." }, 400);
    const token = await createSession(env, me.id, { kind: "profile", userAgent: request.headers.get("User-Agent") || "" });
    await env.DB.prepare("UPDATE sessions SET expires_at = ? WHERE id = ?").bind(new Date(Date.now() + PROFILE_DAYS * 864e5).toISOString(), await sha256(token)).run();
    to.hash = `nova_portal=${token}`;
    return json({ ok: true, redirect: to.toString(), site: to.host });
  }

  // The very first account: an admin, proven with the studio's current (shared) password
  if (pathname === "/auth/setup" && method === "POST") {
    if ((await count()) > 0) return json({ error: "Nova Portal is already set up. Sign in instead." }, 409);
    if (await tooMany(env, request, "setup")) return json({ error: "Too many tries. Wait a minute and try again." }, 429);
    if (!env.ADMIN_PASSWORD || !(await sameText(String(body.studio_password || ""), env.ADMIN_PASSWORD))) return json({ error: "That isn't the studio's current password." }, 401);
    const email = text(body.email, 200).toLowerCase();
    if (!validEmail(email)) return json({ error: "Enter a real email address." }, 400);
    const problem = passwordProblem(body.password);
    if (problem) return json({ error: problem }, 400);
    const name = text(body.display_name, 60) || email.split("@")[0];
    const id = await newId(env, name);
    await env.DB.prepare(
      "INSERT INTO staff (id, email, password_hash, display_name, role, status, created_at, planet_seed, index_partition) VALUES (?, ?, ?, ?, 'admin', 'active', ?, ?, ?)"
    )
      .bind(id, email, await hashPassword(body.password), name, new Date().toISOString(), id, `staff:${id}`)
      .run();
    return signedIn(env, request, await env.DB.prepare("SELECT * FROM staff WHERE id = ?").bind(id).first(), body.client);
  }

  if (pathname === "/auth/invite" && method === "GET") {
    const row = await staffByInvite(env, url.searchParams.get("token"));
    return row ? json({ email: row.email, display_name: row.display_name, role: row.role }) : json({ error: "This invite link has expired or was already used. Ask for a new one." }, 404);
  }

  if (pathname === "/auth/invite/accept" && method === "POST") {
    if (await tooMany(env, request, "invite")) return json({ error: "Too many tries. Wait a minute and try again." }, 429);
    const row = await staffByInvite(env, String(body.token || ""));
    if (!row) return json({ error: "This invite link has expired or was already used. Ask for a new one." }, 404);
    const problem = passwordProblem(body.password);
    if (problem) return json({ error: problem }, 400);
    const name = text(body.display_name, 60) || row.display_name;
    await env.DB.prepare("UPDATE staff SET password_hash = ?, status = 'active', display_name = ?, invite_hash = NULL, invite_expires = NULL WHERE id = ?")
      .bind(await hashPassword(body.password), name, row.id)
      .run();
    return signedIn(env, request, await env.DB.prepare("SELECT * FROM staff WHERE id = ?").bind(row.id).first(), body.client);
  }

  // ---- Staff (everything below needs someone signed in, except the profile and planet) ----
  const parts = pathname.split("/").filter(Boolean); // ["staff", id?, sub?]
  if (parts[0] !== "staff") return json({ error: "Not found" }, 404);
  const id = parts[1] ? decodeURIComponent(parts[1]) : "";
  const sub = parts[2] || "";

  // The planet badge: anyone (it's an avatar), cached, drawn fresh from the seed
  if (id && sub === "planet.svg" && method === "GET") {
    const row = await env.DB.prepare("SELECT planet_seed, planet_overrides, display_name FROM staff WHERE id = ?").bind(id).first();
    const seed = row ? row.planet_seed : id;
    let overrides = null;
    try {
      overrides = row && row.planet_overrides ? JSON.parse(row.planet_overrides) : null;
    } catch {}
    const { generatePlanet, renderPlanetSVG, describePlanet, novaTheme: nova } = await import("./planet/index.js");
    const size = Math.min(Math.max(Number(url.searchParams.get("size")) || 256, 16), 1024);
    const planet = generatePlanet(seed, nova, overrides || undefined);
    let svg = renderPlanetSVG(planet, { size, animate: url.searchParams.get("animate") === "1", background: url.searchParams.get("background") === "1", idPrefix: `p${(await sha256(seed)).slice(0, 6).replace(/[^a-z0-9]/gi, "x")}` });
    // The title (alt text) says whose planet it is, its name and what it is
    if (row) {
      const xml = (t) => String(t).replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
      const title = `<title>${xml(row.display_name)} · ${xml(planet.name ? planet.name + ": " : "")}${xml(describePlanet(planet, nova))}</title>`;
      svg = svg.includes("<title>") ? svg.replace(/<title>[\s\S]*?<\/title>/, title) : svg.replace(/(<svg[^>]*>)/, `$1${title}`);
    }
    return new Response(svg, { headers: { "Content-Type": "image/svg+xml; charset=utf-8", "Cache-Control": "public, max-age=300", "Content-Security-Policy": "default-src 'none'; style-src 'unsafe-inline'", "X-Content-Type-Options": "nosniff" } });
  }

  const me = await requireStaff(request, env);
  if (!me) return json({ error: "Please sign in" }, 401);
  const isAdmin = me.role === "admin";

  if (!id && method === "GET") {
    if (!isAdmin) return json({ error: "Admins only" }, 403);
    const { results } = await env.DB.prepare("SELECT * FROM staff ORDER BY role = 'admin' DESC, display_name COLLATE NOCASE").all();
    return json({ staff: results.map((r) => ({ ...profile(r, { full: true }), invite_pending: r.status === "invited" })) });
  }

  if (!id && method === "POST") {
    if (!isAdmin) return json({ error: "Admins only" }, 403);
    const email = text(body.email, 200).toLowerCase();
    if (!validEmail(email)) return json({ error: "Enter a real email address." }, 400);
    if (await env.DB.prepare("SELECT 1 FROM staff WHERE email = ?").bind(email).first()) return json({ error: "Someone with that email is already here." }, 409);
    const name = text(body.display_name, 60) || email.split("@")[0];
    const role = ROLES.includes(body.role) ? body.role : "staff";
    const newIdValue = await newId(env, name);
    await env.DB.prepare(
      "INSERT INTO staff (id, email, display_name, role, status, created_at, planet_seed, index_partition) VALUES (?, ?, ?, ?, 'invited', ?, ?, ?)"
    )
      .bind(newIdValue, email, name, role, new Date().toISOString(), newIdValue, `staff:${newIdValue}`)
      .run();
    const invite = await inviteFor(env, newIdValue, url.origin);
    return json({ ok: true, staff: profile(await env.DB.prepare("SELECT * FROM staff WHERE id = ?").bind(newIdValue).first(), { full: true }), ...invite }, 201);
  }

  const row = id ? await env.DB.prepare("SELECT * FROM staff WHERE id = ?").bind(id).first() : null;
  if (!row) return json({ error: "No one with that id" }, 404);
  const self = row.id === me.id;

  if (!sub && method === "GET") return json({ staff: profile(row, { full: isAdmin || self }) });

  if (sub === "invite" && method === "POST") {
    if (!isAdmin) return json({ error: "Admins only" }, 403);
    if (row.password_hash) return json({ error: "They've already joined." }, 409);
    return json({ ok: true, ...(await inviteFor(env, row.id, url.origin)) });
  }

  if (!sub && method === "PATCH") {
    if (!isAdmin && !self) return json({ error: "Not allowed" }, 403);
    const sets = [];
    const binds = [];
    if (body.display_name !== undefined) {
      const name = text(body.display_name, 60);
      if (!name) return json({ error: "A name is needed." }, 400);
      sets.push("display_name = ?");
      binds.push(name);
    }
    // A new look: a fresh random seed (or back to the original with "reset")
    if (body.planet_seed === "reroll") {
      sets.push("planet_seed = ?");
      binds.push(`${row.id}~${crypto.randomUUID().slice(0, 8)}`);
    } else if (body.planet_seed === "reset") {
      sets.push("planet_seed = ?");
      binds.push(row.id);
    }
    if (body.planet_overrides !== undefined) {
      const o = body.planet_overrides;
      if (o !== null && (typeof o !== "object" || Array.isArray(o) || JSON.stringify(o).length > 2000)) return json({ error: "Planet tweaks must be a small object." }, 400);
      sets.push("planet_overrides = ?");
      binds.push(o === null ? null : JSON.stringify(o));
    }
    if (body.role !== undefined || body.status !== undefined) {
      if (!isAdmin) return json({ error: "Only admins can change roles or switch accounts off." }, 403);
      if (body.role !== undefined) {
        if (!ROLES.includes(body.role)) return json({ error: "Unknown role" }, 400);
        sets.push("role = ?");
        binds.push(body.role);
      }
      if (body.status !== undefined) {
        if (!STATUSES.includes(body.status)) return json({ error: "Unknown status" }, 400);
        // Someone who never set a password can't be "active": switched back on, they're invited again
        sets.push("status = ?");
        binds.push(body.status === "active" && !row.password_hash ? "invited" : body.status);
      }
      // Never leave the studio without an admin
      const demoting = (body.role && body.role !== "admin") || (body.status && body.status !== "active");
      if (row.role === "admin" && demoting) {
        const admins = await env.DB.prepare("SELECT COUNT(*) AS n FROM staff WHERE role = 'admin' AND status = 'active'").first("n");
        if (admins <= 1) return json({ error: "There has to be at least one active admin." }, 409);
      }
    }
    if (!sets.length) return json({ error: "Nothing to change" }, 400);
    await env.DB.prepare(`UPDATE staff SET ${sets.join(", ")} WHERE id = ?`).bind(...binds, row.id).run();
    // Switched off: signed out everywhere
    if (body.status === "disabled") await env.DB.prepare("DELETE FROM sessions WHERE staff_id = ?").bind(row.id).run();
    return json({ ok: true, staff: profile(await env.DB.prepare("SELECT * FROM staff WHERE id = ?").bind(row.id).first(), { full: true }) });
  }

  // Their Nova Index: their own staff partition, plus the studio's shared facts
  if (sub === "index" && method === "GET") {
    if (!isAdmin && !self) return json({ error: "Not allowed" }, 403);
    const files = [...(await listFiles(env, { scopes: ["staff"], owner_id: row.id })), ...(await listFiles(env, { scopes: ["studio"] }))];
    return json({ partition: row.index_partition, files });
  }

  return json({ error: "Not found" }, 404);
}

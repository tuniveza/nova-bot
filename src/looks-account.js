// The Fixer's looks check account: a built-in test sign-in that only looks.
//
// Every hour (and after each deploy) Nova Agent's Fixer opens Nova Agent and every panel in a
// headless browser, signed in and signed out, at phone, tablet and computer sizes, and checks how
// they look (na src/fixer/looks.ts). To see what an admin sees it signs in as this account:
//   - it's made by Nova Agent itself (POST /nova-agent/looks-session with AGENT_NOVA_KEY), never
//     a real person's account; it has no password, so nobody can sign in to it
//   - each session lasts SESSION_MINUTES at most and is deleted when the check ends (with the
//     account itself), so between checks it doesn't exist
//   - it can only LOOK: requireStaff (portal/auth.js) refuses it for anything but GET, HEAD and
//     OPTIONS, and for WebSockets. So it can't send an email, post, book, approve or save anything,
//     even if a page tried. (The check's browser also stops every write before it leaves.)
//   - it's left out of the team list, the status page's head count and the inbox's people

import { COOKIE, createSession } from "./portal/auth.js";

export const LOOKS_ID = "fixer-looks";
const SESSION_MINUTES = 45;
const LOOKING = new Set(["GET", "HEAD", "OPTIONS"]);

// May this request go ahead for this staff member? (false: treat it as signed out)
export function looksAllowed(staffId, request) {
  if (staffId !== LOOKS_ID) return true;
  if (!LOOKING.has(String(request.method || "GET").toUpperCase())) return false;
  if ((request.headers.get("Upgrade") || "").toLowerCase() === "websocket") return false;
  return true;
}

// { action: "start" } -> { token, cookie, minutes }   { action: "end" } -> { ok }
export async function looksSession(env, body) {
  const now = new Date();
  await env.DB.prepare("DELETE FROM sessions WHERE staff_id = ?").bind(LOOKS_ID).run();
  if (body?.action === "end") {
    await env.DB.prepare("DELETE FROM staff WHERE id = ?").bind(LOOKS_ID).run();
    return Response.json({ ok: true });
  }
  if (body?.action !== "start") return Response.json({ error: "Start or end?" }, { status: 400 });
  await env.DB.prepare(
    "INSERT INTO staff (id, email, password_hash, display_name, role, status, created_at, planet_seed, index_partition) VALUES (?, ?, NULL, ?, 'admin', 'active', ?, ?, ?) " +
      "ON CONFLICT(id) DO UPDATE SET password_hash = NULL, role = 'admin', status = 'active'"
  )
    .bind(LOOKS_ID, `${LOOKS_ID}@nova.invalid`, "Fixer looks check", now.toISOString(), LOOKS_ID, `staff:${LOOKS_ID}`)
    .run();
  const token = await createSession(env, LOOKS_ID, { kind: "cookie", userAgent: "Fixer looks check" });
  const until = new Date(now.getTime() + SESSION_MINUTES * 60_000).toISOString();
  await env.DB.prepare("UPDATE sessions SET expires_at = ? WHERE staff_id = ?").bind(until, LOOKS_ID).run();
  return Response.json({ token, cookie: COOKIE, minutes: SESSION_MINUTES }, { headers: { "Cache-Control": "no-store" } });
}

// "Sign in with Google": a Portal sign-in for anyone on the team whose Google account matches
// their Portal email (or the Google email an admin linked to them in Admin → Google).
//
//   GET  /auth/google/available   { available, clientId }: shows the button (and Notes' Google Docs)
//   GET  /auth/google/start       off to Google (?return=/agent/ online; ?popup=1 from a popup)
//                                  Nova Agent on the studio PC: ?pc=<challenge>&back=http://localhost:4545
//   GET  /auth/google/callback    Google sends the browser back here
//   POST /auth/google/exchange    the studio PC swaps its one-time code (and the verifier only it
//                                  has) for an app sign-in, like signing in with a password
//
// Google is asked for nothing but who you are (openid, email). The browser's trip is protected by
// a one-off state and PKCE (kept in a short-lived cookie only this site can read). The studio PC's
// one-time code lasts two minutes, works once, and only with the verifier the PC made up.

import { googleClient } from "../nova/google-keys.js";
import { createSession, sessionCookie, sha256 } from "./auth.js";

const AUTH_URL = "https://accounts.google.com/o/oauth2/v2/auth";
const TOKEN_URL = "https://oauth2.googleapis.com/token";
const COOKIE = "nv_gsign";
const CODE_PREFIX = "google_pc_code:";
const CODE_MS = 120_000;
// Where the studio PC's Nova Agent may ask to be sent back to
const PC_BACK = /^http:\/\/(localhost|127\.0\.0\.1):454[5-9]$/;
export const LOGINS_KEY = "google_logins"; // { "google email": staff id }

const b64url = (bytes) => btoa(String.fromCharCode(...bytes)).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
const random = (n = 32) => b64url(crypto.getRandomValues(new Uint8Array(n)));
export async function challengeOf(verifier) {
  return b64url(new Uint8Array(await crypto.subtle.digest("SHA-256", new TextEncoder().encode(verifier))));
}
const json = (data, status = 200, headers = {}) => new Response(JSON.stringify(data), { status, headers: { "Content-Type": "application/json", "Cache-Control": "no-store", ...headers } });
const callbackUri = (origin) => `${origin}/auth/google/callback`;
// Only this site's own pages (no "//elsewhere")
const safeReturn = (path) => (typeof path === "string" && /^\/(?!\/)[\w\-./?=&%#]*$/.test(path) ? path : "/agent/");

export async function handleGoogleSignIn(request, env, url, pathname, body, signedIn) {
  const method = request.method;
  if (pathname === "/auth/google/available" && method === "GET") {
    const client = await googleClient(env);
    return json({ available: Boolean(client.id), clientId: client.id || "" });
  }
  if (pathname === "/auth/google/start" && method === "GET") return start(env, url);
  if (pathname === "/auth/google/callback" && method === "GET") return callback(request, env, url);
  if (pathname === "/auth/google/exchange" && method === "POST") return exchange(request, env, body, signedIn);
  return json({ error: "Not found" }, 404);
}

async function start(env, url) {
  const client = await googleClient(env);
  const popup = url.searchParams.get("popup") === "1";
  if (!client.id) return finishPage({ popup, ok: false, message: "Google isn't set up yet. Ask an admin: Admin → Google." });
  const pc = url.searchParams.get("pc") || "";
  const back = url.searchParams.get("back") || "";
  if (pc && (!/^[\w-]{43}$/.test(pc) || !PC_BACK.test(back))) return finishPage({ popup, ok: false, message: "That sign-in didn't come from Nova Agent." });
  const flow = { state: random(), verifier: random(), popup, ret: safeReturn(url.searchParams.get("return") || "/agent/"), pc, back };
  const params = new URLSearchParams({
    client_id: client.id,
    redirect_uri: callbackUri(url.origin),
    response_type: "code",
    scope: "openid email",
    state: flow.state,
    code_challenge: await challengeOf(flow.verifier),
    code_challenge_method: "S256",
    prompt: "select_account",
  });
  return new Response(null, {
    status: 302,
    headers: {
      Location: `${AUTH_URL}?${params}`,
      "Set-Cookie": `${COOKIE}=${b64url(new TextEncoder().encode(JSON.stringify(flow)))}; Path=/auth/google; Max-Age=600; HttpOnly; Secure; SameSite=Lax`,
      "Cache-Control": "no-store",
    },
  });
}

function readFlow(request) {
  const m = (request.headers.get("Cookie") || "").match(new RegExp(`(?:^|;\\s*)${COOKIE}=([\\w-]+)`));
  if (!m) return null;
  try {
    return JSON.parse(new TextDecoder().decode(Uint8Array.from(atob(m[1].replace(/-/g, "+").replace(/_/g, "/")), (c) => c.charCodeAt(0))));
  } catch {
    return null;
  }
}

// Who Google says this is (the ID token comes straight from Google's token endpoint, over TLS)
function claims(idToken) {
  try {
    return JSON.parse(atob(String(idToken).split(".")[1].replace(/-/g, "+").replace(/_/g, "/")));
  } catch {
    return {};
  }
}

// The team member a verified Google email belongs to: their Portal email, or one an admin linked
export async function staffForGoogle(env, email) {
  const lower = String(email || "").trim().toLowerCase();
  if (!lower) return null;
  const linked = JSON.parse((await env.DB.prepare("SELECT value FROM settings WHERE key = ?").bind(LOGINS_KEY).first("value")) || "{}");
  if (linked[lower]) {
    const row = await env.DB.prepare("SELECT * FROM staff WHERE id = ?").bind(linked[lower]).first();
    if (row) return row;
  }
  return env.DB.prepare("SELECT * FROM staff WHERE lower(email) = ?").bind(lower).first();
}

async function callback(request, env, url) {
  const flow = readFlow(request);
  const clear = `${COOKIE}=; Path=/auth/google; Max-Age=0; HttpOnly; Secure; SameSite=Lax`;
  const popup = Boolean(flow && flow.popup);
  const fail = (message) => finishPage({ popup, ok: false, message, cookie: clear });
  if (url.searchParams.get("error")) return fail(url.searchParams.get("error") === "access_denied" ? "Google sign-in was cancelled." : "Google said: " + url.searchParams.get("error"));
  if (!flow || !flow.state || flow.state !== url.searchParams.get("state")) return fail("That sign-in took too long or didn't start here. Try again.");
  const client = await googleClient(env);
  if (!client.id) return fail("Google isn't set up yet. Ask an admin: Admin → Google.");

  let who;
  try {
    const res = await fetch(TOKEN_URL, {
      method: "POST",
      headers: { "Content-Type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams({
        code: url.searchParams.get("code") || "",
        client_id: client.id,
        client_secret: client.secret,
        redirect_uri: callbackUri(url.origin),
        grant_type: "authorization_code",
        code_verifier: flow.verifier,
      }),
      signal: AbortSignal.timeout(10_000),
    });
    const data = await res.json().catch(() => ({}));
    if (!res.ok || !data.id_token) throw new Error(data.error_description || data.error || `Google answered ${res.status}`);
    who = claims(data.id_token);
  } catch (err) {
    console.log("Google sign-in failed:", err);
    return fail("Couldn't finish signing in with Google. Try again.");
  }
  const issuer = who.iss === "accounts.google.com" || who.iss === "https://accounts.google.com";
  if (!issuer || who.aud !== client.id || !(Number(who.exp) * 1000 > Date.now())) return fail("Google's answer didn't check out. Try again.");
  if (who.email_verified !== true && who.email_verified !== "true") return fail("That Google account's email isn't verified yet.");

  const staff = await staffForGoogle(env, who.email);
  if (!staff) return fail(`That Google account (${who.email}) isn't on the team yet. Ask an admin for an invite.`);
  if (staff.status !== "active") return fail(staff.status === "disabled" ? "This account is switched off. Ask an admin." : "Accept your invite first (the link you were sent).");

  // The studio PC: a one-time code for it to swap, sent back to it in the address's #fragment
  if (flow.pc) {
    const code = random();
    const expires = String(Date.now() + CODE_MS).padStart(15, "0");
    await env.DB.batch([
      env.DB.prepare("DELETE FROM settings WHERE key >= ? AND key < ?").bind(CODE_PREFIX, CODE_PREFIX + String(Date.now()).padStart(15, "0")),
      env.DB.prepare("INSERT INTO settings (key, value) VALUES (?, ?)").bind(`${CODE_PREFIX}${expires}:${await sha256(code)}`, JSON.stringify({ staff: staff.id, challenge: flow.pc })),
    ]);
    const to = `${flow.back}/auth/google/done${flow.popup ? "?popup=1" : ""}#code=${code}&c=${flow.pc}`;
    return new Response(null, { status: 303, headers: { Location: to, "Set-Cookie": clear, "Cache-Control": "no-store" } });
  }

  const token = await createSession(env, staff.id, { kind: "cookie", userAgent: request.headers.get("User-Agent") || "" });
  return finishPage({ popup, ok: true, message: `Signed in as ${staff.display_name}.`, ret: flow.ret, cookie: [clear, sessionCookie(token)] });
}

async function exchange(request, env, body, signedIn) {
  const code = String(body.code || "");
  const verifier = String(body.verifier || "");
  if (!/^[\w-]{43}$/.test(code) || !/^[\w-]{43}$/.test(verifier)) return json({ error: "That sign-in code isn't right." }, 400);
  const hash = await sha256(code);
  const row = await env.DB.prepare("SELECT key, value FROM settings WHERE key >= ? AND key < ? AND substr(key, -?) = ?")
    .bind(CODE_PREFIX, CODE_PREFIX + "~", hash.length + 1, ":" + hash)
    .first();
  if (!row) return json({ error: "That sign-in code has been used or has run out. Sign in again." }, 401);
  // Once only, whatever happens next
  await env.DB.prepare("DELETE FROM settings WHERE key = ?").bind(row.key).run();
  const expires = Number(row.key.slice(CODE_PREFIX.length).split(":")[0]);
  const { staff: id, challenge } = JSON.parse(row.value);
  if (!(expires > Date.now())) return json({ error: "That sign-in code has run out. Sign in again." }, 401);
  if ((await challengeOf(verifier)) !== challenge) return json({ error: "That sign-in code isn't for this computer." }, 401);
  const staff = await env.DB.prepare("SELECT * FROM staff WHERE id = ?").bind(id).first();
  if (!staff || staff.status !== "active") return json({ error: "This account can't sign in. Ask an admin." }, 403);
  return signedIn(env, request, staff, "app");
}

// The page the browser lands on afterwards. From a popup: tell Nova Agent (and close).
// Otherwise: straight on to Nova Agent (or wherever the sign-in started).
function finishPage({ popup, ok, message, ret = "/agent/", cookie = [] }) {
  const headers = new Headers({ "Content-Type": "text/html; charset=utf-8", "Cache-Control": "no-store", "Content-Security-Policy": "default-src 'none'; script-src 'unsafe-inline'; style-src 'unsafe-inline'" });
  for (const c of [].concat(cookie)) headers.append("Set-Cookie", c);
  if (ok && !popup) {
    headers.set("Location", ret);
    return new Response(null, { status: 303, headers });
  }
  const esc = (t) => String(t).replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c]);
  return new Response(
    `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1"><title>${ok ? "Signed in" : "Sign-in"} · Nova Agent</title>
<style>body{margin:0;min-height:100vh;display:grid;place-items:center;background:#100816;color:#EBD3E7;font:16px/1.5 system-ui,sans-serif;padding:24px}main{max-width:360px;text-align:center}h1{font-size:22px;color:#fff}a{color:#FF5FA8}</style></head>
<body><main><h1>${ok ? "✓ Signed in" : "Not signed in"}</h1><p>${esc(message)}</p><p><a href="${esc(ret)}">Back to Nova Agent</a></p></main>
<script>
try { new BroadcastChannel("nova-portal").postMessage("changed"); } catch (e) {}
try { if (window.opener) window.opener.postMessage({ type: "nova-google", ok: ${ok ? "true" : "false"} }, "*"); } catch (e) {}
${ok ? 'if (window.opener) setTimeout(function () { window.close(); }, 600);' : ""}
</script></body></html>`,
    { status: ok ? 200 : 400, headers }
  );
}

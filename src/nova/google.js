// Google: the studio's Google Calendar (where every booking lives) and Gmail
// (which sends every booking email), through Google's official APIs.
//
// Setting up (once, see README.md "Google Calendar and Gmail"):
//   1. A Google Cloud project with the Calendar and Gmail APIs switched on, and an
//      OAuth client (type "Web application") whose redirect URI is
//      https://<worker>/admin/google/callback
//   2. npx wrangler secret put GOOGLE_CLIENT_ID / GOOGLE_CLIENT_SECRET
//   3. Open /admin/google and press "Connect Google", signed in as the studio's
//      Google account. The refresh token Google hands back is kept in the
//      settings table (or set it yourself as the GOOGLE_REFRESH_TOKEN secret).
// GOOGLE_CALENDAR_ID picks the calendar (default "primary": the account's own).
//
// Sandbox: with SANDBOX=true and no Google keys, everything works offline:
// the "calendar" is just the bookings table, and emails go to the outbox table.

import { TIME_ZONE } from "./studio.js";

const TOKEN_URL = "https://oauth2.googleapis.com/token";
const AUTH_URL = "https://accounts.google.com/o/oauth2/v2/auth";
const CALENDAR = "https://www.googleapis.com/calendar/v3";
const GMAIL = "https://gmail.googleapis.com/gmail/v1/users/me";
export const SCOPES = [
  "https://www.googleapis.com/auth/calendar",
  "https://www.googleapis.com/auth/gmail.send",
  "openid",
  "email",
];
const TIMEOUT_MS = 10_000;

// ===== CONNECTION =====

// Is Google set up (keys, plus a refresh token)? In the sandbox without keys, the offline stand-in counts.
export async function googleReady(env) {
  if (offline(env)) return true;
  return Boolean(env.GOOGLE_CLIENT_ID && env.GOOGLE_CLIENT_SECRET && (await refreshToken(env)));
}

// The sandbox with no Google keys: work without Google
export function offline(env) {
  return env.SANDBOX === "true" && !env.GOOGLE_CLIENT_ID;
}

export const calendarId = (env) => env.GOOGLE_CALENDAR_ID || "primary";

async function refreshToken(env) {
  if (env.GOOGLE_REFRESH_TOKEN) return env.GOOGLE_REFRESH_TOKEN;
  return (await env.DB.prepare("SELECT value FROM settings WHERE key = 'google_refresh_token'").first("value")) || "";
}

// Where Google sends the browser back to after "Connect Google"
export const redirectUri = (origin) => `${origin}/admin/google/callback`;

// The address of Google's "allow access" page. `state` protects the callback.
export function consentUrl(env, origin, state) {
  const params = new URLSearchParams({
    client_id: env.GOOGLE_CLIENT_ID,
    redirect_uri: redirectUri(origin),
    response_type: "code",
    scope: SCOPES.join(" "),
    access_type: "offline", // a refresh token, so it keeps working
    prompt: "consent", // always hand a refresh token back
    include_granted_scopes: "true",
    state,
  });
  return `${AUTH_URL}?${params}`;
}

// Google sent the browser back with a code: swap it for tokens and keep the refresh token.
// Returns the connected account's email.
export async function finishConnecting(env, origin, code) {
  const res = await fetch(TOKEN_URL, {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({
      code,
      client_id: env.GOOGLE_CLIENT_ID,
      client_secret: env.GOOGLE_CLIENT_SECRET,
      redirect_uri: redirectUri(origin),
      grant_type: "authorization_code",
    }),
    signal: AbortSignal.timeout(TIMEOUT_MS),
  });
  const data = await res.json().catch(() => ({}));
  if (!res.ok || !data.refresh_token) throw new Error(data.error_description || data.error || `Google answered ${res.status}`);
  const email = emailFromIdToken(data.id_token);
  const missing = SCOPES.filter((s) => s.startsWith("https://") && !String(data.scope || "").includes(s));
  if (missing.length) throw new Error("Google didn't grant everything Nova Bot needs (tick every box on Google's page): " + missing.join(", "));
  await env.DB.batch([
    setting(env, "google_refresh_token", data.refresh_token),
    setting(env, "google_account", email || ""),
    setting(env, "google_connected_at", new Date().toISOString()),
  ]);
  accessCache = null;
  return email;
}

export async function disconnect(env) {
  await env.DB.prepare("DELETE FROM settings WHERE key IN ('google_refresh_token', 'google_account', 'google_connected_at')").run();
  accessCache = null;
}

// The connected account's email (for the admin page and the From: line)
export async function connectedAccount(env) {
  return (await env.DB.prepare("SELECT value FROM settings WHERE key = 'google_account'").first("value")) || env.GOOGLE_ACCOUNT || "";
}

function setting(env, key, value) {
  return env.DB.prepare("INSERT INTO settings (key, value) VALUES (?, ?) ON CONFLICT (key) DO UPDATE SET value = excluded.value").bind(key, value);
}

function emailFromIdToken(idToken) {
  try {
    const payload = JSON.parse(atob(String(idToken).split(".")[1].replace(/-/g, "+").replace(/_/g, "/")));
    return typeof payload.email === "string" ? payload.email : "";
  } catch {
    return "";
  }
}

// ===== ACCESS TOKENS =====

let accessCache = null; // { token, until }

// For tests
export function forgetGoogleToken() {
  accessCache = null;
}

async function accessToken(env) {
  if (accessCache && Date.now() < accessCache.until) return accessCache.token;
  const refresh = await refreshToken(env);
  if (!env.GOOGLE_CLIENT_ID || !env.GOOGLE_CLIENT_SECRET || !refresh) throw new GoogleError("Google isn't connected yet (see /admin/google).", 0);
  const res = await fetch(TOKEN_URL, {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({ client_id: env.GOOGLE_CLIENT_ID, client_secret: env.GOOGLE_CLIENT_SECRET, refresh_token: refresh, grant_type: "refresh_token" }),
    signal: AbortSignal.timeout(TIMEOUT_MS),
  });
  const data = await res.json().catch(() => ({}));
  if (!res.ok || !data.access_token) {
    // invalid_grant: the access was removed, or the OAuth app is still in "testing" (tokens last 7 days)
    throw new GoogleError(
      data.error === "invalid_grant"
        ? "Google turned down the saved connection (invalid_grant). Reconnect Google at /admin/google."
        : `Couldn't get a Google access token (${data.error || res.status}).`,
      res.status
    );
  }
  accessCache = { token: data.access_token, until: Date.now() + (Number(data.expires_in) || 3600) * 1000 - 60_000 };
  return data.access_token;
}

export class GoogleError extends Error {
  constructor(message, status) {
    super(message);
    this.status = status;
  }
}

// Call a Google API. Returns the JSON answer, or throws GoogleError.
async function google(env, method, url, body) {
  const token = await accessToken(env);
  const res = await fetch(url, {
    method,
    headers: { Authorization: `Bearer ${token}`, ...(body ? { "Content-Type": "application/json" } : {}) },
    body: body ? JSON.stringify(body) : undefined,
    signal: AbortSignal.timeout(TIMEOUT_MS),
  });
  if (res.status === 204) return {};
  const data = await res.json().catch(() => ({}));
  if (!res.ok) {
    const reason = data?.error?.message || data?.error || res.status;
    console.log(`Google ${method} ${url.split("?")[0]} answered ${res.status}:`, String(reason).slice(0, 300));
    throw new GoogleError(`Google ${res.status}: ${String(reason).slice(0, 200)}`, res.status);
  }
  return data;
}

// ===== CALENDAR =====

const cal = (env, path = "") => `${CALENDAR}/calendars/${encodeURIComponent(calendarId(env))}${path}`;

// Busy times between two instants: [[startMs, endMs], ...]. Every event that
// isn't marked "free" counts: bookings, holds and anything staff put in.
export async function busyTimes(env, fromMs, untilMs) {
  if (offline(env)) return [];
  const data = await google(env, "POST", `${CALENDAR}/freeBusy`, {
    timeMin: new Date(fromMs).toISOString(),
    timeMax: new Date(untilMs).toISOString(),
    timeZone: TIME_ZONE,
    items: [{ id: calendarId(env) }],
  });
  const calendar = Object.values(data.calendars || {})[0] || {};
  if (calendar.errors?.length) throw new GoogleError(`Google Calendar couldn't be read (${calendar.errors[0].reason}).`, 0);
  return (calendar.busy || []).map((b) => [Date.parse(b.start), Date.parse(b.end)]).filter(([s, e]) => e > s);
}

// Events between two instants (single events, soonest first), cancelled ones left out
export async function listEvents(env, fromMs, untilMs, { max = 500 } = {}) {
  if (offline(env)) return [];
  const events = [];
  let pageToken = "";
  do {
    const params = new URLSearchParams({
      timeMin: new Date(fromMs).toISOString(),
      timeMax: new Date(untilMs).toISOString(),
      singleEvents: "true",
      orderBy: "startTime",
      maxResults: "250",
      ...(pageToken ? { pageToken } : {}),
    });
    const data = await google(env, "GET", cal(env, `/events?${params}`));
    events.push(...(data.items || []).filter((e) => e.status !== "cancelled"));
    pageToken = data.nextPageToken || "";
  } while (pageToken && events.length < max);
  return events.slice(0, max);
}

export async function insertEvent(env, event) {
  if (offline(env)) return { id: "sandbox-" + crypto.randomUUID().slice(0, 8), htmlLink: "" };
  return google(env, "POST", cal(env, "/events"), event);
}

export async function patchEvent(env, id, changes) {
  if (offline(env) || !id) return {};
  return google(env, "PATCH", cal(env, `/events/${encodeURIComponent(id)}`), changes);
}

export async function deleteEvent(env, id) {
  if (offline(env) || !id) return;
  try {
    await google(env, "DELETE", cal(env, `/events/${encodeURIComponent(id)}`));
  } catch (err) {
    // Already gone (deleted by hand in Google Calendar): that's fine
    if (err.status !== 404 && err.status !== 410) throw err;
  }
}

// ===== GMAIL =====

// Send an email from the connected Google account. Returns Gmail's message id.
// `attachments`: [{ filename, type, content }] (content is text).
export async function sendEmail(env, { to, subject, text, html, attachments = [], replyTo }) {
  if (offline(env)) return "sandbox";
  const from = await connectedAccount(env);
  const raw = buildMime({ from: from ? `Novacane Studios <${from}>` : "", to, subject, text, html, attachments, replyTo });
  const data = await google(env, "POST", `${GMAIL}/messages/send`, { raw: base64Url(raw) });
  return data.id || "";
}

// An email in the format Gmail's API takes (RFC 2822, UTF-8 throughout)
export function buildMime({ from, to, subject, text, html, attachments = [], replyTo }) {
  const boundary = (tag) => `nova-${tag}-${crypto.randomUUID()}`;
  const mixed = boundary("mixed");
  const alt = boundary("alt");
  const lines = [
    ...(from ? [`From: ${from}`] : []),
    `To: ${headerSafe(to)}`,
    ...(replyTo ? [`Reply-To: ${headerSafe(replyTo)}`] : []),
    `Subject: ${encodeHeader(subject)}`,
    "MIME-Version: 1.0",
    `Content-Type: multipart/mixed; boundary="${mixed}"`,
    "",
    `--${mixed}`,
    `Content-Type: multipart/alternative; boundary="${alt}"`,
    "",
    `--${alt}`,
    "Content-Type: text/plain; charset=UTF-8",
    "Content-Transfer-Encoding: base64",
    "",
    wrap(base64(text || "")),
    `--${alt}`,
    "Content-Type: text/html; charset=UTF-8",
    "Content-Transfer-Encoding: base64",
    "",
    wrap(base64(html || "")),
    `--${alt}--`,
  ];
  for (const a of attachments) {
    lines.push(
      `--${mixed}`,
      `Content-Type: ${a.type}; name="${a.filename}"`,
      `Content-Disposition: attachment; filename="${a.filename}"`,
      "Content-Transfer-Encoding: base64",
      "",
      wrap(base64(a.content))
    );
  }
  lines.push(`--${mixed}--`, "");
  return lines.join("\r\n");
}

// Header values can't carry new lines (that would let someone add their own headers)
function headerSafe(value) {
  return String(value || "").replace(/[\r\n]+/g, " ").trim();
}

// Non-ASCII subjects are sent as =?UTF-8?B?...?=
function encodeHeader(value) {
  const clean = headerSafe(value);
  return /^[\x20-\x7e]*$/.test(clean) ? clean : `=?UTF-8?B?${base64(clean)}?=`;
}

function base64(text) {
  const bytes = new TextEncoder().encode(String(text));
  let binary = "";
  for (let i = 0; i < bytes.length; i += 0x8000) binary += String.fromCharCode(...bytes.subarray(i, i + 0x8000));
  return btoa(binary);
}

const base64Url = (text) => base64(text).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
const wrap = (b64) => b64.replace(/.{76}/g, "$&\r\n");

// ===== HEALTH =====

// "" if Calendar and Gmail both answer, otherwise what's wrong
export async function googleProblem(env) {
  if (offline(env)) return "";
  if (!env.GOOGLE_CLIENT_ID || !env.GOOGLE_CLIENT_SECRET) return "The GOOGLE_CLIENT_ID / GOOGLE_CLIENT_SECRET secrets aren't set.";
  if (!(await refreshToken(env))) return "Google isn't connected yet: open /admin/google and press Connect Google.";
  try {
    const now = Date.now();
    await busyTimes(env, now, now + 3_600_000);
    return "";
  } catch (err) {
    return err.message || String(err);
  }
}

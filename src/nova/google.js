// Google: the studio's Google Calendar (where every booking lives) and Gmail
// (which sends every booking email), through Google's official APIs.
//
// Setting up (once): Admin → Google in Nova Agent walks through it, a step at a time:
//   1. A Google Cloud project with the Calendar, Gmail and Drive APIs switched on, and an
//      OAuth client (type "Web application"); its ID and secret are pasted into Admin → Google
//      (google-keys.js keeps them; GOOGLE_CLIENT_ID / GOOGLE_CLIENT_SECRET secrets still work).
//   2. "Connect Google", signed in as the studio's Google account. The refresh token Google
//      hands back is kept encrypted in the settings table (or set GOOGLE_REFRESH_TOKEN).
//   3. (If wanted) "Connect the Calendar account": Calendar then uses a Google account of its own
//      (google_cal_use = "own"), so bookings land in, say, the engineer's calendar while Gmail,
//      Drive and the rest stay on the studio's. Every call to the Calendar API goes with that
//      account's token (google() picks it by the address). Switching: src/google/calendar-account.js.
// GOOGLE_CALENDAR_ID picks the calendar (default "primary": the account's own).
//
// Sandbox: with SANDBOX=true and no Google keys, everything works offline:
// the "calendar" is just the bookings table, and emails go to the outbox table.

import { TIME_ZONE } from "./studio.js";
import { calendarRefreshToken, CAL_REFRESH_KEY, googleClient, keepCalendarRefreshToken, keepRefreshToken, REFRESH_KEYS, refreshToken } from "./google-keys.js";

const TOKEN_URL = "https://oauth2.googleapis.com/token";
const AUTH_URL = "https://accounts.google.com/o/oauth2/v2/auth";
const CALENDAR = "https://www.googleapis.com/calendar/v3";
const GMAIL = "https://gmail.googleapis.com/gmail/v1/users/me";
// The studio's YouTube channel: its numbers, and videos uploaded after an admin's Approve in Social
export const YOUTUBE_SCOPES = ["https://www.googleapis.com/auth/youtube.readonly", "https://www.googleapis.com/auth/youtube.upload"];
export const SCOPES = [
  "https://www.googleapis.com/auth/calendar",
  "https://www.googleapis.com/auth/gmail.send",
  // Reading customers' replies to emails the studio sent (src/google/gmail.js); never changes mail
  "https://www.googleapis.com/auth/gmail.readonly",
  // Clients ⇄ Google Contacts (src/google/contacts.js)
  "https://www.googleapis.com/auth/contacts",
  // Only the files Nova Agent makes itself (its "Nova Agent" folder, the Money sheet, Notes' docs)
  "https://www.googleapis.com/auth/drive.file",
  // The studio's Gmail as Enquiries' inbox: a "Nova" label on what came in, archived when it's done
  "https://www.googleapis.com/auth/gmail.modify",
  // Quests ⇄ a "Nova quests" list in Google Tasks
  "https://www.googleapis.com/auth/tasks",
  // Reading the studio's Drive (Agent's search, opening a Google Doc in Notes); nothing is changed
  "https://www.googleapis.com/auth/drive.readonly",
  // (YouTube is NOT asked for here: Google refuses Drive and YouTube permission in one sign-in,
  // "scopes that cannot be requested together". YouTube gets a sign-in of its own: YOUTUBE_SCOPES.)
  "openid",
  "email",
];
// Each Google feature and the permission it needs (an older connection may lack some: Portal
// says "Connect again to switch on: …")
export const FEATURE_SCOPES = {
  calendar: "https://www.googleapis.com/auth/calendar",
  send: "https://www.googleapis.com/auth/gmail.send",
  replies: "https://www.googleapis.com/auth/gmail.readonly",
  contacts: "https://www.googleapis.com/auth/contacts",
  drive: "https://www.googleapis.com/auth/drive.file",
  modify: "https://www.googleapis.com/auth/gmail.modify",
  tasks: "https://www.googleapis.com/auth/tasks",
  driveRead: "https://www.googleapis.com/auth/drive.readonly",
  youtube: "https://www.googleapis.com/auth/youtube.readonly",
  youtubeUpload: "https://www.googleapis.com/auth/youtube.upload",
};
// What a connection made before these were added was given
const OLD_SCOPES = ["https://www.googleapis.com/auth/calendar", "https://www.googleapis.com/auth/gmail.send"];
const TIMEOUT_MS = 10_000;

// ===== CONNECTION =====

// Is Google set up (keys, plus a refresh token)? In the sandbox without keys, the offline stand-in counts.
export async function googleReady(env) {
  if (offline(env)) return true;
  return Boolean((await googleClient(env)).id && (await refreshToken(env)));
}

// The sandbox with no Google keys: work without Google
export function offline(env) {
  return env.SANDBOX === "true" && !env.GOOGLE_CLIENT_ID;
}

export const calendarId = (env) => env.GOOGLE_CALENDAR_ID || "primary";

// Where Google sends the browser back to after "Connect Google"
export const redirectUri = (origin) => `${origin}/admin/google/callback`;

// The Calendar account's sign-in asks for Calendar alone
export const CALENDAR_SCOPES = [FEATURE_SCOPES.calendar, "openid", "email"];

// The address of Google's "allow access" page. `state` protects the callback.
// `calendar`: the sign-in for Calendar's own account (Google lets them pick which account).
export async function consentUrl(env, origin, state, { calendar = false } = {}) {
  const params = new URLSearchParams({
    client_id: (await googleClient(env)).id,
    redirect_uri: redirectUri(origin),
    response_type: "code",
    scope: (calendar ? CALENDAR_SCOPES : SCOPES).join(" "),
    access_type: "offline", // a refresh token, so it keeps working
    prompt: calendar ? "consent select_account" : "consent", // always hand a refresh token back
    ...(calendar ? {} : { include_granted_scopes: "true" }),
    state,
  });
  return `${AUTH_URL}?${params}`;
}

// Google sent the browser back with a code: swap it for tokens and keep the refresh token.
// Returns the connected account's email. `calendar`: it's Calendar's own account (the caller
// then switches Calendar over: src/google/calendar-account.js).
export async function finishConnecting(env, origin, code, { calendar = false } = {}) {
  const client = await googleClient(env);
  const res = await fetch(TOKEN_URL, {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({
      code,
      client_id: client.id,
      client_secret: client.secret,
      redirect_uri: redirectUri(origin),
      grant_type: "authorization_code",
    }),
    signal: AbortSignal.timeout(TIMEOUT_MS),
  });
  const data = await res.json().catch(() => ({}));
  if (!res.ok || !data.refresh_token) throw new Error(data.error_description || data.error || `Google answered ${res.status}`);
  const email = emailFromIdToken(data.id_token);
  if (calendar) {
    if (!String(data.scope || "").split(/\s+/).includes(FEATURE_SCOPES.calendar)) throw new Error("Google didn't allow Calendar. Press Connect again and tick the Calendar box.");
    if (!email) throw new Error("Google didn't say which account that was. Press Connect again.");
    await env.DB.batch([
      await keepCalendarRefreshToken(env, data.refresh_token),
      setting(env, "google_cal_account", email),
      setting(env, "google_cal_connected_at", new Date().toISOString()),
    ]);
    accessCache.calendar = null;
    return email;
  }
  // What Google granted (someone can untick boxes on Google's page): each feature checks for its
  // own permission, and Portal says which are missing
  const granted = SCOPES.filter((s) => s.startsWith("https://") && String(data.scope || "").split(/\s+/).includes(s));
  if (!granted.length) throw new Error("Google didn't grant anything Nova Agent needs. Press Connect Google again and tick every box.");
  await env.DB.batch([
    ...(await keepRefreshToken(env, data.refresh_token)),
    setting(env, "google_account", email || ""),
    setting(env, "google_connected_at", new Date().toISOString()),
    setting(env, "google_scopes", granted.join(" ")),
    // Connected again: no more "Connect again" in Portal, nothing on hold
    env.DB.prepare("DELETE FROM settings WHERE key IN ('google_reconnect', 'google_reconnect_pinged', 'google_backoff')"),
  ]);
  accessCache.main = null;
  return email;
}

export async function disconnect(env) {
  await env.DB.prepare(`DELETE FROM settings WHERE key IN ('${REFRESH_KEYS.join("', '")}', 'google_account', 'google_connected_at', 'google_scopes')`).run();
  accessCache.main = null;
}

// The connected account's email (for the admin page and the From: line)
export async function connectedAccount(env) {
  return (await env.DB.prepare("SELECT value FROM settings WHERE key = 'google_account'").first("value")) || env.GOOGLE_ACCOUNT || "";
}

// ===== CALENDAR'S OWN ACCOUNT =====

// Does Calendar use its own account just now? (A switch, so it can go back to the studio's without
// signing out; read at most every 20 seconds.)
let calRoute = null; // { own, until }
export async function calendarOwn(env) {
  if (offline(env) || !env.DB) return false;
  if (calRoute && Date.now() < calRoute.until) return calRoute.own;
  const use = await env.DB.prepare("SELECT value FROM settings WHERE key = 'google_cal_use'").first("value").catch(() => null);
  const own = use === "own" && Boolean(await calendarRefreshToken(env));
  calRoute = { own, until: Date.now() + 20_000 };
  return own;
}
export function forgetCalendarRoute() {
  calRoute = null;
  accessCache.calendar = null;
}

// The account signed in for Calendar (whether it's in use or not), or ""
export async function calendarOwnAccount(env) {
  return (await env.DB.prepare("SELECT value FROM settings WHERE key = 'google_cal_account'").first("value").catch(() => null)) || "";
}

// The account whose calendar Nova uses just now
export async function calendarAccount(env) {
  return (await calendarOwn(env)) ? await calendarOwnAccount(env) : await connectedAccount(env);
}

// Forget Calendar's own account (Calendar goes back to the studio's: the caller switches it)
export async function forgetCalendarAccount(env) {
  await env.DB.prepare(`DELETE FROM settings WHERE key IN ('${CAL_REFRESH_KEY}', 'google_cal_account', 'google_cal_connected_at', 'google_cal_use')`).run();
  forgetCalendarRoute();
}

// The permissions the studio's connection has (a connection from before they were saved: the
// two it was always asked for)
export async function grantedScopes(env) {
  if (offline(env)) return SCOPES.filter((s) => s.startsWith("https://"));
  const saved = await env.DB.prepare("SELECT value FROM settings WHERE key = 'google_scopes'").first("value").catch(() => null);
  if (saved) return saved.split(/\s+/).filter(Boolean);
  return (await refreshToken(env)) ? OLD_SCOPES : [];
}

// Is Google connected with the permission this feature needs? (feature: a FEATURE_SCOPES key)
export async function canUse(env, feature) {
  if (!(await googleReady(env))) return false;
  // Calendar's own account was only kept once Google allowed Calendar
  if (feature === "calendar" && (await calendarOwn(env))) return true;
  return (await grantedScopes(env)).includes(FEATURE_SCOPES[feature]);
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

// The studio's account ("main") and Calendar's own ("calendar"): { token, until } each
const accessCache = { main: null, calendar: null };

// For tests
export function forgetGoogleToken() {
  accessCache.main = null;
  accessCache.calendar = null;
  calRoute = null;
}

// Which account a call goes with: Calendar's own for the Calendar API (when it's switched on),
// otherwise the studio's. `as` ("main" | "calendar") says it outright.
async function whichAccount(env, url, as) {
  if (as === "main" || as === "calendar") return as;
  return String(url).startsWith(CALENDAR) && (await calendarOwn(env)) ? "calendar" : "main";
}

async function accessToken(env, which = "main") {
  const cached = accessCache[which];
  if (cached && Date.now() < cached.until) return cached.token;
  const [refresh, client] = await Promise.all([which === "calendar" ? calendarRefreshToken(env) : refreshToken(env), googleClient(env)]);
  if (!client.id || !refresh) {
    throw new GoogleError(which === "calendar" ? "Calendar's own Google account isn't connected (Portal → Admin → Google → Calendar account)." : "Google isn't connected yet (Admin → Google in Nova Agent).", 0);
  }
  const res = await fetch(TOKEN_URL, {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({ client_id: client.id, client_secret: client.secret, refresh_token: refresh, grant_type: "refresh_token" }),
    signal: AbortSignal.timeout(TIMEOUT_MS),
  });
  const data = await res.json().catch(() => ({}));
  if (!res.ok || !data.access_token) {
    // invalid_grant: the access was removed, or the OAuth app is still in "testing" (tokens last 7 days)
    const err = new GoogleError(
      data.error === "invalid_grant"
        ? which === "calendar"
          ? "Google turned down Calendar's own account (invalid_grant). Press Connect again under Calendar account (Portal → Admin → Google)."
          : "Google turned down the saved connection (invalid_grant). Press Connect Google again (Admin → Google)."
        : `Couldn't get a Google access token (${data.error || res.status}).`,
      res.status
    );
    // Only connecting again mends this (src/google/common.js asks an admin, once a day)
    if (data.error === "invalid_grant" || data.error === "unauthorized_client") err.reconnect = true;
    throw err;
  }
  accessCache[which] = { token: data.access_token, until: Date.now() + (Number(data.expires_in) || 3600) * 1000 - 60_000 };
  return data.access_token;
}

export class GoogleError extends Error {
  constructor(message, status) {
    super(message);
    this.status = status;
  }
}

// Call a Google API and get its raw answer (for downloads and uploads). `body` is sent as it is,
// with `headers`; the caller reads the Response. Throws GoogleError only when there's no token.
export async function googleFetch(env, method, url, { body, headers = {}, timeout = TIMEOUT_MS, as } = {}) {
  const token = await accessToken(env, await whichAccount(env, url, as));
  return fetch(url, { method, headers: { Authorization: `Bearer ${token}`, ...headers }, body, signal: AbortSignal.timeout(timeout) });
}

// Google busy or briefly down (429, 500, 502, 503, 504): one more try after a short wait. Longer
// waits are the caller's (src/google/common.js holds the part for a while).
const PASSING = new Set([429, 500, 502, 503, 504]);
const pause = (ms) => new Promise((r) => setTimeout(r, ms));

// Call a Google API. Returns the JSON answer, or throws GoogleError.
// `as`: "main" or "calendar" to pick the account outright (otherwise it goes by the address).
export async function google(env, method, url, body, { as } = {}) {
  const token = await accessToken(env, await whichAccount(env, url, as));
  const send = () =>
    fetch(url, {
      method,
      headers: { Authorization: `Bearer ${token}`, ...(body ? { "Content-Type": "application/json" } : {}) },
      body: body ? JSON.stringify(body) : undefined,
      signal: AbortSignal.timeout(TIMEOUT_MS),
    });
  let res = await send();
  // (a write is only tried again when Google said it was too busy to take it: 429 or 503)
  if (PASSING.has(res.status) && (method === "GET" || res.status === 429 || res.status === 503)) {
    await pause(Number(res.headers.get("Retry-After")) > 0 ? Math.min(Number(res.headers.get("Retry-After")) * 1000, 3000) : 800);
    res = await send();
  }
  if (res.status === 204) return {};
  const data = await res.json().catch(() => ({}));
  if (!res.ok) {
    const reason = data?.error?.message || data?.error || res.status;
    // (the address without its query: a search can have someone's email address in it)
    console.log(`Google ${method} ${url.split("?")[0].replace(/\/(users|people|threads|messages)\/[^/]+/g, "/$1/…")} answered ${res.status}:`, String(reason).slice(0, 300));
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

// One event by its id, or null if there's no such event (or it's been deleted)
export async function getEvent(env, id) {
  if (offline(env) || !id) return null;
  try {
    const event = await google(env, "GET", cal(env, `/events/${encodeURIComponent(id)}`));
    return event && event.status !== "cancelled" ? event : null;
  } catch (err) {
    if (err.status === 404 || err.status === 410) return null;
    throw err;
  }
}

// `as`: which account's calendar ("main" or "calendar"; otherwise the one Calendar uses now)
export async function insertEvent(env, event, { as } = {}) {
  if (offline(env)) return { id: "sandbox-" + crypto.randomUUID().slice(0, 8), htmlLink: "" };
  return google(env, "POST", cal(env, "/events"), event, { as });
}

export async function patchEvent(env, id, changes) {
  if (offline(env) || !id) return {};
  return google(env, "PATCH", cal(env, `/events/${encodeURIComponent(id)}`), changes);
}

export async function deleteEvent(env, id, { as } = {}) {
  if (offline(env) || !id) return;
  try {
    await google(env, "DELETE", cal(env, `/events/${encodeURIComponent(id)}`), undefined, { as });
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
// `headers`: more header lines (List-Unsubscribe, In-Reply-To, References, Message-ID)
// plain: true sends the text alone (Content-Type: text/plain), with no HTML part or attachments
export function buildMime({ from, to, subject, text, html, attachments = [], replyTo, headers = {}, plain = false }) {
  if (plain) {
    return [
      ...(from ? [`From: ${from}`] : []),
      `To: ${headerSafe(to)}`,
      ...(replyTo ? [`Reply-To: ${headerSafe(replyTo)}`] : []),
      `Subject: ${encodeHeader(subject)}`,
      ...Object.entries(headers || {}).filter(([k, v]) => /^[A-Za-z][A-Za-z0-9-]{1,40}$/.test(k) && v).map(([k, v]) => `${k}: ${headerSafe(v)}`),
      "MIME-Version: 1.0",
      "Content-Type: text/plain; charset=utf-8",
      "Content-Transfer-Encoding: base64",
      "",
      wrap(base64(text || "")),
      "",
    ].join("\r\n");
  }
  const boundary = (tag) => `nova-${tag}-${crypto.randomUUID()}`;
  const mixed = boundary("mixed");
  const alt = boundary("alt");
  const lines = [
    ...(from ? [`From: ${from}`] : []),
    `To: ${headerSafe(to)}`,
    ...(replyTo ? [`Reply-To: ${headerSafe(replyTo)}`] : []),
    `Subject: ${encodeHeader(subject)}`,
    ...Object.entries(headers || {}).filter(([k, v]) => /^[A-Za-z][A-Za-z0-9-]{1,40}$/.test(k) && v).map(([k, v]) => `${k}: ${headerSafe(v)}`),
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

export const base64Url = (text) => base64(text).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
const wrap = (b64) => b64.replace(/.{76}/g, "$&\r\n");

// ===== HEALTH =====

// "" if Calendar and Gmail both answer, otherwise what's wrong
export async function googleProblem(env) {
  if (offline(env)) return "";
  if (!(await googleClient(env)).id) return "Google isn't set up yet: Admin → Google.";
  if (!(await refreshToken(env))) return "Google isn't connected yet: Admin → Google, then Connect Google.";
  try {
    const now = Date.now();
    await busyTimes(env, now, now + 3_600_000);
    return "";
  } catch (err) {
    return err.message || String(err);
  }
}

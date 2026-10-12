// Social posts (Quest 4): Facebook and Instagram, only after an admin approves them
// (migrations/0027_social.sql)
//
// Who can do what is decided here and in the routes, whatever any AI says:
//
//   - Nova Agent's AI (AGENT_NOVA_KEY, src/agent-nova.js) can read posts, write a draft, edit one,
//     read comments and draft a reply. Nothing the agent's key reaches approves or posts anything.
//   - Any staff signed in to Portal can do the same, add pictures and videos, and press "I posted
//     it" on an approved post that someone posted by hand.
//   - Only an admin signed in to Portal in a browser (role 'admin' and the session cookie: checked
//     in handleSocialForStaff) can Approve or Reject a post or a reply.
//
// Approving is one guarded UPDATE (… WHERE status = <what the admin saw> AND updated_at = <when it
// last changed>), so two presses approve it once. The approval stores a hash of exactly what was
// approved (the words, the platforms, the pictures and videos, the time). Nothing is posted unless
// the post is approved with a hash that still matches; any edit puts it back to 'pending_approval'
// with the approval cleared. Pictures and videos never change once saved (a new file is a new id),
// so their ids are enough for the hash.
//
// Posting: with Meta connected (META_PAGE_TOKEN with META_PAGE_ID for Facebook, META_IG_USER_ID for
// Instagram) Nova Bot posts through Meta's Graph API, now or at post_at (the minute's cron). Without
// it, an approved post waits as 'manual': Portal shows the words and the files, someone posts it by
// hand and presses "I posted it". A platform that's connected posts by itself; one that isn't waits
// for a person. Each platform keeps its own state (targets), so nothing is ever posted twice: a
// platform that's posted is never posted again, even after an edit and a new approval.
//
// The pictures and videos are on the studio computer (Nova Agent's social-media/ folder) until the
// VPS takes over. Meta fetches them from Nova Bot's /social/media/<post>/<file>?t=<signature>,
// which only answers for a post that's approved (or being posted) with a signature over exactly
// that approval, and fetches the file from the studio computer over its link (src/agent-relay.js).
// So the studio computer must be on when a post goes out. With SOCIAL_MEDIA_BASE set (the VPS
// later), files come from there instead (Bearer SOCIAL_MEDIA_KEY).
//
// Every hour (with Meta connected): how posts from the last 30 days did (reach, likes, comments,
// shares, clicks), followers, and new comments on them. A reply to a comment is a draft until an
// admin approves it. Dealt-with comments are deleted after 90 days.
//
// Logs say ids and counts only, never anyone's words, names or a key. Times are UTC; Portal shows
// UK time.

import { notifyPhones } from "./push.js";
import { publicUrl } from "./nova/booking.js";
import { readTime } from "./acuity/api.js";
import { askPC } from "./agent-relay.js";

export const PLATFORMS = ["facebook", "instagram"];
const PLATFORM_NAMES = { facebook: "Facebook", instagram: "Instagram" };
export const STATUSES = ["draft", "pending_approval", "approved", "scheduled", "posting", "manual", "posted", "failed", "rejected"];
const MEDIA_EXT = { jpg: "image", png: "image", webp: "image", gif: "image", mp4: "video", mov: "video" };
const MEDIA_TYPES = { jpg: "image/jpeg", png: "image/png", webp: "image/webp", gif: "image/gif", mp4: "video/mp4", mov: "video/quicktime" };
const MEDIA_ID = /^[a-f0-9]{32}$/;

// Meta's limits
const IG_CAPTION = 2200;
const IG_HASHTAGS = 30;
const FB_CAPTION = 63206;
const MAX_MEDIA = 10;
// Posts waiting for approval at once, at most (stops a runaway AI filling the list)
const MAX_WAITING = 30;
const MAX_REPLY = 1000;
const MAX_AHEAD_MS = 365 * 86400000;
// A post time this close is "now"
const SOON_MS = 60 * 1000;
// One step of posting holds the post this long at most
const LEASE_MS = 2 * 60 * 1000;
// Instagram gets this long to get a video ready
const PREPARE_MS = 30 * 60 * 1000;
// An approval that didn't start (Nova Bot stopped in between) is picked up after this
const STUCK_APPROVED_MS = 2 * 60 * 1000;
// Results and comments for posts this recent
const RESULTS_DAYS = 30;
const KEEP_COMMENTS_DAYS = 90;
const HOURLY_KEY = "social_hourly_at";
const SECRET_KEY = "social_media_secret";
export const ADS_URL = "https://adsmanager.facebook.com/";

const nowIso = () => new Date().toISOString();
const fail = (status, error) => ({ status, error });
const plural = (n, word) => `${n} ${word}${n === 1 ? "" : "s"}`;

// ===== TIDYING WHAT COMES IN =====

function cleanText(value, max) {
  return typeof value === "string" ? value.replace(/\r\n?/g, "\n").replace(/[ \t]+\n/g, "\n").trim().slice(0, max) : "";
}

function positiveId(value) {
  const n = typeof value === "string" && /^\d{1,12}$/.test(value.trim()) ? Number(value) : value;
  return Number.isInteger(n) && n > 0 ? n : null;
}

function parseJson(value, fallback) {
  try {
    const v = value ? JSON.parse(value) : fallback;
    return v ?? fallback;
  } catch {
    return fallback;
  }
}

// Platforms: "facebook", "instagram", or both (in that order)
function readPlatforms(value) {
  const list = Array.isArray(value) ? value : typeof value === "string" ? value.split(/[\s,]+/) : [];
  const picked = PLATFORMS.filter((p) => list.map((x) => String(x).toLowerCase()).includes(p));
  return picked.length && picked.length === new Set(list.map((x) => String(x).toLowerCase()).filter(Boolean)).size ? picked : null;
}

// The pictures and videos: [{ id, ext, kind, name, size }] (ids from the studio computer's store)
function readMedia(value) {
  if (value === undefined || value === null) return [];
  if (!Array.isArray(value)) return null;
  const out = [];
  for (const m of value) {
    const id = String(m?.id || "").toLowerCase();
    const ext = String(m?.ext || "").toLowerCase();
    if (!MEDIA_ID.test(id) || !MEDIA_EXT[ext]) return null;
    if (out.some((x) => x.id === id)) continue;
    out.push({ id, ext, kind: MEDIA_EXT[ext], name: cleanText(m?.name, 120).replace(/\n/g, " ") || `${MEDIA_EXT[ext]}.${ext}`, size: Number.isInteger(m?.size) && m.size > 0 ? m.size : null });
  }
  return out;
}

const hashtags = (text) => (String(text).match(/(^|\s)#[\p{L}\p{N}_]+/gu) || []).length;

// A post time (UTC ISO, or the UK clock "YYYY-MM-DDTHH:MM") -> { iso } (null = as soon as it's
// approved) or { problem }
function readPostAt(value) {
  if (value === undefined || value === null || value === "") return { iso: null };
  const date = readTime(String(value));
  if (!date) return { problem: 'postAt must be a UK time "YYYY-MM-DDTHH:MM" or a UTC time (ISO 8601), or empty to post once approved.' };
  if (date.getTime() < Date.now()) return { problem: `postAt (${ukWhen(date)}) is in the past.` };
  if (date.getTime() > Date.now() + MAX_AHEAD_MS) return { problem: "postAt is more than a year ahead." };
  return { iso: date.toISOString() };
}

// "Sun 11 Oct 2026, 14:00" (UK)
export function ukWhen(iso) {
  return new Date(iso).toLocaleString("en-GB", { weekday: "short", day: "numeric", month: "short", year: "numeric", hour: "2-digit", minute: "2-digit", timeZone: "Europe/London" });
}
const ukDate = (at = Date.now()) => new Date(at).toLocaleDateString("en-CA", { timeZone: "Europe/London" });

async function sha256Hex(text) {
  const bytes = new Uint8Array(await crypto.subtle.digest("SHA-256", new TextEncoder().encode(text)));
  return [...bytes].map((b) => b.toString(16).padStart(2, "0")).join("");
}

// The hash of exactly what an admin approves: the words, platforms, files and time
export function postHash(row) {
  const media = parseJson(row.media, []).map((m) => `${m.id}.${m.ext}`);
  return sha256Hex(JSON.stringify(["nova-social-v1", row.caption, parseJson(row.platforms, []), media, row.post_at || null]));
}
const replyHash = (c) => sha256Hex(JSON.stringify(["nova-social-reply-v1", c.platform, c.external_id, c.reply]));

// ===== META =====

// Connected, per platform (the page token is Facebook's and Instagram's: Instagram is reached
// through the Facebook Page it's linked to)
export function metaReady(env, platform) {
  const token = String(env.META_PAGE_TOKEN || "").trim();
  if (!token) return false;
  if (platform === "facebook") return Boolean(String(env.META_PAGE_ID || "").trim());
  if (platform === "instagram") return Boolean(String(env.META_IG_USER_ID || "").trim());
  return false;
}
export const readyFor = (env) => Object.fromEntries(PLATFORMS.map((p) => [p, metaReady(env, p)]));

export class MetaError extends Error {
  constructor(message, status = 0, code = null) {
    super(message);
    this.name = "MetaError";
    this.status = status;
    this.code = code;
  }
}

const graphBase = (env) => `https://graph.facebook.com/${String(env.META_GRAPH_VERSION || "v23.0").replace(/[^\w.]/g, "")}`;

// One call to Meta's Graph API with the page token. The token goes in the body (or the address
// for a read) and is never logged or put in an error.
export async function graph(env, method, path, params = {}) {
  const token = String(env.META_PAGE_TOKEN || "").trim();
  if (!token) throw new MetaError("Meta isn't connected (no META_PAGE_TOKEN).");
  const url = new URL(graphBase(env) + path);
  const init = { method, signal: AbortSignal.timeout(30_000) };
  if (method === "GET") {
    for (const [k, v] of Object.entries(params)) url.searchParams.set(k, String(v));
    url.searchParams.set("access_token", token);
  } else {
    const body = new URLSearchParams();
    for (const [k, v] of Object.entries(params)) if (v !== undefined && v !== null) body.set(k, typeof v === "object" ? JSON.stringify(v) : String(v));
    body.set("access_token", token);
    init.body = body;
  }
  let res;
  try {
    res = await fetch(url.toString(), init);
  } catch (err) {
    throw new MetaError(`Couldn't reach Meta (${err?.name || "network"}).`);
  }
  const data = await res.json().catch(() => ({}));
  if (!res.ok || data?.error) {
    const e = data?.error || {};
    const words = String(e.error_user_msg || e.message || `Meta said no (${res.status}).`).replace(/access_token=[^&\s]+/g, "access_token=…").slice(0, 300);
    throw new MetaError(words, res.status, e.code ?? null);
  }
  return data;
}

// ===== THE FILES (on the studio computer, or the VPS later) =====

async function mediaSecret(env) {
  if (env.SOCIAL_MEDIA_SECRET) return String(env.SOCIAL_MEDIA_SECRET);
  await env.DB.prepare("INSERT OR IGNORE INTO settings (key, value) VALUES (?, ?)")
    .bind(SECRET_KEY, [...crypto.getRandomValues(new Uint8Array(32))].map((b) => b.toString(16).padStart(2, "0")).join(""))
    .run();
  return env.DB.prepare("SELECT value FROM settings WHERE key = ?").bind(SECRET_KEY).first("value");
}

async function hmacHex(secret, text) {
  const key = await crypto.subtle.importKey("raw", new TextEncoder().encode(secret), { name: "HMAC", hash: "SHA-256" }, false, ["sign"]);
  const sig = new Uint8Array(await crypto.subtle.sign("HMAC", key, new TextEncoder().encode(text)));
  return [...sig].map((b) => b.toString(16).padStart(2, "0")).join("");
}

// The signature on a file's public address: only good for this post's current approval
export async function mediaSignature(env, postId, mediaId, approvedHash) {
  return hmacHex(await mediaSecret(env), `social-media:${postId}:${mediaId}:${approvedHash}`);
}

// The address Meta fetches a file from
export async function mediaUrl(env, row, m) {
  return `${publicUrl(env)}/social/media/${row.id}/${m.id}.${m.ext}?t=${await mediaSignature(env, row.id, m.id, row.approved_hash)}`;
}

function sameText(a, b) {
  if (typeof a !== "string" || typeof b !== "string" || a.length !== b.length) return false;
  let diff = 0;
  for (let i = 0; i < a.length; i++) diff |= a.charCodeAt(i) ^ b.charCodeAt(i);
  return diff === 0;
}

// A file, from wherever they're kept: the VPS (SOCIAL_MEDIA_BASE) or the studio computer
export async function fetchMedia(env, file, range) {
  const headers = {};
  if (range) headers.Range = range;
  const base = String(env.SOCIAL_MEDIA_BASE || "").trim().replace(/\/+$/, "");
  if (base) {
    if (env.SOCIAL_MEDIA_KEY) headers.Authorization = `Bearer ${env.SOCIAL_MEDIA_KEY}`;
    return fetch(`${base}/${file}`, { headers, signal: AbortSignal.timeout(60_000) });
  }
  return askPC(env, `/social-media/${file}`, { headers });
}

// GET /social/media/<post>/<file>?t=… : a file of an approved post, for Meta to fetch
export async function handleSocialMedia(request, env, pathname) {
  if (request.method !== "GET" && request.method !== "HEAD") return json({ error: "Not allowed" }, 405);
  const m = pathname.match(/^\/social\/media\/(\d{1,12})\/([a-f0-9]{32})\.(jpg|png|webp|gif|mp4|mov)$/);
  if (!m) return json({ error: "Not found" }, 404);
  const [, postId, mediaId, ext] = m;
  const row = await env.DB.prepare("SELECT id, status, media, approved_hash FROM social_posts WHERE id = ?").bind(Number(postId)).first();
  const t = new URL(request.url).searchParams.get("t") || "";
  if (!row || !row.approved_hash || !["approved", "scheduled", "posting"].includes(row.status)) return json({ error: "Not found" }, 404);
  if (!parseJson(row.media, []).some((x) => x.id === mediaId && x.ext === ext)) return json({ error: "Not found" }, 404);
  if (!sameText(t, await mediaSignature(env, row.id, mediaId, row.approved_hash))) return json({ error: "Not found" }, 404);
  let res;
  try {
    res = await fetchMedia(env, `${mediaId}.${ext}`, request.headers.get("Range"));
  } catch {
    return json({ error: "The studio computer couldn't send the file" }, 503);
  }
  if (!res.ok && res.status !== 206) return json({ error: res.status === 503 ? "The studio computer is off or offline" : "The file isn't there" }, res.status === 503 ? 503 : 404);
  const headers = new Headers({ "Content-Type": MEDIA_TYPES[ext], "Cache-Control": "no-store", "X-Content-Type-Options": "nosniff", "Accept-Ranges": "bytes" });
  const range = res.headers.get("Content-Range");
  if (range) headers.set("Content-Range", range);
  if (request.method === "HEAD") {
    res.body?.cancel().catch(() => {});
    const size = res.headers.get("X-Nova-Size") || res.headers.get("Content-Length");
    if (size) headers.set("Content-Length", size);
    return new Response(null, { status: res.status, headers });
  }
  // Meta wants to know how big it is: a stream of a known length says so
  const size = Number(res.headers.get("X-Nova-Size") || res.headers.get("Content-Length") || 0);
  if (size > 0 && res.body && typeof FixedLengthStream === "function") {
    const fixed = new FixedLengthStream(size);
    res.body.pipeTo(fixed.writable).catch(() => {});
    return new Response(fixed.readable, { status: res.status, headers });
  }
  return new Response(res.body, { status: res.status, headers });
}

// ===== READING =====

const SELECT = "SELECT p.*, s.display_name AS decided_by_name FROM social_posts p LEFT JOIN staff s ON s.id = p.decided_by";

const waitingStatus = (s) => s === "draft" || s === "pending_approval";
const FINAL = ["posted", "failed"];

// A post as Portal and Nova Agent see it
export function publicPost(env, row) {
  if (!row) return null;
  const targets = parseJson(row.targets, {});
  const media = parseJson(row.media, []);
  return {
    id: row.id,
    caption: row.caption,
    platforms: parseJson(row.platforms, []),
    media: media.map((m) => ({ ...m, url: `/social-media/${m.id}.${m.ext}` })),
    postAt: row.post_at || null,
    status: row.status,
    createdBy: row.created_by,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
    submittedAt: row.submitted_at || null,
    decidedBy: row.decided_by || null,
    decidedByName: row.decided_by_name || null,
    decidedAt: row.decided_at || null,
    note: row.decision_note || null,
    targets: Object.fromEntries(
      Object.entries(targets).map(([p, t]) => [p, { mode: t.mode || null, state: t.state || null, url: t.url || null, error: t.error || null, postedAt: t.postedAt || null, by: t.by || null }])
    ),
    postedAt: row.posted_at || null,
    error: row.error || null,
    stats: parseJson(row.stats, null),
    portalUrl: `${publicUrl(env)}/portal/?view=social&post=${row.id}`,
  };
}

async function readRow(env, id) {
  return env.DB.prepare(`${SELECT} WHERE p.id = ?`).bind(id).first();
}

export async function getPost(env, id) {
  return publicPost(env, await readRow(env, id));
}

// status: "waiting", one status, or "all": the ones waiting first, then the newest
export async function listPosts(env, { status = "all", limit = 150 } = {}) {
  const order = "ORDER BY CASE WHEN p.status IN ('draft', 'pending_approval') THEN 0 ELSE 1 END, p.id DESC LIMIT ?";
  let query;
  if (status === "waiting") query = env.DB.prepare(`${SELECT} WHERE p.status IN ('draft', 'pending_approval') ${order}`).bind(limit);
  else if (STATUSES.includes(status)) query = env.DB.prepare(`${SELECT} WHERE p.status = ? ${order}`).bind(status, limit);
  else query = env.DB.prepare(`${SELECT} ${order}`).bind(limit);
  const { results } = await query.all();
  return results.map((row) => publicPost(env, row));
}

export async function postLog(env, id) {
  const { results } = await env.DB.prepare(
    'SELECT l.id, l.at, l.event, l."by", l.detail, s.display_name AS by_name FROM social_post_log l LEFT JOIN staff s ON s.id = l."by" WHERE l.post_id = ? ORDER BY l.id'
  )
    .bind(id)
    .all();
  return results.map((r) => ({ id: r.id, at: r.at, event: r.event, by: r.by, byName: r.by_name || null, detail: r.detail || null }));
}

const logEntry = (env, id, event, by, detail = null) =>
  env.DB.prepare('INSERT INTO social_post_log (post_id, at, event, "by", detail) VALUES (?, ?, ?, ?, ?)').bind(id, nowIso(), event, String(by), detail);

// Followers now, and how many more (or fewer) than about 30 days ago, per platform
export async function followerSummary(env) {
  const out = {};
  for (const p of PLATFORMS) {
    const latest = await env.DB.prepare("SELECT day, followers FROM social_followers WHERE platform = ? ORDER BY day DESC LIMIT 1").bind(p).first();
    if (!latest) continue;
    const since = ukDate(Date.now() - 30 * 86400000);
    const before = await env.DB.prepare("SELECT followers FROM social_followers WHERE platform = ? AND day <= ? ORDER BY day DESC LIMIT 1").bind(p, since).first();
    const first = before || (await env.DB.prepare("SELECT followers FROM social_followers WHERE platform = ? ORDER BY day ASC LIMIT 1").bind(p).first());
    out[p] = { followers: latest.followers, day: latest.day, change: first ? latest.followers - first.followers : 0 };
  }
  return out;
}

// ===== WRITING AND EDITING (the AI, or any staff) =====

// Check a post's fields. `base` is what's saved (for an edit: only what's given changes).
// -> { caption, platforms, media, post_at } or { status, error }
function checkFields(input, base = null) {
  const has = (key) => input && Object.hasOwn(input, key) && input[key] !== undefined;
  const caption = has("caption") ? cleanText(input.caption, FB_CAPTION) : base ? base.caption : "";
  const platforms = has("platforms") ? readPlatforms(input.platforms) : base ? parseJson(base.platforms, []) : null;
  if (!platforms) return fail(400, "platforms: facebook, instagram, or both.");
  const media = has("media") ? readMedia(input.media) : base ? parseJson(base.media, []) : [];
  if (!media) return fail(400, "media: the pictures and videos, as uploaded (each with its id and ext).");
  if (media.length > MAX_MEDIA) return fail(400, `At most ${MAX_MEDIA} pictures and videos in one post.`);
  if (!caption && !media.length) return fail(400, "caption: write the post (or add a picture or video).");
  if (platforms.includes("instagram")) {
    if (caption.length > IG_CAPTION) return fail(400, `Instagram allows ${IG_CAPTION} characters; this is ${caption.length}.`);
    if (hashtags(caption) > IG_HASHTAGS) return fail(400, `Instagram allows ${IG_HASHTAGS} hashtags; this has ${hashtags(caption)}.`);
  }
  if (platforms.includes("facebook") && media.some((m) => m.kind === "video") && media.length > 1) return fail(400, "Facebook takes one video on its own, or up to 10 pictures: not a video with other files.");
  let post_at = base ? base.post_at ?? null : null;
  if (has("postAt")) {
    const when = readPostAt(input.postAt);
    if (when.problem) return fail(400, when.problem);
    post_at = when.iso;
  }
  return { caption, platforms, media, post_at };
}

// What still stops it being posted (checked when an admin approves): null when it can go
function notPostable(row) {
  const platforms = parseJson(row.platforms, []);
  const media = parseJson(row.media, []);
  if (platforms.includes("instagram") && !media.length) return "Instagram needs at least one picture or video. Add one with Edit, or untick Instagram.";
  if (row.post_at && Date.parse(row.post_at) < Date.now()) return `Its post time (${ukWhen(row.post_at)}) has passed. Edit the time (or clear it to post now), then approve.`;
  return null;
}

const who = (by) => (by === "agent" ? "Agent" : by === "staff-chat" ? "Portal's staff chat" : "A colleague");
const forPlatforms = (platforms) => parseJson(platforms, platforms || []).map((p) => PLATFORM_NAMES[p] || p).join(" and ");

// A quiet ping to the admins' phones (only theirs: they're the ones who can approve). Not to the
// person who wrote it, if that's an admin.
async function pingAdmins(env, { by, title, body, url, tag }) {
  try {
    const { results } = await env.DB.prepare("SELECT id FROM staff WHERE role = 'admin' AND status = 'active' AND id != ?").bind(String(by)).all();
    if (!results.length) return;
    await notifyPhones(env, { title, body, url, style: { source: "portal", kind: "social", tag, ttl: 12 * 3600, urgent: false }, to: { staff: results.map((r) => r.id) } });
  } catch (err) {
    console.log(`Social: the ping failed (${err?.message})`);
  }
}

// A quiet ping to everyone on the staff (a post to put up by hand, new comments)
async function pingStaff(env, { title, body, url, tag }) {
  try {
    const { results } = await env.DB.prepare("SELECT id FROM staff WHERE status = 'active'").all();
    if (!results.length) return;
    await notifyPhones(env, { title, body, url, style: { source: "portal", kind: "social", tag, ttl: 12 * 3600, urgent: false }, to: { staff: results.map((r) => r.id) } });
  } catch (err) {
    console.log(`Social: the ping failed (${err?.message})`);
  }
}

const postPing = (post, by, edited) => ({
  by,
  title: edited ? "Social post changed: approve it again" : "Social post to approve",
  body: `${who(by)} ${edited ? "changed" : "wrote"} a post for ${forPlatforms(post.platforms)}. Nothing is posted until an admin approves it in Portal → Social.`,
  url: `/portal/?view=social&post=${post.id}`,
  tag: `social-${post.id}`,
});

// A new post, waiting for approval. by: 'agent', 'staff-chat' or a staff id.
export async function createPost(env, input, by) {
  const fields = checkFields(input || {});
  if (fields.error) return fields;
  const { count } = await env.DB.prepare("SELECT COUNT(*) AS count FROM social_posts WHERE status IN ('draft', 'pending_approval')").first();
  if (count >= MAX_WAITING) return fail(429, "There are already many posts waiting for approval. Ask an admin to go through them in Portal → Social first.");
  const now = nowIso();
  const row = await env.DB.prepare(
    `INSERT INTO social_posts (caption, platforms, media, post_at, status, created_by, created_at, updated_at, submitted_at, targets)
     VALUES (?, ?, ?, ?, 'pending_approval', ?, ?, ?, ?, '{}') RETURNING id`
  )
    .bind(fields.caption, JSON.stringify(fields.platforms), JSON.stringify(fields.media), fields.post_at, String(by), now, now, now)
    .first();
  await env.DB.batch([logEntry(env, row.id, "created", by, `For ${forPlatforms(fields.platforms)}${fields.media.length ? `, with ${plural(fields.media.length, "file")}` : ""}`), logEntry(env, row.id, "submitted", by)]);
  const post = await getPost(env, row.id);
  console.log(`Social post ${row.id} written by ${by === "agent" || by === "staff-chat" ? by : "staff"}; waiting for approval`);
  await pingAdmins(env, postPing(post, by, false));
  return { post };
}

// Change a post: back to 'pending_approval', approval cleared. Not while it's being posted, and
// not once it's posted. A platform it already went out on stays posted (and won't be posted again).
export async function editPost(env, by, id, input) {
  id = positiveId(id);
  if (!id) return fail(400, "Which post?");
  const row = await readRow(env, id);
  if (!row) return fail(404, "That post doesn't exist.");
  if (row.status === "posted") return fail(409, "That post has already gone out.");
  if (row.status === "posting" || row.status === "approved") return fail(409, "It's being posted right now.");
  const fields = checkFields(input || {}, row);
  if (fields.error) return fields;
  const before = { caption: row.caption, platforms: parseJson(row.platforms, []), media: parseJson(row.media, []).map((m) => m.id), post_at: row.post_at || null };
  const after = { caption: fields.caption, platforms: fields.platforms, media: fields.media.map((m) => m.id), post_at: fields.post_at };
  const changed = Object.keys(before).filter((k) => JSON.stringify(before[k]) !== JSON.stringify(after[k]));
  if (!changed.length && waitingStatus(row.status)) return { post: publicPost(env, row), unchanged: true };
  // Platforms it already went out on stay posted (they're never posted again)
  const kept = Object.fromEntries(Object.entries(parseJson(row.targets, {})).filter(([, t]) => t.state === "posted"));
  const now = nowIso();
  const { meta } = await env.DB.prepare(
    `UPDATE social_posts SET caption = ?, platforms = ?, media = ?, post_at = ?, status = 'pending_approval', approved_hash = NULL, decided_by = NULL,
       decided_at = NULL, targets = ?, error = NULL, lease_until = NULL, updated_at = ?, submitted_at = ?
     WHERE id = ? AND status = ? AND updated_at = ?`
  )
    .bind(fields.caption, JSON.stringify(fields.platforms), JSON.stringify(fields.media), fields.post_at, JSON.stringify(kept), now, now, id, row.status, row.updated_at)
    .run();
  if (!meta.changes) return fail(409, "Someone else changed it at the same moment. Look at it again.");
  const names = { caption: "the words", platforms: "platforms", media: "pictures and videos", post_at: "post time" };
  const what = changed.length ? `Changed: ${changed.map((k) => names[k]).join(", ")}` : "Sent for approval again";
  await env.DB.batch([logEntry(env, id, "edited", by, what + (row.status === "rejected" ? " (after it was rejected)" : row.status === "scheduled" ? " (it was scheduled: not any more)" : "")), logEntry(env, id, "submitted", by)]);
  const post = await getPost(env, id);
  console.log(`Social post ${id} edited (was ${row.status}); waiting for approval again`);
  await pingAdmins(env, postPing(post, by, true));
  return { post };
}

// ===== AN ADMIN DECIDES (a person pressed a button in Portal; handleSocialForStaff checks who) =====

export async function approvePost(env, me, { id }) {
  id = positiveId(id);
  if (!id) return fail(400, "Which post?");
  const row = await readRow(env, id);
  if (!row) return fail(404, "That post doesn't exist.");
  if (["approved", "scheduled", "posting", "manual", "posted"].includes(row.status)) return { post: publicPost(env, row), repeated: true };
  if (row.status === "rejected") return fail(409, "That post was rejected. Edit it to send it for approval again.");
  if (row.status === "failed") return fail(409, "That post didn't go out. Edit it (or just save it again) to send it for approval again.");
  const problem = notPostable(row);
  if (problem) return fail(409, problem);
  const hash = await postHash(row);
  const now = nowIso();
  // pending -> approved, once, and only as the admin saw it
  const { meta } = await env.DB.prepare(
    `UPDATE social_posts SET status = 'approved', approved_hash = ?, decided_by = ?, decided_at = ?, decision_note = NULL, error = NULL, updated_at = ?
     WHERE id = ? AND status = ? AND updated_at = ?`
  )
    .bind(hash, me.id, now, now, id, row.status, row.updated_at)
    .run();
  if (!meta.changes) {
    const latest = await readRow(env, id);
    if (latest && ["approved", "scheduled", "posting", "manual", "posted"].includes(latest.status)) return { post: publicPost(env, latest), repeated: true };
    return fail(409, "It changed while you were looking at it. Check it again, then approve.");
  }
  await logEntry(env, id, "approved", me.id, `For ${forPlatforms(row.platforms)}${row.post_at ? `, at ${ukWhen(row.post_at)} (UK)` : ", now"}`).run();
  console.log(`Social post ${id} approved by ${me.id}`);
  return { post: await startApproved(env, id) };
}

export async function rejectPost(env, me, { id, note }) {
  id = positiveId(id);
  if (!id) return fail(400, "Which post?");
  const text = cleanText(note, 500) || null;
  const now = nowIso();
  const { meta } = await env.DB.prepare(
    `UPDATE social_posts SET status = 'rejected', approved_hash = NULL, decided_by = ?, decided_at = ?, decision_note = ?, updated_at = ?
     WHERE id = ? AND status IN ('draft', 'pending_approval')`
  )
    .bind(me.id, now, text, now, id)
    .run();
  if (!meta.changes) {
    const row = await readRow(env, id);
    if (!row) return fail(404, "That post doesn't exist.");
    return { ...fail(409, `That post is already ${row.status.replace("_", " ")}.`), post: publicPost(env, row) };
  }
  await logEntry(env, id, "rejected", me.id, text).run();
  console.log(`Social post ${id} rejected by ${me.id}`);
  return { post: await getPost(env, id) };
}

// ===== POSTING =====

// Exactly what was approved? (an approved hash that still matches what's saved)
async function stillApproved(row) {
  return Boolean(row?.approved_hash) && (await postHash(row)) === row.approved_hash;
}

// It changed after approval: back to waiting (nothing posted)
async function backToWaiting(env, id) {
  const now = nowIso();
  await env.DB.batch([
    env.DB.prepare(
      "UPDATE social_posts SET status = 'pending_approval', approved_hash = NULL, decided_by = NULL, decided_at = NULL, lease_until = NULL, error = ?, updated_at = ? WHERE id = ? AND status IN ('approved', 'scheduled', 'posting')"
    ).bind("It changed after it was approved, so it wasn't posted. Check it and approve it again.", now, id),
    logEntry(env, id, "failed", "nova", "Not posted: it changed after it was approved"),
  ]);
  console.log(`Social post ${id}: refused, it changed after approval`);
}

// Just approved: scheduled for later, or started now. Called by the request whose press approved
// it (and by the cron for one that was approved but didn't start).
export async function startApproved(env, id) {
  const row = await readRow(env, id);
  if (!row || row.status !== "approved") return publicPost(env, row);
  if (!(await stillApproved(row))) {
    await backToWaiting(env, id);
    return getPost(env, id);
  }
  if (row.post_at && Date.parse(row.post_at) > Date.now() + SOON_MS) {
    const now = nowIso();
    const { meta } = await env.DB.prepare("UPDATE social_posts SET status = 'scheduled', updated_at = ? WHERE id = ? AND status = 'approved'").bind(now, id).run();
    if (meta.changes) await logEntry(env, id, "scheduled", "nova", `For ${ukWhen(row.post_at)} (UK)`).run();
    return getPost(env, id);
  }
  return begin(env, row);
}

// Its time has come: each platform not posted yet goes by itself (Meta connected) or waits for a
// person (not connected)
async function begin(env, row) {
  const targets = parseJson(row.targets, {});
  const platforms = parseJson(row.platforms, []);
  for (const p of platforms) {
    if (targets[p]?.state === "posted") continue;
    targets[p] = { mode: metaReady(env, p) ? "auto" : "manual", state: "waiting" };
  }
  const auto = platforms.some((p) => targets[p].mode === "auto" && targets[p].state !== "posted");
  const manual = platforms.filter((p) => targets[p].mode === "manual" && targets[p].state !== "posted");
  const status = auto ? "posting" : manual.length ? "manual" : "posted";
  const now = nowIso();
  const { meta } = await env.DB.prepare(`UPDATE social_posts SET status = ?, targets = ?, updated_at = ?${status === "posted" ? ", posted_at = COALESCE(posted_at, ?)" : ""} WHERE id = ? AND status IN ('approved', 'scheduled') AND approved_hash = ?`)
    .bind(...[status, JSON.stringify(targets), now, ...(status === "posted" ? [now] : []), row.id, row.approved_hash])
    .run();
  if (!meta.changes) return getPost(env, row.id);
  const statements = [];
  if (auto) statements.push(logEntry(env, row.id, "posting", "nova", `Posting to ${forPlatforms(platforms.filter((p) => targets[p].mode === "auto" && targets[p].state !== "posted"))}`));
  if (manual.length) statements.push(logEntry(env, row.id, "manual", "nova", `Waiting for someone to post it on ${forPlatforms(manual)} by hand (Meta isn't connected for ${manual.length === 2 ? "either" : "it"})`));
  if (statements.length) await env.DB.batch(statements);
  if (manual.length && !auto) {
    await pingStaff(env, {
      title: "Time to post it by hand",
      body: `An approved post for ${forPlatforms(manual)} is ready to go. Open Portal → Social for the words and the files, post it, then press "I posted it".`,
      url: `/portal/?view=social&post=${row.id}`,
      tag: `social-${row.id}-manual`,
    });
  }
  if (auto) await advance(env, row.id);
  return getPost(env, row.id);
}

const facebookUrl = (id) => `https://www.facebook.com/${encodeURIComponent(id)}`;

// Facebook: one call (several pictures: each uploaded unpublished, then one post with them all)
async function postToFacebook(env, row, t) {
  const page = String(env.META_PAGE_ID).trim();
  const caption = row.caption || "";
  const media = parseJson(row.media, []);
  if (!media.length) {
    const r = await graph(env, "POST", `/${page}/feed`, { message: caption });
    return { id: r.id, objectId: r.id, url: facebookUrl(r.id) };
  }
  if (media.length === 1 && media[0].kind === "video") {
    const r = await graph(env, "POST", `/${page}/videos`, { file_url: await mediaUrl(env, row, media[0]), description: caption });
    return { id: r.id, objectId: r.id, url: `https://www.facebook.com/${encodeURIComponent(page)}/videos/${encodeURIComponent(r.id)}/` };
  }
  if (media.length === 1) {
    const r = await graph(env, "POST", `/${page}/photos`, { url: await mediaUrl(env, row, media[0]), caption });
    const postId = r.post_id || r.id;
    return { id: postId, objectId: postId, url: facebookUrl(postId) };
  }
  const ids = [];
  for (const m of media) ids.push((await graph(env, "POST", `/${page}/photos`, { url: await mediaUrl(env, row, m), published: "false" })).id);
  const params = { message: caption };
  ids.forEach((fbid, i) => (params[`attached_media[${i}]`] = { media_fbid: fbid }));
  const r = await graph(env, "POST", `/${page}/feed`, params);
  return { id: r.id, objectId: r.id, url: facebookUrl(r.id) };
}

// Instagram: containers (one, or one per file and then the carousel), wait until Meta has them
// ready, then publish. Each call moves it on a step; the minute's cron carries on.
// -> "posted" | "waiting"
async function stepInstagram(env, row, t, save) {
  const ig = String(env.META_IG_USER_ID).trim();
  const media = parseJson(row.media, []);
  if (!media.length) throw new MetaError("Instagram needs at least one picture or video.");
  const item = async (m, extra = {}) =>
    (await graph(env, "POST", `/${ig}/media`, m.kind === "video" ? { media_type: extra.is_carousel_item ? "VIDEO" : "REELS", video_url: await mediaUrl(env, row, m), ...extra } : { image_url: await mediaUrl(env, row, m), ...extra })).id;
  if (!t.container && !t.children) {
    t.startedAt = nowIso();
    if (media.length === 1) t.container = await item(media[0], { caption: row.caption || "" });
    else {
      t.children = [];
      for (const m of media) t.children.push(await item(m, { is_carousel_item: "true" }));
    }
    t.state = "preparing";
    await save();
  }
  const ready = async (id) => {
    const s = String((await graph(env, "GET", `/${id}`, { fields: "status_code" })).status_code || "");
    if (s === "ERROR" || s === "EXPIRED") throw new MetaError(`Instagram couldn't use ${media.length > 1 ? "one of the files" : "the file"} (${s.toLowerCase()}). Check it's a JPEG picture or an MP4/MOV video, and that the studio computer was on.`);
    return s === "FINISHED" || s === "PUBLISHED";
  };
  const tooLong = () => t.startedAt && Date.now() - Date.parse(t.startedAt) > PREPARE_MS;
  if (t.children && !t.container) {
    for (const id of t.children) {
      if (!(await ready(id))) {
        if (tooLong()) throw new MetaError("Instagram took too long to get the files ready.");
        return "waiting";
      }
    }
    t.container = (await graph(env, "POST", `/${ig}/media`, { media_type: "CAROUSEL", children: t.children.join(","), caption: row.caption || "" })).id;
    await save();
  }
  if (!(await ready(t.container))) {
    if (tooLong()) throw new MetaError("Instagram took too long to get the files ready.");
    return "waiting";
  }
  t.state = "publishing";
  await save();
  const r = await graph(env, "POST", `/${ig}/media_publish`, { creation_id: t.container });
  t.id = r.id;
  t.objectId = r.id;
  try {
    t.url = (await graph(env, "GET", `/${r.id}`, { fields: "permalink" })).permalink || null;
  } catch {
    t.url = null;
  }
  return "posted";
}

// One step of posting, for a post that's 'posting'. A lease stops the cron and a press doing it
// at the same time. Platforms already posted, or failed, are left alone.
export async function advance(env, id) {
  const now = nowIso();
  const { meta } = await env.DB.prepare("UPDATE social_posts SET lease_until = ? WHERE id = ? AND status = 'posting' AND (lease_until IS NULL OR lease_until < ?)")
    .bind(new Date(Date.now() + LEASE_MS).toISOString(), id, now)
    .run();
  if (!meta.changes) return;
  const row = await readRow(env, id);
  try {
    if (!(await stillApproved(row))) return void (await backToWaiting(env, id));
    const targets = parseJson(row.targets, {});
    const save = () => env.DB.prepare("UPDATE social_posts SET targets = ? WHERE id = ? AND status = 'posting' AND approved_hash = ?").bind(JSON.stringify(targets), id, row.approved_hash).run();
    const events = [];
    for (const p of parseJson(row.platforms, [])) {
      const t = targets[p];
      if (!t || t.mode !== "auto" || FINAL.includes(t.state)) continue;
      try {
        if (p === "facebook") {
          // Stopped half-way last time: it may or may not be on the Page
          if (t.state === "sending") throw new MetaError("Nova Bot stopped while posting to Facebook. Check the Page before posting it again.");
          t.state = "sending";
          await save();
          Object.assign(t, await postToFacebook(env, row, t), { state: "posted", postedAt: nowIso() });
        } else {
          if (t.state === "publishing") throw new MetaError("Nova Bot stopped while publishing to Instagram. Check the account before posting it again.");
          if ((await stepInstagram(env, row, t, save)) === "posted") Object.assign(t, { state: "posted", postedAt: nowIso() });
        }
        if (t.state === "posted") events.push(logEntry(env, id, "posted", "meta", `On ${PLATFORM_NAMES[p]}${t.url ? `: ${t.url}` : ""}`));
      } catch (err) {
        t.state = "failed";
        t.error = err instanceof MetaError ? err.message : "Something went wrong posting it.";
        events.push(logEntry(env, id, "failed", "meta", `${PLATFORM_NAMES[p]}: ${t.error}`));
        console.log(`Social post ${id}: ${p} failed`);
      }
      await save();
    }
    await settle(env, row, targets, events);
  } finally {
    await env.DB.prepare("UPDATE social_posts SET lease_until = NULL WHERE id = ?").bind(id).run();
  }
}

// The post's status from its platforms': still posting, waiting for a person, posted, or failed
function overall(platforms, targets) {
  const ts = platforms.map((p) => targets[p] || { state: "waiting", mode: "manual" });
  if (ts.some((t) => t.mode === "auto" && !FINAL.includes(t.state))) return "posting";
  if (ts.some((t) => t.mode === "manual" && t.state !== "posted")) return "manual";
  if (ts.some((t) => t.state === "failed")) return "failed";
  return "posted";
}

async function settle(env, row, targets, events = []) {
  const platforms = parseJson(row.platforms, []);
  const status = overall(platforms, targets);
  const errors = platforms.filter((p) => targets[p]?.state === "failed").map((p) => `${PLATFORM_NAMES[p]}: ${targets[p].error}`);
  const posted = platforms.filter((p) => targets[p]?.state === "posted");
  const error = status === "failed" ? `${errors.join(" ")}${posted.length ? ` (It did go out on ${forPlatforms(posted)}.)` : ""}` : null;
  const now = nowIso();
  await env.DB.batch([
    env.DB.prepare(`UPDATE social_posts SET status = ?, targets = ?, error = ?, updated_at = ?, posted_at = CASE WHEN ? = 'posted' THEN COALESCE(posted_at, ?) ELSE posted_at END WHERE id = ? AND status IN ('posting', 'manual')`).bind(
      status,
      JSON.stringify(targets),
      error,
      now,
      status,
      now,
      row.id
    ),
    ...events,
  ]);
  if (status !== row.status) console.log(`Social post ${row.id}: ${status}`);
}

// "I posted it": someone put an approved post up by hand on a platform Meta isn't connected for
export async function markPosted(env, me, { id, platform, url }) {
  id = positiveId(id);
  if (!id) return fail(400, "Which post?");
  if (!PLATFORMS.includes(platform)) return fail(400, "Which platform: facebook or instagram?");
  const link = cleanText(url, 600);
  if (link && !/^https:\/\/[^\s]+$/.test(link)) return fail(400, "The link should be the post's address (https://…), or leave it empty.");
  const row = await readRow(env, id);
  if (!row) return fail(404, "That post doesn't exist.");
  if (row.status !== "manual") return fail(409, row.status === "posted" ? "It's already marked as posted." : "Only an approved post waiting to be posted by hand can be marked as posted.");
  const targets = parseJson(row.targets, {});
  const t = targets[platform];
  if (!t || t.mode !== "manual") return fail(409, `It isn't waiting for ${PLATFORM_NAMES[platform]} by hand.`);
  if (t.state === "posted") return { post: publicPost(env, row), repeated: true };
  Object.assign(t, { state: "posted", url: link || null, postedAt: nowIso(), by: me.id });
  const { meta } = await env.DB.prepare("UPDATE social_posts SET targets = ?, updated_at = ? WHERE id = ? AND status = 'manual' AND updated_at = ?").bind(JSON.stringify(targets), nowIso(), id, row.updated_at).run();
  if (!meta.changes) return fail(409, "Someone else changed it at the same moment. Look at it again.");
  await settle(env, { ...row, updated_at: nowIso() }, targets, [logEntry(env, id, "marked_posted", me.id, `Posted by hand on ${PLATFORM_NAMES[platform]}${link ? `: ${link}` : ""}`)]);
  return { post: await getPost(env, id) };
}

// ===== COMMENTS AND REPLIES =====

const COMMENT_SELECT = `SELECT c.*, p.caption AS post_caption, s.display_name AS decided_by_name FROM social_comments c
  LEFT JOIN social_posts p ON p.id = c.post_id LEFT JOIN staff s ON s.id = c.reply_decided_by`;

export function publicComment(row) {
  if (!row) return null;
  return {
    id: row.id,
    postId: row.post_id,
    postCaption: row.post_caption ? String(row.post_caption).slice(0, 120) : null,
    platform: row.platform,
    author: row.author || null,
    text: row.text,
    commentedAt: row.commented_at,
    handled: Boolean(row.handled),
    reply: row.reply || null,
    replyStatus: row.reply_status || null,
    replyBy: row.reply_by || null,
    replyAt: row.reply_at || null,
    decidedByName: row.decided_by_name || null,
    note: row.reply_note || null,
    replySentAt: row.reply_sent_at || null,
    replyError: row.reply_error || null,
  };
}

// Open ones (not dealt with, or a reply waiting) first, newest first
export async function listComments(env, { open = false, limit = 100 } = {}) {
  const where = open ? "WHERE c.handled = 0 OR c.reply_status = 'pending_approval'" : "";
  const { results } = await env.DB.prepare(`${COMMENT_SELECT} ${where} ORDER BY CASE WHEN c.handled = 0 THEN 0 ELSE 1 END, c.commented_at DESC LIMIT ?`).bind(limit).all();
  return results.map(publicComment);
}

const readComment = (env, id) => env.DB.prepare(`${COMMENT_SELECT} WHERE c.id = ?`).bind(id).first();

// A reply to a comment, waiting for an admin (a new draft replaces one that hasn't gone)
export async function draftReply(env, by, { id, text }) {
  id = positiveId(id);
  if (!id) return fail(400, "Which comment?");
  const reply = cleanText(text, MAX_REPLY);
  if (!reply) return fail(400, "Write the reply.");
  const row = await readComment(env, id);
  if (!row) return fail(404, "That comment doesn't exist.");
  if (row.reply_status === "sent") return fail(409, "It's already been answered.");
  if (row.reply_status === "approved") return fail(409, "The reply is being sent right now.");
  const now = nowIso();
  const { meta } = await env.DB.prepare(
    `UPDATE social_comments SET reply = ?, reply_status = 'pending_approval', reply_by = ?, reply_at = ?, reply_hash = NULL, reply_decided_by = NULL,
       reply_decided_at = NULL, reply_note = NULL, reply_error = NULL WHERE id = ? AND (reply_status IS NULL OR reply_status IN ('pending_approval', 'rejected', 'failed'))`
  )
    .bind(reply, String(by), now, id)
    .run();
  if (!meta.changes) return fail(409, "It changed at the same moment. Look at it again.");
  if (row.post_id) await logEntry(env, row.post_id, "reply_drafted", by, `A reply to comment #${id} on ${PLATFORM_NAMES[row.platform]}`).run();
  await pingAdmins(env, { by, title: "Reply to a comment, to approve", body: `${who(by)} wrote a reply to a comment on ${PLATFORM_NAMES[row.platform]}. Nothing is posted until an admin approves it in Portal → Social.`, url: `/portal/?view=social&comment=${id}`, tag: `social-comment-${id}` });
  return { comment: publicComment(await readComment(env, id)) };
}

export async function approveReply(env, me, { id }) {
  id = positiveId(id);
  if (!id) return fail(400, "Which comment?");
  const row = await readComment(env, id);
  if (!row) return fail(404, "That comment doesn't exist.");
  if (row.reply_status === "sent" || row.reply_status === "approved") return { comment: publicComment(row), repeated: true };
  if (row.reply_status !== "pending_approval" || !row.reply) return fail(409, "There's no reply waiting for approval.");
  if (!metaReady(env, row.platform)) return fail(409, `${PLATFORM_NAMES[row.platform]} isn't connected to Nova yet, so Nova can't post the reply. Copy it and answer on ${PLATFORM_NAMES[row.platform]} yourself, then press "Dealt with".`);
  const hash = await replyHash(row);
  const now = nowIso();
  const { meta } = await env.DB.prepare(
    "UPDATE social_comments SET reply_status = 'approved', reply_hash = ?, reply_decided_by = ?, reply_decided_at = ? WHERE id = ? AND reply_status = 'pending_approval' AND reply = ?"
  )
    .bind(hash, me.id, now, id, row.reply)
    .run();
  if (!meta.changes) return fail(409, "It changed while you were looking at it. Check it again, then approve.");
  if (row.post_id) await logEntry(env, row.post_id, "reply_approved", me.id, `The reply to comment #${id}`).run();
  return { comment: await sendReply(env, id) };
}

// Post an approved reply: only with an approval hash that still matches
async function sendReply(env, id) {
  const row = await readComment(env, id);
  if (!row || row.reply_status !== "approved") return publicComment(row);
  if (!row.reply_hash || (await replyHash(row)) !== row.reply_hash) {
    await env.DB.prepare("UPDATE social_comments SET reply_status = 'pending_approval', reply_hash = NULL, reply_error = ? WHERE id = ? AND reply_status = 'approved'").bind("It changed after it was approved. Check it and approve it again.", id).run();
    return publicComment(await readComment(env, id));
  }
  const now = nowIso();
  try {
    const path = row.platform === "instagram" ? `/${row.external_id}/replies` : `/${row.external_id}/comments`;
    const r = await graph(env, "POST", path, { message: row.reply });
    await env.DB.batch([
      env.DB.prepare("UPDATE social_comments SET reply_status = 'sent', reply_external_id = ?, reply_sent_at = ?, handled = 1, reply_error = NULL WHERE id = ? AND reply_status = 'approved'").bind(String(r.id || ""), now, id),
      ...(row.post_id ? [logEntry(env, row.post_id, "reply_sent", "meta", `The reply to comment #${id} is on ${PLATFORM_NAMES[row.platform]}`)] : []),
    ]);
  } catch (err) {
    const why = err instanceof MetaError ? err.message : "Something went wrong posting it.";
    await env.DB.batch([
      env.DB.prepare("UPDATE social_comments SET reply_status = 'failed', reply_error = ? WHERE id = ? AND reply_status = 'approved'").bind(why, id),
      ...(row.post_id ? [logEntry(env, row.post_id, "reply_failed", "meta", `The reply to comment #${id}: ${why}`)] : []),
    ]);
  }
  return publicComment(await readComment(env, id));
}

export async function rejectReply(env, me, { id, note }) {
  id = positiveId(id);
  if (!id) return fail(400, "Which comment?");
  const text = cleanText(note, 500) || null;
  const { meta } = await env.DB.prepare("UPDATE social_comments SET reply_status = 'rejected', reply_hash = NULL, reply_decided_by = ?, reply_decided_at = ?, reply_note = ? WHERE id = ? AND reply_status = 'pending_approval'")
    .bind(me.id, nowIso(), text, id)
    .run();
  const row = await readComment(env, id);
  if (!row) return fail(404, "That comment doesn't exist.");
  if (!meta.changes) return fail(409, "There's no reply waiting for approval.");
  if (row.post_id) await logEntry(env, row.post_id, "reply_rejected", me.id, `The reply to comment #${id}`).run();
  return { comment: publicComment(row) };
}

// "Dealt with" (or not): any staff
export async function setHandled(env, { id, handled }) {
  id = positiveId(id);
  if (!id) return fail(400, "Which comment?");
  const { meta } = await env.DB.prepare("UPDATE social_comments SET handled = ? WHERE id = ?").bind(handled === false ? 0 : 1, id).run();
  if (!meta.changes) return fail(404, "That comment doesn't exist.");
  return { comment: publicComment(await readComment(env, id)) };
}

// ===== EVERY MINUTE AND EVERY HOUR (index.js's cron) =====

const metaTime = (value) => {
  const ms = Date.parse(String(value || "").replace(/([+-]\d{2})(\d{2})$/, "$1:$2"));
  return Number.isNaN(ms) ? nowIso() : new Date(ms).toISOString();
};

// New comments on the studio's posts from the last 30 days
export async function pullComments(env, at = Date.now()) {
  const since = new Date(at - RESULTS_DAYS * 86400000).toISOString();
  const { results } = await env.DB.prepare("SELECT id, targets FROM social_posts WHERE posted_at >= ? OR (status IN ('failed', 'manual') AND updated_at >= ?) ORDER BY id").bind(since, since).all();
  const page = String(env.META_PAGE_ID || "");
  let added = 0;
  for (const post of results) {
    const targets = parseJson(post.targets, {});
    for (const p of PLATFORMS) {
      const t = targets[p];
      if (!t || t.mode !== "auto" || t.state !== "posted" || !t.objectId || !metaReady(env, p)) continue;
      let list = [];
      try {
        if (p === "facebook") list = (await graph(env, "GET", `/${t.objectId}/comments`, { fields: "id,message,from{id,name},created_time", filter: "toplevel", order: "reverse_chronological", limit: 50 })).data || [];
        else list = (await graph(env, "GET", `/${t.objectId}/comments`, { fields: "id,text,username,timestamp", limit: 50 })).data || [];
      } catch (err) {
        console.log(`Social post ${post.id}: ${p} comments couldn't be read (${err?.name})`);
        continue;
      }
      const statements = [];
      for (const c of list) {
        // (the Page's own comments aren't questions for the team)
        if (p === "facebook" && c.from?.id && c.from.id === page) continue;
        const text = cleanText(p === "facebook" ? c.message : c.text, 4000);
        if (!c.id || !text) continue;
        statements.push(
          env.DB.prepare("INSERT OR IGNORE INTO social_comments (post_id, platform, external_id, author, text, commented_at, seen_at) VALUES (?, ?, ?, ?, ?, ?, ?)").bind(
            post.id,
            p,
            String(c.id),
            cleanText(p === "facebook" ? c.from?.name : c.username ? `@${c.username}` : "", 120) || null,
            text,
            metaTime(p === "facebook" ? c.created_time : c.timestamp),
            nowIso()
          )
        );
      }
      if (statements.length) for (const r of await env.DB.batch(statements)) added += r.meta?.changes || 0;
    }
  }
  if (added) {
    await pingStaff(env, { title: `${plural(added, "new comment")} on the studio's posts`, body: "Open Portal → Social to answer them. Replies are posted after an admin approves them.", url: "/portal/?view=social", tag: "social-comments" });
  }
  return added;
}

const num = (v) => (Number.isFinite(Number(v)) ? Number(v) : null);
const firstValue = (data, name) => {
  const m = (data?.data || []).find((x) => x.name === name);
  const v = m?.values?.[0]?.value ?? m?.total_value?.value;
  return num(v);
};

// How one platform's post did (whatever Meta answers: a metric it won't give is left out)
async function platformStats(env, p, t) {
  const out = {};
  if (p === "facebook") {
    const video = /\/videos\//.test(t.url || "");
    try {
      const r = await graph(env, "GET", `/${t.objectId}`, { fields: video ? "likes.summary(true).limit(0),comments.summary(true).limit(0)" : "shares,reactions.summary(true).limit(0),comments.summary(true).limit(0)" });
      out.likes = num((video ? r.likes : r.reactions)?.summary?.total_count);
      out.comments = num(r.comments?.summary?.total_count);
      if (!video) out.shares = num(r.shares?.count) ?? 0;
    } catch {}
    try {
      const r = video ? await graph(env, "GET", `/${t.objectId}/video_insights`, { metric: "total_video_impressions_unique" }) : await graph(env, "GET", `/${t.objectId}/insights`, { metric: "post_impressions_unique,post_clicks" });
      out.reach = firstValue(r, video ? "total_video_impressions_unique" : "post_impressions_unique");
      if (!video) out.clicks = firstValue(r, "post_clicks");
    } catch {}
  } else {
    try {
      const r = await graph(env, "GET", `/${t.objectId}`, { fields: "like_count,comments_count" });
      out.likes = num(r.like_count);
      out.comments = num(r.comments_count);
    } catch {}
    for (const metric of ["reach,shares,saved,views", "reach,shares,saved", "reach"]) {
      try {
        const r = await graph(env, "GET", `/${t.objectId}/insights`, { metric });
        for (const name of metric.split(",")) out[name] = firstValue(r, name);
        break;
      } catch {}
    }
  }
  return Object.fromEntries(Object.entries(out).filter(([, v]) => v !== null && v !== undefined));
}

// The numbers for posts from the last 30 days, and the followers today
export async function refreshResults(env, at = Date.now()) {
  const since = new Date(at - RESULTS_DAYS * 86400000).toISOString();
  const { results } = await env.DB.prepare("SELECT id, targets FROM social_posts WHERE posted_at >= ? OR (status IN ('failed', 'manual') AND updated_at >= ?) ORDER BY id").bind(since, since).all();
  for (const post of results) {
    const targets = parseJson(post.targets, {});
    const stats = {};
    for (const p of PLATFORMS) {
      const t = targets[p];
      if (t?.mode === "auto" && t.state === "posted" && t.objectId && metaReady(env, p)) stats[p] = await platformStats(env, p, t);
    }
    if (!Object.keys(stats).length) continue;
    await env.DB.prepare("UPDATE social_posts SET stats = ? WHERE id = ?").bind(JSON.stringify({ ...stats, fetchedAt: nowIso() }), post.id).run();
  }
  const day = ukDate(at);
  for (const p of PLATFORMS) {
    if (!metaReady(env, p)) continue;
    try {
      const id = p === "facebook" ? env.META_PAGE_ID : env.META_IG_USER_ID;
      const r = await graph(env, "GET", `/${String(id).trim()}`, { fields: "followers_count" });
      const n = num(r.followers_count);
      if (n !== null) await env.DB.prepare("INSERT INTO social_followers (day, platform, followers) VALUES (?, ?, ?) ON CONFLICT (day, platform) DO UPDATE SET followers = excluded.followers").bind(day, p, n).run();
    } catch (err) {
      console.log(`Social: ${p} followers couldn't be read (${err?.name})`);
    }
  }
  return results.length;
}

// Every minute: approved posts that didn't start, scheduled ones whose time has come, and ones
// being posted (Instagram getting a video ready). Every hour: results, followers and comments.
export async function socialOnSchedule(env, at = Date.now()) {
  const now = new Date(at).toISOString();
  const { results } = await env.DB.prepare(
    `SELECT id, status FROM social_posts WHERE (status = 'scheduled' AND (post_at IS NULL OR post_at <= ?)) OR status = 'posting' OR (status = 'approved' AND updated_at <= ?) ORDER BY id LIMIT 20`
  )
    .bind(new Date(at + SOON_MS).toISOString(), new Date(at - STUCK_APPROVED_MS).toISOString())
    .all();
  for (const r of results) {
    try {
      if (r.status === "posting") await advance(env, r.id);
      else if (r.status === "approved") await startApproved(env, r.id);
      else {
        const row = await readRow(env, r.id);
        if (row?.status !== "scheduled") continue;
        if (!(await stillApproved(row))) await backToWaiting(env, r.id);
        else await begin(env, row);
      }
    } catch (err) {
      console.log(`Social post ${r.id}: the minute's check failed (${err?.name})`);
    }
  }

  const last = await env.DB.prepare("SELECT value FROM settings WHERE key = ?").bind(HOURLY_KEY).first("value");
  if (last && at - Date.parse(last) < 3600000) return { due: results.length, hourly: false };
  await env.DB.prepare("INSERT INTO settings (key, value) VALUES (?, ?) ON CONFLICT (key) DO UPDATE SET value = excluded.value").bind(HOURLY_KEY, now).run();
  // Dealt-with comments go after 90 days
  await env.DB.prepare("DELETE FROM social_comments WHERE handled = 1 AND (reply_status IS NULL OR reply_status IN ('sent', 'rejected')) AND commented_at < ?").bind(new Date(at - KEEP_COMMENTS_DAYS * 86400000).toISOString()).run();
  if (!PLATFORMS.some((p) => metaReady(env, p))) return { due: results.length, hourly: true };
  await refreshResults(env, at).catch((err) => console.log("Social: results failed:", err?.name));
  await pullComments(env, at).catch((err) => console.log("Social: comments failed:", err?.name));
  return { due: results.length, hourly: true };
}

// ===== FOR NOVA AGENT =====

export async function socialContext(env) {
  const [recent, followers, comments] = await Promise.all([env.DB.prepare(`${SELECT} ORDER BY p.id DESC LIMIT 6`).all(), followerSummary(env), listComments(env, { open: true, limit: 20 })]);
  return {
    connected: readyFor(env),
    recent: recent.results.map((row) => publicPost(env, row)),
    followers,
    openComments: comments.length,
    today: ukDate(),
  };
}

// ===== ROUTES =====

// Approve and reject: an admin with Portal open in a browser (the cookie), never an app's token,
// other staff, or Nova Agent's key
const canDecide = (me) => me.role === "admin" && me.session_kind === "cookie";

// Portal's /app/api/social… (src/app-page.js has already checked the sign-in and the Origin).
// -> a Response, or null
export async function handleSocialForStaff(request, env, me, route) {
  if (route === "/social" && request.method === "GET") {
    const [posts, comments, followers] = await Promise.all([listPosts(env), listComments(env), followerSummary(env)]);
    return json({ posts, comments, followers, connected: readyFor(env), canDecide: canDecide(me), adsUrl: ADS_URL, limits: { instagramCaption: IG_CAPTION, instagramHashtags: IG_HASHTAGS, facebookCaption: FB_CAPTION, media: MAX_MEDIA } });
  }
  const one = route.match(/^\/social\/(\d{1,12})$/);
  if (one && request.method === "GET") {
    const row = await readRow(env, Number(one[1]));
    if (!row) return json({ error: "That post doesn't exist." }, 404);
    return json({ post: publicPost(env, row), log: await postLog(env, row.id) });
  }
  if (request.method !== "POST") return null;
  if (route === "/social") return answer(await createPost(env, await readJson(request), me.id));
  const edit = route.match(/^\/social\/(\d{1,12})\/edit$/);
  if (edit) return answer(await editPost(env, me.id, Number(edit[1]), await readJson(request)));
  const posted = route.match(/^\/social\/(\d{1,12})\/posted$/);
  if (posted) {
    const body = await readJson(request);
    return answer(await markPosted(env, me, { id: Number(posted[1]), platform: body.platform, url: body.url }));
  }
  const reply = route.match(/^\/social\/comments\/(\d{1,12})\/reply$/);
  if (reply) return answer(await draftReply(env, me.id, { id: Number(reply[1]), text: (await readJson(request)).text }));
  const handled = route.match(/^\/social\/comments\/(\d{1,12})\/handled$/);
  if (handled) return answer(await setHandled(env, { id: Number(handled[1]), handled: (await readJson(request)).handled }));

  const decide = route.match(/^\/social\/(\d{1,12})\/(approve|reject)$/);
  const decideReply = route.match(/^\/social\/comments\/(\d{1,12})\/(approve|reject)$/);
  if (!decide && !decideReply) return null;
  if (!canDecide(me)) {
    return json({ error: "Only an admin, with Portal open in a browser and signed in, can approve or reject a post or a reply.", onlineUrl: `${publicUrl(env)}/portal/?view=social` }, 403);
  }
  const body = await readJson(request);
  if (decide) return answer(decide[2] === "approve" ? await approvePost(env, me, { id: Number(decide[1]) }) : await rejectPost(env, me, { id: Number(decide[1]), note: body.note }));
  return answer(decideReply[2] === "approve" ? await approveReply(env, me, { id: Number(decideReply[1]) }) : await rejectReply(env, me, { id: Number(decideReply[1]), note: body.note }));
}

// Nova Agent's /nova-agent/social… (src/agent-nova.js has already checked the key). Read, write,
// edit and draft replies only: there is no approve or post for the agent's key.
export async function handleSocialForAgent(env, pathname, body) {
  if (pathname === "/nova-agent/social/context") return json(await socialContext(env));
  if (pathname === "/nova-agent/social/draft") {
    // Only these fields are read: a status, hash or approver sent along is ignored
    return answer(await createPost(env, { caption: body?.caption, platforms: body?.platforms, postAt: body?.postAt }, "agent"));
  }
  if (pathname === "/nova-agent/social") return json({ posts: await listPosts(env, { status: typeof body?.status === "string" ? body.status : "all", limit: 50 }) });
  if (pathname === "/nova-agent/social/comments") return json({ comments: await listComments(env, { open: body?.open !== false, limit: 50 }) });
  const reply = pathname.match(/^\/nova-agent\/social\/comments\/(\d{1,12})\/reply$/);
  if (reply) return answer(await draftReply(env, "agent", { id: Number(reply[1]), text: body?.text }));
  const one = pathname.match(/^\/nova-agent\/social\/(\d{1,12})$/);
  if (one) {
    const post = await getPost(env, Number(one[1]));
    return post ? json({ post, log: await postLog(env, post.id) }) : json({ error: "That post doesn't exist." }, 404);
  }
  const edit = pathname.match(/^\/nova-agent\/social\/(\d{1,12})\/edit$/);
  if (edit) {
    // The agent changes the words, platforms and time; the pictures and videos are a person's
    const changes = {};
    for (const key of ["caption", "platforms", "postAt"]) if (body && Object.hasOwn(body, key)) changes[key] = body[key];
    return answer(await editPost(env, "agent", Number(edit[1]), changes));
  }
  return json({ error: "Not found" }, 404);
}

// ===== SHARED =====

function answer(result) {
  if (result?.error) {
    const { status, ...rest } = result;
    return json(rest, status || 400);
  }
  return json({ ok: true, ...result });
}

async function readJson(request) {
  try {
    return (await request.json()) || {};
  } catch {
    return {};
  }
}

function json(data, status = 200) {
  return new Response(JSON.stringify(data), { status, headers: { "Content-Type": "application/json", "Cache-Control": "no-store" } });
}

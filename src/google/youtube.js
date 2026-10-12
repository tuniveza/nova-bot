// YouTube: the studio's channel (Portal → Admin → Google → "YouTube"; posting is Social's)
//
// Posting: YouTube is one of Social's places to post (src/social.js). A post for YouTube is one
// video with its words; it's uploaded only when an admin has approved exactly that post (Social's
// approval rules, the same as Facebook's and Instagram's). The first line of the words is the
// video's title (100 characters at most), all of them its description; "#Shorts" in the words makes
// it a Short. The video comes from its copy in Google Drive (or the studio PC), straight through to
// YouTube without being held in memory.
//   Note: Google keeps videos uploaded through a new Google Cloud project private until YouTube has
//   audited the project (Google's rule). Until then, make each one public in YouTube Studio.
// Numbers: each video's views, likes and comments (with the other platforms' results in Social), and
// the channel's subscribers, views and videos once a day.

import { canUse, google, googleFetch, GoogleError } from "../nova/google.js";
import { partOn, readSetting, writeSetting } from "./common.js";

const API = "https://www.googleapis.com/youtube/v3";
const UPLOAD = "https://www.googleapis.com/upload/youtube/v3/videos";
const CHANNEL_KEY = "google_youtube_channel";

// Connected for uploading (Social posts there by itself), or just for reading the numbers
export async function youtubeReady(env) {
  return (await partOn(env, "youtube").catch(() => false)) && (await canUse(env, "youtubeUpload").catch(() => false));
}
export const youtubeReadable = (env) => partOn(env, "youtube").catch(() => false);

// The video's title and description from a post's words
export function youtubeText(caption) {
  const text = String(caption || "").replace(/[<>]/g, "").trim();
  const first = text.split("\n").map((l) => l.trim()).find(Boolean) || "New video from Novacane Studios";
  return { title: first.slice(0, 100), description: text.slice(0, 5000), short: /(^|\s)#shorts\b/i.test(text) };
}

// Upload one video. `source`: a Response with the file (its body is streamed to YouTube).
// -> { id, url }
export async function uploadVideo(env, { caption, source, type = "video/mp4", size = null }) {
  const { title, description, short } = youtubeText(caption);
  let length = Number(source.headers.get("Content-Length")) || Number(size) || 0;
  let body = source.body;
  if (!length) {
    // No length given: read it in (the studio's videos are 25 MB at most through the PC's link)
    const buf = await source.arrayBuffer();
    length = buf.byteLength;
    body = buf;
  }
  const start = await googleFetch(env, "POST", `${UPLOAD}?uploadType=resumable&part=snippet,status`, {
    body: JSON.stringify({
      snippet: { title, description, categoryId: "10" }, // Music
      status: { privacyStatus: "public", selfDeclaredMadeForKids: false },
    }),
    headers: { "Content-Type": "application/json; charset=UTF-8", "X-Upload-Content-Type": type, "X-Upload-Content-Length": String(length) },
  });
  const session = start.headers.get("Location");
  if (!start.ok || !session) {
    const data = await start.json().catch(() => ({}));
    throw new GoogleError(`YouTube wouldn't start the upload (${data?.error?.message || start.status}).`, start.status || 502);
  }
  // Straight through, at its known length (FixedLengthStream: Cloudflare Workers)
  if (body && typeof body.pipeTo === "function" && typeof FixedLengthStream === "function") {
    const { readable, writable } = new FixedLengthStream(length);
    body.pipeTo(writable).catch(() => {});
    body = readable;
  }
  const put = await googleFetch(env, "PUT", session, { body, headers: { "Content-Type": type }, timeout: 300_000 });
  const data = await put.json().catch(() => ({}));
  if (!put.ok || !data.id) throw new GoogleError(`YouTube didn't take the video (${data?.error?.message || put.status}).`, put.status || 502);
  return { id: data.id, url: short ? `https://youtube.com/shorts/${data.id}` : `https://youtu.be/${data.id}` };
}

// Views, likes and comments for videos (by id). -> { id: { views, likes, comments } }
export async function videoStats(env, ids) {
  const out = {};
  const list = [...new Set(ids.filter(Boolean))];
  for (let i = 0; i < list.length; i += 50) {
    const data = await google(env, "GET", `${API}/videos?${new URLSearchParams({ part: "statistics", id: list.slice(i, i + 50).join(",") })}`);
    for (const v of data.items || []) {
      const s = v.statistics || {};
      out[v.id] = Object.fromEntries(Object.entries({ views: s.viewCount, likes: s.likeCount, comments: s.commentCount }).filter(([, x]) => x !== undefined).map(([k, x]) => [k, Number(x)]));
    }
  }
  return out;
}

// The channel's numbers (once a day kept, with yesterday's, for "+12 this week" style changes)
export async function channelStats(env, { refresh = false } = {}) {
  let saved = null;
  try {
    saved = JSON.parse((await readSetting(env, CHANNEL_KEY)) || "null");
  } catch {}
  const today = new Date().toLocaleDateString("en-CA", { timeZone: "Europe/London" });
  if (saved && saved.day === today && !refresh) return saved;
  const data = await google(env, "GET", `${API}/channels?${new URLSearchParams({ part: "statistics,snippet", mine: "true" })}`);
  const c = (data.items || [])[0];
  if (!c) return saved;
  const s = c.statistics || {};
  const now = { day: today, title: c.snippet?.title || "", subscribers: s.hiddenSubscriberCount ? null : Number(s.subscriberCount || 0), views: Number(s.viewCount || 0), videos: Number(s.videoCount || 0) };
  const next = saved && saved.day !== today ? { ...now, before: { day: saved.day, subscribers: saved.subscribers, views: saved.views } } : { ...now, before: saved?.before || null };
  await writeSetting(env, CHANNEL_KEY, JSON.stringify(next)).run();
  return next;
}

// For Agent's youtube_stats: the channel, and the latest videos' numbers
export async function youtubeSummary(env, { max = 10 } = {}) {
  const channel = await channelStats(env, { refresh: true });
  const ch = await google(env, "GET", `${API}/channels?${new URLSearchParams({ part: "contentDetails", mine: "true" })}`);
  const uploads = ch.items?.[0]?.contentDetails?.relatedPlaylists?.uploads;
  const videos = [];
  if (uploads) {
    const pl = await google(env, "GET", `${API}/playlistItems?${new URLSearchParams({ part: "snippet", playlistId: uploads, maxResults: String(Math.min(max, 25)) })}`);
    const items = (pl.items || []).map((i) => ({ id: i.snippet?.resourceId?.videoId, title: i.snippet?.title || "", published: i.snippet?.publishedAt || null }));
    const stats = await videoStats(env, items.map((i) => i.id));
    for (const i of items) videos.push({ ...i, url: `https://youtu.be/${i.id}`, ...(stats[i.id] || {}) });
  }
  return { channel, videos };
}

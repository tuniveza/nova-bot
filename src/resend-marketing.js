// Resend's marketing API (contacts, segments, broadcasts), for email campaigns (src/campaigns.js)
//
// Needs a FULL-ACCESS key: the secret RESEND_MARKETING_KEY, else RESEND_API_KEY (which works
// only if it was made with full access; a sending-only key gets 401/403 here).
//
// Resend allows about 2 requests a second, so calls are spaced out (RESEND_GAP_MS, 550 ms by
// default) and a 429 waits (Resend's Retry-After, else RESEND_BACKOFF_MS) and tries again, up
// to 3 times. Nothing here logs the key, an email address or anyone's details.

const API = "https://api.resend.com";
const RETRIES = 3;

// When the next call may go (shared by every call this Worker makes)
let nextSlot = 0;

export class ResendError extends Error {
  constructor(message, status = 0) {
    super(message);
    this.name = "ResendError";
    this.status = status;
  }
}

// The key for the marketing API ("" if none)
export function marketingKey(env) {
  return String(env.RESEND_MARKETING_KEY || env.RESEND_API_KEY || "").trim();
}

const wait = (ms) => (ms > 0 ? new Promise((resolve) => setTimeout(resolve, ms)) : Promise.resolve());

function gapMs(env) {
  const n = Number(env.RESEND_GAP_MS ?? 550);
  return Number.isFinite(n) && n >= 0 ? n : 550;
}

function backoffMs(env, res, attempt) {
  const after = Number(res.headers.get("Retry-After"));
  if (Number.isFinite(after) && after > 0) return Math.min(after, 10) * 1000;
  const base = Number(env.RESEND_BACKOFF_MS ?? 1000);
  return (Number.isFinite(base) && base >= 0 ? base : 1000) * attempt;
}

// Wait for our turn, so calls are at least the gap apart
async function takeSlot(env) {
  const now = Date.now();
  const at = Math.max(now, nextSlot);
  nextSlot = at + gapMs(env);
  await wait(at - now);
}

// One call. -> { ok, status, data } (Resend's answer, or { message } if it wasn't JSON).
// Throws a ResendError if there's no key or Resend can't be reached.
export async function resendApi(env, method, path, body) {
  const key = marketingKey(env);
  if (!key) throw new ResendError("Resend isn't set up (no RESEND_MARKETING_KEY or RESEND_API_KEY).");
  for (let attempt = 1; ; attempt++) {
    await takeSlot(env);
    let res;
    try {
      res = await fetch(API + path, {
        method,
        headers: { Authorization: `Bearer ${key}`, "Content-Type": "application/json" },
        ...(body === undefined ? {} : { body: JSON.stringify(body) }),
      });
    } catch (err) {
      throw new ResendError("Couldn't reach Resend: " + String(err?.message || err).slice(0, 100));
    }
    if (res.status === 429 && attempt <= RETRIES) {
      await wait(backoffMs(env, res, attempt));
      continue;
    }
    let data = null;
    try {
      data = await res.json();
    } catch {
      data = {};
    }
    return { ok: res.ok, status: res.status, data: data || {} };
  }
}

// Resend's reason for saying no, in a sentence
export function resendReason(answer) {
  const said = answer?.data?.message || answer?.data?.error || "";
  if (answer?.status === 401 || answer?.status === 403) return `Resend refused the key (${answer.status}): the campaigns need a full-access key (RESEND_MARKETING_KEY).`;
  if (answer?.status === 429) return "Resend is busy (too many requests). Try again in a minute.";
  return `Resend said ${answer?.status || "no"}${said ? `: ${String(said).slice(0, 200)}` : ""}.`;
}

// Every item of a paged list (Resend's cursor pagination: ?limit=&after=<last id>), up to `max`
export async function listAll(env, path, { max = 20000, limit = 100 } = {}) {
  const items = [];
  let after = "";
  for (;;) {
    const sep = path.includes("?") ? "&" : "?";
    const answer = await resendApi(env, "GET", `${path}${sep}limit=${limit}${after ? `&after=${encodeURIComponent(after)}` : ""}`);
    if (!answer.ok) throw new ResendError(resendReason(answer), answer.status);
    const page = Array.isArray(answer.data.data) ? answer.data.data : [];
    items.push(...page);
    if (items.length >= max) return { items: items.slice(0, max), capped: true };
    if (!answer.data.has_more || !page.length) return { items, capped: false };
    after = page[page.length - 1].id || "";
    if (!after) return { items, capped: false };
  }
}

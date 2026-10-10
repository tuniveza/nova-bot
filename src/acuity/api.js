// Acuity's official API: the one way Nova Bot talks to it
//
// Every call to https://acuityscheduling.com/api/v1 goes through acuityRequest(), so they all
// sign in the same way (Basic auth from the ACUITY_USER_ID and ACUITY_API_KEY secrets), give up
// after 10 seconds, and cope with Acuity being busy or down in the same way:
//
//   - 429 (too many requests): wait (what Acuity's Retry-After asks, 3 seconds at most) and
//     try again, twice at most. Still busy: an AcuityError with kind "rateLimited".
//   - 5xx, a network problem or the 10 seconds running out: try once more, then an
//     AcuityError with kind "unreachable". Never for a POST (making a booking or a blocked
//     time), which may have gone through even though no answer came: trying again could
//     make it twice.
//   - Anything else (200, 400, 404…) comes back as { ok, status, data } for the caller to read.
//
// The read helpers below turn Acuity's answers into the shapes Nova Agent gets (see
// /nova-agent/acuity/* in src/agent-nova.js): times in UTC (ISO 8601), labels in UK time.
// Logs name the path and status only, never the keys or anyone's details.

export const ACUITY_API = "https://acuityscheduling.com/api/v1";

const TIMEOUT_MS = 10_000;
const MAX_RATE_RETRIES = 2;
const MAX_RATE_WAIT_MS = 3000;
const SERVER_RETRY_WAIT_MS = 500;
// The most appointments or blocked times one read lists
const MAX_LISTED = 200;

// Acuity being busy, down or not set up (what the routes turn into 429, 503 or 409)
export class AcuityError extends Error {
  constructor(kind, message, status = 0) {
    super(message);
    this.kind = kind; // "unreachable" | "refused" | "rateLimited" | "notSetUp"
    this.status = status;
  }
}

export const acuityReady = (env) => Boolean(env?.ACUITY_USER_ID && env?.ACUITY_API_KEY);

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

// One call to Acuity's API. `path` starts with "/" and may carry a query. Returns
// { ok, status, data }, or throws an AcuityError (see the top of this file).
export async function acuityRequest(env, method, path, body) {
  if (!acuityReady(env)) throw new AcuityError("notSetUp", "Acuity's API isn't set up (it needs the ACUITY_USER_ID and ACUITY_API_KEY secrets).");
  const where = `${method} ${path.split("?")[0]}`;
  const canRepeat = method !== "POST";
  let rateRetries = 0;
  let serverRetries = 0;
  for (;;) {
    let res;
    try {
      res = await fetch(ACUITY_API + path, {
        method,
        headers: {
          Authorization: "Basic " + btoa(`${env.ACUITY_USER_ID.trim()}:${env.ACUITY_API_KEY.trim()}`),
          Accept: "application/json",
          ...(body ? { "Content-Type": "application/json" } : {}),
        },
        body: body ? JSON.stringify(body) : undefined,
        signal: AbortSignal.timeout(TIMEOUT_MS),
      });
    } catch (err) {
      const reason = err?.name === "TimeoutError" || err?.name === "AbortError" ? "no answer within 10 seconds" : "couldn't connect";
      if (canRepeat && serverRetries < 1) {
        serverRetries++;
        await sleep(SERVER_RETRY_WAIT_MS);
        continue;
      }
      console.log(`Acuity ${where}: ${reason}`);
      throw new AcuityError("unreachable", `Acuity unreachable: ${reason}.`);
    }

    if (res.status === 429) {
      if (rateRetries < MAX_RATE_RETRIES) {
        rateRetries++;
        await sleep(retryAfterMs(res.headers.get("Retry-After")));
        continue;
      }
      console.log(`Acuity ${where} answered 429 (still busy after ${MAX_RATE_RETRIES} retries)`);
      throw new AcuityError("rateLimited", "Acuity is busy right now (too many requests). Try again in a minute.", 429);
    }
    if (res.status >= 500) {
      if (canRepeat && serverRetries < 1) {
        serverRetries++;
        await sleep(SERVER_RETRY_WAIT_MS);
        continue;
      }
      console.log(`Acuity ${where} answered ${res.status}`);
      throw new AcuityError("unreachable", `Acuity unreachable: it answered ${res.status}.`, res.status);
    }

    const data = await res.json().catch(() => ({}));
    if (!res.ok) console.log(`Acuity ${where} answered ${res.status}`);
    return { ok: res.ok, status: res.status, data };
  }
}

// Retry-After in seconds (or an HTTP date), capped
function retryAfterMs(value) {
  if (value === null || value === undefined || value === "") return 1000;
  const seconds = Number(value);
  const ms = Number.isFinite(seconds) ? seconds * 1000 : Date.parse(value) - Date.now();
  return Math.min(Math.max(Number.isFinite(ms) ? ms : 1000, 0), MAX_RATE_WAIT_MS);
}

// An AcuityError (or anything else thrown) as { status, body } for a route to answer with
export function acuityFailure(err) {
  if (err instanceof AcuityError) {
    if (err.kind === "rateLimited") return { status: 429, body: { error: err.message, rateLimited: true } };
    if (err.kind === "notSetUp") return { status: 409, body: { error: err.message } };
    if (err.kind === "refused") return { status: 502, body: { error: err.message, refused: true } };
    return { status: 503, body: { error: err.message, unreachable: true } };
  }
  console.log("Acuity: something went wrong:", err?.message || err);
  return { status: 503, body: { error: "Acuity unreachable: something went wrong reading its answer.", unreachable: true } };
}

// What Acuity said went wrong, for a person to read
export function acuityMessage(data) {
  return String(data?.message || data?.error || "no reason given").slice(0, 300);
}

// ===== UK TIME =====
// Acuity works in the studio's time (Europe/London: GMT in winter, BST in summer).

const LONDON = "Europe/London";

// How far London is ahead of UTC at this moment, in minutes (0 or 60)
export function londonOffsetMinutes(ms) {
  const parts = Object.fromEntries(
    new Intl.DateTimeFormat("en-GB", { timeZone: LONDON, hourCycle: "h23", year: "numeric", month: "2-digit", day: "2-digit", hour: "2-digit", minute: "2-digit", second: "2-digit" })
      .formatToParts(new Date(ms))
      .map((p) => [p.type, p.value])
  );
  const asUtc = Date.UTC(+parts.year, +parts.month - 1, +parts.day, +parts.hour, +parts.minute, +parts.second);
  return Math.round((asUtc - Math.floor(ms / 1000) * 1000) / 60000);
}

// "2026-10-31T17:00" (a clock on the studio wall) -> the UTC moment, or null if it isn't a
// real UK time (e.g. 01:30 on the morning the clocks go forward). On the night the clocks go
// back, an hour that happens twice means the first (BST) one.
export function ukWallToUtc(text) {
  const m = String(text || "").match(/^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2})(?::(\d{2}))?$/);
  if (!m) return null;
  const wall = Date.UTC(+m[1], +m[2] - 1, +m[3], +m[4], +m[5], +(m[6] || 0));
  if (!Number.isFinite(wall)) return null;
  // Try BST first, then GMT: the first that reads back as the same wall clock
  for (const offset of [60, 0]) {
    const ms = wall - offset * 60000;
    if (londonOffsetMinutes(ms) === offset) return new Date(ms);
  }
  return null;
}

// Any time Nova Agent or the AI gives: UTC ISO ("…Z" or with an offset) or a UK wall clock
// ("YYYY-MM-DDTHH:MM"). -> a Date, or null.
export function readTime(value) {
  if (typeof value !== "string") return null;
  const text = value.trim();
  if (/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}(:\d{2})?$/.test(text)) return ukWallToUtc(text);
  if (/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}(:\d{2}(\.\d+)?)?(Z|[+-]\d{2}:?\d{2})$/.test(text)) {
    const date = new Date(text.replace(/([+-]\d{2})(\d{2})$/, "$1:$2"));
    return Number.isNaN(date.getTime()) ? null : date;
  }
  return null;
}

// A moment as Acuity wants it: London's wall clock with its offset, "2026-10-31T17:00:00+00:00"
export function toLondonIso(date) {
  const ms = new Date(date).getTime();
  const offset = londonOffsetMinutes(ms);
  const wall = new Date(ms + offset * 60000).toISOString().slice(0, 19);
  const sign = offset < 0 ? "-" : "+";
  const abs = Math.abs(offset);
  return `${wall}${sign}${String(Math.floor(abs / 60)).padStart(2, "0")}:${String(abs % 60).padStart(2, "0")}`;
}

// Acuity's own times ("2026-10-31T17:00:00+0000") -> UTC ISO, or null
export function acuityTimeToUtc(value) {
  const date = readTime(String(value || ""));
  return date ? date.toISOString() : null;
}

// "17:00" in UK time
export function ukClock(date) {
  return new Date(date).toLocaleTimeString("en-GB", { hour: "2-digit", minute: "2-digit", hourCycle: "h23", timeZone: LONDON });
}

// "Sat 31 Oct 17:00" in UK time
export function ukShort(date) {
  const day = new Date(date).toLocaleDateString("en-GB", { weekday: "short", day: "numeric", month: "short", timeZone: LONDON }).replace(/,/g, "");
  return `${day} ${ukClock(date)}`;
}

// A UK day "YYYY-MM-DD"?
export function isUkDate(value) {
  return typeof value === "string" && /^\d{4}-\d{2}-\d{2}$/.test(value) && !Number.isNaN(Date.parse(value + "T00:00:00Z"));
}

export function daysBetween(from, to) {
  return Math.round((Date.parse(to + "T00:00:00Z") - Date.parse(from + "T00:00:00Z")) / 86400000);
}

// Acuity answered, but no: a refusal (401/403: the keys, or the plan doesn't include the API)
// says so plainly; anything else counts as unreachable
function answeredNo(status, data) {
  if (status === 401 || status === 403) return new AcuityError("refused", `Acuity refused: ${acuityMessage(data)}`, status);
  return new AcuityError("unreachable", `Acuity unreachable: it answered ${status} (${acuityMessage(data)}).`, status);
}

// ===== READS (each throws an AcuityError if Acuity is busy, down or refuses) =====

async function readList(env, path) {
  const { ok, status, data } = await acuityRequest(env, "GET", path);
  if (!ok) throw answeredNo(status, data);
  return Array.isArray(data) ? data : [];
}

// A booking as Nova Agent sees it (times in UTC)
export function appointmentShape(a) {
  const start = acuityTimeToUtc(a.datetime);
  const minutes = Number(a.duration);
  const end = start && Number.isFinite(minutes) && minutes > 0 ? new Date(Date.parse(start) + minutes * 60000).toISOString() : start;
  return {
    id: a.id,
    start,
    end,
    type: a.type || "",
    typeId: a.appointmentTypeID ?? null,
    name: `${a.firstName || ""} ${a.lastName || ""}`.trim(),
    email: a.email || "",
    phone: a.phone || "",
    price: a.price ?? null,
    paid: a.paid === "yes",
    amountPaid: a.amountPaid ?? null,
    notes: a.notes || "",
    canceled: Boolean(a.canceled),
    calendar: a.calendar || "",
    calendarId: a.calendarID ?? null,
  };
}

// Bookings on these UK days (inclusive), oldest first. Cancelled ones only with includeCanceled.
export async function listAppointments(env, { from, to, includeCanceled = false }) {
  const query = new URLSearchParams({ minDate: from, maxDate: to, max: String(MAX_LISTED), direction: "ASC" });
  if (includeCanceled) query.set("showall", "true");
  return (await readList(env, `/appointments?${query}`)).map(appointmentShape);
}

// One booking (Acuity's own shape), or null if there's no such booking
export async function getAppointment(env, id) {
  const { ok, status, data } = await acuityRequest(env, "GET", `/appointments/${Number(id)}`);
  if (ok && data?.id === Number(id)) return data;
  if (status === 400 || status === 404) return null;
  throw answeredNo(status, data);
}

// Free start times for a session type on one UK day
export async function availableTimes(env, { typeId, date }) {
  const list = await readList(env, `/availability/times?appointmentTypeID=${Number(typeId)}&date=${date}`);
  return list
    .map((slot) => acuityTimeToUtc(slot.time))
    .filter(Boolean)
    .map((start) => ({ start, label: ukClock(start) }));
}

// A blocked-off time as Nova Agent sees it
export function blockShape(b) {
  return {
    id: b.id,
    start: acuityTimeToUtc(b.start),
    end: acuityTimeToUtc(b.end),
    notes: b.notes || b.description || "",
    calendar: b.calendar || "",
    calendarId: b.calendarID ?? null,
  };
}

export async function listBlocks(env, { from, to }) {
  const query = new URLSearchParams({ minDate: from, maxDate: to, max: String(MAX_LISTED) });
  return (await readList(env, `/blocks?${query}`)).map(blockShape);
}

// One blocked time (Acuity's own shape), or null
export async function getBlock(env, id) {
  const { ok, status, data } = await acuityRequest(env, "GET", `/blocks/${Number(id)}`);
  if (ok && data?.id === Number(id)) return data;
  if (status === 400 || status === 404) return null;
  throw answeredNo(status, data);
}

export async function listTypes(env) {
  return (await readList(env, "/appointment-types")).map((t) => ({
    id: t.id,
    name: t.name || "",
    price: t.price ?? null,
    duration: t.duration ?? null,
    active: t.active !== false,
    private: Boolean(t.private),
  }));
}

export async function searchClients(env, search) {
  const list = await readList(env, `/clients?search=${encodeURIComponent(search)}`);
  return list.slice(0, 25).map((c) => ({ firstName: c.firstName || "", lastName: c.lastName || "", email: c.email || "", phone: c.phone || "", notes: c.notes || "" }));
}

export async function listCalendars(env) {
  return (await readList(env, "/calendars")).map((c) => ({ id: c.id, name: c.name || "" }));
}

// UK time helpers for times staff, Nova Agent and the AI give (the studio works in Europe/London:
// GMT in winter, BST in summer). Used by booking changes, campaigns, social posts and the client list.

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

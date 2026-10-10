// Calendar: the studio's events and day cards, kept here (D1, calendar_items) so the
// Calendar panel works from anywhere, even with the studio PC off.
//
//   GET    /app/api/calendar/items?since=N   what changed since rev N (everything for 0)
//   PUT    /app/api/calendar/items/:id       { item } save an event or day card
//   DELETE /app/api/calendar/items/:id?updated=ISO   delete one
//   POST   /nova-agent/calendar               Nova Agent's copy on the PC: { since, upserts, deletes }
//
// Two copies can change the same thing: the change made last wins (each change carries
// the time it was made, `updated`), and the loser is told what's there now. Nova Agent's
// own entries (its plan: ids starting quest-, block-, mile-) only change from the PC.

import { cleanRepeat } from "./recur.js";

const isDate = (s) => typeof s === "string" && /^\d{4}-\d{2}-\d{2}$/.test(s);
const isStamp = (s) => typeof s === "string" && /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}/.test(s);
const text = (v, max) => (typeof v === "string" ? v.slice(0, max) : "");
const isoNow = () => new Date().toISOString();
export const COLORS = ["rose", "violet", "blue", "teal", "green", "amber", "orange", "red", "grey"];
// Nova Agent's plan, shown in the calendar: changed only by Nova Agent itself
export const isAgentItem = (id) => /^(quest|block|mile)-/.test(String(id || ""));

// A tidy item, or null. Fields the panel doesn't know are dropped.
export function cleanItem(raw) {
  if (!raw || typeof raw !== "object") return null;
  const id = text(raw.id, 64).replace(/[^\w.:-]/g, "");
  if (!id) return null;
  const updated = isStamp(raw.updated) ? text(raw.updated, 40) : isoNow();
  const created = text(raw.created, 40) || updated;
  if (raw.kind === "day") {
    if (!isDate(raw.date)) return null;
    return {
      kind: "day",
      id,
      date: raw.date,
      preset: text(raw.preset, 40) || "custom",
      title: text(raw.title, 80),
      aesthetic: text(raw.aesthetic, 30) || "nebula",
      theme: text(raw.theme, 30) || "app",
      info: text(raw.info, 4000),
      location: text(raw.location, 120),
      tags: Array.isArray(raw.tags) ? raw.tags.map((t) => text(t, 30)).filter(Boolean).slice(0, 12) : [],
      repeat: raw.repeat === "yearly" ? "yearly" : "none",
      artSalt: text(raw.artSalt, 40),
      created,
      updated,
    };
  }
  if (!isStamp(raw.start)) return null;
  const start = raw.start.slice(0, 16);
  const end = isStamp(raw.end) && raw.end.slice(0, 16) >= start ? raw.end.slice(0, 16) : start;
  const item = {
    kind: "event",
    id,
    title: text(raw.title, 120),
    body: text(raw.body, 5000),
    author: text(raw.author, 60),
    start,
    end,
    allDay: raw.allDay === true,
    location: text(raw.location, 160),
    color: COLORS.includes(raw.color) ? raw.color : "",
    reminders: Array.isArray(raw.reminders)
      ? [...new Set(raw.reminders.map(Number).filter((m) => Number.isInteger(m) && m >= 0 && m <= 40320))].slice(0, 5).sort((a, b) => a - b)
      : [],
    art: raw.art && typeof raw.art === "object" ? { seed: Number(raw.art.seed) >>> 0, subject: text(raw.art.subject, 30) || "auto" } : undefined,
    created,
    updated,
  };
  const repeat = cleanRepeat(raw.repeat);
  if (repeat) {
    item.repeat = repeat;
    item.exdates = Array.isArray(raw.exdates) ? [...new Set(raw.exdates.filter(isDate))].slice(0, 500) : [];
  }
  if (!item.art) delete item.art;
  return item;
}

function fromRow(row) {
  let data = {};
  try {
    data = JSON.parse(row.data);
  } catch {}
  return row.deleted ? { id: row.id, kind: row.kind, deleted: true, updated: row.updated } : { ...data, id: row.id, kind: row.kind, updated: row.updated };
}

export async function currentRev(env) {
  return (await env.DB.prepare("SELECT COALESCE(MAX(rev), 0) AS rev FROM calendar_items").first("rev")) || 0;
}

// What changed since rev N (deleted ones too, so copies can drop them)
export async function changesSince(env, since = 0) {
  const { results } = await env.DB.prepare("SELECT * FROM calendar_items WHERE rev > ? ORDER BY rev").bind(Math.max(0, Math.floor(Number(since) || 0))).all();
  // On a first load, deleted ones are left out: there's nothing to drop yet
  const items = results.filter((r) => since > 0 || !r.deleted).map(fromRow);
  return { rev: results.length ? results[results.length - 1].rev : await currentRev(env), items };
}

async function stored(env, id) {
  const row = await env.DB.prepare("SELECT * FROM calendar_items WHERE id = ?").bind(id).first();
  return row ? fromRow(row) : null;
}

// Save one: kept if it's the latest change (or new). Returns { ok, item } or
// { ok: false, current } when a later change is already here.
export async function saveItem(env, raw) {
  const item = cleanItem(raw);
  if (!item) return { ok: false, error: "That isn't a calendar item." };
  const res = await env.DB.prepare(
    `INSERT INTO calendar_items (id, kind, data, start, updated, deleted, rev)
     VALUES (?1, ?2, ?3, ?4, ?5, 0, (SELECT COALESCE(MAX(rev), 0) + 1 FROM calendar_items))
     ON CONFLICT (id) DO UPDATE SET kind = excluded.kind, data = excluded.data, start = excluded.start,
       updated = excluded.updated, deleted = 0, rev = excluded.rev
     WHERE excluded.updated > calendar_items.updated OR (excluded.updated = calendar_items.updated AND (excluded.data != calendar_items.data OR calendar_items.deleted = 1))`
  )
    .bind(item.id, item.kind, JSON.stringify(item), item.kind === "day" ? item.date : item.start, item.updated)
    .run();
  if (res.meta.changes) return { ok: true, item };
  const current = await stored(env, item.id);
  // Sent again exactly as it is (a copy catching up): nothing to do
  if (current && !current.deleted && current.updated === item.updated) return { ok: true, item: current, unchanged: true };
  return { ok: false, current };
}

// Delete one (kept as a marker so other copies drop it too), unless it changed after
export async function deleteItem(env, id, updated = isoNow()) {
  const when = isStamp(updated) ? updated : isoNow();
  const res = await env.DB.prepare(
    `UPDATE calendar_items SET deleted = 1, data = '{}', updated = ?2, rev = (SELECT COALESCE(MAX(rev), 0) + 1 FROM calendar_items)
     WHERE id = ?1 AND updated <= ?2`
  )
    .bind(String(id), when)
    .run();
  if (res.meta.changes) return { ok: true };
  const current = await stored(env, String(id));
  // Never there, or already gone: nothing to do
  if (!current || current.deleted) return { ok: true };
  return { ok: false, current };
}

const json = (data, status = 200) => Response.json(data, { status, headers: { "Cache-Control": "no-store" } });

// The Calendar panel's requests (signed-in staff; app-page.js checks that)
export async function handleCalendarItems(request, env, route) {
  const url = new URL(request.url);
  const id = decodeURIComponent(route.slice("/calendar/items/".length));
  if (route === "/calendar/items" && request.method === "GET") return json(await changesSince(env, Number(url.searchParams.get("since")) || 0));
  if (!route.startsWith("/calendar/items/") || !id) return json({ error: "Not found" }, 404);
  if (isAgentItem(id)) return json({ error: "That's part of Nova Agent's plan: change it in Quests." }, 403);
  if (request.method === "PUT") {
    const body = await request.json().catch(() => ({}));
    if (JSON.stringify(body).length > 64000) return json({ error: "That's too big." }, 413);
    const result = await saveItem(env, { ...body, id });
    if (result.error) return json({ error: result.error }, 400);
    return json({ ...result, rev: await currentRev(env) });
  }
  if (request.method === "DELETE") return json({ ...(await deleteItem(env, id, url.searchParams.get("updated") || undefined)), rev: await currentRev(env) });
  return json({ error: "Not found" }, 404);
}

// Nova Agent's copy on the PC: its changes in, everything changed since its last sync out
export async function syncFromAgent(env, body) {
  const upserts = Array.isArray(body?.upserts) ? body.upserts.slice(0, 2000) : [];
  const deletes = Array.isArray(body?.deletes) ? body.deletes.slice(0, 2000) : [];
  const rejected = [];
  for (const raw of upserts) {
    const r = await saveItem(env, raw);
    if (!r.ok && r.current) rejected.push(r.current);
  }
  for (const d of deletes) {
    const r = await deleteItem(env, d && d.id, d && d.updated);
    if (!r.ok && r.current) rejected.push(r.current);
  }
  const since = Math.max(0, Math.floor(Number(body?.since) || 0));
  const changes = await changesSince(env, since);
  return Response.json({ ...changes, rejected });
}

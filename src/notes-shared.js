// Shared notes: notes the whole team sees and edits, in Notes inside Nova Agent (online and on
// the studio PC). A note kept "Local" stays in one browser and never comes here.
//
// Notes keeps a copy of the shared notes in each browser (fast, readable offline) and syncs it
// through here (web/notes/js/shared.js). Signed-in Portal staff only: the cookie online, Nova
// Agent's app token on the PC (passed on by Nova Agent).
//
//   GET    /notes-api/changes?since=<rev>   what changed since then: { notes, cursor, more, me }
//   PUT    /notes-api/notes/<id>            save it: { title, html, created, updated, pinned, named,
//                                          gdocId, gdocUrl, base } → { note } (+ copy, if it clashed)
//   DELETE /notes-api/notes/<id>?base=<rev> delete it (kept as a "deleted" mark) → { note }
//
// "base" is the rev this copy last had of the note. If someone else saved it since, nobody's
// words are lost: the saved note stays as it is, and what this copy sent becomes a new shared
// note, "… (conflicted copy)", next to it. A stale delete is refused (the note comes back).
import { requireStaff, tokenOf } from "./portal/auth.js";

const MAX_NOTE_BYTES = 1_900_000; // D1 keeps up to 2 MB in a row; pictures are inside the HTML
const MAX_BODY_BYTES = 2_100_000;
const MAX_NOTES = 10_000;
const PAGE_ROWS = 100;
const PAGE_BYTES = 8_000_000;

const json = (data, status = 200) => Response.json(data, { status, headers: { "Cache-Control": "no-store" } });
const bytes = (s) => new TextEncoder().encode(s).length;
const iso = (v) => (typeof v === "string" && v.length <= 40 && !Number.isNaN(Date.parse(v)) ? v : null);

function out(row) {
  if (!row) return null;
  let meta = {};
  try {
    meta = JSON.parse(row.meta || "{}");
  } catch (err) {}
  return {
    id: row.id,
    title: row.title,
    html: row.html,
    created: row.created_at,
    updated: row.updated_at,
    pinned: meta.pinned === true,
    named: meta.named === true,
    gdocId: typeof meta.gdocId === "string" ? meta.gdocId : "",
    gdocUrl: typeof meta.gdocUrl === "string" ? meta.gdocUrl : "",
    by: row.updated_by_name || row.created_by_name || "",
    deleted: Boolean(row.deleted_at),
    rev: row.rev,
  };
}

const getRow = (env, id) => env.DB.prepare("SELECT * FROM shared_notes WHERE id = ?").bind(id).first();
const NEXT_REV = "(SELECT COALESCE(MAX(rev), 0) + 1 FROM shared_notes)";

// The same words and settings (a copy re-sending what's already here isn't a clash)
const same = (row, n) => !row.deleted_at && row.title === n.title && row.html === n.html && row.meta === n.meta;

async function tooMany(env, staffId) {
  if (!env.CHAT_LIMIT) return false;
  try {
    // Shares the chat limiter's namespace with its own key: a burst of saves is fine, a flood isn't
    const a = await env.CHAT_LIMIT.limit({ key: `notes-shared:${staffId}:a` });
    if (a.success) return false;
    const b = await env.CHAT_LIMIT.limit({ key: `notes-shared:${staffId}:b` });
    return !b.success;
  } catch (err) {
    return false;
  }
}

function noteFrom(body, now) {
  return {
    title: typeof body.title === "string" ? body.title.slice(0, 200) : "Untitled note",
    html: body.html,
    meta: JSON.stringify({
      pinned: body.pinned === true,
      named: body.named === true,
      gdocId: typeof body.gdocId === "string" ? body.gdocId.slice(0, 200) : "",
      gdocUrl: typeof body.gdocUrl === "string" && body.gdocUrl.startsWith("https://") ? body.gdocUrl.slice(0, 500) : "",
    }),
    created: iso(body.created) || now,
    updated: iso(body.updated) || now,
  };
}

async function insert(env, staff, id, note, size) {
  const name = String(staff.display_name || "");
  return env.DB.prepare(
    `INSERT INTO shared_notes (id, title, html, meta, created_at, updated_at, created_by, created_by_name, updated_by, updated_by_name, deleted_at, rev, size)
     VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?7, ?8, NULL, ${NEXT_REV}, ?9) ON CONFLICT (id) DO NOTHING`
  )
    .bind(id, note.title, note.html, note.meta, note.created, note.updated, staff.id, name, size)
    .run();
}

export async function handleSharedNotes(request, env, pathname) {
  if (!env.DB) return json({ error: "No database" }, 503);
  const staff = await requireStaff(request, env);
  if (!staff) return json({ error: "Sign in with Portal to see shared notes", signedIn: false }, 401);
  const url = new URL(request.url);
  // Changes from a browser must come from this site; Nova Agent (an app token) proves itself
  const t = tokenOf(request);
  if (request.method !== "GET" && request.method !== "HEAD" && !(t && t.kind === "token") && request.headers.get("Origin") !== url.origin) return json({ error: "Forbidden" }, 403);
  if (request.method !== "GET" && (await tooMany(env, staff.id))) return json({ error: "Too many changes at once. Notes will try again in a moment." }, 429);

  if (pathname === "/notes-api/changes" && request.method === "GET") {
    const since = Math.max(0, Number.parseInt(url.searchParams.get("since") || "0", 10) || 0);
    const { results } = await env.DB.prepare("SELECT * FROM shared_notes WHERE rev > ? ORDER BY rev LIMIT ?").bind(since, PAGE_ROWS + 1).all();
    const notes = [];
    let size = 0;
    let cursor = since;
    for (const row of results.slice(0, PAGE_ROWS)) {
      if (notes.length && size + row.size > PAGE_BYTES) break;
      notes.push(out(row));
      size += row.size;
      cursor = row.rev;
    }
    return json({ notes, cursor, more: notes.length < results.length, me: { id: staff.id, name: staff.display_name } });
  }

  const m = /^\/notes-api\/notes\/([\w-]{1,64})$/.exec(pathname);
  if (!m) return json({ error: "Not found" }, 404);
  const id = m[1];

  if (request.method === "GET") {
    const row = await getRow(env, id);
    return row ? json({ note: out(row) }) : json({ error: "Not found" }, 404);
  }

  if (request.method === "PUT") {
    const text = await request.text();
    if (text.length > MAX_BODY_BYTES) return json({ error: "That note is too big to share (pictures take a lot of room). It stays on this device." }, 413);
    let body;
    try {
      body = JSON.parse(text);
    } catch (err) {
      return json({ error: "Expected a note" }, 400);
    }
    if (!body || typeof body !== "object" || typeof body.html !== "string") return json({ error: "Expected a note" }, 400);
    const now = new Date().toISOString();
    const note = noteFrom(body, now);
    const size = bytes(note.title) + bytes(note.html);
    if (size > MAX_NOTE_BYTES) return json({ error: "That note is too big to share (pictures take a lot of room). It stays on this device." }, 413);
    const base = Number.isInteger(body.base) ? body.base : null;

    const row = await getRow(env, id);
    if (!row) {
      const count = await env.DB.prepare("SELECT COUNT(*) AS n FROM shared_notes WHERE deleted_at IS NULL").first("n");
      if (count >= MAX_NOTES) return json({ error: `The team has ${MAX_NOTES} shared notes, the most there can be. Delete some to share new ones.` }, 413);
      const r = await insert(env, staff, id, note, size);
      if (r.meta.changes) return json({ note: out(await getRow(env, id)) });
    } else if (same(row, note)) {
      return json({ note: out(row) });
    } else if (base === row.rev) {
      // Only if nobody saved it in between (rev unchanged); a deleted note comes back the same way (Undo)
      const r = await env.DB.prepare(
        `UPDATE shared_notes SET title = ?2, html = ?3, meta = ?4, updated_at = ?5, updated_by = ?6, updated_by_name = ?7, deleted_at = NULL, size = ?8, rev = ${NEXT_REV} WHERE id = ?1 AND rev = ?9`
      )
        .bind(id, note.title, note.html, note.meta, note.updated, staff.id, String(staff.display_name || ""), size, row.rev)
        .run();
      if (r.meta.changes) return json({ note: out(await getRow(env, id)) });
    }
    // Someone else saved it meanwhile: theirs stays, and what was sent becomes its own shared note
    const current = await getRow(env, id);
    const copyId = `${id.slice(0, 40)}-c${crypto.randomUUID().slice(0, 8)}`;
    const copy = { ...note, title: `${note.title} (conflicted copy)`.slice(0, 200), created: now, updated: now };
    await insert(env, staff, copyId, copy, size);
    return json({ note: out(current), copy: out(await getRow(env, copyId)), conflict: true });
  }

  if (request.method === "DELETE") {
    const row = await getRow(env, id);
    if (!row) return json({ note: null });
    if (row.deleted_at) return json({ note: out(row) });
    const base = Number.parseInt(url.searchParams.get("base") || "", 10);
    if (base === row.rev) {
      const r = await env.DB.prepare(`UPDATE shared_notes SET html = '', deleted_at = ?2, size = 0, updated_by = ?3, updated_by_name = ?4, rev = ${NEXT_REV} WHERE id = ?1 AND rev = ?5`)
        .bind(id, new Date().toISOString(), staff.id, String(staff.display_name || ""), base)
        .run();
      if (r.meta.changes) return json({ note: out(await getRow(env, id)) });
    }
    // Changed by someone else since this copy saw it: it isn't deleted, the copy gets it back
    return json({ error: "Someone changed this note meanwhile, so it wasn't deleted.", note: out(await getRow(env, id)) }, 409);
  }

  return json({ error: "Method not allowed" }, 405);
}

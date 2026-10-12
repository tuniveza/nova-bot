// Notes ⇄ Google Docs (Portal → Admin → Google → "Notes kept in Google Docs"), and reading the
// studio's Drive for Agent
//
// Keep in Google Docs: a shared note someone marks "Keep in Google Docs" (in Notes) gets a Google
// Doc in the Nova Agent folder (or keeps the one it was sent to), and every 15 minutes the two are
// put in step:
//   changed in Notes only        the Doc gets the note's words
//   changed in the Doc only      the note gets the Doc's words (as Notes would write them)
//   changed in both              the newer one wins, and the other is kept as a copy (a copy
//                                note in Notes, or a copy of the Doc in Drive), so nothing is lost
// A Google Doc opened into Notes ("Open a Google Doc" in Notes, with its link) is kept the same way.
// One the studio didn't make with Nova Agent can only come into Notes: Google lets Nova change only
// the Docs it made (drive.file); changes in Notes then stay in Notes (said in the note's status).
//
// google_links 'notedoc': note id ⇄ Doc id, with a hash of the note as last put in step and, in
// `extra`, the Doc's last modified time seen (and "in" for a Doc Nova can only read).
//
// Agent (read-only, drive.readonly): searching the studio's Drive by name and words, and reading a
// Google Doc's text.

import { google, googleFetch, GoogleError } from "../nova/google.js";
import { folder } from "./drive.js";
import { flush, forgetLink, keepLink, later, linkOf, links, low, prep, sha, spendDb } from "./common.js";

const DRIVE = "https://www.googleapis.com/drive/v3";
const UPLOAD = "https://www.googleapis.com/upload/drive/v3";
const DOC_TYPE = "application/vnd.google-apps.document";
const PER_RUN = 8;
const NEXT_REV = "(SELECT COALESCE(MAX(rev), 0) + 1 FROM shared_notes)";

const nowIso = () => new Date().toISOString();
const noteHash = (title, html) => sha(JSON.stringify([String(title || ""), String(html || "")]));
const ukStamp = () => new Date().toLocaleString("en-GB", { timeZone: "Europe/London", day: "numeric", month: "short", hour: "2-digit", minute: "2-digit" });

// ===== THE WORDS: Notes' HTML ⇄ a Doc's =====

const escapeHtml = (s) => String(s).replace(/[&<>"]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" })[c]);

// A Doc exported as HTML, as Notes would keep it: its body only, without Google's styles, scripts
// and classes; links, headings, lists, tables, bold and italics stay
export function docHtmlToNote(html) {
  let body = String(html || "");
  const m = body.match(/<body[^>]*>([\s\S]*)<\/body>/i);
  if (m) body = m[1];
  body = body
    .replace(/<(script|style|head|meta|link|title)[\s\S]*?<\/\1>/gi, "")
    .replace(/<(script|style|meta|link)[^>]*>/gi, "")
    // Google writes bold and italics as styled spans
    .replace(/<span[^>]*font-weight:\s*(700|bold)[^>]*>([\s\S]*?)<\/span>/gi, "<strong>$2</strong>")
    .replace(/<span[^>]*font-style:\s*italic[^>]*>([\s\S]*?)<\/span>/gi, "<em>$1</em>")
    .replace(/<\/?span[^>]*>/gi, "")
    // Google's links go through google.com/url?q=…: the real address
    .replace(/href="https:\/\/www\.google\.com\/url\?q=([^"&]+)[^"]*"/gi, (_, u) => `href="${escapeHtml(decodeURIComponent(u))}"`)
    // Attributes: only links' addresses stay
    .replace(/<(a)\s[^>]*?(href="[^"]*")[^>]*>/gi, "<$1 $2>")
    .replace(/<(?!a\s)([a-z][a-z0-9]*)\s[^>]*>/gi, "<$1>")
    .replace(/\s*<p>\s*<\/p>\s*/gi, "<p><br></p>")
    .trim();
  return body.slice(0, 1_500_000);
}

const docPage = (title, html) => `<!doctype html><html><head><meta charset="utf-8"><title>${escapeHtml(title || "Note")}</title></head><body>${String(html || "")}</body></html>`;

// ===== DRIVE CALLS =====

async function docInfo(env, id) {
  return google(env, "GET", `${DRIVE}/files/${encodeURIComponent(id)}?fields=id,name,mimeType,modifiedTime,trashed,webViewLink,capabilities(canEdit)`);
}

async function exportDocHtml(env, id) {
  const res = await googleFetch(env, "GET", `${DRIVE}/files/${encodeURIComponent(id)}/export?mimeType=text%2Fhtml`, { timeout: 30_000 });
  if (!res.ok) throw new GoogleError(`Google Docs didn't give the document (${res.status}).`, res.status);
  return res.text();
}

// The note's words into the Doc (Google converts the HTML). -> the Doc's new modified time
async function writeDoc(env, id, title, html) {
  const res = await googleFetch(env, "PATCH", `${UPLOAD}/files/${encodeURIComponent(id)}?uploadType=media&fields=id,modifiedTime`, {
    body: docPage(title, html),
    headers: { "Content-Type": "text/html; charset=UTF-8" },
    timeout: 30_000,
  });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) {
    const err = new GoogleError(`Google Docs didn't take the change (${data?.error?.message || res.status}).`, res.status);
    throw err;
  }
  return data.modifiedTime || nowIso();
}

// A new Doc from a note, in the Docs folder. -> { id, url, modifiedTime }
async function newDoc(env, title, html) {
  const parent = await folder(env, "docs");
  const boundary = "nova-doc-" + crypto.randomUUID();
  const meta = JSON.stringify({ name: String(title || "Note").slice(0, 200), mimeType: DOC_TYPE, parents: [parent] });
  const body = `--${boundary}\r\nContent-Type: application/json; charset=UTF-8\r\n\r\n${meta}\r\n--${boundary}\r\nContent-Type: text/html; charset=UTF-8\r\n\r\n${docPage(title, html)}\r\n--${boundary}--`;
  const res = await googleFetch(env, "POST", `${UPLOAD}/files?uploadType=multipart&fields=id,webViewLink,modifiedTime`, { body, headers: { "Content-Type": `multipart/related; boundary=${boundary}` }, timeout: 60_000 });
  const data = await res.json().catch(() => ({}));
  if (!res.ok || !data.id) throw new GoogleError(`Google Docs didn't make the document (${data?.error?.message || res.status}).`, res.status || 502);
  return { id: data.id, url: data.webViewLink || `https://docs.google.com/document/d/${data.id}/edit`, modifiedTime: data.modifiedTime || nowIso() };
}

// A Doc's id from its link (docs.google.com/document/d/<id>/…), or an id as it is
export function docIdFrom(text) {
  const s = String(text || "").trim();
  const m = s.match(/\/document\/d\/([\w-]{20,})/) || s.match(/[?&]id=([\w-]{20,})/) || s.match(/^([\w-]{20,})$/);
  return m ? m[1] : null;
}

// ===== NOTES: WHAT'S SAVED =====

async function readNote(env, id) {
  return env.DB.prepare("SELECT id, title, html, meta, updated_at, deleted_at, rev FROM shared_notes WHERE id = ?").bind(String(id)).first();
}

// The note's Doc link shown in Notes (its meta: gdocId, gdocUrl, gdocKeep)
function noteMeta(row, changes) {
  let meta = {};
  try {
    meta = JSON.parse(row?.meta || "{}");
  } catch {}
  return JSON.stringify({ ...meta, ...changes });
}

function updateNote(env, id, { title, html, meta }, by = "Google Docs") {
  const size = new TextEncoder().encode(String(title || "") + String(html || "")).length;
  return env.DB.prepare(
    `UPDATE shared_notes SET title = ?2, html = ?3, meta = ?4, updated_at = ?5, updated_by = 'google', updated_by_name = ?6, size = ?7, rev = ${NEXT_REV} WHERE id = ?1`
  ).bind(String(id), String(title || "").slice(0, 200), html, meta, nowIso(), by, size);
}

function insertNote(env, { id, title, html, meta, by = "google", byName = "Google Docs" }) {
  const now = nowIso();
  const size = new TextEncoder().encode(String(title || "") + String(html || "")).length;
  return env.DB.prepare(
    `INSERT INTO shared_notes (id, title, html, meta, created_at, updated_at, created_by, created_by_name, updated_by, updated_by_name, deleted_at, rev, size)
     VALUES (?1, ?2, ?3, ?4, ?5, ?5, ?6, ?7, ?6, ?7, NULL, ${NEXT_REV}, ?8)`
  ).bind(id, String(title || "Note").slice(0, 200), html, meta, now, by, byName, size);
}

// ===== KEEP IN GOOGLE DOCS (a person ticked it in Notes) =====

// Start (or stop) keeping a shared note in step with a Google Doc. -> { url } or { error, status }
export async function keepNoteInDocs(env, me, { noteId, on }) {
  const note = await readNote(env, noteId);
  if (!note || note.deleted_at) return { error: "That note isn't a shared note (only shared notes can be kept in Google Docs).", status: 404 };
  const budget = prep({ left: 6 });
  const link = await linkOf(env, budget, "notedoc", note.id);
  if (!on) {
    if (link) forgetLink(env, budget, "notedoc", note.id);
    later(budget, env.DB.prepare(`UPDATE shared_notes SET meta = ?2, rev = ${NEXT_REV} WHERE id = ?1`).bind(note.id, noteMeta(note, { gdocKeep: false })));
    await flush(env, budget);
    return { ok: true, kept: false };
  }
  if (link) return { ok: true, kept: true, url: `https://docs.google.com/document/d/${link.google_id}/edit` };
  let meta = {};
  try {
    meta = JSON.parse(note.meta || "{}");
  } catch {}
  let doc = null;
  // Sent to Docs before: keep that one, if Nova can still change it
  if (meta.gdocId) {
    try {
      const info = await docInfo(env, meta.gdocId);
      if (!info.trashed && info.mimeType === DOC_TYPE) {
        const modified = await writeDoc(env, info.id, note.title, note.html);
        doc = { id: info.id, url: info.webViewLink, modifiedTime: modified };
      }
    } catch (err) {
      if (err.status && err.status !== 404 && err.status !== 403) throw err;
    }
  }
  if (!doc) doc = await newDoc(env, note.title, note.html);
  keepLink(env, budget, "notedoc", note.id, doc.id, { extra: doc.modifiedTime, hash: await noteHash(note.title, note.html) });
  later(budget, env.DB.prepare(`UPDATE shared_notes SET meta = ?2, rev = ${NEXT_REV} WHERE id = ?1`).bind(note.id, noteMeta(note, { gdocId: doc.id, gdocUrl: doc.url, gdocKeep: true })));
  await flush(env, budget);
  console.log(`Notes: a note is kept in Google Docs now (by ${me?.id || "someone"})`);
  return { ok: true, kept: true, url: doc.url };
}

// Open a Google Doc into Notes, kept in step from then on. -> { noteId, url, oneWay }
export async function importDoc(env, me, { url }) {
  const id = docIdFrom(url);
  if (!id) return { error: "That isn't a Google Doc's link (it looks like docs.google.com/document/d/…).", status: 400 };
  let info;
  try {
    info = await docInfo(env, id);
  } catch (err) {
    if (err.status === 404 || err.status === 403) return { error: "Nova can't see that Doc. It has to be in the studio's Google Drive (the account Nova is connected to), and Google has to be connected with \"Read your Drive\".", status: 404 };
    throw err;
  }
  if (info.mimeType !== DOC_TYPE) return { error: "That's not a Google Doc (only Docs can be opened in Notes).", status: 400 };
  const html = docHtmlToNote(await exportDocHtml(env, id));
  const budget = prep({ left: 4 });
  const existing = await links(env, budget, "notedoc");
  const already = existing.byGoogle.get(id);
  if (already) return { ok: true, noteId: already.nova_id, url: info.webViewLink, already: true };
  const noteId = "gdoc-" + crypto.randomUUID();
  const oneWay = info.capabilities?.canEdit === false;
  const meta = JSON.stringify({ pinned: false, named: true, gdocId: id, gdocUrl: info.webViewLink || `https://docs.google.com/document/d/${id}/edit`, gdocKeep: true });
  spendDb(budget);
  await insertNote(env, { id: noteId, title: info.name || "Google Doc", html, meta, by: me?.id || "google", byName: me?.display_name || "Google Docs" }).run();
  keepLink(env, budget, "notedoc", noteId, id, { extra: info.modifiedTime || nowIso(), hash: await noteHash(info.name, html) });
  await flush(env, budget);
  return { ok: true, noteId, url: info.webViewLink, oneWay };
}

// ===== EVERY 15 MINUTES: PUT THEM IN STEP =====

export async function syncDocs(env, budget) {
  prep(budget);
  try {
    const L = await links(env, budget, "notedoc");
    const all = [...L.byNova.values()].sort((a, b) => String(a.synced_at).localeCompare(String(b.synced_at)));
    if (!all.length) return "No notes kept in Google Docs yet (tick \"Keep in Google Docs\" on a shared note in Notes)";
    const ids = all.slice(0, PER_RUN).map((l) => l.nova_id);
    spendDb(budget);
    const { results } = await env.DB.prepare(`SELECT id, title, html, meta, updated_at, deleted_at FROM shared_notes WHERE id IN (${ids.map(() => "?").join(",")})`).bind(...ids).all();
    const notes = new Map(results.map((r) => [r.id, r]));
    let toDoc = 0;
    let toNote = 0;
    let copies = 0;
    let more = all.length > PER_RUN;
    for (const id of ids) {
      if (low(budget, 3)) {
        more = true;
        break;
      }
      const link = L.byNova.get(id);
      const note = notes.get(id);
      // The note was deleted: the Doc stays in Drive, just not kept in step
      if (!note || note.deleted_at) {
        forgetLink(env, budget, "notedoc", id);
        continue;
      }
      budget.left--;
      let info;
      try {
        info = await docInfo(env, link.google_id);
      } catch (err) {
        if (err.status === 404) {
          forgetLink(env, budget, "notedoc", id);
          continue;
        }
        throw err;
      }
      if (info.trashed) {
        forgetLink(env, budget, "notedoc", id);
        later(budget, env.DB.prepare(`UPDATE shared_notes SET meta = ?2, rev = ${NEXT_REV} WHERE id = ?1`).bind(id, noteMeta(note, { gdocKeep: false })));
        continue;
      }
      const [seenTime, mode] = String(link.extra || "").split("|");
      const hash = await noteHash(note.title, note.html);
      const noteChanged = hash !== link.hash;
      const docChanged = Boolean(info.modifiedTime && seenTime && info.modifiedTime > seenTime);
      const canWrite = mode !== "in" && info.capabilities?.canEdit !== false;
      if (!noteChanged && !docChanged) {
        keepLink(env, budget, "notedoc", id, link.google_id, { extra: link.extra, hash });
        continue;
      }
      const docWins = docChanged && (!noteChanged || Date.parse(info.modifiedTime) >= Date.parse(note.updated_at));
      if (docWins) {
        budget.left--;
        const html = docHtmlToNote(await exportDocHtml(env, link.google_id));
        // Both changed: Notes' version is kept as a copy note
        if (noteChanged) {
          spendDb(budget);
          await insertNote(env, { id: "copy-" + crypto.randomUUID(), title: `${note.title || "Note"} (Notes' copy, ${ukStamp()})`, html: note.html, meta: JSON.stringify({ pinned: false, named: true }) }).run();
          copies++;
        }
        later(budget, updateNote(env, id, { title: info.name || note.title, html, meta: noteMeta(note, { gdocId: link.google_id, gdocUrl: info.webViewLink, gdocKeep: true }) }));
        keepLink(env, budget, "notedoc", id, link.google_id, { extra: `${info.modifiedTime}${mode ? "|" + mode : ""}`, hash: await noteHash(info.name || note.title, html) });
        toNote++;
        continue;
      }
      // Notes' words go to the Doc
      if (!canWrite) {
        // A Doc Nova can only read: Notes' changes stay in Notes
        keepLink(env, budget, "notedoc", id, link.google_id, { extra: `${info.modifiedTime}|in`, hash });
        continue;
      }
      if (docChanged) {
        // Both changed and Notes' is newer: the Doc's version is kept as a copy in Drive
        budget.left--;
        await google(env, "POST", `${DRIVE}/files/${encodeURIComponent(link.google_id)}/copy?fields=id`, { name: `${info.name || "Note"} (Google Docs' copy, ${ukStamp()})` }).catch(() => {});
        copies++;
      }
      budget.left--;
      let modified;
      try {
        modified = await writeDoc(env, link.google_id, note.title, note.html);
      } catch (err) {
        if (err.status === 403) {
          keepLink(env, budget, "notedoc", id, link.google_id, { extra: `${info.modifiedTime}|in`, hash });
          continue;
        }
        throw err;
      }
      keepLink(env, budget, "notedoc", id, link.google_id, { extra: modified, hash });
      toDoc++;
    }
    await flush(env, budget);
    const n = (await links(env, budget, "notedoc")).byNova.size;
    const moved = [toDoc && `${toDoc} to Docs`, toNote && `${toNote} to Notes`, copies && `${copies} copies kept`].filter(Boolean);
    return { note: `${n} note${n === 1 ? "" : "s"} kept in Google Docs${moved.length ? ` · ${moved.join(", ")}` : ""}${more ? " · more next run" : ""}`, more };
  } finally {
    await flush(env, budget).catch(() => {});
  }
}

// ===== FOR AGENT (read-only) =====

// Search the studio's Drive by name and words: name, type, when changed, link
export async function searchDrive(env, query, max = 10) {
  const q = String(query || "").replace(/['\\]/g, " ").trim().slice(0, 100);
  if (!q) return [];
  const params = new URLSearchParams({
    q: `(name contains '${q}' or fullText contains '${q}') and trashed = false`,
    fields: "files(id,name,mimeType,modifiedTime,webViewLink)",
    pageSize: String(Math.min(max, 20)),
    orderBy: "modifiedTime desc",
  });
  const data = await google(env, "GET", `${DRIVE}/files?${params}`);
  const kind = (t) => (t === DOC_TYPE ? "Google Doc" : t === "application/vnd.google-apps.spreadsheet" ? "Google Sheet" : t === "application/vnd.google-apps.folder" ? "folder" : t === "application/pdf" ? "PDF" : String(t || "file").split("/").pop());
  return (data.files || []).map((f) => ({ id: f.id, name: f.name, kind: kind(f.mimeType), modified: f.modifiedTime, url: f.webViewLink }));
}

// A Google Doc's words (plain text, the first 20,000 characters)
export async function readDocText(env, idOrUrl) {
  const id = docIdFrom(idOrUrl);
  if (!id) throw new GoogleError("That isn't a Google Doc's id or link.", 400);
  const info = await docInfo(env, id);
  if (info.mimeType !== DOC_TYPE) throw new GoogleError("That's not a Google Doc.", 400);
  const res = await googleFetch(env, "GET", `${DRIVE}/files/${encodeURIComponent(id)}/export?mimeType=text%2Fplain`, { timeout: 30_000 });
  if (!res.ok) throw new GoogleError(`Google Docs didn't give the text (${res.status}).`, res.status);
  const text = await res.text();
  return { name: info.name, url: info.webViewLink, text: text.slice(0, 20_000), cut: text.length > 20_000 };
}

// Google Drive: a "Nova Agent" folder in the studio's Drive (Portal → Admin → Google)
//
//   Social     social posts' pictures and videos: a copy of each goes here when it's added (Nova
//              Agent on the PC sends it: /nova-agent/google/drive/put), so when a post goes out
//              Meta's copy comes from Drive, not the studio computer (which can then be off).
//   Receipts   expenses' receipt photos, the same way (Portal shows them from Drive when the PC is off).
//   Backups    every night: Index (all of it, as one file, the last 14 kept) and the PC's files
//              (kept up to date, one copy each).
//   Docs       Notes' "Send to Google Docs": a note becomes a Google Doc in this folder.
//   Money      the accountant's Google Sheet (src/google/sheets.js) lives here too.
//
// Nova Agent can only see the files it made itself (the drive.file permission): nothing else in
// the studio's Drive is read or touched. google_links: 'media' / 'receipt' / 'backup' -> the file's id.

import { google, googleFetch, GoogleError } from "../nova/google.js";
import { getLink, putLink, dropLink, readSetting, writeSetting } from "./common.js";

const DRIVE = "https://www.googleapis.com/drive/v3";
const UPLOAD = "https://www.googleapis.com/upload/drive/v3";
const FOLDER_TYPE = "application/vnd.google-apps.folder";
const FOLDERS = { root: "Nova Agent", media: "Social", receipt: "Receipts", backup: "Backups", docs: "Docs", file: "Files", invoice: "Invoices" };
// Kept up to date in place (one copy each); the others never change once made
const UPDATED_IN_PLACE = new Set(["backup", "file", "invoice"]);
const KEEP_INDEX_BACKUPS = 14;

// ===== FOLDERS =====

async function makeFolder(env, name, parent) {
  return (await google(env, "POST", `${DRIVE}/files?fields=id`, { name, mimeType: FOLDER_TYPE, ...(parent ? { parents: [parent] } : {}) })).id;
}

// The folder for a kind of file ("root", "media", "receipt", "backup", "docs"), made if needed
// (and again if someone deleted it in Drive)
export async function folder(env, kind = "root") {
  const key = `google_drive_folder_${kind}`;
  const saved = await readSetting(env, key);
  if (saved) {
    try {
      const f = await google(env, "GET", `${DRIVE}/files/${encodeURIComponent(saved)}?fields=id,trashed`);
      if (!f.trashed) return saved;
    } catch (err) {
      if (err.status !== 404) throw err;
    }
  }
  const parent = kind === "root" ? null : await folder(env, "root");
  const id = await makeFolder(env, FOLDERS[kind] || kind, parent);
  await writeSetting(env, key, id).run();
  return id;
}

// A link to the Nova Agent folder (for Portal)
export async function folderUrl(env) {
  const id = await readSetting(env, "google_drive_folder_root");
  return id ? `https://drive.google.com/drive/folders/${id}` : null;
}

// ===== FILES =====

// Upload bytes as a new file (resumable, so big videos go too). -> the file's id
export async function uploadFile(env, { name, type, bytes, parent }) {
  const start = await googleFetch(env, "POST", `${UPLOAD}/files?uploadType=resumable&fields=id`, {
    body: JSON.stringify({ name, parents: [parent] }),
    headers: { "Content-Type": "application/json; charset=UTF-8", "X-Upload-Content-Type": type, "X-Upload-Content-Length": String(bytes.byteLength) },
  });
  const session = start.headers.get("Location");
  if (!start.ok || !session) throw new GoogleError(`Google Drive wouldn't start the upload (${start.status}).`, start.status || 502);
  const put = await googleFetch(env, "PUT", session, { body: bytes, headers: { "Content-Type": type }, timeout: 120_000 });
  const data = await put.json().catch(() => ({}));
  if (!put.ok || !data.id) throw new GoogleError(`Google Drive didn't take the file (${put.status}).`, put.status || 502);
  return data.id;
}

// Put a file's new content in place (a backup kept up to date)
async function replaceFile(env, id, { type, bytes }) {
  const res = await googleFetch(env, "PATCH", `${UPLOAD}/files/${encodeURIComponent(id)}?uploadType=media&fields=id`, { body: bytes, headers: { "Content-Type": type }, timeout: 120_000 });
  if (res.status === 404) return false;
  if (!res.ok) throw new GoogleError(`Google Drive didn't update the file (${res.status}).`, res.status);
  return true;
}

// Keep one of Nova's files in Drive. kind: "media" | "receipt" | "backup" | "file"; novaId: its id in
// Nova (a backup: its name). A backup with that name already there is updated in place; the
// others never change once made (a new picture is a new id). -> the Drive file's id
export async function keepFile(env, { kind, novaId, name, type, bytes }) {
  const link = await getLink(env, kind, novaId);
  if (link) {
    if (!UPDATED_IN_PLACE.has(kind)) return link.google_id;
    if (await replaceFile(env, link.google_id, { type, bytes })) {
      await putLink(env, kind, novaId, link.google_id, { extra: name }).run();
      return link.google_id;
    }
  }
  const id = await uploadFile(env, { name, type, bytes, parent: await folder(env, kind) });
  await putLink(env, kind, novaId, id, { extra: name }).run();
  return id;
}

// One of Nova's files from Drive, as a Response (Range works), or null if it isn't there
export async function fileFromDrive(env, kind, novaId, range) {
  const link = await getLink(env, kind, novaId);
  if (!link) return null;
  const res = await googleFetch(env, "GET", `${DRIVE}/files/${encodeURIComponent(link.google_id)}?alt=media`, { headers: range ? { Range: range } : {}, timeout: 60_000 });
  if (res.status === 404) {
    await dropLink(env, kind, novaId).run();
    return null;
  }
  return res.ok || res.status === 206 ? res : null;
}

// A file removed in Nova: removed from Drive too (to Drive's bin, where it stays 30 days)
export async function dropFile(env, kind, novaId) {
  const link = await getLink(env, kind, novaId);
  if (!link) return false;
  try {
    await google(env, "PATCH", `${DRIVE}/files/${encodeURIComponent(link.google_id)}`, { trashed: true });
  } catch (err) {
    if (err.status !== 404) throw err;
  }
  await dropLink(env, kind, novaId).run();
  return true;
}

// ===== DOCS (Notes' "Send to Google Docs") =====

// A note's HTML as a Google Doc in the Docs folder. -> { id, url }
export async function makeDoc(env, { title, html }) {
  const parent = await folder(env, "docs");
  const boundary = "nova-doc-" + crypto.randomUUID();
  const meta = JSON.stringify({ name: String(title || "Note").slice(0, 200), mimeType: "application/vnd.google-apps.document", parents: [parent] });
  const page = `<!doctype html><html><head><meta charset="utf-8"><title>${String(title || "Note").replace(/[<>&]/g, "")}</title></head><body>${String(html || "")}</body></html>`;
  const body = `--${boundary}\r\nContent-Type: application/json; charset=UTF-8\r\n\r\n${meta}\r\n--${boundary}\r\nContent-Type: text/html; charset=UTF-8\r\n\r\n${page}\r\n--${boundary}--`;
  const res = await googleFetch(env, "POST", `${UPLOAD}/files?uploadType=multipart&fields=id,webViewLink`, { body, headers: { "Content-Type": `multipart/related; boundary=${boundary}` }, timeout: 60_000 });
  const data = await res.json().catch(() => ({}));
  if (!res.ok || !data.id) throw new GoogleError(`Google Docs didn't make the document (${data?.error?.message || res.status}).`, res.status || 502);
  return { id: data.id, url: data.webViewLink || `https://docs.google.com/document/d/${data.id}/edit` };
}

// ===== BACKUPS =====

const ukDay = (d = new Date()) => d.toLocaleDateString("en-CA", { timeZone: "Europe/London" });

// Every night: all of Index as one file ("Index 2026-10-12.json"); the last 14 kept
export async function backupIndex(env) {
  const day = ukDay();
  if (await getLink(env, "backup", `index:${day}`)) return "Already backed up today";
  const { results } = await env.DB.prepare("SELECT id, scope, owner_id, path, name, description, aliases, body, version, source_app, updated_at FROM memory_files ORDER BY scope, owner_id, path").all();
  const bytes = new TextEncoder().encode(JSON.stringify({ backedUp: new Date().toISOString(), files: results }, null, 1));
  await keepFile(env, { kind: "backup", novaId: `index:${day}`, name: `Index ${day}.json`, type: "application/json", bytes });
  // Older ones beyond the last 14 go
  const { results: old } = await env.DB.prepare("SELECT nova_id FROM google_links WHERE kind = 'backup' AND nova_id LIKE 'index:%' ORDER BY nova_id DESC LIMIT -1 OFFSET ?").bind(KEEP_INDEX_BACKUPS).all();
  for (const o of old) await dropFile(env, "backup", o.nova_id).catch(() => {});
  return `Index backed up (${results.length} page${results.length === 1 ? "" : "s"}), ${ukDay()}`;
}

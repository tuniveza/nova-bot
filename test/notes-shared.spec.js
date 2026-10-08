// Shared notes (src/notes-shared.js): the team's notes, synced through /notes-api/
import { createExecutionContext, env, waitOnExecutionContext } from "cloudflare:test";
import { beforeEach, describe, expect, it } from "vitest";
import worker from "../src";
import { STAFF_COOKIE } from "./sign-in.js";
import { sha256 } from "../src/portal/auth.js";

const BASE = "https://novacane-worker.test";
const OTHER_TOKEN = "test-staff-two-session";
const OTHER_COOKIE = `nova_session=${OTHER_TOKEN}`;

async function call(path, { method = "GET", cookie = STAFF_COOKIE, body, origin = BASE } = {}) {
  const ctx = createExecutionContext();
  const headers = { "Content-Type": "application/json" };
  if (origin) headers.Origin = origin;
  if (cookie) headers.Cookie = cookie;
  const res = await worker.fetch(new Request(BASE + path, { method, headers, body: body === undefined ? undefined : typeof body === "string" ? body : JSON.stringify(body) }), env, ctx);
  await waitOnExecutionContext(ctx);
  return { status: res.status, data: await res.json().catch(() => ({})) };
}
const put = (id, note, cookie) => call(`/notes-api/notes/${id}`, { method: "PUT", body: note, cookie });
const changes = (since = 0, cookie) => call(`/notes-api/changes?since=${since}`, { cookie });

beforeEach(async () => {
  const now = new Date().toISOString();
  const later = new Date(Date.now() + 86_400_000).toISOString();
  await env.DB.batch([
    env.DB.prepare("DELETE FROM shared_notes"),
    env.DB.prepare("INSERT OR REPLACE INTO staff (id, email, password_hash, display_name, role, status, created_at, planet_seed, index_partition) VALUES ('test-two', 'two@novacane.test', NULL, 'Second Person', 'staff', 'active', ?, 'test-two', 'staff:test-two')").bind(now),
    env.DB.prepare("INSERT OR REPLACE INTO sessions (id, staff_id, kind, created_at, expires_at, last_seen_at) VALUES (?, 'test-two', 'cookie', ?, ?, ?)").bind(await sha256(OTHER_TOKEN), now, later, now),
  ]);
});

describe("shared notes", () => {
  it("are for signed-in staff only", async () => {
    expect((await changes(0, "")).status).toBe(401);
    expect((await put("n1", { title: "T", html: "<p>x</p>" }, "")).status).toBe(401);
  });

  it("changes must come from this site", async () => {
    const r = await call("/notes-api/notes/n1", { method: "PUT", body: { title: "T", html: "<p>x</p>" }, origin: "https://evil.example" });
    expect(r.status).toBe(403);
  });

  it("one person's note shows for the whole team, with who changed it", async () => {
    const saved = await put("n1", { title: "Plan", html: "<p>Mix</p>", pinned: true });
    expect(saved.status).toBe(200);
    expect(saved.data.note).toMatchObject({ id: "n1", title: "Plan", pinned: true, deleted: false, by: "Test Admin" });
    const seen = await changes(0, OTHER_COOKIE);
    expect(seen.status).toBe(200);
    expect(seen.data.notes.map((n) => n.id)).toEqual(["n1"]);
    expect(seen.data.me.id).toBe("test-two");
    // The other person edits it; the first sees their change after their cursor
    const edited = await put("n1", { title: "Plan", html: "<p>Mix and master</p>", base: saved.data.note.rev }, OTHER_COOKIE);
    expect(edited.data.note.by).toBe("Second Person");
    const later = await changes(saved.data.note.rev);
    expect(later.data.notes).toHaveLength(1);
    expect(later.data.notes[0].html).toBe("<p>Mix and master</p>");
  });

  it("two edits at once keep both: the second becomes a conflicted copy", async () => {
    const a = await put("n1", { title: "Song", html: "<p>v1</p>" });
    const base = a.data.note.rev;
    await put("n1", { title: "Song", html: "<p>theirs</p>", base }, OTHER_COOKIE);
    const mine = await put("n1", { title: "Song", html: "<p>mine</p>", base });
    expect(mine.data.conflict).toBe(true);
    expect(mine.data.note.html).toBe("<p>theirs</p>");
    expect(mine.data.copy.title).toBe("Song (conflicted copy)");
    expect(mine.data.copy.html).toBe("<p>mine</p>");
    const all = await changes(0);
    expect(all.data.notes.filter((n) => !n.deleted)).toHaveLength(2);
  });

  it("re-sending the same note isn't a clash", async () => {
    const a = await put("n1", { title: "Same", html: "<p>x</p>" });
    const again = await put("n1", { title: "Same", html: "<p>x</p>", base: 0 });
    expect(again.data.conflict).toBeUndefined();
    expect(again.data.note.rev).toBe(a.data.note.rev);
  });

  it("delete leaves a mark every copy sees, Undo brings it back, a stale delete is refused", async () => {
    const a = await put("n1", { title: "Gone", html: "<p>bye</p>" });
    const del = await call(`/notes-api/notes/n1?base=${a.data.note.rev}`, { method: "DELETE" });
    expect(del.status).toBe(200);
    expect(del.data.note.deleted).toBe(true);
    const seen = await changes(a.data.note.rev, OTHER_COOKIE);
    expect(seen.data.notes[0]).toMatchObject({ id: "n1", deleted: true });
    // Undo: saved again on top of the delete
    const back = await put("n1", { title: "Gone", html: "<p>bye</p>", base: del.data.note.rev });
    expect(back.data.note.deleted).toBe(false);
    // Someone edits, then a delete from an old copy is refused
    const edited = await put("n1", { title: "Gone", html: "<p>still here</p>", base: back.data.note.rev }, OTHER_COOKIE);
    const stale = await call(`/notes-api/notes/n1?base=${back.data.note.rev}`, { method: "DELETE" });
    expect(stale.status).toBe(409);
    expect(stale.data.note).toMatchObject({ deleted: false, html: "<p>still here</p>", rev: edited.data.note.rev });
  });

  it("turns down a note that's too big or isn't a note", async () => {
    expect((await put("n1", { title: "Big", html: "x".repeat(2_000_000) })).status).toBe(413);
    expect((await call("/notes-api/notes/n1", { method: "PUT", body: "not json" })).status).toBe(400);
    expect((await put("n1", { title: "No html" })).status).toBe(400);
    expect((await call("/notes-api/notes/bad%20id", { method: "PUT", body: { html: "" } })).status).toBe(404);
  });

  it("pages through many changes in rev order", async () => {
    for (let i = 0; i < 5; i++) await put(`n${i}`, { title: `N${i}`, html: `<p>${i}</p>` });
    const first = await changes(0);
    expect(first.data.notes.map((n) => n.id)).toEqual(["n0", "n1", "n2", "n3", "n4"]);
    const none = await changes(first.data.cursor);
    expect(none.data.notes).toHaveLength(0);
    expect(none.data.cursor).toBe(first.data.cursor);
  });
});

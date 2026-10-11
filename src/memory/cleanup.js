// Index cleanup: junk and repeats out of memory, with a dry run first (P0-5).
//
//   1. check   (dry run) looks at every file and every fact waiting for approval and lists what
//              WOULD be removed, each with its reason. Nothing changes; the report is saved
//              (memory_cleanups) exactly as shown, with who ran it and when.
//   2. apply   takes that report's id and the ids from it, and removes only those: each one is
//              re-checked first (still there, unchanged, still junk or still a repeat) and
//              skipped otherwise. Anything not in the saved report is never touched.
//   3. the bin every removed entry is copied to memory_removed first (what, why, by whom, when),
//              and an admin can put it back for 30 days. After that it's cleared for good.
//
// What counts:
//   empty file     a file with no facts at all
//   junk file      a file whose every fact is junk (it goes as a whole, never left empty)
//   junk line      a fact that's empty, placeholder text ("n/a", "test", "TBD"), only
//                  punctuation, too short, or cut off mid-sentence (store.js junkReason)
//   repeat line    the same fact as an earlier line in the same file, after ignoring case,
//                  spaces, punctuation and the [tag]. The FIRST copy (the earliest line) stays.
//   junk pending   a fact waiting for approval that's junk
//   repeat pending the same fact already waiting for the same file (the OLDEST stays), or
//                  already remembered in that file
// Repeats are only looked for inside one file (or one file's queue): the same words in two
// people's files ("prefers evening sessions") are two different facts.

import { binAndDeleteFile, factLine, forgetCached, getFile, junkReason, normalFact, restorePending } from "./store.js";

export const BIN_DAYS = 30;
const BIN_MS = BIN_DAYS * 86_400_000;
// A report can be applied for a day; after that, check again
const REPORT_MS = 86_400_000;
// Kept small so applying one report stays well inside D1's queries-per-request limit (the rest: check again)
const MAX_ITEMS = 200;
export const KEEPS =
  "For repeats, the first copy stays: the earliest line in the file, or the fact that has waited longest for approval. Only the entries listed are removed, and each can be put back for 30 days.";

const FACT = /^-\s*\[(stated|observed|inferred)\]\s*(.*)$/i;
const factOf = (line) => {
  const m = String(line).trim().match(FACT);
  return m ? m[2] : String(line).trim();
};

// A short, stable fingerprint of a line's exact text (so an id names that very line)
function fingerprint(s) {
  let h = 0x811c9dc5;
  for (const ch of String(s)) {
    h ^= ch.codePointAt(0);
    h = Math.imul(h, 0x01000193) >>> 0;
  }
  return h.toString(16).padStart(8, "0");
}

// Each line of a body judged: junk, a repeat of an earlier line, or fine. Blank lines are left be.
function judgeLines(fileId, body) {
  const seen = new Map();
  const count = new Map();
  const out = [];
  for (const line of String(body || "").split("\n")) {
    if (!line.trim()) continue;
    const n = (count.get(line) || 0) + 1;
    count.set(line, n);
    const id = `line:${fileId}:${fingerprint(line)}:${n}`;
    const fact = factOf(line);
    const junk = junkReason(fact);
    if (junk) {
      out.push({ id, line, kind: "junk-line", reason: junk });
      continue;
    }
    const key = normalFact(fact);
    if (seen.has(key)) {
      out.push({ id, line, kind: "repeat-line", reason: "the same fact is already in this file", kept: seen.get(key) });
      continue;
    }
    seen.set(key, line.trim());
    out.push({ id, line, kind: null, key });
  }
  return out;
}

// What a file's check finds: the whole file (empty, or nothing but junk), or some of its lines
function judgeFile(row) {
  const lines = judgeLines(row.id, row.body);
  const where = { scope: row.scope, owner_id: row.owner_id, path: row.path };
  if (!lines.length) return { file: { id: `file:${row.id}`, kind: "empty-file", reason: "it has no facts", ...where, text: row.name || row.path }, lines: [], keys: new Set() };
  if (lines.every((l) => l.kind === "junk-line")) {
    return { file: { id: `file:${row.id}`, kind: "junk-file", reason: "every fact in it is junk", ...where, text: lines.map((l) => l.line.trim()).join(" · ").slice(0, 200) }, lines: [], keys: new Set() };
  }
  return {
    file: null,
    lines: lines.filter((l) => l.kind).map((l) => ({ id: l.id, kind: l.kind, reason: l.reason, ...where, text: l.line.trim(), ...(l.kept ? { kept: l.kept } : {}) })),
    keys: new Set(lines.filter((l) => !l.kind).map((l) => l.key)),
  };
}

const fileKey = (scope, owner, path) => `${scope}\u0001${owner ?? ""}\u0001${path}`;

// Facts waiting for approval, oldest first: junk, already waiting, or already remembered
function judgePending(rows, fileKeys) {
  const items = [];
  const seen = new Map();
  for (const p of rows) {
    const where = { scope: p.scope, owner_id: p.owner_id, path: p.target };
    const junk = junkReason(p.fact);
    if (junk) {
      items.push({ id: `pending:${p.id}`, kind: "junk-pending", reason: junk, ...where, text: p.fact });
      continue;
    }
    const k = fileKey(p.scope, p.owner_id, p.target);
    const key = k + "\u0001" + normalFact(p.fact);
    if (seen.has(key)) {
      items.push({ id: `pending:${p.id}`, kind: "repeat-pending", reason: "the same fact is already waiting for approval", ...where, text: p.fact, kept: seen.get(key) });
      continue;
    }
    if ((fileKeys.get(k) || new Set()).has(normalFact(p.fact))) {
      items.push({ id: `pending:${p.id}`, kind: "repeat-pending", reason: "it's already remembered in that file", ...where, text: p.fact });
      continue;
    }
    seen.set(key, p.fact);
  }
  return items;
}

const pendingOldestFirst = (env) => env.DB.prepare("SELECT * FROM memory_pending ORDER BY created_at, id").all().then((r) => r.results);

// ---- 1. The dry run ----

export async function checkForJunk(env, by) {
  const { results: files } = await env.DB.prepare("SELECT * FROM memory_files ORDER BY scope, owner_id, path").all();
  const items = [];
  const fileKeys = new Map();
  for (const row of files) {
    const found = judgeFile(row);
    if (found.file) items.push(found.file);
    items.push(...found.lines);
    fileKeys.set(fileKey(row.scope, row.owner_id, row.path), found.keys);
  }
  items.push(...judgePending(await pendingOldestFirst(env), fileKeys));
  const counts = { empty_files: 0, junk_files: 0, junk_lines: 0, repeat_lines: 0, junk_pending: 0, repeat_pending: 0 };
  const name = { "empty-file": "empty_files", "junk-file": "junk_files", "junk-line": "junk_lines", "repeat-line": "repeat_lines", "junk-pending": "junk_pending", "repeat-pending": "repeat_pending" };
  for (const i of items) counts[name[i.kind]]++;
  counts.total = items.length;
  const report = { id: crypto.randomUUID(), checked_by: String(by || "an admin").slice(0, 80), checked_at: Date.now(), keeps: KEEPS, counts, items: items.slice(0, MAX_ITEMS), more: Math.max(0, items.length - MAX_ITEMS) };
  await env.DB.prepare("INSERT INTO memory_cleanups (id, checked_by, checked_at, report) VALUES (?, ?, ?, ?)")
    .bind(report.id, report.checked_by, report.checked_at, JSON.stringify({ keeps: report.keeps, counts, items: report.items, more: report.more }))
    .run();
  return report;
}

// ---- 2. Applying a report ----

const fail = (error, status) => ({ error, status });

export async function applyReport(env, { report_id, ids, by }) {
  const who = String(by || "an admin").slice(0, 80);
  if (!report_id || !Array.isArray(ids) || !ids.length) return fail("Run a check first, then apply its report", 400);
  const run = await env.DB.prepare("SELECT * FROM memory_cleanups WHERE id = ?").bind(String(report_id)).first();
  if (!run) return fail("That report isn't there. Run a fresh check.", 404);
  if (run.applied_at) return fail("That report has already been applied. Run a fresh check.", 409);
  if (Date.now() - run.checked_at > REPORT_MS) return fail("That report is more than a day old. Run a fresh check.", 410);
  const report = JSON.parse(run.report);
  const listed = new Map(report.items.map((i) => [i.id, i]));
  const skipped = [];
  const chosen = [];
  for (const id of new Set(ids.map(String))) {
    if (listed.has(id)) chosen.push(listed.get(id));
    else skipped.push({ id, why: "it wasn't in the report" });
  }
  const binned = { cleanup_id: run.id, by: who };
  let removed = 0;

  // Whole files
  for (const item of chosen.filter((i) => i.id.startsWith("file:"))) {
    const row = await env.DB.prepare("SELECT * FROM memory_files WHERE id = ?").bind(item.id.slice(5)).first();
    if (!row) {
      skipped.push({ id: item.id, why: "it's already gone" });
      continue;
    }
    const lines = judgeLines(row.id, row.body);
    const still = item.kind === "empty-file" ? !lines.length : lines.every((l) => l.kind === "junk-line");
    if (!still) {
      skipped.push({ id: item.id, why: "it has changed since the check and now holds facts worth keeping" });
      continue;
    }
    const res = await binAndDeleteFile(env, row, { reason: item.reason, ...binned });
    if (res.ok) removed++;
    else skipped.push({ id: item.id, why: "it changed while it was being removed" });
  }

  // Lines, file by file
  const byFile = new Map();
  for (const item of chosen.filter((i) => i.id.startsWith("line:"))) {
    const fileId = item.id.split(":")[1];
    if (!byFile.has(fileId)) byFile.set(fileId, []);
    byFile.get(fileId).push(item);
  }
  for (const [fileId, items] of byFile) {
    const want = new Map(items.map((i) => [i.id, i]));
    let done = false;
    for (let attempt = 0; attempt < 2 && !done; attempt++) {
      const row = await env.DB.prepare("SELECT * FROM memory_files WHERE id = ?").bind(fileId).first();
      if (!row) break;
      const out = [];
      const keep = [];
      for (const l of judgeLines(row.id, row.body)) {
        const asked = want.get(l.id);
        if (asked && l.kind === asked.kind) out.push({ ...asked, line: l.line });
        else keep.push(l.line);
      }
      if (!out.length) break;
      if (!keep.some((l) => l.trim())) {
        for (const o of out) skipped.push({ id: o.id, why: "removing it would leave the file empty; check again" });
        done = true;
        out.length = 0;
        break;
      }
      const version = crypto.randomUUID();
      const now = Date.now();
      const stmts = [
        env.DB.prepare("UPDATE memory_files SET body = ?, version = ?, source_app = 'Index cleanup', updated_at = ? WHERE id = ? AND version = ?").bind(keep.join("\n"), version, now, row.id, row.version),
        ...out.map((o) =>
          env.DB.prepare(
            "INSERT INTO memory_removed (id, cleanup_id, kind, reason, scope, owner_id, path, content, removed_by, removed_at) SELECT ?, ?, 'line', ?, ?, ?, ?, ?, ?, ? WHERE EXISTS (SELECT 1 FROM memory_files WHERE id = ? AND version = ?)"
          ).bind(crypto.randomUUID(), run.id, o.reason, row.scope, row.owner_id, row.path, o.line.trim(), who, now, row.id, version)
        ),
      ];
      const [upd] = await env.DB.batch(stmts);
      if (upd.meta.changes) {
        removed += out.length;
        for (const o of out) want.delete(o.id);
        done = true;
      }
    }
    for (const id of want.keys()) if (!skipped.some((s) => s.id === id)) skipped.push({ id, why: "it has changed or gone since the check" });
  }

  // Facts waiting for approval
  const pendingItems = chosen.filter((i) => i.id.startsWith("pending:"));
  if (pendingItems.length) {
    const rows = await pendingOldestFirst(env);
    const fileKeys = new Map();
    const { results: files } = await env.DB.prepare("SELECT * FROM memory_files").all();
    for (const f of files) fileKeys.set(fileKey(f.scope, f.owner_id, f.path), judgeFile(f).keys);
    const now = new Map(judgePending(rows, fileKeys).map((i) => [i.id, i]));
    for (const item of pendingItems) {
      const row = rows.find((r) => `pending:${r.id}` === item.id);
      const still = now.get(item.id);
      if (!row || !still || still.kind !== item.kind) {
        skipped.push({ id: item.id, why: row ? "it isn't junk or a repeat any more" : "it's already gone" });
        continue;
      }
      const [, del] = await env.DB.batch([
        env.DB.prepare(
          "INSERT INTO memory_removed (id, cleanup_id, kind, reason, scope, owner_id, path, content, removed_by, removed_at) SELECT ?, ?, 'pending', ?, ?, ?, ?, ?, ?, ? WHERE EXISTS (SELECT 1 FROM memory_pending WHERE id = ?)"
        ).bind(crypto.randomUUID(), run.id, item.reason, row.scope, row.owner_id, row.target, JSON.stringify(row), who, Date.now(), row.id),
        env.DB.prepare("DELETE FROM memory_pending WHERE id = ?").bind(row.id),
      ]);
      if (del.meta.changes) removed++;
      else skipped.push({ id: item.id, why: "it's already gone" });
    }
  }

  await env.DB.prepare("UPDATE memory_cleanups SET applied_by = ?, applied_at = ?, removed = ?, skipped = ? WHERE id = ?").bind(who, Date.now(), removed, JSON.stringify(skipped), run.id).run();
  await emptyOldBin(env);
  forgetCached();
  return { ok: true, cleanup_id: run.id, removed, skipped, bin_days: BIN_DAYS };
}

// ---- 3. The bin ----

export const emptyOldBin = (env) => env.DB.prepare("DELETE FROM memory_removed WHERE removed_at < ?").bind(Date.now() - BIN_MS).run();

// What's in the bin (newest first) and the last few cleanups
export async function listRemoved(env) {
  await emptyOldBin(env);
  const since = Date.now() - BIN_MS;
  const [bin, runs] = await env.DB.batch([
    env.DB.prepare("SELECT id, cleanup_id, kind, reason, scope, owner_id, path, content, removed_by, removed_at, restored_by, restored_at FROM memory_removed WHERE removed_at >= ? ORDER BY removed_at DESC LIMIT 300").bind(since),
    env.DB.prepare("SELECT id, checked_by, checked_at, applied_by, applied_at, removed, skipped FROM memory_cleanups ORDER BY checked_at DESC LIMIT 10"),
  ]);
  return {
    days: BIN_DAYS,
    removed: bin.results.map((r) => ({ ...r, text: binText(r), content: undefined })),
    runs: runs.results.map((r) => ({ ...r, skipped: JSON.parse(r.skipped || "[]").length })),
  };
}

// The words to show for a bin entry
function binText(r) {
  if (r.kind === "line") return r.content;
  try {
    const data = JSON.parse(r.content);
    if (r.kind === "pending") return data.fact;
    const n = data.body ? data.body.split("\n").filter((l) => l.trim()).length : 0;
    return `${data.name || data.path} (${n} fact${n === 1 ? "" : "s"})`;
  } catch {
    return "";
  }
}

// Put something back from the bin: a file comes back (or its facts join the file there now),
// a line goes back into its file (unless the file has it already), a pending fact rejoins the queue
export async function restoreRemoved(env, binId, by) {
  const r = await env.DB.prepare("SELECT * FROM memory_removed WHERE id = ?").bind(String(binId)).first();
  if (!r) return fail("That isn't in the bin", 404);
  if (r.restored_at) return fail("That's already been put back", 409);
  if (r.removed_at < Date.now() - BIN_MS) return fail(`It's been more than ${BIN_DAYS} days, so it can't come back`, 410);
  const now = Date.now();
  if (r.kind === "pending") {
    await restorePending(env, JSON.parse(r.content));
  } else {
    const data = r.kind === "file" ? JSON.parse(r.content) : null;
    const lines = r.kind === "file" ? String(data.body || "").split("\n").filter((l) => l.trim()) : [r.content];
    for (let attempt = 0; ; attempt++) {
      const current = await getFile(env, r.scope, r.owner_id, r.path);
      if (!current) {
        const name = (data && data.name) || r.path.split("/").pop();
        const aliases = data ? (typeof data.aliases === "string" ? data.aliases : JSON.stringify(data.aliases || [])) : "[]";
        const res = await env.DB.prepare(
          "INSERT OR IGNORE INTO memory_files (id, scope, owner_id, path, name, description, aliases, body, version, source_app, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, 'Index (put back)', ?)"
        )
          .bind(crypto.randomUUID(), r.scope, r.owner_id, r.path, name, (data && data.description) || `Facts about ${name}`, aliases, lines.join("\n"), crypto.randomUUID(), now)
          .run();
        if (res.meta.changes) break;
      } else {
        const have = new Set(current.body.split("\n").map((l) => normalFact(factOf(l))));
        const add = lines.filter((l) => !have.has(normalFact(factOf(l)))).map((l) => {
          const m = l.trim().match(FACT);
          return m ? factLine(m[1].toLowerCase(), m[2]) || l.trim() : l.trim();
        });
        if (!add.length) break;
        const res = await env.DB.prepare("UPDATE memory_files SET body = ?, version = ?, source_app = 'Index (put back)', updated_at = ? WHERE id = ? AND version = ?")
          .bind([current.body, ...add].filter(Boolean).join("\n"), crypto.randomUUID(), now, current.id, current.version)
          .run();
        if (res.meta.changes) break;
      }
      if (attempt >= 2) return fail("Someone is writing to that file right now. Try again in a moment.", 409);
    }
  }
  await env.DB.prepare("UPDATE memory_removed SET restored_by = ?, restored_at = ? WHERE id = ?").bind(String(by || "an admin").slice(0, 80), now, r.id).run();
  forgetCached();
  return { ok: true };
}

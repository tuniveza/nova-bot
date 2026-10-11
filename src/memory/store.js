// Index's memory store: small files of one-line facts, one file per
// subject, kept in D1 (never in git: it holds clients' details).
//
//   memory_files    the facts: scope + owner + path → description (the index) + body
//   memory_pending  facts waiting for a person to approve them
//
// Scopes: "studio" (shared; no owner), "staff" (per staff member), "customer"
// (per client: their email, or "chat:<id>" until it's known). Who may see
// which scope is decided by the caller's role (see ROLES below), never by the
// caller's own say-so.
//
// A file's body is lines like "- [stated] prefers evening sessions". Tags:
// [stated] said directly, [observed] seen in bookings or behaviour,
// [inferred] a pattern across observations.

export const SCOPES = ["studio", "staff", "customer"];
export const TAGS = ["stated", "observed", "inferred"];
// A file is kept under this size (a condense pass runs when it grows past it)
export const MAX_FILE_BYTES = 3000;
// The most memory that goes into one prompt (about 800 tokens)
export const CONTEXT_CHARS = 3200;

// What each kind of caller may read and write
//   agent    Nova Agent (its key): the studio's facts and staff memory
//   staff    Portal and Index (signed in): everything
//   website  NovaBot on the website: that customer's own file and the public studio file only
export const ROLES = {
  agent: { read: ["studio", "staff"], write: ["studio", "staff"] },
  staff: { read: ["studio", "staff", "customer"], write: ["studio", "staff", "customer"] },
  website: { read: ["customer"], write: [] },
  // A staff member signed in with Portal (not an admin): the studio's facts, and their own partition
  member: { read: ["studio", "staff"], write: ["staff"] },
};

export function allowed(role, action, scope) {
  return Boolean(ROLES[role] && ROLES[role][action].includes(scope));
}

// ---- Shapes ----

const text = (v, max) => (typeof v === "string" ? v.trim().slice(0, max) : "");

// "people/Kai M!" → "people/kai-m"; only the four kinds of path (plus the studio's own files)
export function cleanPath(path) {
  const p = String(path || "")
    .toLowerCase()
    .replace(/[^a-z0-9/_-]+/g, "-")
    .replace(/\/{2,}/g, "/")
    .replace(/^[-/]+|[-/]+$/g, "")
    .slice(0, 80);
  if (["profile", "studio", "public"].includes(p)) return p;
  const m = p.match(/^(people|topics|areas)\/([a-z0-9_-]{1,60})$/);
  return m ? `${m[1]}/${m[2].replace(/^-+|-+$/g, "")}` : "";
}

export function cleanOwner(scope, owner) {
  if (scope === "studio") return null;
  const o = String(owner || "").trim().toLowerCase().slice(0, 120);
  return o || null;
}

// One fact line: "- [tag] fact" (one short clause; never card, bank or ID numbers)
export function factLine(tag, fact) {
  const t = TAGS.includes(tag) ? tag : "stated";
  const f = String(fact || "").replace(/\s+/g, " ").replace(/^[-•*\s]+/, "").trim().slice(0, 240);
  return f ? `- [${t}] ${f}` : "";
}

// Things memory must never keep: card numbers, bank account and sort codes, National
// Insurance and passport numbers, passwords. A fact mentioning one is dropped.
const NEVER = [
  /\b(?:\d[ -]?){13,19}\b/, // card numbers
  /\b\d{2}[- ]\d{2}[- ]\d{2}\b.*\b\d{8}\b|\b\d{8}\b.*\b\d{2}[- ]\d{2}[- ]\d{2}\b/, // sort code + account
  /\baccount (?:no|number)\b|\bsort code\b|\biban\b|\bcvv\b|\bcvc\b|\bpin\b(?! code)/i,
  /\b[A-Z]{2}\s?\d{2}\s?\d{2}\s?\d{2}\s?[A-D]\b/i, // National Insurance numbers
  /\bnational insurance\b/i,
  /\bpassport\b|\bdriving licen[cs]e number\b|\bpassword\b/i,
];
export const isForbidden = (fact) => NEVER.some((re) => re.test(String(fact)));

// ---- What counts as a fact worth keeping (every write goes through this) ----

// A fact's text for comparing: no tag, case, accents, punctuation or extra spaces
// ("- [stated] Prefers  evening sessions." and "prefers evening sessions" are the same fact)
export function normalFact(fact) {
  return String(fact ?? "")
    .replace(/^\s*-?\s*\[(?:stated|observed|inferred)\]\s*/i, "")
    .toLowerCase()
    .normalize("NFKD")
    .replace(/[\u0300-\u036f]/g, "")
    .replace(/[^\p{L}\p{N}\s]+/gu, " ")
    .replace(/\s+/g, " ")
    .trim();
}

// Text that's a stand-in, not a fact (compared after normalFact)
const PLACEHOLDERS = new Set(
  [
    "n a", "na", "none", "null", "nil", "undefined", "nan", "object object", "unknown", "tbd", "tbc", "todo", "to do",
    "test", "testing", "test fact", "placeholder", "example", "example fact", "fact", "a fact", "new fact", "xxx", "xxxx",
    "asdf", "qwerty", "foo", "bar", "foo bar", "lorem ipsum", "no facts", "no fact", "nothing", "nothing to note",
    "nothing to remember", "no durable facts", "nothing durable", "empty", "blank", "etc", "misc", "same as above",
    "see above", "ditto", "yes", "no", "ok", "okay", "hi", "hello", "thanks", "thank you", "noted", "add a fact",
  ]
);
export const FACT_MAX = 240;

// Why a fact can't be kept (or null when it's fine). Plain words, shown to people.
export function junkReason(fact) {
  const f = String(fact ?? "").replace(/\s+/g, " ").replace(/^[-•*\s]+/, "").trim();
  if (!f) return "it's empty";
  if (f.length > FACT_MAX) return `it's too long for one fact (over ${FACT_MAX} characters): split it into short facts`;
  const n = normalFact(f);
  if (!n) return "it's only punctuation or symbols";
  if (PLACEHOLDERS.has(n) || n.startsWith("lorem ipsum")) return "it's placeholder text, not a fact";
  const solid = n.replace(/\s/g, "");
  if ((n.match(/\p{L}/gu) || []).length < 2) return "it has no words in it";
  if (solid.length < 3) return "it's too short to be a fact";
  if (/^(.)\1+$/u.test(solid)) return "it's one character over and over";
  // Cut off mid-sentence: a trailing "…" (but not "etc…"), a dangling comma, colon or dash,
  // an unclosed bracket at the end, or a last word that needs something after it
  if ((/(\.\.\.|…)$/.test(f) && !/\betc\.*…?$/i.test(f)) || /[,:;(\-–—&]$/.test(f) || /\b(and|or|but|the|because|plus)$/i.test(f)) {
    return "it looks cut off mid-sentence";
  }
  return null;
}

// A body checked line by line: what's kept, and each line that wasn't (with why).
// Kept: "- [tag] fact" lines that aren't junk, card/bank/ID numbers, or a repeat of an
// earlier line in the same file (the first copy stays).
// keep: lines already saved in the file. They're kept as they are even if the newer junk and
// repeat checks wouldn't let them in: old lines only ever go through the cleanup's report
// (cleanup.js: checked first, then a person presses Remove, and they go to the bin).
export function checkBody(body, { keep = new Set() } = {}) {
  const seen = new Map();
  const lines = [];
  const refused = [];
  for (const raw of String(body || "").split("\n")) {
    const shown = raw.trim();
    if (!shown) continue;
    const m = shown.match(/^-\s*\[(stated|observed|inferred)\]\s*(.*)$/i);
    if (!m) {
      refused.push({ line: shown.slice(0, 120), reason: 'it isn\'t a "- [tag] fact" line' });
      continue;
    }
    if (isForbidden(m[2])) {
      refused.push({ line: "(hidden)", reason: "memory never keeps card, bank or ID numbers, or passwords" });
      continue;
    }
    const old = keep.has(shown);
    const junk = old ? "" : junkReason(m[2]);
    if (junk) {
      refused.push({ line: shown.slice(0, 120), reason: junk });
      continue;
    }
    const line = factLine(m[1].toLowerCase(), m[2]);
    const key = normalFact(m[2]);
    if (seen.has(key) && !old) {
      refused.push({ line: shown.slice(0, 120), reason: `it repeats "${seen.get(key)}"` });
      continue;
    }
    if (!seen.has(key)) seen.set(key, line.replace(/^- \[\w+\] /, "").slice(0, 80));
    lines.push(line);
  }
  return { body: lines.join("\n"), refused };
}

// The body's lines, kept to fact lines only, without junk or repeats
export function cleanBody(body) {
  return checkBody(body).body;
}

function aliasesOf(value) {
  let list = value;
  if (typeof value === "string") {
    try {
      list = JSON.parse(value);
    } catch {
      list = value.split(",");
    }
  }
  return (Array.isArray(list) ? list : []).map((a) => text(String(a), 60)).filter(Boolean).slice(0, 12);
}

function shape(row, withBody = true) {
  if (!row) return null;
  const file = {
    id: row.id,
    scope: row.scope,
    owner_id: row.owner_id,
    path: row.path,
    name: row.name,
    description: row.description,
    aliases: aliasesOf(row.aliases),
    version: row.version,
    source_app: row.source_app,
    updated_at: row.updated_at,
    facts: row.body ? row.body.split("\n").filter(Boolean).length : 0,
  };
  if (withBody) file.body = row.body;
  return file;
}

// ---- A little cache inside this Worker, so a busy chat doesn't re-read D1 every turn ----
// Every write bumps the generation, which empties it (other Workers catch up within the TTL).
const CACHE_MS = 30_000;
const cache = new Map();
let generation = 0;
function cached(key, load) {
  const hit = cache.get(key);
  if (hit && hit.gen === generation && Date.now() - hit.at < CACHE_MS) return hit.value;
  const value = load();
  cache.set(key, { gen: generation, at: Date.now(), value });
  if (cache.size > 300) cache.delete(cache.keys().next().value);
  return value;
}
const bump = () => {
  generation += 1;
  cache.clear();
};
// For the cleanup (src/memory/cleanup.js), which writes D1 itself
export const forgetCached = () => bump();

// ---- Reading ----

// The listing for Index (no bodies, so it's quick to send)
// q: only files whose name, description, aliases, owner, path or facts mention it
// since: only files changed after this moment (ms), for Index's live feed
export async function listFiles(env, { scopes, owner_id, q, since } = {}) {
  const want = (scopes && scopes.length ? scopes : SCOPES).filter((s) => SCOPES.includes(s));
  let where = `scope IN (${want.map(() => "?").join(",")})`;
  const binds = [...want];
  if (owner_id === null) where += " AND owner_id IS NULL";
  else if (owner_id !== undefined) {
    where += " AND owner_id = ?";
    binds.push(owner_id);
  }
  if (q && String(q).trim()) {
    const like = "%" + String(q).trim().toLowerCase().replace(/[%_]/g, "").slice(0, 80) + "%";
    where += " AND (LOWER(name) LIKE ? OR LOWER(description) LIKE ? OR LOWER(aliases) LIKE ? OR LOWER(COALESCE(owner_id, '')) LIKE ? OR LOWER(path) LIKE ? OR LOWER(body) LIKE ?)";
    binds.push(like, like, like, like, like, like);
  }
  if (Number(since) > 0) {
    where += " AND updated_at > ?";
    binds.push(Number(since));
  }
  const { results } = await env.DB.prepare(
    `SELECT id, scope, owner_id, path, name, description, aliases, body, version, source_app, updated_at FROM memory_files WHERE ${where} ORDER BY updated_at DESC LIMIT 2000`
  )
    .bind(...binds)
    .all();
  // With a search, say which lines matched (so the list can show them)
  const term = q && String(q).trim().toLowerCase();
  return results.map((r) => {
    const f = shape(r, false);
    if (term) f.matches = r.body.split("\n").filter((l) => l.toLowerCase().includes(term)).slice(0, 3);
    return f;
  });
}

export async function getFile(env, scope, owner_id, path) {
  const owner = cleanOwner(scope, owner_id);
  const row = await env.DB.prepare(
    `SELECT * FROM memory_files WHERE scope = ? AND path = ? AND ${owner === null ? "owner_id IS NULL" : "owner_id = ?"}`
  )
    .bind(...(owner === null ? [scope, path] : [scope, path, owner]))
    .first();
  return shape(row);
}

// ---- Writing (optimistic: if_version must match, or "new" for a file that doesn't exist yet) ----

export async function putFile(env, input, source_app = "unknown") {
  const scope = SCOPES.includes(input.scope) ? input.scope : null;
  const path = cleanPath(input.path);
  if (!scope || !path) return { error: "A scope and a path (profile, people/…, topics/…, areas/…, studio or public) are needed", status: 400 };
  const owner = cleanOwner(scope, input.owner_id);
  if (scope !== "studio" && !owner) return { error: "An owner is needed for staff and customer files", status: 400 };
  // Every new line checked: lines that aren't "- [tag] fact", junk (empty, placeholder, cut
  // off), repeats, or card, bank or ID numbers are left out, each with its reason. Lines
  // already in the file stay (old ones are only tidied by the cleanup, with its report and bin).
  const before = await getFile(env, scope, owner, path);
  const keep = new Set(String(before?.body || "").split("\n").map((l) => l.trim()).filter(Boolean));
  const { body, refused } = checkBody(input.body, { keep });
  const given = String(input.body || "").split("\n").filter((l) => l.trim()).length;
  const kept = body ? body.split("\n").length : 0;
  const dropped = Math.max(0, given - kept);
  // Nothing worth keeping: refused (an empty file is junk too), with the reasons
  if (!kept) {
    if (!given) return { error: "A file needs at least one fact. To remove a file, delete it instead.", refused, status: 400 };
    return { error: `Nothing was saved: ${refusedText(refused)}`, refused, status: 400 };
  }
  const current = await getFile(env, scope, owner, path);
  const ifVersion = String(input.if_version || "");
  if (current ? ifVersion !== current.version : ifVersion !== "new") return { conflict: true, current, status: 409 };
  const name = text(input.name, 60) || path.split("/").pop();
  const description = text(input.description, 200) || (current && current.description) || `Facts about ${name}`;
  const aliases = JSON.stringify(aliasesOf(input.aliases ?? (current ? current.aliases : [])));
  const version = crypto.randomUUID();
  const now = Date.now();
  if (current) {
    const { meta } = await env.DB.prepare(
      "UPDATE memory_files SET name = ?, description = ?, aliases = ?, body = ?, version = ?, source_app = ?, updated_at = ? WHERE id = ? AND version = ?"
    )
      .bind(name, description, aliases, body, version, text(source_app, 40), now, current.id, current.version)
      .run();
    // Someone else wrote in between: say so, with what's there now
    if (!meta.changes) return { conflict: true, current: await getFile(env, scope, owner, path), status: 409 };
  } else {
    try {
      await env.DB.prepare(
        "INSERT INTO memory_files (id, scope, owner_id, path, name, description, aliases, body, version, source_app, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)"
      )
        .bind(crypto.randomUUID(), scope, owner, path, name, description, aliases, body, version, text(source_app, 40), now)
        .run();
    } catch {
      return { conflict: true, current: await getFile(env, scope, owner, path), status: 409 };
    }
  }
  bump();
  return {
    ok: true,
    file: await getFile(env, scope, owner, path),
    dropped,
    ...(dropped ? { refused, note: `${dropped} line${dropped === 1 ? " was" : "s were"} left out: ${refusedText(refused)}` } : {}),
  };
}

// "“ok” (it's placeholder text, not a fact); …" for people to read
export function refusedText(refused) {
  if (!refused || !refused.length) return "";
  const shown = refused.slice(0, 4).map((r) => (r.line === "(hidden)" ? r.reason : `"${String(r.line).slice(0, 60)}" (${r.reason})`));
  return shown.join("; ") + (refused.length > 4 ? `; and ${refused.length - 4} more` : "") + ".";
}

// Delete a file (only the version you read, if you give one: someone may have just added to it).
// A copy goes in the bin (memory_removed) first, so an admin can put it back for 30 days.
export async function deleteFile(env, scope, owner_id, path, version, by = "someone") {
  const owner = cleanOwner(scope, owner_id);
  const p = cleanPath(path);
  const current = await getFile(env, scope, owner, p);
  if (!current) return { ok: true };
  if (version && current.version !== version) return { conflict: true, current };
  const res = await binAndDeleteFile(env, current, { reason: "deleted in Index", by, cleanup_id: null });
  if (!res.ok) return { conflict: true, current: await getFile(env, scope, owner, p) };
  return { ok: true, binned: res.bin_id };
}

// Copy a file into the bin and delete it, in one go, only if it's still the version given
export async function binAndDeleteFile(env, file, { reason, by, cleanup_id }) {
  const binId = crypto.randomUUID();
  const row = { id: file.id, scope: file.scope, owner_id: file.owner_id, path: file.path, name: file.name, description: file.description, aliases: file.aliases, body: file.body || "", source_app: file.source_app, updated_at: file.updated_at };
  const [, del] = await env.DB.batch([
    env.DB.prepare(
      "INSERT INTO memory_removed (id, cleanup_id, kind, reason, scope, owner_id, path, content, removed_by, removed_at) SELECT ?, ?, 'file', ?, ?, ?, ?, ?, ?, ? WHERE EXISTS (SELECT 1 FROM memory_files WHERE id = ? AND version = ?)"
    ).bind(binId, cleanup_id, reason, file.scope, file.owner_id, file.path, JSON.stringify(row), String(by).slice(0, 80), Date.now(), file.id, file.version),
    env.DB.prepare("DELETE FROM memory_files WHERE id = ? AND version = ?").bind(file.id, file.version),
    // The bin keeps things 30 days, then they're gone for good
    env.DB.prepare("DELETE FROM memory_removed WHERE removed_at < ?").bind(Date.now() - 30 * 86_400_000),
  ]);
  bump();
  return del.meta.changes ? { ok: true, bin_id: binId } : { ok: false };
}

// A pending fact goes back in the queue (when approving it failed)
export async function restorePending(env, row) {
  await env.DB.prepare(
    "INSERT OR IGNORE INTO memory_pending (id, scope, owner_id, target, tag, fact, source_app, source_ref, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)"
  )
    .bind(row.id, row.scope, row.owner_id, row.target, row.tag, row.fact, row.source_app, row.source_ref, row.created_at)
    .run();
}

// ---- Facts waiting for approval ----

// A fact learned from a customer waits for approval, unless it's junk or already known:
// the same fact (after normalFact) waiting already for the same file, or already in that file.
// Returns { ok } or { refused: "why" }.
export async function addPending(env, { scope, owner_id, target, tag, fact, source_app, source_ref }) {
  if (!SCOPES.includes(scope)) return { refused: "no such memory" };
  if (isForbidden(fact)) return { refused: "memory never keeps card, bank or ID numbers, or passwords" };
  const path = cleanPath(target);
  if (!path) return { refused: "no such file" };
  const junk = junkReason(fact);
  if (junk) return { refused: junk };
  const line = factLine(tag, fact);
  const owner = cleanOwner(scope, owner_id);
  const key = normalFact(line);
  const { results: waiting } = await env.DB.prepare(
    `SELECT fact FROM memory_pending WHERE scope = ? AND target = ? AND ${owner === null ? "owner_id IS NULL" : "owner_id = ?"}`
  )
    .bind(...(owner === null ? [scope, path] : [scope, path, owner]))
    .all();
  if (waiting.some((w) => normalFact(w.fact) === key)) return { refused: "the same fact is already waiting for approval" };
  const file = await getFile(env, scope, owner, path);
  if (file && file.body.split("\n").some((l) => normalFact(l) === key)) return { refused: "it's already remembered" };
  await env.DB.prepare(
    "INSERT INTO memory_pending (id, scope, owner_id, target, tag, fact, source_app, source_ref, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)"
  )
    .bind(crypto.randomUUID(), scope, owner, path, TAGS.includes(tag) ? tag : "stated", line.replace(/^- \[\w+\] /, ""), text(source_app, 40), text(source_ref, 120) || null, Date.now())
    .run();
  return { ok: true };
}

export async function listPending(env) {
  const { results } = await env.DB.prepare("SELECT * FROM memory_pending ORDER BY created_at DESC LIMIT 300").all();
  return results;
}

export async function takePending(env, id) {
  const row = await env.DB.prepare("SELECT * FROM memory_pending WHERE id = ?").bind(String(id)).first();
  if (row) await env.DB.prepare("DELETE FROM memory_pending WHERE id = ?").bind(row.id).run();
  return row;
}

// ---- What goes into a prompt ----

const words = (s) => new Set(String(s || "").toLowerCase().match(/[a-z0-9]{3,}/g) || []);

// The files that matter for this turn, as a compact block of text:
//   always the studio's file (or its public one) and the person's profile,
//   then the 1–3 other files whose description, name or aliases best match the turn.
// readers: [{ scope, owner_id }] the caller may read (already checked against its role)
export async function context(env, { readers, q = "", budget = CONTEXT_CHARS, publicOnly = false }) {
  const key = JSON.stringify([readers, q.slice(0, 300), budget, publicOnly]);
  return cached(key, async () => {
    const files = [];
    for (const r of readers) {
      const owner = cleanOwner(r.scope, r.owner_id);
      const list = await listFiles(env, { scopes: [r.scope], owner_id: owner });
      for (const f of list) files.push(f);
    }
    // Always: the studio's file (or only its public one), then the person's profile, in that order
    const rank = { studio: 0, public: 1, profile: 2 };
    const always = files
      .filter((f) => (publicOnly ? f.path === "public" : f.path === "studio" || f.path === "public") || f.path === "profile")
      .sort((a, b) => rank[a.path] - rank[b.path]);
    // Score the rest against the turn
    const want = words(q);
    const scored = files
      .filter((f) => !always.includes(f) && !(publicOnly && f.scope === "studio"))
      .map((f) => {
        const have = words([f.name, f.description, f.path, ...(f.aliases || [])].join(" "));
        let score = 0;
        for (const w of want) if (have.has(w)) score += 1;
        // A name or alias said in full counts most
        for (const a of [f.name, ...(f.aliases || [])]) if (a && q.toLowerCase().includes(String(a).toLowerCase())) score += 3;
        return { f, score };
      })
      .filter((s) => s.score > 0)
      .sort((a, b) => b.score - a.score || b.f.updated_at - a.f.updated_at)
      .slice(0, 3)
      .map((s) => s.f);
    // Load only those bodies, most important first, within the budget
    let out = "";
    const used = [];
    for (const f of [...always, ...scored]) {
      const full = await getFile(env, f.scope, f.owner_id, f.path);
      if (!full || !full.body) continue;
      const block = `## ${f.scope === "studio" ? "Studio" : f.scope === "staff" ? "Staff" : "Client"} · ${f.path} — ${f.description}\n${full.body}\n`;
      if (out.length + block.length > budget) {
        // Keep what fits of this file, line by line (lowest relevance is dropped first)
        const room = budget - out.length - f.description.length - 40;
        if (room > 120) out += block.slice(0, room).replace(/\n[^\n]*$/, "") + "\n";
        break;
      }
      out += block;
      used.push(`${f.scope}:${f.path}`);
    }
    return { text: out.trim(), files: used };
  });
}

// The memory block for a system prompt (or nothing)
export function memoryPrompt(ctx, who = "the person you're talking to") {
  if (!ctx || !ctx.text) return "";
  return `WHAT NOVA AGENT REMEMBERS (facts learned earlier, about the studio and ${who}). Use them quietly to be more helpful; don't recite them, and don't mention this memory unless asked. If something here conflicts with what they say now, trust what they say now.\n${ctx.text}`;
}

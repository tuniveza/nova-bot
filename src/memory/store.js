// Nova Index's memory store: small files of one-line facts, one file per
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
//   staff    Nova Hub and Nova Index (signed in): everything
//   website  NovaBot on the website: that customer's own file and the public studio file only
export const ROLES = {
  agent: { read: ["studio", "staff"], write: ["studio", "staff"] },
  staff: { read: ["studio", "staff", "customer"], write: ["studio", "staff", "customer"] },
  website: { read: ["customer"], write: [] },
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

// The body's lines, kept to fact lines only, without repeats
export function cleanBody(body) {
  const seen = new Set();
  const lines = [];
  for (const raw of String(body || "").split("\n")) {
    const m = raw.trim().match(/^-\s*\[(stated|observed|inferred)\]\s*(.+)$/i);
    if (!m) continue;
    const line = factLine(m[1].toLowerCase(), m[2]);
    const key = line.toLowerCase();
    if (!line || seen.has(key) || isForbidden(m[2])) continue;
    seen.add(key);
    lines.push(line);
  }
  return lines.join("\n");
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

// ---- Reading ----

// The listing for Nova Index (no bodies, so it's quick to send)
// q: only files whose name, description, aliases, owner, path or facts mention it
// since: only files changed after this moment (ms), for Nova Index's live feed
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
  const body = cleanBody(input.body);
  // Lines left out: not "- [tag] fact", repeats, or card, bank or ID numbers
  const given = String(input.body || "").split("\n").filter((l) => l.trim()).length;
  const kept = body ? body.split("\n").length : 0;
  const dropped = Math.max(0, given - kept);
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
  return { ok: true, file: await getFile(env, scope, owner, path), dropped, ...(dropped ? { note: `${dropped} line${dropped === 1 ? " was" : "s were"} left out: each fact must be one "- [tag] fact" line, no repeats, and never card, bank or ID numbers.` } : {}) };
}

// Delete a file (only the version you read, if you give one: someone may have just added to it)
export async function deleteFile(env, scope, owner_id, path, version) {
  const owner = cleanOwner(scope, owner_id);
  const p = cleanPath(path);
  if (version) {
    const current = await getFile(env, scope, owner, p);
    if (current && current.version !== version) return { conflict: true, current };
  }
  await env.DB.prepare(`DELETE FROM memory_files WHERE scope = ? AND path = ? AND ${owner === null ? "owner_id IS NULL" : "owner_id = ?"}`)
    .bind(...(owner === null ? [scope, p] : [scope, p, owner]))
    .run();
  bump();
  return { ok: true };
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

export async function addPending(env, { scope, owner_id, target, tag, fact, source_app, source_ref }) {
  if (!SCOPES.includes(scope) || isForbidden(fact)) return;
  const path = cleanPath(target);
  const line = factLine(tag, fact);
  if (!path || !line) return;
  await env.DB.prepare(
    "INSERT INTO memory_pending (id, scope, owner_id, target, tag, fact, source_app, source_ref, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)"
  )
    .bind(crypto.randomUUID(), scope, cleanOwner(scope, owner_id), path, TAGS.includes(tag) ? tag : "stated", line.replace(/^- \[\w+\] /, ""), text(source_app, 40), text(source_ref, 120) || null, Date.now())
    .run();
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
  return `WHAT THE NOVA SUITE REMEMBERS (facts learned earlier, about the studio and ${who}). Use them quietly to be more helpful; don't recite them, and don't mention this memory unless asked. If something here conflicts with what they say now, trust what they say now.\n${ctx.text}`;
}

// The memory engine's doors.
//
// For Nova Agent (Authorization: Bearer <AGENT_NOVA_KEY>), role "agent":
//   GET  /memory/context?scope=staff&owner_id=&q=   the files that matter for this turn, as text
//   GET  /memory/file?scope=&owner_id=&path=        one file and its version token
//   PUT  /memory/file                               write a file ({ ..., if_version: "new" | token }; 409 + current on a clash)
//   POST /memory/extract                            hand over a conversation chunk; learned in the background (202)
//   GET  /memory/index?scope=                       the listing (no bodies)
// For Nova Hub and Nova Index (signed in), role "staff", under /app/api/memory/:
//   index, file (GET/PUT/DELETE), pending (GET), pending/:id (POST approve/reject), stats
// The website's NovaBot reads its own customer's slice in-process (see readForWebsite).

import { approve, learn, PATHS } from "./extract.js";
import { allowed, cleanPath, context, deleteFile, getFile, listFiles, listPending, putFile, restorePending, SCOPES, takePending } from "./store.js";

const json = (data, status = 200) => Response.json(data, { status, headers: { "Cache-Control": "no-store" } });

// Shared by both doors: the role decides what's allowed
async function serve(request, env, ctx, route, role, sourceApp, memberId = null) {
  const url = new URL(request.url);
  const q = (k) => url.searchParams.get(k);
  if (!env.DB) return json({ error: "No database" }, 503);
  // A member only ever sees their own staff partition
  if (role === "member") {
    const owner = (request.method === "PUT" ? null : q("owner_id")) || null;
    if (q("scope") === "staff" && owner && owner !== memberId) return json({ error: "Not allowed" }, 403);
    if (route === "/index" && request.method === "GET") {
      const scopes = q("scope") ? [q("scope")].filter((s) => allowed(role, "read", s)) : ["studio", "staff"];
      const files = [];
      for (const s of scopes) files.push(...(await listFiles(env, { scopes: [s], owner_id: s === "staff" ? memberId : undefined, q: q("q"), since: q("since") })));
      return json({ files: files.sort((a, b) => b.updated_at - a.updated_at), at: Date.now(), member: memberId });
    }
    if (route === "/file" && request.method === "PUT") {
      const peek = await request.clone().json().catch(() => ({}));
      if (peek.scope === "staff" && String(peek.owner_id || "").toLowerCase() !== memberId) return json({ error: "Not allowed" }, 403);
    }
    if (route === "/pending" || route.startsWith("/pending/")) return route === "/pending" ? json({ pending: [], locked: true }) : json({ error: "Approvals are for admins" }, 403);
    if (route === "/stats") {
      const files = [...(await listFiles(env, { scopes: ["studio"] })), ...(await listFiles(env, { scopes: ["staff"], owner_id: memberId }))];
      const by = {};
      for (const f of files) (by[f.scope] ||= { scope: f.scope, files: 0, facts: 0 }), by[f.scope].files++, (by[f.scope].facts += f.facts);
      return json({ scopes: Object.values(by), pending: 0, locked: true });
    }
    if (route === "/context") return json({ error: "Not allowed" }, 403);
  }

  if (route === "/index" && request.method === "GET") {
    const scopes = (q("scope") ? [q("scope")] : SCOPES).filter((s) => allowed(role, "read", s));
    return json({ files: await listFiles(env, { scopes, q: q("q"), since: q("since") }), at: Date.now() });
  }
  if (route === "/file" && request.method === "GET") {
    const scope = q("scope");
    if (!allowed(role, "read", scope)) return json({ error: "Not allowed" }, 403);
    const file = await getFile(env, scope, q("owner_id"), cleanPath(q("path")));
    return file ? json({ file }) : json({ error: "No such file" }, 404);
  }
  if (route === "/file" && request.method === "PUT") {
    const body = await request.json().catch(() => ({}));
    if (!allowed(role, "write", body.scope)) return json({ error: "Not allowed" }, 403);
    const res = await putFile(env, body, sourceApp);
    if (res.error) return json({ error: res.error }, res.status || 400);
    if (res.conflict) return json({ error: "Changed since you read it", current: res.current }, 409);
    return json({ ok: true, file: res.file, dropped: res.dropped, ...(res.note ? { note: res.note } : {}) });
  }
  if (route === "/file" && request.method === "DELETE") {
    const scope = q("scope");
    if (!allowed(role, "write", scope)) return json({ error: "Not allowed" }, 403);
    const res = await deleteFile(env, scope, q("owner_id"), q("path"), q("version"));
    return res.conflict ? json({ error: "Changed since you read it", current: res.current }, 409) : json(res);
  }
  if (route === "/context" && request.method === "GET") {
    const scope = q("scope") || "staff";
    if (!allowed(role, "read", scope) || !allowed(role, "read", "studio")) return json({ error: "Not allowed" }, 403);
    const readers = [{ scope: "studio", owner_id: null }];
    if (scope !== "studio") readers.push({ scope, owner_id: q("owner_id") });
    return json(await context(env, { readers, q: q("q") || "", budget: Math.min(Number(q("budget")) || 3200, 6000) }));
  }
  if (route === "/extract" && request.method === "POST") {
    const body = await request.json().catch(() => ({}));
    const scope = body.scope || "staff";
    if (!allowed(role, "write", scope)) return json({ error: "Not allowed" }, 403);
    const transcript = String(body.transcript || "").slice(-16000);
    if (!transcript.trim()) return json({ error: "No conversation" }, 400);
    // Learned in the background: the caller never waits
    ctx.waitUntil(
      learn(env, {
        transcript,
        scope,
        owner_id: body.owner_id,
        mode: scope === "customer" ? "pending" : "auto",
        source_app: sourceApp,
        source_ref: body.source_ref,
        who: scope === "staff" ? "a Novacane staff member talking to Nova Agent" : "the studio team",
        paths: PATHS[scope === "staff" ? "staff" : scope === "customer" ? "customer" : "hub"],
      }).catch((err) => console.log("Memory extraction failed:", err.message))
    );
    return json({ ok: true, queued: true }, 202);
  }
  // Nova Index and Nova Hub only
  if (role === "staff" && route === "/pending" && request.method === "GET") return json({ pending: await listPending(env) });
  if (role === "staff" && route.startsWith("/pending/") && request.method === "POST") {
    const body = await request.json().catch(() => ({}));
    const row = await takePending(env, route.slice("/pending/".length));
    if (!row) return json({ error: "Already dealt with" }, 404);
    if (body.action !== "approve") return json({ ok: true, rejected: true });
    const res = await approve(env, row, body.fact).catch((err) => ({ error: err.message }));
    if (res.error) {
      // Not saved: the fact goes back in the queue rather than being lost
      await restorePending(env, row);
      return json({ error: res.error, kept: true }, 400);
    }
    return json({ ok: true, file: res.file });
  }
  if (role === "staff" && route === "/stats" && request.method === "GET") {
    const counts = await env.DB.batch([
      env.DB.prepare("SELECT scope, COUNT(*) AS files, SUM(CASE WHEN body = '' THEN 0 ELSE LENGTH(body) - LENGTH(REPLACE(body, char(10), '')) + 1 END) AS facts FROM memory_files GROUP BY scope"),
      env.DB.prepare("SELECT COUNT(*) AS n FROM memory_pending"),
    ]);
    return json({ scopes: counts[0].results, pending: counts[1].results[0].n });
  }
  return json({ error: "Not found" }, 404);
}

// Nova Agent's door (the agent key)
// Compare two secrets without giving away how much matched
async function sameText(a, b) {
  const hash = async (s) => new Uint8Array(await crypto.subtle.digest("SHA-256", new TextEncoder().encode(String(s))));
  return crypto.subtle.timingSafeEqual(await hash(a), await hash(b));
}

export async function handleMemoryApi(request, env, ctx, pathname) {
  const auth = request.headers.get("Authorization") || "";
  const key = auth.startsWith("Bearer ") ? auth.slice(7) : "";
  if (!env.AGENT_NOVA_KEY || !(await sameText(key, env.AGENT_NOVA_KEY))) return json({ error: "Not allowed" }, 401);
  return serve(request, env, ctx, pathname.slice("/memory".length), "agent", "Nova Agent");
}

// Nova Hub's and Nova Index's door (already signed in when this is called)
// memberId: a signed-in staff member who isn't an admin (only their own partition and the studio's facts)
export function handleMemoryForStaff(request, env, ctx, route, sourceApp = "Nova Index", memberId = null) {
  return memberId ? serve(request, env, ctx, route, "member", sourceApp, memberId) : serve(request, env, ctx, route, "staff", sourceApp);
}

// ---- The website's NovaBot (in-process) ----

// Who this chat is, as a customer: their email if they've sent an enquiry from it
async function customerFor(env, chatId) {
  if (!chatId) return null;
  const row = await env.DB.prepare("SELECT email FROM enquiries WHERE chat_id = ? AND email IS NOT NULL ORDER BY id DESC LIMIT 1").bind(chatId).first().catch(() => null);
  return row && row.email ? row.email.toLowerCase() : `chat:${chatId}`;
}

// What NovaBot may know on the website: the public studio file and this customer's own file
export async function readForWebsite(env, chatId, q) {
  if (!env.DB) return null;
  const owner = await customerFor(env, chatId);
  const readers = [{ scope: "studio", owner_id: null }];
  if (owner) readers.push({ scope: "customer", owner_id: owner });
  return context(env, { readers, q, publicOnly: true, budget: 2000 });
}

// What Nova Hub's chats may know: the studio's memory (people, topics, areas)
export function readForStaff(env, q) {
  if (!env.DB) return null;
  return context(env, { readers: [{ scope: "studio", owner_id: null }], q });
}

// Learn from Nova Hub's staff chats (in the background; saved straight away: staff are trusted)
export function learnFromStaffChat(env, messages) {
  const transcript = messages
    .slice(-6)
    .map((m) => `${m.role === "user" ? "Staff" : "NovaBot"}: ${m.content}`)
    .join("\n");
  return learn(env, { transcript, scope: "studio", owner_id: null, mode: "auto", source_app: "Nova Hub", who: "the studio team in Nova Hub", paths: PATHS.hub });
}

// ---- Website chats, read for facts by the every-minute job ----
// A chat is read once it's been quiet for 10 minutes (or every 20 messages in a long one),
// two chats a run at most, and only from where it was last read. Facts wait for approval.
export async function learnFromWebsiteChats(env) {
  if (!env.DB || !env.ANTHROPIC_API_KEY) return;
  const quiet = new Date(Date.now() - 10 * 60_000).toISOString();
  const { results } = await env.DB.prepare(
    `SELECT m.chat_id, MAX(m.id) AS last_id, MAX(m.created_at) AS last_at, COUNT(*) AS n
     FROM chat_messages m LEFT JOIN memory_progress p ON p.chat_id = m.chat_id
     WHERE m.id > COALESCE(p.last_message_id, 0) AND m.chat_id IS NOT NULL
     GROUP BY m.chat_id HAVING MAX(m.created_at) < ? OR COUNT(*) >= 20
     ORDER BY last_at LIMIT 2`
  )
    .bind(quiet)
    .all()
    .catch(() => ({ results: [] }));
  for (const chat of results) {
    const from = await env.DB.prepare("SELECT last_message_id FROM memory_progress WHERE chat_id = ?").bind(chat.chat_id).first("last_message_id");
    const { results: msgs } = await env.DB.prepare("SELECT id, role, content FROM chat_messages WHERE chat_id = ? AND id > ? ORDER BY id LIMIT 40")
      .bind(chat.chat_id, from || 0)
      .all();
    if (!msgs.length) continue;
    const last = msgs[msgs.length - 1].id;
    // Mark it read first, so a failure never makes it run again and again
    await env.DB.prepare("INSERT INTO memory_progress (chat_id, last_message_id, updated_at) VALUES (?, ?, ?) ON CONFLICT (chat_id) DO UPDATE SET last_message_id = excluded.last_message_id, updated_at = excluded.updated_at")
      .bind(chat.chat_id, last, Date.now())
      .run();
    const transcript = msgs.map((m) => `${m.role === "user" ? "Customer" : "NovaBot"}: ${m.content}`).join("\n");
    await learn(env, {
      transcript,
      scope: "customer",
      owner_id: await customerFor(env, chat.chat_id),
      mode: "pending",
      source_app: "NovaBot",
      source_ref: chat.chat_id,
      who: "a customer chatting with NovaBot on the studio's website",
      paths: PATHS.customer,
    }).catch((err) => console.log("Memory from a website chat failed:", err.message));
  }
}

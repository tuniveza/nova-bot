// The inbox: enquiries sorted like support tickets, the spam filter, saved replies, and
// website chats marked "needs a person" or "done" (migrations/0030_inbox.sql)
//
// Every enquiry is in one place (its status):
//   new → open → replied ("Waiting on them") → done, or spam
// Moving it is one press in Portal. Nothing is ever deleted: Spam is just another folder, and
// "Not spam" moves an enquiry back to New. Sending a reply still works exactly as before
// (src/enquiry-replies.js): nothing here sends anything, to anyone.
//
// The spam filter runs when an enquiry arrives (src/enquiries.js). It's a few plain rules, each
// with a reason a person can read; an enquiry that scores 2 or more goes to Spam with the
// reasons shown on its card. Spam doesn't ping phones or email the team a copy. The visitor is
// told the same as any other ("Sent"), so a spammer learns nothing.
//
// Who can do what:
//   - Any staff signed in to Portal: sort enquiries, take one on, label it, write and edit
//     saved replies, mark website chats.
//   - Nova Agent's AI (its key): list saved replies and sort an enquiry (new / open / waiting /
//     done / spam). It can't send, approve or delete anything.

const nowIso = () => new Date().toISOString();
const fail = (status, error) => ({ status, error });

// The places an enquiry can be, as stored, and what Portal calls them
export const STATES = ["new", "open", "replied", "done", "spam"];
export const STATE_NAMES = { new: "New", open: "Open", replied: "Waiting on them", done: "Done", spam: "Spam" };
// Names people (and the AI) might use for them
const STATE_WORDS = { waiting: "replied", "waiting-on-them": "replied", closed: "done", "not-spam": "new" };

export function readState(value) {
  const word = String(value || "").trim().toLowerCase().replace(/\s+/g, "-");
  const state = STATE_WORDS[word] || word;
  return STATES.includes(state) ? state : null;
}

const MAX_LABEL = 40;
const MAX_TITLE = 80;
const MAX_REPLY = 4000;
const MAX_SAVED = 100;

// ===== THE SPAM FILTER =====

// Throwaway email services: nobody who wants a reply uses one
export const DISPOSABLE_DOMAINS = new Set([
  "mailinator.com", "guerrillamail.com", "guerrillamail.net", "guerrillamailblock.com", "sharklasers.com", "grr.la",
  "10minutemail.com", "10minutemail.net", "tempmail.com", "temp-mail.org", "temp-mail.io", "tempmail.net", "tempail.com",
  "yopmail.com", "yopmail.net", "trashmail.com", "trashmail.de", "getnada.com", "nada.email", "dispostable.com",
  "maildrop.cc", "throwawaymail.com", "fakeinbox.com", "mintemail.com", "emailondeck.com", "mohmal.com", "burnermail.io",
  "spamgourmet.com", "mailnesia.com", "mytemp.email", "moakt.com", "mailcatch.com", "spambox.us", "tempinbox.com",
  "discard.email", "getairmail.com", "inboxkitten.com", "tempr.email", "emailfake.com", "fakemail.net",
]);

// Things only spam says to a recording studio. Each is a whole phrase (or word), matched
// without caring about capitals.
export const SPAM_PHRASES = [
  "seo services", "seo agency", "backlinks", "guest post", "rank your website", "rank higher on google", "first page of google",
  "increase your traffic", "website traffic", "web design services", "redesign your website", "lead generation services",
  "crypto investment", "bitcoin investment", "forex trading", "binary options", "investment opportunity", "double your money",
  "casino", "viagra", "cialis", "payday loan", "loan offer", "work from home and earn", "make money online",
  "dear sir/madam", "dear website owner", "kindly reply", "click here to claim", "you have won", "claim your prize",
  "buy followers", "buy instagram followers", "spotify streams for sale", "cheap streams",
];

const LINK = /\bhttps?:\/\/|\bwww\.[a-z0-9-]+\.|\b[a-z0-9-]+\.(?:ru|xyz|top|click|loan|icu|buzz|cn)\b/gi;

// Words that are just keyboard mashing: long with no vowels, or a long run of consonants
// (links are left out first: their ids often look like that)
function gibberishWords(text) {
  const words = String(text || "").toLowerCase().replace(/\S*(?:https?:\/\/|www\.)\S*/g, " ").match(/[a-z]{7,}/g) || [];
  return words.filter((w) => !/[aeiouy]/.test(w) || /[bcdfghjklmnpqrstvwxz]{6,}/.test(w));
}

// Is this enquiry likely spam? -> { spam, score, reasons: ["3 links", …] }
// `recent`: how many enquiries this visitor sent in the last day before this one.
export function spamCheck({ name = "", email = "", subject = "", details = "" } = {}, { recent = 0 } = {}) {
  const reasons = [];
  let score = 0;
  const add = (points, reason) => {
    score += points;
    reasons.push(reason);
  };
  const text = `${subject}\n${details}`;
  const lower = text.toLowerCase();

  const links = (text.match(LINK) || []).length;
  if (links >= 3) add(2, `${links} links`);
  else if (links === 2) add(1, "2 links");

  const domain = String(email).toLowerCase().split("@")[1] || "";
  if (DISPOSABLE_DOMAINS.has(domain)) add(2, `a throwaway email address (${domain})`);

  const phrases = SPAM_PHRASES.filter((p) => new RegExp(`(^|[^a-z])${p.replace(/[.*+?^${}()|[\]\\/]/g, "\\$&")}([^a-z]|$)`, "i").test(lower));
  if (phrases.length) add(2, `spam words (${phrases.slice(0, 3).map((p) => `"${p}"`).join(", ")})`);

  const mashed = [...gibberishWords(name), ...gibberishWords(text)];
  const letters = (text.match(/[a-z]/gi) || []).length;
  if (mashed.length >= 2 || (mashed.length === 1 && letters < 60)) add(2, `random letters ("${mashed[0]}")`);
  else if (text.trim().length >= 10 && letters / text.trim().length < 0.4) add(2, "mostly symbols, not words");

  if (recent >= 3) add(1, `${recent + 1} enquiries from the same visitor today`);

  return { spam: score >= 2, score, reasons };
}

export const spamReason = (check) => "Likely spam: " + check.reasons.join("; ");

// ===== SORTING ENQUIRIES =====

// Move an enquiry to a state; optionally who's on it and its label at the same time.
// by: a staff id, or 'agent'. -> { ok, enquiry: { id, status, assigned_to, label } }
export async function sortEnquiry(env, by, input = {}) {
  const id = Number(input.id);
  if (!Number.isInteger(id) || id <= 0) return fail(400, "Which enquiry?");
  const row = await env.DB.prepare("SELECT id, status, assigned_to, label, spam_reason FROM enquiries WHERE id = ?").bind(id).first();
  if (!row) return fail(404, "That enquiry doesn't exist.");
  const sets = [];
  const binds = [];
  if (input.state !== undefined) {
    const state = readState(input.state);
    if (!state) return fail(400, `state must be one of: new, open, waiting, done, spam.`);
    if (state !== row.status) {
      sets.push("status = ?", "state_at = ?", "state_by = ?");
      binds.push(state, nowIso(), String(by));
      // Into Spam by hand: say who; out of Spam: the filter's reason goes
      if (state === "spam") {
        sets.push("spam_reason = ?");
        binds.push(by === "agent" ? "Moved to Spam by Agent" : "Moved to Spam by a person");
      } else if (row.status === "spam") sets.push("spam_reason = NULL");
    }
  }
  if (input.assignedTo !== undefined) {
    let who = input.assignedTo === null || input.assignedTo === "" ? null : String(input.assignedTo);
    if (who === "me") who = String(by);
    if (who) {
      const staff = await env.DB.prepare("SELECT id FROM staff WHERE id = ? AND status = 'active'").bind(who).first();
      if (!staff) return fail(400, "That person isn't on the team.");
    }
    sets.push("assigned_to = ?");
    binds.push(who);
  }
  if (input.label !== undefined) {
    const label = typeof input.label === "string" ? input.label.replace(/\s+/g, " ").trim().slice(0, MAX_LABEL) : "";
    sets.push("label = ?");
    binds.push(label || null);
  }
  if (sets.length) await env.DB.prepare(`UPDATE enquiries SET ${sets.join(", ")} WHERE id = ?`).bind(...binds, id).run();
  const after = await env.DB.prepare("SELECT id, status, assigned_to, label, spam_reason FROM enquiries WHERE id = ?").bind(id).first();
  return { enquiry: after };
}

// How many enquiries are in each place (Spam counted on its own)
export async function stateCounts(env) {
  const { results } = await env.DB.prepare("SELECT status, COUNT(*) AS n FROM enquiries GROUP BY status").all();
  const counts = Object.fromEntries(STATES.map((s) => [s, 0]));
  for (const r of results) if (counts[r.status] !== undefined) counts[r.status] = r.n;
  return counts;
}

// The team, for "who's on it"
export async function team(env) {
  const { results } = await env.DB.prepare("SELECT id, display_name AS name FROM staff WHERE status = 'active' ORDER BY display_name").all();
  return results;
}

// Labels already in use (most used first), to suggest when labelling
export async function labelsInUse(env) {
  const { results } = await env.DB.prepare("SELECT label, COUNT(*) AS n FROM enquiries WHERE label IS NOT NULL GROUP BY label ORDER BY n DESC, label LIMIT 30").all();
  return results.map((r) => r.label);
}

// ===== SAVED REPLIES =====

const publicSaved = (r) => ({ id: r.id, title: r.title, body: r.body, updatedAt: r.updated_at, updatedBy: r.updated_by_name || r.created_by_name || null });

export async function listSaved(env) {
  const { results } = await env.DB.prepare(
    `SELECT r.*, a.display_name AS created_by_name, b.display_name AS updated_by_name FROM saved_replies r
     LEFT JOIN staff a ON a.id = r.created_by LEFT JOIN staff b ON b.id = r.updated_by ORDER BY r.title COLLATE NOCASE`
  ).all();
  return results.map(publicSaved);
}

function savedFields(input) {
  const title = typeof input?.title === "string" ? input.title.replace(/\s+/g, " ").trim().slice(0, MAX_TITLE) : "";
  const body = typeof input?.body === "string" ? input.body.replace(/\r\n?/g, "\n").trim().slice(0, MAX_REPLY) : "";
  if (!title) return fail(400, "Give it a short name, e.g. “Prices”.");
  if (!body) return fail(400, "Write the reply.");
  return { title, body };
}

// Add (no id) or change (id) a saved reply
export async function saveSaved(env, me, input) {
  const fields = savedFields(input);
  if (fields.error) return fields;
  const now = nowIso();
  if (input.id !== undefined && input.id !== null) {
    const id = Number(input.id);
    const { meta } = await env.DB.prepare("UPDATE saved_replies SET title = ?, body = ?, updated_by = ?, updated_at = ? WHERE id = ?").bind(fields.title, fields.body, me.id, now, id).run();
    if (!meta.changes) return fail(404, "That saved reply doesn't exist.");
    return { saved: await listSaved(env) };
  }
  const { n } = await env.DB.prepare("SELECT COUNT(*) AS n FROM saved_replies").first();
  if (n >= MAX_SAVED) return fail(429, "That's a lot of saved replies already. Remove one you don't use first.");
  await env.DB.prepare("INSERT INTO saved_replies (title, body, created_by, created_at, updated_at) VALUES (?, ?, ?, ?, ?)").bind(fields.title, fields.body, me.id, now, now).run();
  return { saved: await listSaved(env) };
}

export async function removeSaved(env, input) {
  const id = Number(input?.id);
  if (!Number.isInteger(id)) return fail(400, "Which saved reply?");
  await env.DB.prepare("DELETE FROM saved_replies WHERE id = ?").bind(id).run();
  return { saved: await listSaved(env) };
}

// ===== WEBSITE CHATS AS TICKETS =====

export const CHAT_STATES = ["needs-person", "done"];

// Mark a chat "needs-person" or "done" (or "" / null to clear the mark); optionally who's on it
export async function markChat(env, me, input) {
  const chatId = typeof input?.chatId === "string" ? input.chatId.trim().slice(0, 200) : "";
  if (!chatId) return fail(400, "Which conversation?");
  const exists = await env.DB.prepare("SELECT 1 AS x FROM chat_messages WHERE chat_id = ? LIMIT 1").bind(chatId).first();
  if (!exists) return fail(404, "That conversation isn't there any more (chats are kept for 90 days).");
  const state = input.state === null || input.state === "" ? null : String(input.state);
  if (state === null) {
    await env.DB.prepare("DELETE FROM chat_tickets WHERE chat_id = ?").bind(chatId).run();
    return { ticket: null };
  }
  if (!CHAT_STATES.includes(state)) return fail(400, "needs-person or done?");
  let who = input.assignedTo === undefined ? undefined : input.assignedTo ? String(input.assignedTo) : null;
  if (who === "me") who = me.id;
  const now = nowIso();
  await env.DB.prepare(
    `INSERT INTO chat_tickets (chat_id, state, assigned_to, updated_by, updated_at) VALUES (?, ?, ?, ?, ?)
     ON CONFLICT (chat_id) DO UPDATE SET state = excluded.state, updated_by = excluded.updated_by, updated_at = excluded.updated_at
       ${who !== undefined ? ", assigned_to = excluded.assigned_to" : ""}`
  )
    .bind(chatId, state, who ?? null, me.id, now)
    .run();
  return { ticket: await env.DB.prepare("SELECT * FROM chat_tickets WHERE chat_id = ?").bind(chatId).first() };
}

// ===== ROUTES =====

// Portal's /app/api/inbox/… (src/app-page.js has already checked the sign-in and the Origin).
// -> a Response, or null
export async function handleInboxForStaff(request, env, me, route) {
  if (route === "/inbox/saved" && request.method === "GET") return json({ saved: await listSaved(env) });
  if (request.method !== "POST") return null;
  const body = await readJson(request);
  if (route === "/inbox/sort") return answer(await sortEnquiry(env, me.id, body));
  if (route === "/inbox/saved") return answer(await saveSaved(env, me, body));
  if (route === "/inbox/saved/remove") return answer(await removeSaved(env, body));
  if (route === "/inbox/chat") return answer(await markChat(env, me, body));
  return null;
}

// Nova Agent's /nova-agent/inbox/… (src/agent-nova.js has already checked the key). Sorting and
// reading saved replies only: nothing here sends, approves or deletes.
export async function handleInboxForAgent(env, pathname, body) {
  if (pathname === "/nova-agent/inbox/saved") return json({ saved: (await listSaved(env)).map(({ id, title, body }) => ({ id, title, body })) });
  if (pathname === "/nova-agent/inbox/sort") {
    // Only the state and the label: who's on it is for people to decide
    const changes = { id: body?.id, state: body?.state };
    if (body && Object.hasOwn(body, "label")) changes.label = body.label;
    return answer(await sortEnquiry(env, "agent", changes));
  }
  return json({ error: "Not found" }, 404);
}

function answer(result) {
  if (result?.error) return json({ error: result.error }, result.status || 400);
  return json({ ok: true, ...result });
}

async function readJson(request) {
  try {
    return (await request.json()) || {};
  } catch {
    return {};
  }
}

function json(data, status = 200) {
  return new Response(JSON.stringify(data), { status, headers: { "Content-Type": "application/json", "Cache-Control": "no-store" } });
}

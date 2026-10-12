// Live chat: someone from the studio typing straight to a visitor in a website chat
// (migrations/0033_live_chat.sql)
//
// In Portal → Conversations a staff member opens a website chat and presses Take over (or just
// replies): NovaBot stops answering that chat (index.js asks isStaffMode before calling Claude),
// and the visitor sees a note, "Sam from the studio has joined the chat.", then Sam's messages
// with his first name. Hand back gives the chat back to NovaBot (another note says so).
//
//   visitor's chat (public/novabot.js)        Portal (staff)
//     POST /chat/live { chatId, after } ──▶     GET  /app/api/conversations?chat=ID&after=N
//       ◀── { mode, staff, messages }           POST /app/api/conversations/live
//                                                    { chatId, action: takeover | handback | reply, text }
//
// The visitor's chat asks every few seconds while it's open. For a chat nobody has taken over
// that's one look at a tiny table (chat_live, by its key); nothing is held open, so Durable
// Object time isn't used at all.
//
// A visitor asking for a person ("can I speak to someone?") marks the chat "Needs a person" and
// sends the team's phones a quiet ping (once per half hour per chat). A visitor writing while a
// person has the chat pings that person (once every two minutes at most).
//
// Rules: these are replies to someone who started the conversation (a service, not marketing),
// so they need no approval. Only a person signed in to Portal can post as staff: NovaBot's AI
// never does, and Nova Agent has no tool for it. Logs say ids only, never what anyone wrote.

import { notifyPhones } from "./push.js";

const MAX_TEXT = 1500;
const PING_VISITOR_GAP_MS = 2 * 60 * 1000;
const PING_ASKED_GAP_MS = 30 * 60 * 1000;
const nowIso = () => new Date().toISOString();
const fail = (status, error) => ({ status, error });

// A website chat's id, as the widget makes them
export const goodChatId = (value) => typeof value === "string" && /^[A-Za-z0-9-]{8,64}$/.test(value);

// "Sam Brown" -> "Sam"
export function firstName(name) {
  const first = String(name || "").trim().split(/\s+/)[0] || "";
  return first.slice(0, 30) || "Someone";
}

const cleanText = (value) => (typeof value === "string" ? value.replace(/\r\n?/g, "\n").trim().slice(0, MAX_TEXT) : "");

export const joinedNote = (name) => `${name} from the studio has joined the chat.`;
export const leftNote = (name) => `${name} has handed you back to NovaBot. Ask anything, any time.`;

// The visitor asked for a person (a real one, not NovaBot)
const ASKS_FOR_PERSON =
  /\b(real|actual|live) (person|human|people)\b|\b(speak|talk|chat) (to|with) (a |an |the )?(person|human|someone|somebody|staff|engineer|owner|manager|team)\b|\bhuman please\b|\bare you (a )?(bot|robot|real)\b|\bcan (someone|somebody) (call|ring|text) me\b/i;
export const asksForPerson = (text) => ASKS_FOR_PERSON.test(String(text || ""));

async function liveRow(env, chatId) {
  return env.DB.prepare("SELECT * FROM chat_live WHERE chat_id = ?").bind(chatId).first();
}

// Is a person from the studio answering this chat (so NovaBot stays quiet)?
export async function staffMode(env, chatId) {
  if (!env.DB || !goodChatId(chatId)) return null;
  try {
    const row = await env.DB.prepare("SELECT mode, staff_id, staff_name FROM chat_live WHERE chat_id = ?").bind(chatId).first();
    return row && row.mode === "staff" ? row : null;
  } catch {
    return null; // (before the migration: as if nobody had)
  }
}

const insertMessage = (env, chatId, role, content, sender = null, page = null) =>
  env.DB.prepare("INSERT INTO chat_messages (chat_id, created_at, role, content, page, sender) VALUES (?, ?, ?, ?, ?, ?)").bind(chatId, nowIso(), role, content, page, sender);

async function chatExists(env, chatId) {
  return Boolean(await env.DB.prepare("SELECT 1 AS x FROM chat_messages WHERE chat_id = ? LIMIT 1").bind(chatId).first());
}

// ===== THE VISITOR'S SIDE (the website's chat) =====

// New messages from the studio for this chat (after the last one the visitor has), and who has it
export async function visitorPoll(env, { chatId, after }) {
  if (!goodChatId(chatId)) return { mode: "bot", staff: null, messages: [] };
  let live = null;
  try {
    live = await env.DB.prepare("SELECT mode, staff_name FROM chat_live WHERE chat_id = ?").bind(chatId).first();
  } catch {
    return { mode: "bot", staff: null, messages: [] };
  }
  if (!live) return { mode: "bot", staff: null, messages: [] };
  const from = Number.isInteger(after) && after > 0 ? after : 0;
  const { results } = await env.DB.prepare(
    "SELECT id, role, content, sender, created_at FROM chat_messages WHERE chat_id = ? AND id > ? AND role IN ('staff', 'note') ORDER BY id LIMIT 50"
  )
    .bind(chatId, from)
    .all();
  return {
    mode: live.mode,
    staff: live.mode === "staff" ? live.staff_name || null : null,
    messages: results.map((m) => ({ id: m.id, role: m.role, content: m.content, name: m.sender || null, at: m.created_at })),
  };
}

// The visitor wrote while a person has the chat: keep it (NovaBot doesn't answer) and let that
// person know, quietly
export async function visitorWroteToStaff(env, { chatId, page, text, live }) {
  const now = nowIso();
  await env.DB.batch([
    insertMessage(env, chatId, "user", text, null, page),
    env.DB.prepare("UPDATE chat_live SET visitor_at = ?, updated_at = ? WHERE chat_id = ?").bind(now, now, chatId),
  ]);
  const row = await liveRow(env, chatId);
  if (row && row.staff_id && (!row.pinged_at || Date.now() - Date.parse(row.pinged_at) > PING_VISITOR_GAP_MS)) {
    await env.DB.prepare("UPDATE chat_live SET pinged_at = ? WHERE chat_id = ?").bind(now, chatId).run();
    await ping(env, chatId, { to: [row.staff_id], title: "New message in a chat you're answering", body: "The visitor on the website chat wrote again. Open Conversations to reply." });
  }
  console.log(`Live chat ${chatId.slice(0, 8)}: visitor wrote while ${live ? "staff" : "nobody"} has it`);
}

// The visitor asked for a person: mark the chat "Needs a person" (unless it's marked already)
// and ping the team's phones, quietly, once per half hour for this chat
export async function visitorAskedForPerson(env, { chatId }) {
  if (!goodChatId(chatId)) return;
  const now = nowIso();
  try {
    await env.DB.prepare("INSERT INTO chat_tickets (chat_id, state, assigned_to, updated_by, updated_at) VALUES (?, 'needs-person', NULL, 'novabot', ?) ON CONFLICT (chat_id) DO NOTHING")
      .bind(chatId, now)
      .run();
    const row = await liveRow(env, chatId);
    if (row && row.pinged_at && Date.now() - Date.parse(row.pinged_at) < PING_ASKED_GAP_MS) return;
    await env.DB.prepare(
      `INSERT INTO chat_live (chat_id, mode, pinged_at, updated_at) VALUES (?, 'bot', ?, ?)
       ON CONFLICT (chat_id) DO UPDATE SET pinged_at = excluded.pinged_at, updated_at = excluded.updated_at`
    )
      .bind(chatId, now, now)
      .run();
    const { results } = await env.DB.prepare("SELECT id FROM staff WHERE status = 'active'").all();
    if (results.length) await ping(env, chatId, { to: results.map((r) => r.id), title: "A visitor wants a person", body: "Someone on the website chat asked to talk to a person. Open Conversations to reply." });
    console.log(`Live chat ${chatId.slice(0, 8)}: the visitor asked for a person`);
  } catch (err) {
    console.log("Live chat: couldn't mark a chat for a person:", err?.name);
  }
}

async function ping(env, chatId, { to, title, body }) {
  try {
    await notifyPhones(env, {
      title,
      body,
      url: `/portal/?view=chats&chat=${encodeURIComponent(chatId)}`,
      style: { source: "portal", kind: "chat", tag: `chat-${chatId}`, ttl: 3600, urgent: false },
      to: { staff: to },
    });
  } catch (err) {
    console.log(`Live chat ${chatId.slice(0, 8)}: the ping failed (${err?.name})`);
  }
}

// ===== THE STUDIO'S SIDE (Portal → Conversations) =====

// One chat for Portal: its messages (all, or after the last one Portal has) and who has it
export async function staffView(env, chatId, after = 0) {
  const from = Number.isInteger(after) && after > 0 ? after : 0;
  const [{ results }, live] = await Promise.all([
    env.DB.prepare("SELECT id, role, content, page, created_at, sender FROM chat_messages WHERE chat_id = ? AND id > ? ORDER BY id").bind(chatId, from).all(),
    liveRow(env, chatId).catch(() => null),
  ]);
  return {
    messages: results,
    live: {
      mode: live ? live.mode : "bot",
      staffId: live && live.mode === "staff" ? live.staff_id : null,
      staffName: live && live.mode === "staff" ? live.staff_name : null,
      since: live && live.mode === "staff" ? live.since : null,
      visitorAt: live ? live.visitor_at : null,
    },
  };
}

// Take the chat over: NovaBot pauses for it, the visitor is told who's here
export async function takeOver(env, me, chatId) {
  if (!goodChatId(chatId)) return fail(400, "Which chat?");
  if (!(await chatExists(env, chatId))) return fail(404, "That chat doesn't exist (chats are kept for 90 days).");
  const name = firstName(me.display_name);
  const live = await liveRow(env, chatId);
  if (live && live.mode === "staff" && live.staff_id === me.id) return { live: (await staffView(env, chatId, Number.MAX_SAFE_INTEGER)).live, unchanged: true };
  const now = nowIso();
  await env.DB.batch([
    env.DB.prepare(
      `INSERT INTO chat_live (chat_id, mode, staff_id, staff_name, since, updated_at) VALUES (?, 'staff', ?, ?, ?, ?)
       ON CONFLICT (chat_id) DO UPDATE SET mode = 'staff', staff_id = excluded.staff_id, staff_name = excluded.staff_name, since = excluded.since, updated_at = excluded.updated_at`
    ).bind(chatId, me.id, name, now, now),
    insertMessage(env, chatId, "note", joinedNote(name), name),
  ]);
  console.log(`Live chat ${chatId.slice(0, 8)}: taken over by ${me.id}`);
  return { live: (await staffView(env, chatId, Number.MAX_SAFE_INTEGER)).live };
}

// Give the chat back to NovaBot
export async function handBack(env, me, chatId) {
  if (!goodChatId(chatId)) return fail(400, "Which chat?");
  const live = await liveRow(env, chatId);
  if (!live || live.mode !== "staff") return { live: { mode: "bot" }, unchanged: true };
  const name = live.staff_name || firstName(me.display_name);
  const now = nowIso();
  await env.DB.batch([
    env.DB.prepare("UPDATE chat_live SET mode = 'bot', updated_at = ? WHERE chat_id = ?").bind(now, chatId),
    insertMessage(env, chatId, "note", leftNote(name), name),
  ]);
  console.log(`Live chat ${chatId.slice(0, 8)}: handed back to NovaBot by ${me.id}`);
  return { live: { mode: "bot" } };
}

// A message from the studio to the visitor. Replying to a chat NovaBot still has takes it over first.
export async function staffReply(env, me, chatId, text) {
  if (!goodChatId(chatId)) return fail(400, "Which chat?");
  const said = cleanText(text);
  if (!said) return fail(400, "Write a message first.");
  const live = await liveRow(env, chatId);
  if (!live || live.mode !== "staff") {
    const taken = await takeOver(env, me, chatId);
    if (taken.error) return taken;
  } else if (live.staff_id !== me.id) {
    // Someone else from the team joins in: the visitor sees their name on their messages
    await env.DB.prepare("UPDATE chat_live SET staff_id = ?, staff_name = ?, updated_at = ? WHERE chat_id = ?").bind(me.id, firstName(me.display_name), nowIso(), chatId).run();
  }
  const name = firstName(me.display_name);
  const row = await env.DB.prepare("INSERT INTO chat_messages (chat_id, created_at, role, content, page, sender) VALUES (?, ?, 'staff', ?, NULL, ?) RETURNING id").bind(chatId, nowIso(), said, name).first();
  console.log(`Live chat ${chatId.slice(0, 8)}: ${me.id} replied (#${row.id})`);
  return { id: row.id, live: (await staffView(env, chatId, Number.MAX_SAFE_INTEGER)).live };
}

// Portal's POST /app/api/conversations/live (app-page.js has checked the sign-in and the Origin)
export async function handleLiveForStaff(request, env, me) {
  let body = {};
  try {
    body = (await request.json()) || {};
  } catch {}
  const chatId = body.chatId;
  const result =
    body.action === "takeover" ? await takeOver(env, me, chatId) : body.action === "handback" ? await handBack(env, me, chatId) : body.action === "reply" ? await staffReply(env, me, chatId, body.text) : fail(400, "Say takeover, handback or reply.");
  if (result.error) {
    const { status, ...rest } = result;
    return Response.json(rest, { status: status || 400, headers: { "Cache-Control": "no-store" } });
  }
  return Response.json({ ok: true, ...result }, { headers: { "Cache-Control": "no-store" } });
}

// For the bot's own memory of a chat (and anything else that reads a transcript)
export function speakerOf(m) {
  if (m.role === "user") return "Customer";
  if (m.role === "staff") return `${m.sender || "Someone"} from the studio`;
  if (m.role === "note") return null;
  return "NovaBot";
}

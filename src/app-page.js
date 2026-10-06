// Nova Hub: the staff app at /app
//
// The app itself (public/app/) is plain files with no customer data in them.
// Everything it shows comes from these /app/api/ requests, which need a staff
// login (the ADMIN_PASSWORD secret):
//
//   POST /app/api/login                 { password } -> signs in (cookie, 30 days)
//   POST /app/api/logout
//   GET  /app/api/me                    is this browser signed in?
//   GET  /app/api/enquiries?show=all    enquiries (new ones only, unless show=all)
//   POST /app/api/enquiries/status      { id, status: "new" | "done" }
//   GET  /app/api/sessions              the session types, for booking links
//   POST /app/api/booking-link          { enquiryId, typeId } -> link with their details
//   GET  /app/api/conversations         recent customer chats (?chat=ID for one)
//   POST /app/api/chat                  { messages } -> NovaBot's reply (staff chat)
//   GET  /app/api/push/key              the public key phones need to sign up for notifications
//   POST /app/api/push/subscribe        { subscription } -> this phone gets notifications
//   POST /app/api/push/unsubscribe      { endpoint } -> this phone stops getting them
//   POST /app/api/push/test             sends a test notification to every signed-up phone
//   GET  /app/api/notifications         notifications that reached a phone (the Alerts tab), and its settings
//   POST /app/api/notifications/delete  { id } or { all: true } -> deletes alerts
//   POST /app/api/notifications/settings { days } -> alerts delete themselves after this many days (0 = off)
//   POST /app/api/voice                 a recording (WAV) -> { text } (for voice commands)
//   GET  /app/api/calendar              every booking in Acuity's diary (the Calendar tab)
//   POST /app/api/ask                   { question, history } -> { answer } (questions about bookings, enquiries, alerts)

import { ACUITY_OWNER, bookingLink, getSessionTypes } from "./booking.js";
import { askHub } from "./hub-ask.js";
import { questsForHub, queueQuestAction } from "./agent-nova.js";
import { listBookings } from "./booking-calendar.js";
// With the switch on Nova Bot's own booking system (mode.js), these come from src/nova/
import { usesNova } from "./mode.js";
import { bookingLink as novaBookingLink, getSessionTypes as novaSessionTypes } from "./nova/booking.js";
import { listBookings as novaListBookings } from "./nova/booking-calendar.js";
import { AUTO_DELETE_CHOICES, autoDeleteDays, deleteAlerts, forgetPhone, listAlerts, notifyPhones, savePhone, setAutoDelete } from "./push.js";

const COOKIE = "nvadmin";
const SIGNED_IN_DAYS = 30;

export async function handleApp(request, env, ctx, answer) {
  const url = new URL(request.url);
  const route = url.pathname.replace(/^\/app\/api/, "");

  if (!env.ADMIN_PASSWORD) {
    return json({ error: "The app isn't set up yet. Run: npx wrangler secret put ADMIN_PASSWORD" }, 503);
  }

  // Changes only from the app itself (stops other websites acting for a signed-in phone)
  if (request.method === "POST" && request.headers.get("Origin") !== url.origin) {
    return json({ error: "Forbidden" }, 403);
  }

  if (route === "/login" && request.method === "POST") return login(request, env);
  if (route === "/logout" && request.method === "POST") return logout();

  if (!(await signedIn(request, env))) return json({ error: "Please sign in" }, 401);

  if (route === "/me") return json({ ok: true });
  if (route === "/enquiries" && request.method === "GET") return listEnquiries(env, url);
  if (route === "/enquiries/status" && request.method === "POST") return setEnquiryStatus(request, env);
  if (route === "/sessions") return listSessions(env);
  if (route === "/booking-link" && request.method === "POST") return makeLink(request, env);
  if (route === "/conversations") return conversations(env, url);
  if (route === "/chat" && request.method === "POST") return staffChat(request, env, ctx, answer);
  if (route === "/push/key") return json({ publicKey: env.VAPID_PUBLIC_KEY || null });
  if (route === "/push/subscribe" && request.method === "POST") return subscribe(request, env);
  if (route === "/push/unsubscribe" && request.method === "POST") return unsubscribe(request, env);
  if (route === "/push/test" && request.method === "POST") return testNotification(env);
  if (route === "/notifications" && request.method === "GET") return alerts(env);
  if (route === "/notifications/delete" && request.method === "POST") return removeAlerts(request, env);
  if (route === "/notifications/settings" && request.method === "POST") return alertSettings(request, env);
  if (route === "/voice" && request.method === "POST") return voice(request, env);
  if (route === "/calendar" && request.method === "GET") return calendar(env);
  if (route === "/quests" && request.method === "GET") return json(await questsForHub(env));
  if (route === "/quests/action" && request.method === "POST") return questAction(request, env);
  if (route === "/ask" && request.method === "POST") return (await allowed(env, request, "app-ask:")) ? askHub(request, env) : json({ error: "Too many questions. Wait a minute." }, 429);
  return json({ error: "Not found" }, 404);
}

// ===== NOVA QUESTS =====

// A tap on a quest or mission in Nova Hub, passed on to Nova Agent
const QUEST_ACTIONS = ["done", "start", "skip", "reopen", "snooze", "finish", "pause", "resume"];
async function questAction(request, env) {
  const body = await readJson(request);
  const id = String(body.id || "").replace(/[^\w-]/g, "").slice(0, 64);
  const action = String(body.action || "");
  const kind = body.kind === "mission" ? "mission" : "quest";
  if (!id || !QUEST_ACTIONS.includes(action)) return json({ error: "That isn't something Nova Agent can do" }, 400);
  const minutes = Math.min(Math.max(Number(body.minutes) || 15, 1), 1440);
  await queueQuestAction(env, { kind, id, action, minutes });
  return json({ ok: true });
}

// ===== SIGNING IN =====

async function login(request, env) {
  // A few tries a minute at most, so the password can't be guessed by brute force
  const ip = request.headers.get("CF-Connecting-IP") || "";
  if (env.CHAT_LIMIT && ip) {
    try {
      if (!(await env.CHAT_LIMIT.limit({ key: "app-login:" + ip })).success) {
        return json({ error: "Too many tries. Wait a minute and try again." }, 429);
      }
    } catch {}
  }
  let password = "";
  try {
    password = String((await request.json()).password || "");
  } catch {}
  if (!(await sameText(password, env.ADMIN_PASSWORD))) return json({ error: "That password isn't right." }, 401);

  const expires = Date.now() + SIGNED_IN_DAYS * 24 * 60 * 60 * 1000;
  const token = `${expires}.${await signature(env, expires)}`;
  return json({ ok: true }, 200, {
    "Set-Cookie": `${COOKIE}=${token}; Path=/app; Max-Age=${SIGNED_IN_DAYS * 24 * 60 * 60}; HttpOnly; Secure; SameSite=Strict`,
  });
}

function logout() {
  return json({ ok: true }, 200, { "Set-Cookie": `${COOKIE}=; Path=/app; Max-Age=0; HttpOnly; Secure; SameSite=Strict` });
}

async function signedIn(request, env) {
  const cookie = (request.headers.get("Cookie") || "").split(/;\s*/).find((c) => c.startsWith(COOKIE + "="));
  if (!cookie) return false;
  const [expires, sig] = cookie.slice(COOKIE.length + 1).split(".");
  if (!/^\d+$/.test(expires || "") || Number(expires) < Date.now()) return false;
  return sameText(sig || "", await signature(env, expires));
}

// The cookie is signed with the admin password, so changing it signs everyone out
async function signature(env, expires) {
  const key = await crypto.subtle.importKey("raw", new TextEncoder().encode(env.ADMIN_PASSWORD), { name: "HMAC", hash: "SHA-256" }, false, ["sign"]);
  const mac = new Uint8Array(await crypto.subtle.sign("HMAC", key, new TextEncoder().encode("novabot-admin:" + expires)));
  return btoa(String.fromCharCode(...mac)).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

// Compare without giving away how much matched (same time whatever was typed)
async function sameText(a, b) {
  const hash = async (s) => new Uint8Array(await crypto.subtle.digest("SHA-256", new TextEncoder().encode(String(s))));
  return crypto.subtle.timingSafeEqual(await hash(a), await hash(b));
}

// ===== ENQUIRIES =====

async function listEnquiries(env, url) {
  const all = url.searchParams.get("show") === "all";
  const { results } = await env.DB.prepare(
    `SELECT id, created_at, name, email, phone, subject, details, page, chat_id, emailed, status
     FROM enquiries ${all ? "" : "WHERE status = 'new'"} ORDER BY created_at DESC LIMIT 300`
  ).all();
  const { count } = await env.DB.prepare("SELECT COUNT(*) AS count FROM enquiries WHERE status = 'new'").first();
  return json({ enquiries: results, newCount: count });
}

async function setEnquiryStatus(request, env) {
  const { id, status } = await readJson(request);
  if (!Number.isInteger(id) || !["new", "done"].includes(status)) return json({ error: "Bad request" }, 400);
  const { meta } = await env.DB.prepare("UPDATE enquiries SET status = ? WHERE id = ?").bind(status, id).run();
  if (!meta.changes) return json({ error: "That enquiry doesn't exist." }, 404);
  return json({ ok: true });
}

// ===== BOOKING LINKS =====

async function listSessions(env) {
  if (await usesNova(env)) return json({ sessions: novaSessionTypes().map(({ id, name, price }) => ({ id, name, price })) });
  try {
    const types = await getSessionTypes(ACUITY_OWNER);
    return json({ sessions: types.map(({ id, name, price }) => ({ id, name, price })) });
  } catch (err) {
    console.log("App couldn't read the session types:", err);
    return json({ error: "Couldn't read the sessions from the Acuity booking page just now." }, 502);
  }
}

async function makeLink(request, env) {
  const { enquiryId, typeId } = await readJson(request);
  const enquiry = await env.DB.prepare("SELECT name, email, phone FROM enquiries WHERE id = ?").bind(Number(enquiryId)).first();
  if (!enquiry) return json({ error: "That enquiry doesn't exist." }, 404);
  if (await usesNova(env)) {
    const type = novaSessionTypes().find((t) => t.id === Number(typeId));
    if (!type) return json({ error: "That session isn't bookable." }, 400);
    return json({ url: novaBookingLink(env, type.id, enquiry), session: type.name });
  }
  let types;
  try {
    types = await getSessionTypes(ACUITY_OWNER);
  } catch {
    return json({ error: "Couldn't read the sessions from the Acuity booking page just now." }, 502);
  }
  const type = types.find((t) => t.id === Number(typeId));
  if (!type) return json({ error: "That session isn't bookable." }, 400);
  return json({ url: bookingLink(ACUITY_OWNER, type.id, enquiry), session: type.name });
}

// ===== CONVERSATIONS =====

async function conversations(env, url) {
  const chatId = url.searchParams.get("chat");
  if (chatId) {
    const { results } = await env.DB.prepare("SELECT role, content, page, created_at FROM chat_messages WHERE chat_id = ? ORDER BY id")
      .bind(chatId)
      .all();
    return json({ messages: results });
  }
  const { results } = await env.DB.prepare(
    `SELECT chat_id, MIN(created_at) AS started, MAX(created_at) AS last, COUNT(*) / 2 AS messages,
       (SELECT content FROM chat_messages f WHERE f.chat_id = m.chat_id AND f.role = 'user' ORDER BY f.id LIMIT 1) AS first_question,
       (SELECT COUNT(*) FROM enquiries q WHERE q.chat_id = m.chat_id) AS enquiries
     FROM chat_messages m GROUP BY chat_id ORDER BY last DESC LIMIT 200`
  ).all();
  return json({ conversations: results });
}

// ===== STAFF CHAT WITH NOVABOT =====
// Same NovaBot as on the website, plus tools to manage existing bookings.
// Staff chats aren't saved to the chat log.

async function staffChat(request, env, ctx, answer) {
  const { messages } = await readJson(request);
  // The same memory as the website chat: the last 40 messages
  let list = Array.isArray(messages) ? messages.slice(-40) : [];
  list = list
    .filter((m) => (m.role === "user" || m.role === "assistant") && typeof m.content === "string")
    .map((m) => ({ role: m.role, content: m.content.slice(0, 1500) }));
  while (list.length && list[0].role !== "user") list.shift();
  if (!list.length) return json({ error: "No message" }, 400);
  const visitor = { chatId: null, page: "Nova Hub (staff)", ip: request.headers.get("CF-Connecting-IP") || "staff" };
  // Staff can also find, cancel, reschedule and change bookings (manage-bookings.js)
  return json({ reply: (await answer(list, env, visitor, (work) => ctx.waitUntil(work), { staff: true })).text });
}

// ===== NOTIFICATIONS =====
// Only signed-in staff get this far, so only their phones can sign up.

// A phone hands over its delivery address
async function subscribe(request, env) {
  // Read the address the phone sent
  const { subscription } = await readJson(request);
  // Save it, or say it wasn't a proper address
  return (await savePhone(env, subscription)) ? json({ ok: true }) : json({ error: "That isn't a valid notification address." }, 400);
}

// A phone turns notifications off
async function unsubscribe(request, env) {
  // Read which address to forget
  const { endpoint } = await readJson(request);
  // Forget it
  await forgetPhone(env, endpoint);
  // Say it's done
  return json({ ok: true });
}

// Staff tap "Send a test"
async function testNotification(env) {
  // Send it to every signed-up phone and count how many it reached
  // (tests stay out of the Alerts tab)
  const delivered = await notifyPhones(env, { title: "Nova Hub", body: "Test notification: notifications are working 🎉", save: false });
  // Report back
  return json({ delivered });
}

// ===== CALENDAR =====

// Every booking in Acuity's diary (from its private calendar feed)
async function calendar(env) {
  // Try it
  try {
    // Read the diary
    const bookings = (await usesNova(env)) ? await novaListBookings(env) : await listBookings(env);
    // The feed isn't set up
    if (!bookings) return json({ bookings: [], setUp: false });
    // The bookings
    return json({ bookings, setUp: true });
  } catch (err) {
    // The feed couldn't be read
    console.log("Calendar: couldn't read the Acuity feed:", err);
    return json({ error: "Couldn't read the Acuity calendar just now." }, 502);
  }
}

// ===== ALERTS =====

// The Alerts tab: the alerts, and the auto-delete switch's setting
async function alerts(env) {
  // Both at once
  return json({ notifications: await listAlerts(env), autoDeleteDays: await autoDeleteDays(env), choices: AUTO_DELETE_CHOICES });
}

// Delete one alert, or all of them
async function removeAlerts(request, env) {
  // Which: { id } or { all: true }
  const { id, all } = await readJson(request);
  // Nothing sensible asked for
  if (all !== true && !Number.isInteger(id)) return json({ error: "Bad request" }, 400);
  // Delete them
  await deleteAlerts(env, { id, all });
  // Done
  return json({ ok: true });
}

// The auto-delete switch: { days } (0 = off)
async function alertSettings(request, env) {
  // The number of days asked for
  const { days } = await readJson(request);
  // Only off, or one of the choices
  if (days !== 0 && !AUTO_DELETE_CHOICES.includes(days)) return json({ error: "Bad request" }, 400);
  // Save it (and delete anything already too old)
  await setAutoDelete(env, days);
  // Done
  return json({ ok: true, autoDeleteDays: days });
}

// ===== VOICE COMMANDS =====
// The app records what staff say and sends it here; Whisper (Workers AI)
// writes it down, and the app works out what to do with the words.

async function voice(request, env) {
  // A few a minute at most (it costs a little each time)
  const ip = request.headers.get("CF-Connecting-IP") || "";
  // Check the limit, ignoring problems with the limiter itself
  if (env.VOICE_LIMIT && ip && !(await env.VOICE_LIMIT.limit({ key: "app-voice:" + ip }).then((r) => r.success, () => true))) {
    // Too many
    return json({ error: "Too many voice commands. Wait a minute." }, 429);
  }
  // The recording
  const audio = new Uint8Array(await request.arrayBuffer());
  // Nothing recorded
  if (!audio.byteLength) return json({ error: "No audio" }, 400);
  // About a minute at most
  if (audio.byteLength > 1500000) return json({ error: "Too long" }, 413);
  // The recording as base64 text, which Whisper wants
  let binary = "";
  // Build it a piece at a time (one big step can overflow)
  for (let i = 0; i < audio.length; i += 0x8000) binary += String.fromCharCode(...audio.subarray(i, i + 0x8000));
  // Whisper sometimes fails on good audio, so try up to 3 times
  for (let attempt = 1; attempt <= 3; attempt++) {
    // Try it
    try {
      // Write down what was said
      const result = await env.AI.run("@cf/openai/whisper-large-v3-turbo", {
        // The recording
        audio: btoa(binary),
        // English
        language: "en",
        // Ignore silence
        vad_filter: true,
        // Words it should expect
        initial_prompt: "Nova, show alerts. Nova, call Eric. Staff giving a command to Nova Hub, the Novacane Studios app: show enquiries, alerts, chats, delete alerts, call, email, ask NovaBot.",
      });
      // Hand back the words
      return json({ text: (result.text || "").trim() });
    } catch (err) {
      // Note it and try again
      console.log("Voice command: Whisper failed (attempt " + attempt + "):", err);
    }
  }
  // It never worked
  return json({ error: "Couldn't hear that just now. Try again." }, 503);
}

// ===== SHARED =====

// Under the per-minute limit? (keyed by the phone's address)
async function allowed(env, request, prefix) {
  // The phone's address
  const ip = request.headers.get("CF-Connecting-IP") || "";
  // No limiter (tests) or no address: allowed
  if (!env.CHAT_LIMIT || !ip) return true;
  // Check, ignoring problems with the limiter itself
  return env.CHAT_LIMIT.limit({ key: prefix + ip }).then((r) => r.success, () => true);
}

async function readJson(request) {
  try {
    return await request.json();
  } catch {
    return {};
  }
}

function json(data, status = 200, headers = {}) {
  return new Response(JSON.stringify(data), {
    status,
    headers: { "Content-Type": "application/json", "Cache-Control": "no-store", ...headers },
  });
}

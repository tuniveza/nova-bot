// The staff API for Portal (the staff app, at /portal/; it used to be at /app/, so the API kept
// that address)
//
// The app itself (public/portal/) is plain files with no customer data in them.
// Everything it shows comes from these /app/api/ requests, which need a Portal
// sign-in (the one sign-in: /auth/login; there's no password here):
//
//   POST /app/api/logout                signs out of Portal (everything)
//   GET  /app/api/me                    is this browser signed in?
//   GET  /app/api/enquiries?show=all    enquiries (new ones only, unless show=all)
//   POST /app/api/enquiries/status      { id, status: "new" | "replied" | "done" } ("closed" = "done")
//   GET  /app/api/enquiries/thread?id=N an enquiry and its conversation (replies, notes, drafts)
//   POST /app/api/enquiries/reply       { id, body, key } -> emails the customer (a person pressed Send)
//   POST /app/api/enquiries/note        { id, body, key } -> an internal note (never sent)
//   POST /app/api/enquiries/draft/edit  { messageId, body } -> change a draft from Agent
//   POST /app/api/enquiries/draft/approve { messageId, body } -> Approve & send (a person's press)
//   POST /app/api/enquiries/draft/discard { messageId }
//   POST /app/api/enquiries/retry       { messageId } -> try a failed reply again
//   POST /app/api/enquiries/contact     { id, doNotContact } -> "Don't contact" on or off
//   POST /app/api/enquiries/logged      { id, kind: "whatsapp" | "sms" | "call", body, outcome, key }
//                                       -> a WhatsApp, text or call the person made from their own phone
//   GET  /app/api/services              what each part of Nova runs on, and whether it's set up
//   POST /app/api/services/test-email   emails the person signed in, through Resend
//     (Sending needs a browser's Portal sign-in, the cookie: never an app's token or Nova Agent's key.
//      See src/enquiry-replies.js.)
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
//   GET|PUT|DELETE /app/api/calendar/items[/:id]  the studio's events and day cards (src/calendar/items.js)
//   POST /app/api/ask                   { question, history } -> { answer } (questions about bookings, enquiries, alerts)
//   GET  /app/api/booking-actions?status=pending|all -> { actions, canDecide } booking changes the AIs proposed
//   POST /app/api/booking-actions/approve { id, payload? } -> approves it and makes the change in Acuity
//   POST /app/api/booking-actions/edit    { id, payload }  -> changes a pending one's details (still pending)
//   POST /app/api/booking-actions/reject  { id, note? }
//     (Approve, edit and reject need an admin with Portal open in a browser, the cookie: never an
//      app's token, other staff, or Nova Agent's key. See src/booking-actions.js.)
//   GET  /app/api/clients?search=&filter=all|owing|lapsed|enquiry&since=YYYY-MM-DD
//                                       -> { clients, total } the client list (500 at most; see src/clients.js)
//   GET  /app/api/clients/:id           -> { client, sessions, consentLog }
//   POST /app/api/clients/:id           { name?, email?, phone?, notes?, depositsPaid?, invoiced?, outstanding?,
//                                         consent?: { yes, source, at? } } -> { client } (consent yes needs a source;
//                                       every consent change is logged with who)
//   POST /app/api/clients               { name, email?, phone?, notes? } -> { client } added by hand
//                                       (a duplicate is refused with the existing one's id)
//   POST /app/api/clients/import        { csv } -> Acuity's appointments or clients spreadsheet (admins only)
//   POST /app/api/clients/sync          -> reads Acuity's calendar feed and the enquiries now (admins only)
//   GET  /app/api/campaigns?status=waiting|all|<status>
//                                       -> { campaigns, canDecide, audiences: { fans, clients, everyone }, signupUrl }
//                                       email campaigns (opted-in counts per audience; see src/campaigns.js)
//   GET  /app/api/campaigns/:id         -> { campaign, log, previewHtml }
//   GET  /app/api/campaigns/:id/preview -> the email as a page (for Portal's preview frame)
//   POST /app/api/campaigns             { subject, body, audience, sendAt? } -> { campaign } waiting for approval
//   POST /app/api/campaigns/:id/edit    { subject?, body?, audience?, sendAt? } -> { campaign } back to waiting
//                                       for approval (the approval is cleared; a scheduled send is cancelled)
//   POST /app/api/campaigns/:id/approve {} -> { campaign } approves it, then Resend sends it (or schedules it)
//   POST /app/api/campaigns/:id/reject  { note? }
//   POST /app/api/campaigns/test-send   { id } -> emails it once to the admin who pressed it, marked [TEST]
//     (Approve, reject and test-send need an admin with Portal open in a browser, the cookie: never an
//      app's token, other staff, or Nova Agent's key.)

import { ACUITY_OWNER, bookingLink, getSessionTypes } from "./booking.js";
import { askPortal } from "./portal-ask.js";
import { questsForPortal, queueQuestAction } from "./agent-nova.js";
import { handleMemoryForStaff, learnFromStaffChat } from "./memory/routes.js";
import { clearCookie, endSession, requireStaff } from "./portal/auth.js";
import { checkedLinks } from "./links.js";
import * as replies from "./enquiry-replies.js";
import * as bookingActions from "./booking-actions.js";
import { acuityFailure } from "./acuity/api.js";
import { servicesStatus, testEmailToMe } from "./services.js";
import { publicUrl } from "./nova/booking.js";
import { listBookings } from "./booking-calendar.js";
import { handleClientsForStaff } from "./clients.js";
import { handleCampaignsForStaff } from "./campaigns.js";
// With the switch on Nova Bot's own booking system (mode.js), these come from src/nova/
import { usesNova } from "./mode.js";
import { handleCalendarItems } from "./calendar/items.js";
import { bookingLink as novaBookingLink, getSessionTypes as novaSessionTypes } from "./nova/booking.js";
import { listBookings as novaListBookings } from "./nova/booking-calendar.js";
import { AUTO_DELETE_CHOICES, autoDeleteDays, deleteAlerts, forgetPhone, listAlerts, listPhones, notifyPhones, phoneName, savePhone, setAutoDelete, verifyBooking } from "./push.js";

// The old shared-password cookie: only ever cleared now (Portal is the one sign-in)
const OLD_COOKIE = "nvadmin";

export async function handleApp(request, env, ctx, answer) {
  const url = new URL(request.url);
  const route = url.pathname.replace(/^\/app\/api/, "");

  // Changes only from the app itself (stops other websites acting for a signed-in phone)
  if (request.method === "POST" && request.headers.get("Origin") !== url.origin) {
    return json({ error: "Forbidden" }, 403);
  }

  // Portal is the one sign-in: there's no password here any more
  if (route === "/login" && request.method === "POST") return json({ error: "Sign in with Portal", signIn: "/portal/" }, 410);
  if (route === "/logout" && request.method === "POST") return logout(request, env);

  const me = await requireStaff(request, env);
  if (!me) return json({ error: "Please sign in", signIn: "/portal/" }, 401);

  if (route === "/me") return json({ ok: true });
  if (route === "/enquiries" && request.method === "GET") return listEnquiries(env, url);
  if (route === "/enquiries/status" && request.method === "POST") return done(await replies.setEnquiryStatus(env, await readJson(request)));
  if (route.startsWith("/enquiries/")) {
    const reply = await enquiryReplies(request, env, me, route);
    if (reply) return reply;
  }
  if (route === "/booking-actions" || route.startsWith("/booking-actions/")) {
    const answer = await approvals(request, env, me, route);
    if (answer) return answer;
  }
  // The client list (src/clients.js): import and sync are for admins
  if (route === "/clients" || route.startsWith("/clients/")) {
    const answer = await handleClientsForStaff(request, env, me, route);
    if (answer) return answer;
  }
  // Email campaigns (src/campaigns.js): approve, reject and test-send are for an admin in a browser
  if (route === "/campaigns" || route.startsWith("/campaigns/")) {
    const answer = await handleCampaignsForStaff(request, env, me, route);
    if (answer) return answer;
  }
  if (route === "/services" && request.method === "GET") return json({ services: await servicesStatus(env), admin: me.role === "admin" });
  if (route === "/services/test-email" && request.method === "POST") return done(await testEmailToMe(env, me));
  if (route === "/sessions") return listSessions(env);
  if (route === "/booking-link" && request.method === "POST") return makeLink(request, env);
  if (route === "/conversations") return conversations(env, url);
  if (route === "/chat" && request.method === "POST") return staffChat(request, env, ctx, answer);
  if (route === "/push/key") return json({ publicKey: env.VAPID_PUBLIC_KEY || null });
  if (route === "/push/subscribe" && request.method === "POST") return subscribe(request, env, me);
  // The signed-up phones, for choosing which ones get a Calendar reminder
  if (route === "/push/phones" && request.method === "GET") return json({ phones: await listPhones(env), me: me.id });
  if (route === "/push/unsubscribe" && request.method === "POST") return unsubscribe(request, env);
  if (route === "/push/test" && request.method === "POST") return testNotification(env);
  if (route === "/notifications" && request.method === "GET") return alerts(env);
  if (route === "/verify-booking" && request.method === "GET") return json(await verifyBooking(env, url.searchParams.get("id")));
  if (route === "/notifications/delete" && request.method === "POST") return removeAlerts(request, env);
  if (route === "/notifications/settings" && request.method === "POST") return alertSettings(request, env);
  if (route === "/voice" && request.method === "POST") return voice(request, env);
  // Calendar's events and day cards (src/calendar/items.js). Changes only from this site or an app's sign-in.
  if (route === "/calendar/items" || route.startsWith("/calendar/items/")) {
    const app = (request.headers.get("Authorization") || "").startsWith("Bearer nsess_");
    if (request.method !== "GET" && !app && request.headers.get("Origin") !== url.origin) return json({ error: "Forbidden" }, 403);
    return handleCalendarItems(request, env, route);
  }
  if (route === "/calendar" && request.method === "GET") return calendar(env);
  if (route === "/quests" && request.method === "GET") return json(await questsForPortal(env));
  // Index: the suite's memory (browse, edit, approve)
  if (route.startsWith("/memory/")) {
    if (request.method !== "GET" && request.headers.get("Origin") !== url.origin) return json({ error: "Forbidden" }, 403);
    // An admin (or the shared studio password) sees everything; other staff see the studio's
    // memory and their own partition (Portal decides who's who)
    const who = await requireStaff(request, env);
    const member = who && who.role !== "admin" ? who.id : null;
    return handleMemoryForStaff(request, env, ctx, route.slice("/memory".length), request.headers.get("X-Nova-App") === "portal" ? "Portal" : "Index", member);
  }
  if (route === "/links" && request.method === "GET") return json(await checkedLinks(env));
  if (route === "/quests/action" && request.method === "POST") return questAction(request, env);
  if (route === "/ask" && request.method === "POST") return (await allowed(env, request, "app-ask:")) ? askPortal(request, env) : json({ error: "Too many questions. Wait a minute." }, 429);
  return json({ error: "Not found" }, 404);
}

// ===== NOVA QUESTS =====

// A tap on a quest or mission in Portal, passed on to Nova Agent
const QUEST_ACTIONS = ["done", "start", "skip", "reopen", "snooze", "finish", "pause", "resume", "mode"];
// How a quest is going (Nova Agent's MODES): Portal's mode chip
const QUEST_MODES = ["waiting", "soon", "working", "nearly", "longer", "questions", "done"];
async function questAction(request, env) {
  const body = await readJson(request);
  const id = String(body.id || "").replace(/[^\w-]/g, "").slice(0, 64);
  const action = String(body.action || "");
  const kind = body.kind === "mission" ? "mission" : "quest";
  if (!id || !QUEST_ACTIONS.includes(action)) return json({ error: "That isn't something Nova Agent can do" }, 400);
  const minutes = Math.min(Math.max(Number(body.minutes) || 15, 1), 1440);
  // The session it was tapped on, so a late or repeated "done" can't count against the next one
  const session = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}(:\d{2})?$/.test(body.session) ? body.session : undefined;
  if (action === "mode" && !QUEST_MODES.includes(body.mode)) return json({ error: "That isn't a mode" }, 400);
  await queueQuestAction(env, { kind, id, action, minutes, ...(session && { session }), ...(action === "mode" && { mode: body.mode }) });
  return json({ ok: true });
}

// ===== SIGNING OUT =====
// Signing in is Portal's job (/auth/login). Signing out here signs out of Portal, so of
// everything, and clears the old shared-password cookie if a phone still has one.

async function logout(request, env) {
  await endSession(env, request).catch(() => {});
  const headers = new Headers({ "Content-Type": "application/json", "Cache-Control": "no-store" });
  headers.append("Set-Cookie", `${OLD_COOKIE}=; Path=/app; Max-Age=0; HttpOnly; Secure; SameSite=Strict`);
  headers.append("Set-Cookie", clearCookie());
  return new Response(JSON.stringify({ ok: true }), { headers });
}

// ===== ENQUIRIES =====

async function listEnquiries(env, url) {
  const all = url.searchParams.get("show") === "all";
  const enquiries = await replies.listEnquiries(env, { show: all ? "all" : "new" });
  const { count } = await env.DB.prepare("SELECT COUNT(*) AS count FROM enquiries WHERE status = 'new'").first();
  return json({ enquiries, newCount: count });
}

// The conversation on each enquiry (src/enquiry-replies.js). Reading and notes need a Portal
// sign-in; anything that emails the customer needs a person in a browser: the Portal cookie
// (the Origin check above already stops other websites). An app's token can't send.
async function enquiryReplies(request, env, me, route) {
  if (route === "/enquiries/thread" && request.method === "GET") {
    const id = Number(new URL(request.url).searchParams.get("id"));
    const thread = Number.isInteger(id) ? await replies.enquiryThread(env, id) : null;
    if (!thread) return json({ error: "That enquiry doesn't exist." }, 404);
    // Whether this sign-in can send (a browser's), and where Portal is online for one that can't
    return json({ ...thread, canSend: me.session_kind === "cookie", onlineUrl: `${publicUrl(env)}/portal/?view=enquiries&enquiry=${id}` });
  }
  if (request.method !== "POST") return null;
  const SENDS = ["/enquiries/reply", "/enquiries/draft/approve", "/enquiries/retry"];
  const ACTIONS = [...SENDS, "/enquiries/note", "/enquiries/logged", "/enquiries/draft/edit", "/enquiries/draft/discard", "/enquiries/contact"];
  if (!ACTIONS.includes(route)) return null;
  if (SENDS.includes(route) && me.session_kind !== "cookie") return json({ error: "Sending needs Portal open in a browser, signed in (on the studio computer, open Portal online).", onlineUrl: `${publicUrl(env)}/portal/?view=enquiries` }, 403);
  const body = await readJson(request);
  if (route === "/enquiries/reply") return done(await replies.staffReply(env, me, body));
  if (route === "/enquiries/note") return done(await replies.staffNote(env, me, body));
  if (route === "/enquiries/logged") return done(await replies.staffLogged(env, me, body));
  if (route === "/enquiries/draft/edit") return done(await replies.editDraft(env, me, body));
  if (route === "/enquiries/draft/approve") return done(await replies.approveDraft(env, me, body));
  if (route === "/enquiries/draft/discard") return done(await replies.discardDraft(env, me, body));
  if (route === "/enquiries/retry") return done(await replies.retrySend(env, me, body));
  if (route === "/enquiries/contact") return done(await replies.setDoNotContact(env, { id: body.id, on: body.doNotContact === true, by: me.id }));
  return null;
}

// ===== APPROVALS: booking changes the AIs proposed =====
// Any signed-in staff can see them. Only an admin, in a browser (the Portal cookie; the Origin
// check above already stops other websites), can edit, approve or reject: never an app's token.

const canDecide = (me) => me.role === "admin" && me.session_kind === "cookie";

async function approvals(request, env, me, route) {
  if (route === "/booking-actions" && request.method === "GET") {
    const status = new URL(request.url).searchParams.get("status") === "all" ? "all" : "pending";
    return json({ actions: await bookingActions.listActions(env, { status }), canDecide: canDecide(me) });
  }
  const ACTIONS = { "/booking-actions/approve": bookingActions.approveAction, "/booking-actions/edit": bookingActions.editAction, "/booking-actions/reject": bookingActions.rejectAction };
  if (request.method !== "POST" || !ACTIONS[route]) return null;
  if (!canDecide(me)) {
    return json({ error: "Only an admin, with Portal open in a browser and signed in, can approve booking changes.", onlineUrl: `${publicUrl(env)}/portal/?view=approvals` }, 403);
  }
  const body = await readJson(request);
  try {
    return done(await ACTIONS[route](env, me, body));
  } catch (err) {
    const { status, body: answer } = acuityFailure(err);
    return json(answer, status);
  }
}

// A result from src/enquiry-replies.js as a response: { status, error } is a refusal
function done(result) {
  if (result && result.error) return json({ error: result.error }, result.status || 400);
  return json({ ok: true, ...result });
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
  const visitor = { chatId: null, page: "Portal (staff)", ip: request.headers.get("CF-Connecting-IP") || "staff" };
  // Staff can also find, cancel, reschedule and change bookings (manage-bookings.js)
  const reply = (await answer(list, env, visitor, (work) => ctx.waitUntil(work), { staff: true })).text;
  // What the team says about clients and the studio feeds Index (in the background)
  ctx.waitUntil(learnFromStaffChat(env, [...list, { role: "assistant", content: reply }]).catch((err) => console.log("Memory from Portal failed:", err.message)));
  return json({ reply });
}

// ===== NOTIFICATIONS =====
// Only signed-in staff get this far, so only their phones can sign up.

// A phone hands over its delivery address (it's theirs: whoever is signed in on it)
async function subscribe(request, env, me) {
  // Read the address the phone sent
  const { subscription } = await readJson(request);
  // What the phone is ("iPhone"), so it can be picked out in Calendar
  const owner = { staffId: me.id, name: phoneName(request.headers.get("User-Agent") || "") };
  // Save it, or say it wasn't a proper address
  return (await savePhone(env, subscription, owner)) ? json({ ok: true }) : json({ error: "That isn't a valid notification address." }, 400);
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
  const delivered = await notifyPhones(env, { title: "Portal", body: "Test notification: notifications are working 🎉", save: false });
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
        initial_prompt: "Nova, show alerts. Nova, call Eric. Staff giving a command to Portal, the Novacane Studios staff app: show enquiries, alerts, chats, delete alerts, call, email, ask NovaBot.",
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

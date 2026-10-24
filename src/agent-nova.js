// Nova Agent's own addresses on Nova Bot: checking in, its alerts and plan, and read-only (or
// propose-only) tools for its AI
//
// Rather than this Worker calling Nova Agent (which would need it to be reachable from the
// internet), Nova Agent checks in here, like a courier calling the office. With `wait`, the call
// stays open (up to 20 seconds) until something happens, and Nova Agent calls straight back:
//
//   POST /nova-agent/next     { dryRun, bookingsPerVisitor, wait, bookingsSeen }
//                            -> { job: null, questActions, bookingsChanged }: Quests taps from Portal, and when
//                            the bookings last changed (a booking made, moved or cancelled, or an approved change).
//                            The wait ends early when that's newer than bookingsSeen (ISO, or "" for never).
//                            (`job` is always null: the jobs it did on Acuity's pages went with Acuity.)
//   POST /nova-agent/quests   { state }             -> Portal shows Nova Agent's quests;
//                            replies with { actions } tapped in Portal since (also handed over with /next)
//   POST /nova-agent/notify         { title, message, source?, kind?, tag?, ttl?, urgent?, keep? }
//                            -> staff phones get Nova Agent's and Quest's alerts
//
//   POST /nova-agent/enquiries          { show? }  -> the enquiries ("new", "open", "all" or "spam")
//   POST /nova-agent/inbox/sort         { id, state, label? } -> sorts one (new, open, waiting, done, spam;
//                            never sends anything: src/inbox.js)
//   POST /nova-agent/inbox/saved        {}         -> the team's saved replies (read only)
//   POST /nova-agent/enquiries/:id      {}         -> one enquiry and its conversation
//   POST /nova-agent/enquiries/:id/drafts { body } -> a DRAFT reply, for a person to approve in Portal
//                            (the AI can only draft: nothing here approves or sends; see src/enquiry-replies.js)
//
//   POST /nova-agent/bookings/appointments { from, to } -> { appointments } bookings on those UK days (max 62;
//                            includeCanceled: true lists cancelled ones too). Times in UTC; id is the booking's number.
//   POST /nova-agent/bookings/availability { typeId, date } -> { times: [{ start, label }] } free start times
//   POST /nova-agent/bookings/blocks       { from, to } -> { blocks } blocked-off times in the studio's calendar
//   POST /nova-agent/bookings/types        {}           -> { types } session types
//   POST /nova-agent/bookings/clients      { search }   -> { clients } (25 at most)
//                            (read-only: Nova's own bookings and the studio's Google Calendar, src/nova/diary.js.
//                            The calendar not answering -> 503 { unreachable: true }. /nova-agent/acuity/… is the
//                            old address of the same five.)
//
//   POST /nova-agent/booking-actions/propose { kind, payload, reason } -> { action } a PROPOSED booking change,
//                            for an admin to approve in Portal → Approvals
//   POST /nova-agent/booking-actions        { status? } -> { actions } ("pending" or "all"; read-only)
//                            (the AI can only propose: nothing here approves, edits or carries anything
//                            out; see src/booking-actions.js)
//
//   POST /nova-agent/clients/find     { search } -> { clients } (20 at most)
//   POST /nova-agent/clients/history  { id }     -> { client, sessions }
//   POST /nova-agent/clients/owing    {}         -> { clients } who owes money, most first
//   POST /nova-agent/clients/lapsed   { since: "YYYY-MM-DD" } -> { clients } who hasn't booked since that day
//                            (the client list, read-only: nothing here changes a client; see src/clients.js)
//   POST /nova-agent/campaigns/context {}       -> { audiences, recent, today } (for suggest_campaign)
//   POST /nova-agent/campaigns/draft  { subject, body, audience, sendAt? } -> { campaign } waiting for an admin's
//                            approval in Portal → Campaigns (the admins' phones get a quiet ping)
//   POST /nova-agent/campaigns/:id/edit { subject?, body?, audience?, sendAt? } -> { campaign } back to waiting
//   POST /nova-agent/campaigns        { status? } -> { campaigns }
//   POST /nova-agent/campaigns/:id    {}         -> { campaign, log }
//   POST /nova-agent/money/context    {}         -> { summary, vatRate, dueDays, categories, recentInvoices, today }
//   POST /nova-agent/money/invoices   { status? } -> { invoices }
//   POST /nova-agent/money/invoices/:id {}       -> { invoice, payments }
//   POST /nova-agent/money/invoices/draft { clientId?, billName, billEmail, lines, … } -> { invoice } waiting
//                            for an admin's approval in Portal → Money (never sent by the agent)
//   POST /nova-agent/money/invoices/:id/edit { … } -> { invoice } back to waiting
//   POST /nova-agent/money/expenses   { spentOn, amount, category, supplier, note } -> { expense } 'unconfirmed'
//                            (the AI can only write and edit: nothing here approves, sends, schedules or
//                            test-sends; see src/campaigns.js)
//   POST /nova-agent/tidy             {}         -> { counts, items } what looks like test stuff, and why (read
//                            only: deleting is for an admin in Portal → Test stuff; see src/tidy.js)
//   POST /nova-agent/outreach/draft   { kind, toEmail, toName?, organisation?, clientId?, aboutBooking?, subject, body }
//                            -> { outreach } a one-to-one email waiting for an admin's approval in Portal →
//                            Campaigns (refused, with the reason, if that person can't be emailed)
//   POST /nova-agent/outreach/:id/edit { …any of those } -> { outreach } back to waiting
//   POST /nova-agent/outreach         { status? } -> { outreach }
//   POST /nova-agent/outreach/:id     {}         -> { outreach, log }
//                            (write and edit only: nothing here approves, sends or test-sends; see src/outreach.js)
//   POST /nova-agent/social/context  {}          -> { connected, recent, followers, openComments, today }
//   POST /nova-agent/social/draft    { caption, platforms, postAt? } -> { post } waiting for an admin's approval
//                            in Portal → Social (pictures and videos are added there by a person)
//   POST /nova-agent/social/:id/edit { caption?, platforms?, postAt? } -> { post } back to waiting
//   POST /nova-agent/social          { status? } -> { posts }
//   POST /nova-agent/social/:id      {}          -> { post, log }
//   POST /nova-agent/social/comments { open? }   -> { comments } on the studio's posts
//   POST /nova-agent/social/comments/:id/reply { text } -> { comment } a reply waiting for approval
//                            (the AI can only write, edit and draft: nothing here approves or posts; see
//                            src/social.js)
//
//   POST /nova-agent/bookings-feed    { from, to } -> { appointments: [{ id, start, end, type, name }] } bookings on
//                            those UK days (max 62), in short. Times in UTC.
//
//   POST /nova-agent/me       { staff_id? }         -> who Nova Agent works for (its Nova Agent badge and memory);
//                            without an id, the studio's first admin
//
//   POST /nova-agent/fixer-health -> { at, checks: [{ group, name, ok, severity, area, detail }] }: Nova Bot's
//                            health for the Fixer's hourly check (invoices, their emails and pages, a way
//                            to pay, stuck or failed emails, approvals waiting, Google; src/fixer-health.js)
//
// All of them need header Authorization: Bearer <AGENT_NOVA_KEY>.

import { planetFacts, profile } from "./portal/routes.js";
import { notifyPhones, studioOwner } from "./push.js";
import { syncFromAgent } from "./calendar/items.js";
import { agentDraft, enquiryThread, listEnquiries } from "./enquiry-replies.js";
import { handleInboxForAgent } from "./inbox.js";
import { daysBetween, isUkDate } from "./uk-time.js";
import { bookingsChangedAt, listActions, proposeAction } from "./booking-actions.js";
import { handleClientsForAgent, listClients } from "./clients.js";
import * as diary from "./nova/diary.js";
import { handleCampaignsForAgent } from "./campaigns.js";
import { handleOutreachForAgent } from "./outreach.js";
import { handleSocialForAgent } from "./social.js";
import { handleMoneyForAgent } from "./money.js";
import { handleGoogleForAgent } from "./google/index.js";
import { tidyForAgent } from "./tidy.js";
import { looksSession } from "./looks-account.js";
import { fixerHealth } from "./fixer-health.js";

// The longest Nova Agent's check-in is held open, and how often it looks for news meanwhile
const MAX_WAIT_SECONDS = 20;
const WAIT_CHECK_MS = 500;

// Nova Agent counts as "online" if it checked in this recently
const ONLINE_MINUTES = 5;

// ===== ROUTES FOR NOVA AGENT =====

export async function handleAgentNova(request, env, pathname) {
  // Only POSTs with the right key, and only once the key is set up
  const auth = request.headers.get("Authorization") || "";
  const key = auth.startsWith("Bearer ") ? auth.slice(7) : "";
  if (request.method !== "POST" || !env.AGENT_NOVA_KEY || !(await sameText(key, env.AGENT_NOVA_KEY))) {
    return Response.json({ error: "Not allowed" }, { status: 401 });
  }
  // A file for Google Drive: its bytes are the body (src/google/index.js)
  if (pathname === "/nova-agent/google/drive/put") return handleGoogleForAgent(request, env, pathname, {});
  let body = {};
  try {
    body = await request.json();
  } catch {
    // An empty body is fine
  }
  // Google: read-only tools for the AI, and the PC's file copies (src/google/index.js)
  if (pathname.startsWith("/nova-agent/google/")) return handleGoogleForAgent(request, env, pathname, body);

  if (pathname === "/nova-agent/next") {
    await checkIn(env, body);
    return Response.json({ job: null, questActions: await takeQuestActions(env), bookingsChanged: await bookingsChangedAt(env) });
  }
  if (pathname === "/nova-agent/quests") return saveQuests(env, body);
  if (pathname === "/nova-agent/notify") return sendAlert(env, body);
  if (pathname === "/nova-agent/me") return agentStaff(env, body);
  // The Fixer's hourly check: Nova Bot's health, read-only (src/fixer-health.js)
  if (pathname === "/nova-agent/fixer-health") return Response.json(await fixerHealth(env), { headers: { "Cache-Control": "no-store" } });
  // The Fixer's looks check: a sign-in that only looks, for one check (src/looks-account.js)
  if (pathname === "/nova-agent/looks-session") return looksSession(env, body);
  // Calendar: Nova Agent's copy on the PC and this one, kept the same (src/calendar/items.js)
  if (pathname === "/nova-agent/calendar") return syncFromAgent(env, body);
  // Enquiries: read them, and draft replies (never send: a person approves in Portal)
  if (pathname === "/nova-agent/enquiries" || pathname.startsWith("/nova-agent/enquiries/")) return agentEnquiries(env, pathname, body);
  // The inbox: sort an enquiry (or move it to Spam), read the saved replies (src/inbox.js)
  if (pathname.startsWith("/nova-agent/inbox/")) return handleInboxForAgent(env, pathname, body);
  // The diary (read only), and PROPOSE changes (never make them: an admin approves in Portal).
  // /nova-agent/acuity/… is the old address of the same thing (a Nova Agent from before reads it).
  if (pathname.startsWith("/nova-agent/bookings/")) return agentDiary(env, pathname.replace("/nova-agent/bookings/", "/"), body);
  if (pathname.startsWith("/nova-agent/acuity/")) return agentDiary(env, pathname.replace("/nova-agent/acuity/", "/"), body);
  if (pathname === "/nova-agent/booking-actions" || pathname.startsWith("/nova-agent/booking-actions/")) return agentBookingActions(env, pathname, body);
  // The client list (read-only) and the bookings in short
  if (pathname.startsWith("/nova-agent/clients/")) return handleClientsForAgent(env, pathname, body);
  if (pathname === "/nova-agent/bookings-feed") return bookingsFeed(env, body);
  // Email campaigns: read, write and edit (never approve or send: an admin approves in Portal)
  if (pathname === "/nova-agent/campaigns" || pathname.startsWith("/nova-agent/campaigns/")) return handleCampaignsForAgent(env, pathname, body);
  // One-to-one emails: read, write and edit (never approve or send: an admin approves in Portal)
  if (pathname === "/nova-agent/outreach" || pathname.startsWith("/nova-agent/outreach/")) return handleOutreachForAgent(env, pathname, body);
  // Social posts: read, write, edit and draft replies (never approve or post: an admin approves in Portal)
  if (pathname === "/nova-agent/social" || pathname.startsWith("/nova-agent/social/")) return handleSocialForAgent(env, pathname, body);
  // Money: read, write and edit invoices (an admin approves and sends them in Portal), and log
  // expenses as unconfirmed (a person confirms them). No payments, sending or settings.
  if (pathname.startsWith("/nova-agent/money/")) return handleMoneyForAgent(env, pathname, body);
  // Test stuff: read only (what looks like a test, and why). Deleting is for an admin in Portal.
  if (pathname === "/nova-agent/tidy") return tidyForAgent(env);
  return Response.json({ error: "Not found" }, { status: 404 });
}

// ===== THE DIARY: NOVA'S OWN BOOKINGS (read only; src/nova/diary.js) =====
// The bookings table and the studio's Google Calendar, in the shapes Nova Agent reads.

// The most days one read covers
const MAX_DAYS = 62;

async function agentDiary(env, route, body) {
  const bad = (error) => Response.json({ error }, { status: 400 });
  const range = () => {
    if (!isUkDate(body?.from) || !isUkDate(body?.to)) return "from and to must be UK dates, YYYY-MM-DD.";
    const days = daysBetween(body.from, body.to);
    if (days < 0) return "to is before from.";
    if (days + 1 > MAX_DAYS) return `That's more than ${MAX_DAYS} days: ask for less at a time.`;
    return "";
  };
  try {
    if (route === "/appointments") {
      const problem = range();
      if (problem) return bad(problem);
      return Response.json({ appointments: await diary.listAppointments(env, { from: body.from, to: body.to, includeCanceled: body.includeCanceled === true }) });
    }
    if (route === "/availability") {
      const typeId = Number(body?.typeId);
      if (!Number.isInteger(typeId) || typeId <= 0) return bad("typeId: which session type (its id from types)?");
      if (!isUkDate(body?.date)) return bad("date must be a UK date, YYYY-MM-DD.");
      return Response.json({ times: await diary.availableTimes(env, { typeId, date: body.date }) });
    }
    if (route === "/blocks") {
      const problem = range();
      if (problem) return bad(problem);
      return Response.json({ blocks: await diary.listBlocks(env, { from: body.from, to: body.to }) });
    }
    if (route === "/types") return Response.json({ types: diary.listTypes() });
    if (route === "/clients") {
      const search = typeof body?.search === "string" ? body.search.trim().slice(0, 100) : "";
      if (search.length < 2) return bad("search: at least 2 letters of a name, email or phone.");
      const { clients = [] } = await listClients(env, { search, limit: 25 });
      return Response.json({
        clients: clients.slice(0, 25).map((c) => {
          const [firstName, ...rest] = String(c.name || "").split(/\s+/);
          return { firstName: firstName || "", lastName: rest.join(" "), email: c.email || "", phone: c.phone || "", notes: c.notes || "" };
        }),
      });
    }
  } catch (err) {
    // Google Calendar not answering (free times and blocked times read it)
    console.log("Nova Agent: the diary couldn't be read:", err?.name || "error");
    return Response.json({ error: "The studio's calendar couldn't be read just now. Try again in a minute.", unreachable: true }, { status: 503 });
  }
  return Response.json({ error: "Not found" }, { status: 404 });
}

// ===== THE BOOKINGS IN SHORT (read only) =====

async function bookingsFeed(env, body) {
  if (!isUkDate(body?.from) || !isUkDate(body?.to)) return Response.json({ error: "from and to must be UK dates, YYYY-MM-DD." }, { status: 400 });
  const days = daysBetween(body.from, body.to);
  if (days < 0) return Response.json({ error: "to is before from." }, { status: 400 });
  if (days + 1 > MAX_DAYS) return Response.json({ error: `That's more than ${MAX_DAYS} days: ask for less at a time.` }, { status: 400 });
  const list = await diary.listAppointments(env, { from: body.from, to: body.to });
  return Response.json({ appointments: list.map((a) => ({ id: a.id, start: a.start, end: a.end, type: a.type, name: a.name })) });
}

// ===== BOOKING CHANGES (propose and list only) =====

async function agentBookingActions(env, pathname, body) {
  if (pathname === "/nova-agent/booking-actions") {
    return Response.json({ actions: await listActions(env, { status: body?.status === "all" ? "all" : "pending" }) });
  }
  if (pathname === "/nova-agent/booking-actions/propose") {
    // Only kind, payload and reason are read: a summary or status sent along is ignored
    try {
      const result = await proposeAction(env, { kind: body?.kind, payload: body?.payload, reason: body?.reason, proposedBy: "agent" });
      return result.error ? Response.json({ error: result.error }, { status: result.status || 400 }) : Response.json({ action: result.action, repeated: result.repeated === true });
    } catch (err) {
      // Google Calendar not answering (a blocked time is checked there)
      console.log("Nova Agent: couldn't check a proposed booking change:", err?.name || "error");
      return Response.json({ error: "The studio's calendar couldn't be read just now. Try again in a minute.", unreachable: true }, { status: 503 });
    }
  }
  // Nothing else: there is no approve, edit, reject or execute for the agent's key
  return Response.json({ error: "Not found" }, { status: 404 });
}

// ===== ENQUIRIES (read, and draft only) =====

async function agentEnquiries(env, pathname, body) {
  if (pathname === "/nova-agent/enquiries") {
    const show = ["new", "open", "all", "spam"].includes(body?.show) ? body.show : "open";
    const enquiries = await listEnquiries(env, { show, limit: 50 });
    // Short: the AI reads one in full with /nova-agent/enquiries/:id
    return Response.json({
      enquiries: enquiries.map((e) => ({
        id: e.id, created_at: e.created_at, name: e.name, email: e.email, subject: e.subject, state: e.state, label: e.label || null,
        ...(e.spam_reason ? { spam_reason: e.spam_reason } : {}),
        details: String(e.details || "").slice(0, 300), drafts_waiting: e.drafts, replies_sent: e.replies,
      })),
    });
  }
  const read = pathname.match(/^\/nova-agent\/enquiries\/(\d+)$/);
  if (read) {
    const thread = await enquiryThread(env, Number(read[1]));
    return thread ? Response.json(thread) : Response.json({ error: "That enquiry doesn't exist." }, { status: 404 });
  }
  const drafts = pathname.match(/^\/nova-agent\/enquiries\/(\d+)\/drafts$/);
  if (drafts) {
    const result = await agentDraft(env, { id: Number(drafts[1]), body: body?.body });
    return result.error ? Response.json({ error: result.error }, { status: result.status || 400 }) : Response.json({ ok: true, ...result });
  }
  // Nothing else: there is no approve or send for the agent's key
  return Response.json({ error: "Not found" }, { status: 404 });
}

// Nova Agent checked in: note that (whether it's live or rehearsing, and the booking limit set in its
// .env), then, with `wait`, hold on until there's news for it (a Quests tap, or a booking change it
// hasn't seen), so it hears within a second
async function checkIn(env, body) {
  const now = new Date();
  const mode = body?.dryRun === false ? "live" : "rehearsal";
  const limit = readBookingLimit(body?.bookingsPerVisitor);
  await env.DB.batch([
    env.DB.prepare("INSERT INTO settings (key, value) VALUES ('bookings_per_visitor', ?) ON CONFLICT (key) DO UPDATE SET value = excluded.value").bind(limit),
    env.DB.prepare("INSERT INTO settings (key, value) VALUES ('agent_nova_seen', ?) ON CONFLICT (key) DO UPDATE SET value = excluded.value").bind(now.toISOString()),
    env.DB.prepare("INSERT INTO settings (key, value) VALUES ('agent_nova_mode', ?) ON CONFLICT (key) DO UPDATE SET value = excluded.value").bind(mode),
  ]);
  // `wait` (seconds, up to MAX_WAIT_SECONDS). Stop waiting early for a tap in Portal's Quests tab, or a
  // booking change Nova Agent hasn't seen (only when it says what it's seen: an older Nova Agent never
  // sends bookingsSeen)
  const waitSeconds = Math.min(Math.max(Number(body?.wait) || 0, 0), MAX_WAIT_SECONDS);
  const giveUpAt = Date.now() + waitSeconds * 1000;
  const seen = typeof body?.bookingsSeen === "string" ? body.bookingsSeen : null;
  const bookingsNews = async () => {
    if (seen === null) return false;
    const changed = await bookingsChangedAt(env);
    return Boolean(changed) && (!seen || Date.parse(changed) > (Date.parse(seen) || 0));
  };
  while (!(await hasQuestActions(env)) && !(await bookingsNews()) && Date.now() < giveUpAt) {
    await new Promise((resolve) => setTimeout(resolve, WAIT_CHECK_MS));
  }
}

// How many sessions NovaBot may book for one visitor a day: "unlimited", or a
// number from 1 to 100. Anything else means the safe default.
export const DEFAULT_BOOKINGS_PER_VISITOR = "2";

function readBookingLimit(value) {
  const text = String(value ?? "").trim().toLowerCase();
  if (text === "unlimited") return "unlimited";
  const number = Number(text);
  return Number.isInteger(number) && number >= 1 && number <= 100 ? String(number) : DEFAULT_BOOKINGS_PER_VISITOR;
}

// The current limit (as Nova Agent last reported it): a number, or Infinity
export async function bookingsPerVisitor(env) {
  const value = (await env.DB.prepare("SELECT value FROM settings WHERE key = 'bookings_per_visitor'").first("value")) || DEFAULT_BOOKINGS_PER_VISITOR;
  return value === "unlimited" ? Infinity : Number(value);
}

// An alert from Nova Agent itself
// Which Nova app an alert is from, and the name shown in front of its title
const ALERT_SOURCES = { agent: "Nova Agent", quest: "Quest", fixer: "Fixer" };

async function sendAlert(env, body) {
  const title = typeof body.title === "string" ? body.title.trim().slice(0, 100) : "";
  const message = typeof body.message === "string" ? body.message.trim().slice(0, 1000) : "";
  if (!title) return Response.json({ error: "A title is needed" }, { status: 400 });
  // How the phone should show it (anything missing or odd falls back to a plain Nova Agent alert)
  // (a Nova Agent from before Missions went may still send "mission": it's someone's own, like a quest's)
  const source = body.source === "mission" ? "quest" : Object.hasOwn(ALERT_SOURCES, body.source) ? body.source : "agent";
  const kind = typeof body.kind === "string" ? body.kind.replace(/[^a-z-]/g, "").slice(0, 20) : "";
  const tag = typeof body.tag === "string" ? body.tag.replace(/[^\w-]/g, "").slice(0, 64) : "";
  const ttl = Math.min(Math.max(Number(body.ttl) || 86400, 60), 86400);
  const style = { source, kind, tag: tag ? `${source}-${tag}` : "", ttl, urgent: body.urgent === true };
  // `keep: false` (quick repeats): ring the phone but leave it out of the Alerts list
  // Quest reminders are someone's own: the phones the quest picked, or else its
  // owner's (`owner`, the staff id Nova Agent sends), never anyone else's. Without an owner (a Nova
  // Agent from before, or one that doesn't know who it works for yet): the studio owner's.
  // Nova Agent's own alerts still go to every phone.
  let to = null;
  if (source === "quest") {
    const phones = Array.isArray(body.phones) ? body.phones.filter((x) => typeof x === "string" && /^[0-9a-f]{12}$/.test(x)).slice(0, 10) : [];
    to = { phones, staff: await reminderOwner(env, body.owner) };
  }
  // The Fixer's pings (a new serious problem, a fix ready to approve) are for the admins: only
  // they can approve. Tapping one opens the Fixer.
  if (source === "fixer") {
    const { results } = await env.DB.prepare("SELECT id FROM staff WHERE role = 'admin' AND status = 'active'").all();
    if (!results.length) return Response.json({ ok: true, phones: 0 });
    to = { staff: results.map((r) => r.id) };
  }
  const url = source === "fixer" ? "/agent/?open=%2Ffixer%2F" : "/portal/#nova";
  const delivered = await notifyPhones(env, { title: `${ALERT_SOURCES[source]}: ${title}`, body: message, url, style, save: body.keep !== false, to });
  return Response.json({ ok: true, phones: delivered });
}

// Whose phones a quest reminder goes to: its owner, or (none given) the studio owner
export async function reminderOwner(env, owner) {
  const id = typeof owner === "string" ? owner.toLowerCase().trim() : "";
  if (/^[a-z0-9_-]{1,64}$/.test(id) && id !== "owner") return [id];
  const studio = await studioOwner(env);
  return studio ? [studio.id] : [];
}

// ===== NOVA QUESTS IN STUDIO =====
// Nova Agent keeps its plan (quests, pulses) here, so Portal can
// show it; taps in Portal (Done, Start, Not now...) wait here until Nova
// Agent next checks in, usually within a second.

const QUESTS_KEY = "nova_quests";
const ACTIONS_KEY = "nova_quest_actions";
const MAX_STATE_BYTES = 800_000;

async function setSetting(env, key, value) {
  await env.DB.prepare("INSERT INTO settings (key, value) VALUES (?, ?) ON CONFLICT (key) DO UPDATE SET value = excluded.value").bind(key, value).run();
}

async function saveQuests(env, body) {
  const state = JSON.stringify(body?.state ?? null);
  if (state.length > MAX_STATE_BYTES) return Response.json({ error: "Too big" }, { status: 413 });
  await setSetting(env, QUESTS_KEY, JSON.stringify({ at: new Date().toISOString(), state: body?.state ?? null }));
  return Response.json({ ok: true, actions: await takeQuestActions(env) });
}

// What Portal shows: the latest plan, when it came, and whether Nova Agent is online.
// With `me` (the signed-in person): their own quests; `who: "everyone"` shows an admin everyone's
// (each says whose it is). Quests with no owner (from a Nova Agent before owners) are the studio
// owner's. Missions went from Nova on 23 Oct 2026: a plan saved by a Nova Agent from before that
// still has them, and they're left out.
export async function questsForPortal(env, me = null, who = "mine") {
  const { results } = await env.DB.prepare("SELECT key, value FROM settings WHERE key IN (?, 'agent_nova_seen')").bind(QUESTS_KEY).all();
  const setting = Object.fromEntries(results.map((row) => [row.key, row.value]));
  let saved = { at: null, state: null };
  try {
    saved = JSON.parse(setting[QUESTS_KEY] || "null") || saved;
  } catch {}
  if (saved.state && typeof saved.state === "object" && "missions" in saved.state) {
    const { missions: _gone, ...rest } = saved.state;
    saved = { ...saved, state: rest };
  }
  const seen = setting.agent_nova_seen ? Date.parse(setting.agent_nova_seen) : 0;
  const online = Date.now() - seen < ONLINE_MINUTES * 60000;
  if (!me) return { ...saved, online };
  const canSeeEveryone = me.role === "admin";
  const everyone = who === "everyone" && canSeeEveryone;
  const out = { ...saved, online, me: me.id, scope: everyone ? "everyone" : "mine", canSeeEveryone };
  const st = saved.state;
  if (!st || typeof st !== "object") return out;
  const fallback = (await studioOwner(env))?.id || "";
  const ownerOf = (x) => (x && typeof x.owner === "string" && x.owner) || fallback;
  const mine = (x) => ownerOf(x) === me.id;
  const shown = (x) => everyone || mine(x);
  const list = (v) => (Array.isArray(v) ? v : []);
  // "Now" and "next" are always your own
  const own = st.people && st.people[me.id];
  out.state = {
    ...st,
    quests: list(st.quests).filter(shown),
    pulses: list(st.pulses).filter(shown),
    current: own ? own.current || null : st.current && mine(st.current) ? st.current : null,
    next: own ? list(own.next) : list(st.next).filter(mine),
  };
  return out;
}

// A tap in Portal, for Nova Agent to carry out. Each gets an id (so Nova
// Agent counts it once) and is added in one statement, so taps made at the
// same moment are all kept.
export async function queueQuestAction(env, action) {
  const tap = JSON.stringify({ ...action, tapId: crypto.randomUUID(), at: new Date().toISOString() });
  await env.DB.prepare(
    `INSERT INTO settings (key, value) VALUES (?1, json_array(json(?2)))
     ON CONFLICT (key) DO UPDATE SET value = CASE WHEN json_valid(value) AND json_type(value) = 'array' THEN json_insert(value, '$[#]', json(?2)) ELSE json_array(json(?2)) END`
  )
    .bind(ACTIONS_KEY, tap)
    .run();
}

async function readActions(env) {
  try {
    return JSON.parse((await env.DB.prepare("SELECT value FROM settings WHERE key = ?").bind(ACTIONS_KEY).first("value")) || "[]");
  } catch {
    return [];
  }
}
async function hasQuestActions(env) {
  return (await readActions(env)).length > 0;
}
// Taken and cleared in one statement, so two collectors (the check-in and the
// plan upload) never both get the same tap (the last 50, if many piled up)
async function takeQuestActions(env) {
  const row = await env.DB.prepare("DELETE FROM settings WHERE key = ? RETURNING value").bind(ACTIONS_KEY).first();
  try {
    const list = JSON.parse(row?.value || "[]");
    return Array.isArray(list) ? list.slice(-50) : [];
  } catch {
    return [];
  }
}

// Compare two secrets without giving away how much matched
async function sameText(a, b) {
  const hash = async (s) => new Uint8Array(await crypto.subtle.digest("SHA-256", new TextEncoder().encode(String(s))));
  return crypto.subtle.timingSafeEqual(await hash(a), await hash(b));
}

// Who Nova Agent works for, for its Nova Agent badge and its Index memory. With a
// staff_id (someone who pressed "Connect as me", or NOVA_STAFF_ID), that person; without
// one, the studio's first admin (the account set up with the studio password). Before
// Portal has anyone, a stand-in from the id.
async function agentStaff(env, body) {
  const asked = String(body.staff_id || "").toLowerCase().slice(0, 64);
  let row = null;
  if (env.DB) {
    row = asked
      ? await env.DB.prepare("SELECT * FROM staff WHERE id = ?").bind(asked).first().catch(() => null)
      : await env.DB.prepare("SELECT * FROM staff WHERE role = 'admin' AND status = 'active' ORDER BY created_at, id LIMIT 1").first().catch(() => null);
  }
  // Picked automatically: what Nova Agent learned before it knew who (as "owner") becomes theirs
  if (row && !asked) await adoptOwnerMemory(env, row.id);
  const id = asked || "owner";
  const who = row
    ? profile(row)
    : { id, display_name: id === "owner" ? "Studio" : id.replace(/-/g, " ").replace(/\b\w/g, (c) => c.toUpperCase()), role: "staff", status: "local", planet_seed: id, planet_overrides: null, planet_theme: "nova", index_partition: `staff:${id}`, created_at: null };
  return Response.json({ staff: { ...who, planet: await planetFacts(who.planet_seed, who.planet_overrides) }, via: "nova-agent", linked: Boolean(row), auto: !asked });
}

// Index files kept under "owner" (before Nova Agent knew who it works for) move to that
// person, unless they already have a file at the same path. Runs once in practice: after the
// move there's nothing left under "owner".
async function adoptOwnerMemory(env, staffId) {
  if (staffId === "owner") return;
  try {
    await env.DB.batch([
      env.DB.prepare(
        "UPDATE memory_files SET owner_id = ?1 WHERE scope = 'staff' AND owner_id = 'owner' AND path NOT IN (SELECT path FROM memory_files WHERE scope = 'staff' AND owner_id = ?1)"
      ).bind(staffId),
      env.DB.prepare("UPDATE memory_pending SET owner_id = ?1 WHERE scope = 'staff' AND owner_id = 'owner'").bind(staffId),
    ]);
  } catch {
    // The memory tables may not exist (an older database); the badge still works
  }
}

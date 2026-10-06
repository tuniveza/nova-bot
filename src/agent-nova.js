// Nova Agent: the browser helper that books and changes sessions in Acuity
//
// Nova Agent uses Acuity's admin pages in a hidden browser, on another
// computer. It does two kinds of job:
//   - 'book':   book a session a customer asked NovaBot to book for them
//               (book-session.js)
//   - 'change': change a booking's session type, price or paid status, which
//               staff asked for in Nova Hub (manage-bookings.js)
//
// Rather than this Worker calling it (which would need it to be reachable
// from the internet), Nova Agent checks in here and asks for work, like a
// courier calling the office for the next pickup. With `wait`, the call stays
// open until a job comes in (up to 20 seconds), and Nova Agent calls straight
// back, so a job is picked up within about a second:
//
//   POST /hub/agent/next     { dryRun, bookingsPerVisitor, wait } -> { job } the oldest waiting job, or { job: null }
//   POST /hub/agent/result   { id, ok, message }   -> staff phones get the result
//   POST /hub/agent/quests   { state }             -> Nova Hub shows Nova Agent's missions and quests;
//                            replies with { actions } tapped in Nova Hub since (also handed over with /next)
//   POST /hub/notify         { title, message, source?, kind?, tag?, ttl?, urgent?, keep? }
//                            -> staff phones get Nova Agent's, Nova Quest's and Nova Mission's alerts
//
// All three need header Authorization: Bearer <AGENT_NOVA_KEY>.

import { notifyPhones } from "./push.js";

// A job Nova Agent took but never reported on (e.g. it was restarted) is
// offered again after this long
const STUCK_AFTER_MINUTES = 15;
// The longest Nova Agent's "any jobs?" call is held open, and how often the queue is looked at meanwhile
const MAX_WAIT_SECONDS = 20;
const WAIT_CHECK_MS = 500;

// Nova Agent counts as "online" if it checked in this recently
const ONLINE_MINUTES = 5;

// ===== QUEUEING =====

// Add a job. Returns its number, or the number of the same job already waiting.
export async function queueAgentJob(env, { kind = "change", appointmentId = null, clientName, changes, summary }) {
  const changesJson = JSON.stringify(changes);
  const same = await env.DB.prepare(
    "SELECT id FROM agent_jobs WHERE kind = ? AND appointment_id IS ? AND changes = ? AND status IN ('waiting', 'working')"
  )
    .bind(kind, appointmentId, changesJson)
    .first("id");
  if (same) return same;
  const { meta } = await env.DB.prepare(
    "INSERT INTO agent_jobs (created_at, kind, appointment_id, client_name, changes, summary) VALUES (?, ?, ?, ?, ?, ?)"
  )
    .bind(new Date().toISOString(), kind, appointmentId, clientName, changesJson, summary)
    .run();
  return meta.last_row_id;
}

// Why Nova Agent can't take a job right now ("" if it can). With
// needLive, it must also be in live mode (not rehearsing with DRY_RUN),
// which matters for customers: a rehearsal books nothing.
export async function agentNovaProblem(env, { needLive = false, now = Date.now() } = {}) {
  if (!env.AGENT_NOVA_KEY) return "Nova Agent isn't connected (no AGENT_NOVA_KEY).";
  const { results } = await env.DB.prepare("SELECT key, value FROM settings WHERE key IN ('agent_nova_seen', 'agent_nova_mode')").all();
  const setting = Object.fromEntries(results.map((row) => [row.key, row.value]));
  if (!setting.agent_nova_seen) return "Nova Agent has never checked in, so it may not be set up yet.";
  const minutes = Math.round((now - Date.parse(setting.agent_nova_seen)) / 60000);
  if (minutes > ONLINE_MINUTES) return `Nova Agent last checked in ${minutes} minutes ago, so it may be switched off.`;
  if (needLive && setting.agent_nova_mode !== "live") return "Nova Agent is in rehearsal mode (DRY_RUN), so it won't really book anything.";
  return "";
}

// ===== ROUTES FOR NOVA AGENT =====

export async function handleAgentNova(request, env, pathname) {
  // Only POSTs with the right key, and only once the key is set up
  const auth = request.headers.get("Authorization") || "";
  const key = auth.startsWith("Bearer ") ? auth.slice(7) : "";
  if (request.method !== "POST" || !env.AGENT_NOVA_KEY || !(await sameText(key, env.AGENT_NOVA_KEY))) {
    return Response.json({ error: "Not allowed" }, { status: 401 });
  }
  let body = {};
  try {
    body = await request.json();
  } catch {
    // An empty body is fine
  }

  if (pathname === "/hub/agent/next") {
    const job = await nextJob(env, body);
    return Response.json({ job, questActions: await takeQuestActions(env) });
  }
  if (pathname === "/hub/agent/quests") return saveQuests(env, body);
  if (pathname === "/hub/agent/result") return reportResult(env, body);
  if (pathname === "/hub/notify") return sendAlert(env, body);
  return Response.json({ error: "Not found" }, { status: 404 });
}

// Hand Nova Agent the oldest waiting job (and note that it checked in,
// whether it's live or rehearsing, and the booking limit set in its .env)
async function nextJob(env, body) {
  const now = new Date();
  const mode = body?.dryRun === false ? "live" : "rehearsal";
  const limit = readBookingLimit(body?.bookingsPerVisitor);
  await env.DB.batch([
    env.DB.prepare("INSERT INTO settings (key, value) VALUES ('bookings_per_visitor', ?) ON CONFLICT (key) DO UPDATE SET value = excluded.value").bind(limit),
    env.DB.prepare("INSERT INTO settings (key, value) VALUES ('agent_nova_seen', ?) ON CONFLICT (key) DO UPDATE SET value = excluded.value").bind(
      now.toISOString()
    ),
    env.DB.prepare("INSERT INTO settings (key, value) VALUES ('agent_nova_mode', ?) ON CONFLICT (key) DO UPDATE SET value = excluded.value").bind(mode),
  ]);

  // Jobs taken long ago but never finished go back in the queue
  const stuck = new Date(now.getTime() - STUCK_AFTER_MINUTES * 60000).toISOString();
  await env.DB.prepare("UPDATE agent_jobs SET status = 'waiting' WHERE status = 'working' AND picked_at < ?").bind(stuck).run();

  // `wait` (seconds, up to MAX_WAIT_SECONDS): if there's no job yet, hold on
  // and keep looking, so a new job is handed over within a second of being
  // queued instead of at Nova Agent's next check-in
  const waitSeconds = Math.min(Math.max(Number(body?.wait) || 0, 0), MAX_WAIT_SECONDS);
  const giveUpAt = Date.now() + waitSeconds * 1000;
  let job = await takeJob(env);
  // Stop waiting early for a job, or for a tap in Nova Hub's Quests tab
  while (!job && !(await hasQuestActions(env)) && Date.now() < giveUpAt) {
    await new Promise((resolve) => setTimeout(resolve, WAIT_CHECK_MS));
    job = await takeJob(env);
  }
  if (!job) return null;

  if (job.kind === "book") return { id: job.id, kind: "book", clientName: job.client_name, details: JSON.parse(job.changes) };
  return { id: job.id, kind: "change", appointmentId: job.appointment_id, clientName: job.client_name, changes: JSON.parse(job.changes) };
}

// The oldest waiting job, taken so nothing else gets it, or null
async function takeJob(env) {
  const job = await env.DB.prepare("SELECT id, kind, appointment_id, client_name, changes FROM agent_jobs WHERE status = 'waiting' ORDER BY id LIMIT 1").first();
  if (!job) return null;
  // Take it (only if nothing else just did)
  const { meta } = await env.DB.prepare("UPDATE agent_jobs SET status = 'working', picked_at = ? WHERE id = ? AND status = 'waiting'")
    .bind(new Date().toISOString(), job.id)
    .run();
  return meta.changes ? job : null;
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

// Nova Agent reports how a job went; staff phones get told
async function reportResult(env, body) {
  const id = Number(body.id);
  const ok = body.ok === true;
  const message = typeof body.message === "string" ? body.message.trim().slice(0, 1000) : "";
  const job = await env.DB.prepare("SELECT kind, summary, appointment_id, client_name FROM agent_jobs WHERE id = ? AND status = 'working'").bind(id).first();
  if (!job) return Response.json({ error: "No such job in progress" }, { status: 404 });

  await env.DB.prepare("UPDATE agent_jobs SET status = ?, result = ?, finished_at = ? WHERE id = ?")
    .bind(ok ? "done" : "failed", message, new Date().toISOString(), id)
    .run();

  let title = ok ? "Nova Agent: done" : "Nova Agent: couldn't do it";
  let lines = [job.summary, message];
  if (job.kind === "book") {
    title = ok ? "NovaBot booked: " + job.client_name : "NovaBot couldn't book: " + job.client_name;
    lines = ok
      ? [job.summary, "Deposit not paid yet", message]
      : [job.summary, message, "They were told to book with the link if no confirmation email arrives. Please check with them."];
  }
  await notifyPhones(env, { title, body: lines.filter(Boolean).join("\n"), url: "https://secure.acuityscheduling.com/", appointmentId: job.appointment_id });
  return Response.json({ ok: true });
}

// An alert from Nova Agent itself (e.g. "can't log in to Acuity")
// Which Nova app an alert is from, and the name shown in front of its title
const ALERT_SOURCES = { agent: "Nova Agent", quest: "Nova Quest", mission: "Nova Mission" };

async function sendAlert(env, body) {
  const title = typeof body.title === "string" ? body.title.trim().slice(0, 100) : "";
  const message = typeof body.message === "string" ? body.message.trim().slice(0, 1000) : "";
  if (!title) return Response.json({ error: "A title is needed" }, { status: 400 });
  // How the phone should show it (anything missing or odd falls back to a plain Nova Agent alert)
  const source = Object.hasOwn(ALERT_SOURCES, body.source) ? body.source : "agent";
  const kind = typeof body.kind === "string" ? body.kind.replace(/[^a-z-]/g, "").slice(0, 20) : "";
  const tag = typeof body.tag === "string" ? body.tag.replace(/[^\w-]/g, "").slice(0, 64) : "";
  const ttl = Math.min(Math.max(Number(body.ttl) || 86400, 60), 86400);
  const style = { source, kind, tag: tag ? `${source}-${tag}` : "", ttl, urgent: body.urgent === true };
  // `keep: false` (quick repeats): ring the phone but leave it out of the Alerts list
  const delivered = await notifyPhones(env, { title: `${ALERT_SOURCES[source]}: ${title}`, body: message, url: "/app/#nova", style, save: body.keep !== false });
  return Response.json({ ok: true, phones: delivered });
}

// ===== NOVA QUESTS IN NOVA HUB =====
// Nova Agent keeps its plan (missions, quests, pulses) here, so Nova Hub can
// show it; taps in Nova Hub (Done, Start, Not now...) wait here until Nova
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

// What Nova Hub shows: the latest plan, when it came, and whether Nova Agent is online
export async function questsForHub(env) {
  const { results } = await env.DB.prepare("SELECT key, value FROM settings WHERE key IN (?, 'agent_nova_seen')").bind(QUESTS_KEY).all();
  const setting = Object.fromEntries(results.map((row) => [row.key, row.value]));
  let saved = { at: null, state: null };
  try {
    saved = JSON.parse(setting[QUESTS_KEY] || "null") || saved;
  } catch {}
  const seen = setting.agent_nova_seen ? Date.parse(setting.agent_nova_seen) : 0;
  return { ...saved, online: Date.now() - seen < ONLINE_MINUTES * 60000 };
}

// A tap in Nova Hub, for Nova Agent to carry out
export async function queueQuestAction(env, action) {
  const list = await readActions(env);
  list.push({ ...action, at: new Date().toISOString() });
  await setSetting(env, ACTIONS_KEY, JSON.stringify(list.slice(-50)));
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
async function takeQuestActions(env) {
  const list = await readActions(env);
  if (list.length) await setSetting(env, ACTIONS_KEY, "[]");
  return list;
}

// Compare two secrets without giving away how much matched
async function sameText(a, b) {
  const hash = async (s) => new Uint8Array(await crypto.subtle.digest("SHA-256", new TextEncoder().encode(String(s))));
  return crypto.subtle.timingSafeEqual(await hash(a), await hash(b));
}

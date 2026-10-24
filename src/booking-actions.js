// Booking changes an AI suggests and a person approves (migrations/0023_booking_actions.sql)
//
// Nova Agent's AI (AGENT_NOVA_KEY, src/agent-nova.js) and the AI in Portal's staff chat
// (src/nova/manage-bookings.js) can suggest a change to a booking in Nova's own booking system
// (create, reschedule, cancel, update, extras, block_add, block_remove: the details of each are in
// src/nova/booking-changes.js, which checks them and makes the change). This file is the queue.
//
// (start and end: UTC ISO, or the UK clock "YYYY-MM-DDTHH:MM"; saved in UTC.)
//
// Who can do what is decided here and in the routes, whatever any AI says:
//
//   - The AIs can only PROPOSE: proposeAction() checks the details against the bookings, writes its
//     own plain-English summary (never the AI's), saves it as 'pending' and pings the admins'
//     phones. They can also list what's waiting. Nothing they can reach approves, edits or
//     carries anything out.
//   - An admin signed in to Portal in a browser (role 'admin' and the session cookie: checked
//     in src/app-page.js) can edit a pending one, approve it, or reject it.
//   - Approving is one guarded UPDATE (… WHERE status = 'pending'), so two presses at once
//     approve it once. Only the request that approved it carries it out, and only from status
//     'approved' (claimed once with started_at), so a change is never made twice.
//
// Logs carry ids and statuses only, never anyone's details.

import { notifyPhones } from "./push.js";
import { publicUrl } from "./nova/booking.js";
import { checkBookingChange, makeBookingChange } from "./nova/booking-changes.js";

export const KINDS = ["create", "reschedule", "cancel", "update", "extras", "block_add", "block_remove"];
export const PROPOSERS = ["agent", "staff-chat"];

// Suggestions waiting at once, at most (stops a runaway AI filling the list)
const MAX_PENDING = 50;

// An approved change still not finished after this long was cut off part-way (Nova Bot stopped)
const STUCK_MS = 5 * 60 * 1000;

const nowIso = () => new Date().toISOString();
const fail = (status, error) => ({ status, error });

// ===== CHECKING WHAT'S PROPOSED =====

function text(value, max) {
  return typeof value === "string" ? value.replace(/\r\n?/g, "\n").trim().slice(0, max) : "";
}

function positiveId(value) {
  const n = typeof value === "string" && /^\d{1,15}$/.test(value.trim()) ? Number(value) : value;
  return Number.isInteger(n) && n > 0 ? n : null;
}

// Check and tidy a proposal's details for its kind, and write the summary (nova/booking-changes.js).
// -> { payload, summary } or { status, error }
export const checkProposal = (env, kind, raw) => checkBookingChange(env, kind, raw);

// ===== READING =====

// An action as Nova Agent and Portal see it
function publicAction(env, row) {
  if (!row) return null;
  const parse = (value) => {
    try {
      return value ? JSON.parse(value) : null;
    } catch {
      return null;
    }
  };
  // Approved and started, but never finished (Nova Bot was stopped part-way): say so
  const stuck = row.status === "approved" && row.started_at && Date.now() - Date.parse(row.started_at) > STUCK_MS;
  return {
    id: row.id,
    kind: row.kind,
    status: stuck ? "failed" : row.status,
    summary: row.summary,
    payload: parse(row.payload) || {},
    reason: row.reason || "",
    proposedBy: row.proposed_by,
    createdAt: row.created_at,
    decidedBy: row.decided_by || null,
    decidedByName: row.decided_by_name || null,
    decidedAt: row.decided_at || null,
    note: row.decision_note || null,
    executedAt: row.executed_at || null,
    result: parse(row.result),
    error: stuck ? "It didn't finish (Nova Bot stopped part-way). Check the booking before doing it again." : row.error || null,
    portalUrl: `${publicUrl(env)}/portal/?view=approvals&action=${row.id}`,
  };
}

const SELECT = "SELECT a.*, s.display_name AS decided_by_name FROM booking_actions a LEFT JOIN staff s ON s.id = a.decided_by";

export async function getAction(env, id) {
  return publicAction(env, await env.DB.prepare(`${SELECT} WHERE a.id = ?`).bind(id).first());
}

// "pending" (the default): the ones waiting, oldest first. "all": the latest 100 of every status.
export async function listActions(env, { status = "pending" } = {}) {
  const { results } =
    status === "all"
      ? await env.DB.prepare(`${SELECT} ORDER BY a.id DESC LIMIT 100`).all()
      : await env.DB.prepare(`${SELECT} WHERE a.status = 'pending' ORDER BY a.id LIMIT 100`).all();
  return results.map((row) => publicAction(env, row));
}

// ===== THE AIs: propose only =====

// Save a suggestion as 'pending' and ping the admins. It's never carried out from here.
// -> { action } or { status, error }. Throws if Google Calendar can't be read (a blocked time's check).
export async function proposeAction(env, { kind, payload, reason, proposedBy }) {
  if (!KINDS.includes(kind)) return fail(400, `kind must be one of: ${KINDS.join(", ")}.`);
  if (!PROPOSERS.includes(proposedBy)) return fail(400, "Who's proposing it?");
  const checked = await checkProposal(env, kind, payload);
  if (checked.error) return checked;
  const payloadJson = JSON.stringify(checked.payload);

  // The same suggestion already waiting: hand that one back (no second ping)
  const same = await env.DB.prepare(`${SELECT} WHERE a.status = 'pending' AND a.kind = ? AND a.payload = ?`).bind(kind, payloadJson).first();
  if (same) return { action: publicAction(env, same), repeated: true };
  const { count } = await env.DB.prepare("SELECT COUNT(*) AS count FROM booking_actions WHERE status = 'pending'").first();
  if (count >= MAX_PENDING) return fail(429, "There are already many booking changes waiting for approval. Ask an admin to go through them in Portal first.");

  const now = nowIso();
  const { meta } = await env.DB.prepare(
    `INSERT INTO booking_actions (kind, payload, summary, reason, status, proposed_by, created_at, updated_at)
     VALUES (?, ?, ?, ?, 'pending', ?, ?, ?)`
  )
    .bind(kind, payloadJson, checked.summary, text(reason, 1000) || null, proposedBy, now, now)
    .run();
  const action = await getAction(env, meta.last_row_id);
  console.log(`Booking action ${action.id} (${kind}) proposed by ${proposedBy}`);
  await pingAdmins(env, action);
  return { action };
}

// A quiet ping to the admins' phones (only theirs: they're the ones who can approve)
async function pingAdmins(env, action) {
  try {
    const { results } = await env.DB.prepare("SELECT id FROM staff WHERE role = 'admin' AND status = 'active'").all();
    if (!results.length) return;
    await notifyPhones(env, {
      title: "Booking change to approve",
      body: `${action.proposedBy === "agent" ? "Agent" : "Portal's staff chat"} suggests: ${action.summary}. Approve or reject it in Portal.`,
      url: `/portal/?view=approvals&action=${action.id}`,
      style: { source: "portal", kind: "booking-action", tag: `booking-action-${action.id}`, ttl: 12 * 3600, urgent: false },
      to: { staff: results.map((r) => r.id) },
    });
  } catch (err) {
    console.log(`Booking action ${action.id}: the ping failed (${err.message})`);
  }
}

// ===== AN ADMIN (a person pressed a button in Portal; src/app-page.js checks who) =====

async function decidedAlready(env, id) {
  const action = await getAction(env, id);
  if (!action) return fail(404, "That booking change doesn't exist.");
  return { ...fail(409, `That booking change has already been ${action.status === "pending" ? "changed" : action.status}.`), action };
}

// The saved details with a person's edits on top (they may send only what they changed)
function withEdits(saved, edits) {
  let base = {};
  try {
    base = JSON.parse(saved) || {};
  } catch {}
  return edits && typeof edits === "object" && !Array.isArray(edits) ? { ...base, ...edits } : base;
}

// Change a pending one's details (it stays pending; the summary is written again)
export async function editAction(env, me, { id, payload }) {
  id = positiveId(id);
  if (!id) return fail(400, "Which booking change?");
  const row = await env.DB.prepare("SELECT kind, status, payload FROM booking_actions WHERE id = ?").bind(id).first();
  if (!row) return fail(404, "That booking change doesn't exist.");
  if (row.status !== "pending") return decidedAlready(env, id);
  const checked = await checkProposal(env, row.kind, withEdits(row.payload, payload));
  if (checked.error) return checked;
  const { meta } = await env.DB.prepare("UPDATE booking_actions SET payload = ?, summary = ?, updated_at = ? WHERE id = ? AND status = 'pending'")
    .bind(JSON.stringify(checked.payload), checked.summary, nowIso(), id)
    .run();
  if (!meta.changes) return decidedAlready(env, id);
  console.log(`Booking action ${id} edited by ${me.id}`);
  return { action: await getAction(env, id) };
}

// Approve (with the details as the admin last saw them, if given) and carry it out straight away
export async function approveAction(env, me, { id, payload }) {
  id = positiveId(id);
  if (!id) return fail(400, "Which booking change?");
  const row = await env.DB.prepare("SELECT kind, status, payload FROM booking_actions WHERE id = ?").bind(id).first();
  if (!row) return fail(404, "That booking change doesn't exist.");
  if (row.status !== "pending") return { action: await getAction(env, id), repeated: true };
  let checked = null;
  if (payload !== undefined && payload !== null) {
    checked = await checkProposal(env, row.kind, withEdits(row.payload, payload));
    if (checked.error) return checked;
  }
  const now = nowIso();
  // pending -> approved, once: a second press finds it no longer pending and does nothing
  const { meta } = await env.DB.prepare(
    `UPDATE booking_actions SET status = 'approved', payload = COALESCE(?, payload), summary = COALESCE(?, summary),
       decided_by = ?, decided_at = ?, updated_at = ?
     WHERE id = ? AND status = 'pending'`
  )
    .bind(checked ? JSON.stringify(checked.payload) : null, checked ? checked.summary : null, me.id, now, now, id)
    .run();
  if (!meta.changes) return { action: await getAction(env, id), repeated: true };
  console.log(`Booking action ${id} approved by ${me.id}`);
  return { action: await executeApproved(env, id) };
}

export async function rejectAction(env, me, { id, note }) {
  id = positiveId(id);
  if (!id) return fail(400, "Which booking change?");
  const now = nowIso();
  const { meta } = await env.DB.prepare(
    "UPDATE booking_actions SET status = 'rejected', decided_by = ?, decided_at = ?, decision_note = ?, updated_at = ? WHERE id = ? AND status = 'pending'"
  )
    .bind(me.id, now, text(note, 500) || null, now, id)
    .run();
  if (!meta.changes) return decidedAlready(env, id);
  console.log(`Booking action ${id} rejected by ${me.id}`);
  return { action: await getAction(env, id) };
}

// ===== CARRYING IT OUT =====

// Carry out an approved action, once. Only status 'approved' runs (a person pressed Approve);
// anything else is handed back untouched. started_at is claimed first, so even two calls at the
// same moment make the change once.
export async function executeApproved(env, id) {
  const now = nowIso();
  const { meta } = await env.DB.prepare("UPDATE booking_actions SET started_at = ?, updated_at = ? WHERE id = ? AND status = 'approved' AND started_at IS NULL")
    .bind(now, now, id)
    .run();
  if (!meta.changes) return getAction(env, id);
  const row = await env.DB.prepare("SELECT kind, payload FROM booking_actions WHERE id = ? AND status = 'approved'").bind(id).first();
  let outcome;
  try {
    outcome = await makeBookingChange(env, row.kind, JSON.parse(row.payload));
  } catch (err) {
    // Google or Stripe not answering: their own words (they never hold anyone's details)
    const outside = /^(Google|Stripe)\b/.test(String(err?.message || ""));
    outcome = { ok: false, error: outside ? `${String(err.message).slice(0, 200)}. Check the booking before trying again.` : "Something went wrong carrying it out. Check the booking before trying again." };
    console.log(`Booking action ${id}: carrying it out failed (${err?.name || "error"})`);
  }
  const done = nowIso();
  await env.DB.prepare("UPDATE booking_actions SET status = ?, executed_at = ?, result = ?, error = ?, updated_at = ? WHERE id = ? AND status = 'approved'")
    .bind(outcome.ok ? "executed" : "failed", done, outcome.ok ? JSON.stringify(outcome.result || {}) : null, outcome.ok ? null : outcome.error, done, id)
    .run();
  console.log(`Booking action ${id} (${row.kind}): ${outcome.ok ? "executed" : "failed"}`);
  // Nova Agent re-reads the bookings (a blocked time doesn't go through the booking engine)
  if (outcome.ok) await markBookingsChanged(env).catch(() => {});
  return getAction(env, id);
}

// ===== "BOOKINGS CHANGED" (for Nova Agent's /next) =====

export const BOOKINGS_CHANGED_KEY = "bookings_changed_at";

// Something changed in the diary (a booking made, moved or cancelled, or an approved change): note when
export async function markBookingsChanged(env, at = nowIso()) {
  await env.DB.prepare("INSERT INTO settings (key, value) VALUES (?, ?) ON CONFLICT (key) DO UPDATE SET value = excluded.value").bind(BOOKINGS_CHANGED_KEY, at).run();
}

export async function bookingsChangedAt(env) {
  return (await env.DB.prepare("SELECT value FROM settings WHERE key = ?").bind(BOOKINGS_CHANGED_KEY).first("value")) || null;
}

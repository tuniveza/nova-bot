// Booking changes an AI suggests and a person approves (migrations/0023_booking_actions.sql)
//
// Nova Agent's AI (AGENT_NOVA_KEY, src/agent-nova.js) and the AI in Portal's staff chat
// (src/manage-bookings.js) can suggest a change in Acuity:
//
//   create        make a booking            { typeId, start, firstName, lastName, email, phone?, notes?, notifyClient }
//   reschedule    move a booking            { appointmentId, start, notifyClient }
//   cancel        cancel a booking          { appointmentId, notifyClient, note? }
//   update        change a booking's client details or notes { appointmentId, firstName?, lastName?, email?, phone?, notes? }
//   block_add     block off a time          { start, end, notes?, calendarId? }
//   block_remove  remove a blocked-off time { blockId }
//
// (start and end: UTC ISO, or the UK clock "YYYY-MM-DDTHH:MM"; saved in UTC.)
//
// Who can do what is decided here and in the routes, whatever any AI says:
//
//   - The AIs can only PROPOSE: proposeAction() checks the details against Acuity, writes its
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
import { queueAgentJob } from "./agent-nova.js";
import { publicUrl } from "./nova/booking.js";
import {
  AcuityError,
  acuityMessage,
  acuityRequest,
  getAppointment,
  getBlock,
  listCalendars,
  listTypes,
  readTime,
  toLondonIso,
  ukClock,
  ukShort,
} from "./acuity/api.js";

export const KINDS = ["create", "reschedule", "cancel", "update", "extras", "block_add", "block_remove"];
export const PROPOSERS = ["agent", "staff-chat"];

// Suggestions waiting at once, at most (stops a runaway AI filling the list)
const MAX_PENDING = 50;
// How far ahead a booking or blocked time can be
const MAX_AHEAD_MS = 2 * 365 * 86400000;
// The longest blocked-off time in one go
const MAX_BLOCK_MS = 31 * 86400000;

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

const looksLikeEmail = (value) => /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(value);

// A start or end time -> UTC ISO, or a problem
function readWhen(value, label, { future = true } = {}) {
  const date = readTime(value);
  if (!date) return { problem: `${label} must be a UK time "YYYY-MM-DDTHH:MM" or a UTC time (ISO 8601).` };
  if (future && date.getTime() < Date.now()) return { problem: `${label} (${ukShort(date)}) is in the past.` };
  if (date.getTime() > Date.now() + MAX_AHEAD_MS) return { problem: `${label} is more than two years ahead.` };
  return { iso: date.toISOString() };
}

const emailNote = (notify) => (notify ? "Acuity emails the client" : "no email to the client");
const whose = (a) => `${`${a.firstName || ""} ${a.lastName || ""}`.trim() || "the client"}'s ${a.type || "booking"}`;
const span = (start, end) => {
  const a = ukShort(start);
  const b = ukShort(end);
  return a.slice(0, -5) === b.slice(0, -5) ? `${a}–${ukClock(end)}` : `${a} to ${b}`;
};

// A booking that exists and isn't cancelled (Acuity's shape), or a problem
async function liveAppointment(env, id) {
  const appt = await getAppointment(env, id);
  if (!appt) return { problem: `There's no booking ${id} in Acuity.` };
  if (appt.canceled) return { problem: `Booking ${id} is already cancelled.` };
  return { appt };
}

// Check and tidy a proposal's details for its kind, reading Acuity where needed, and write the
// summary. -> { payload, summary } or { status, error }. Throws an AcuityError if Acuity is
// busy or down.
export async function checkProposal(env, kind, raw) {
  const input = raw && typeof raw === "object" && !Array.isArray(raw) ? raw : {};
  const notifyClient = input.notifyClient !== false;

  if (kind === "create") {
    const typeId = positiveId(input.typeId);
    if (!typeId) return fail(400, "typeId: which session type (its Acuity id)?");
    const start = readWhen(input.start, "start");
    if (start.problem) return fail(400, start.problem);
    const firstName = text(input.firstName, 60);
    const lastName = text(input.lastName, 60);
    const email = text(input.email, 200).toLowerCase();
    if (!firstName || !lastName) return fail(400, "The client's first and last name are needed.");
    if (!looksLikeEmail(email)) return fail(400, "The client's email address is needed.");
    const payload = { typeId, start: start.iso, firstName, lastName, email, notifyClient };
    if (text(input.phone, 40)) payload.phone = text(input.phone, 40);
    if (text(input.notes, 2000)) payload.notes = text(input.notes, 2000);
    const type = (await listTypes(env)).find((t) => t.id === typeId);
    if (!type) return fail(400, `There's no session type ${typeId} in Acuity.`);
    const minutes = Number(type.duration) || 0;
    const when = minutes ? span(start.iso, new Date(Date.parse(start.iso) + minutes * 60000)) : ukShort(start.iso);
    return { payload, summary: `Book ${firstName} ${lastName} (${email}) for ${type.name} on ${when} (${emailNote(notifyClient)})` };
  }

  if (kind === "reschedule") {
    const appointmentId = positiveId(input.appointmentId);
    if (!appointmentId) return fail(400, "appointmentId: which booking (its Acuity id)?");
    const start = readWhen(input.start, "start");
    if (start.problem) return fail(400, start.problem);
    const found = await liveAppointment(env, appointmentId);
    if (found.problem) return fail(400, found.problem);
    const was = readTime(String(found.appt.datetime || ""));
    if (was && was.toISOString() === start.iso) return fail(400, `It's already at ${ukShort(start.iso)}.`);
    return {
      payload: { appointmentId, start: start.iso, notifyClient },
      summary: `Move ${whose(found.appt)} from ${was ? ukShort(was) : "its current time"} to ${ukShort(start.iso)} (${emailNote(notifyClient)})`,
    };
  }

  if (kind === "cancel") {
    const appointmentId = positiveId(input.appointmentId);
    if (!appointmentId) return fail(400, "appointmentId: which booking (its Acuity id)?");
    const found = await liveAppointment(env, appointmentId);
    if (found.problem) return fail(400, found.problem);
    const note = text(input.note, 500);
    const was = readTime(String(found.appt.datetime || ""));
    const payload = { appointmentId, notifyClient };
    if (note) payload.note = note;
    return {
      payload,
      summary: `Cancel ${whose(found.appt)} on ${was ? ukShort(was) : "its day"} (${emailNote(notifyClient)}${note && notifyClient ? `, with the note "${note}"` : ""})`,
    };
  }

  if (kind === "update") {
    const appointmentId = positiveId(input.appointmentId);
    if (!appointmentId) return fail(400, "appointmentId: which booking (its Acuity id)?");
    const changes = {};
    for (const [key, max] of [["firstName", 60], ["lastName", 60], ["email", 200], ["phone", 40]]) {
      if (text(input[key], max)) changes[key] = key === "email" ? text(input[key], max).toLowerCase() : text(input[key], max);
    }
    if (typeof input.notes === "string") changes.notes = input.notes.slice(0, 2000);
    if (changes.email && !looksLikeEmail(changes.email)) return fail(400, "That email address doesn't look right.");
    const found = await liveAppointment(env, appointmentId);
    if (found.problem) return fail(400, found.problem);
    // Only what really changes
    for (const key of Object.keys(changes)) if (String(found.appt[key] || "") === changes[key]) delete changes[key];
    if (Object.keys(changes).length === 0) return fail(400, "Nothing to change: give at least one of firstName, lastName, email, phone, notes that's different.");
    const NAMES = { firstName: "first name", lastName: "last name", email: "email", phone: "phone", notes: "notes" };
    const list = Object.entries(changes).map(([key, value]) => `${NAMES[key]} "${String(found.appt[key] || "").slice(0, 100)}" → "${value.slice(0, 100)}"`);
    const was = readTime(String(found.appt.datetime || ""));
    return { payload: { appointmentId, ...changes }, summary: `Change ${whose(found.appt)} on ${was ? ukShort(was) : "its day"}: ${list.join(", ")}` };
  }

  // Session type, price, paid: Acuity's API can't change these, so once approved Nova Agent
  // does it on Acuity's pages (a job, src/agent-nova.js)
  if (kind === "extras") {
    const appointmentId = positiveId(input.appointmentId);
    if (!appointmentId) return fail(400, "appointmentId: which booking (its Acuity id)?");
    const changes = {};
    if (text(input.type, 150)) changes.type = text(input.type, 150);
    if (input.price !== undefined && input.price !== null && input.price !== "") {
      const price = String(input.price).replace(/[£\s,]/g, "");
      if (!/^\d{1,5}(\.\d{1,2})?$/.test(price)) return fail(400, "price: the amount in pounds, e.g. 80.00.");
      changes.price = Number(price).toFixed(2);
    }
    if (typeof input.paid === "boolean") changes.paid = input.paid;
    if (Object.keys(changes).length === 0) return fail(400, "Nothing to change: give type, price or paid.");
    const found = await liveAppointment(env, appointmentId);
    if (found.problem) return fail(400, found.problem);
    const list = [
      changes.type ? `session type "${found.appt.type || "?"}" → "${changes.type}"` : "",
      changes.price ? `price £${found.appt.price || "?"} → £${changes.price}` : "",
      "paid" in changes ? `paid: ${changes.paid ? "yes" : "no"}` : "",
    ].filter(Boolean);
    const was = readTime(String(found.appt.datetime || ""));
    const clientName = `${found.appt.firstName || ""} ${found.appt.lastName || ""}`.trim();
    return {
      payload: { appointmentId, clientName, ...changes },
      summary: `Change ${whose(found.appt)} on ${was ? ukShort(was) : "its day"}: ${list.join(", ")} (Nova Agent does this on Acuity's pages)`,
    };
  }

  if (kind === "block_add") {
    const start = readWhen(input.start, "start");
    if (start.problem) return fail(400, start.problem);
    const end = readWhen(input.end, "end");
    if (end.problem) return fail(400, end.problem);
    const length = Date.parse(end.iso) - Date.parse(start.iso);
    if (length <= 0) return fail(400, "end must be after start.");
    if (length > MAX_BLOCK_MS) return fail(400, "That's more than a month: block it off in smaller pieces.");
    const payload = { start: start.iso, end: end.iso };
    const notes = text(input.notes, 500);
    if (notes) payload.notes = notes;
    let calendar = "";
    if (input.calendarId !== undefined && input.calendarId !== null && input.calendarId !== "") {
      const calendarId = positiveId(input.calendarId);
      const found = calendarId && (await listCalendars(env)).find((c) => c.id === calendarId);
      if (!found) return fail(400, `There's no calendar ${input.calendarId} in Acuity.`);
      payload.calendarId = calendarId;
      calendar = found.name;
    }
    return { payload, summary: `Block off ${span(start.iso, end.iso)}${calendar ? ` in ${calendar}` : ""}${notes ? ` ("${notes}")` : ""}` };
  }

  if (kind === "block_remove") {
    const blockId = positiveId(input.blockId);
    if (!blockId) return fail(400, "blockId: which blocked time (its Acuity id)?");
    const block = await getBlock(env, blockId);
    if (!block) return fail(400, `There's no blocked time ${blockId} in Acuity.`);
    const start = readTime(String(block.start || ""));
    const end = readTime(String(block.end || ""));
    const notes = text(block.notes || block.description, 100);
    return { payload: { blockId }, summary: `Remove the blocked-off time ${start && end ? span(start, end) : `#${blockId}`}${notes ? ` ("${notes}")` : ""}` };
  }

  return fail(400, `kind must be one of: ${KINDS.join(", ")}.`);
}

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
    error: stuck ? "It didn't finish (Nova Bot stopped part-way). Check Acuity before doing it again." : row.error || null,
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
// -> { action } or { status, error }. Throws an AcuityError if Acuity is busy or down.
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
// same moment make the change in Acuity once.
export async function executeApproved(env, id) {
  const now = nowIso();
  const { meta } = await env.DB.prepare("UPDATE booking_actions SET started_at = ?, updated_at = ? WHERE id = ? AND status = 'approved' AND started_at IS NULL")
    .bind(now, now, id)
    .run();
  if (!meta.changes) return getAction(env, id);
  const row = await env.DB.prepare("SELECT kind, payload FROM booking_actions WHERE id = ? AND status = 'approved'").bind(id).first();
  let outcome;
  try {
    outcome = await carryOut(env, row.kind, JSON.parse(row.payload));
  } catch (err) {
    const unsure = err instanceof AcuityError && err.kind === "unreachable" && ["create", "block_add"].includes(row.kind);
    outcome = {
      ok: false,
      error: err instanceof AcuityError ? err.message + (unsure ? " It may or may not have been made: check Acuity before trying again." : "") : "Something went wrong carrying it out.",
    };
  }
  const done = nowIso();
  await env.DB.prepare("UPDATE booking_actions SET status = ?, executed_at = ?, result = ?, error = ?, updated_at = ? WHERE id = ? AND status = 'approved'")
    .bind(outcome.ok ? "executed" : "failed", done, outcome.ok ? JSON.stringify(outcome.result || {}) : null, outcome.ok ? null : outcome.error, done, id)
    .run();
  console.log(`Booking action ${id} (${row.kind}): ${outcome.ok ? "executed" : "failed"}`);
  // Nova Agent re-reads the bookings (blocked times never get a webhook from Acuity)
  if (outcome.ok) await markBookingsChanged(env).catch(() => {});
  return getAction(env, id);
}

// The change itself, in Acuity. -> { ok, result } or { ok: false, error }
async function carryOut(env, kind, p) {
  const quiet = p.notifyClient === false ? "&noEmail=true" : "";
  const said = (data) => ({ ok: false, error: `Acuity said "${acuityMessage(data)}".` });

  if (kind === "create") {
    const body = { appointmentTypeID: p.typeId, datetime: toLondonIso(p.start), firstName: p.firstName, lastName: p.lastName, email: p.email };
    if (p.phone) body.phone = p.phone;
    if (p.notes) body.notes = p.notes;
    const { ok, data } = await acuityRequest(env, "POST", `/appointments?admin=true${quiet}`, body);
    return ok ? { ok: true, result: { appointmentId: data?.id ?? null } } : said(data);
  }
  if (kind === "reschedule") {
    const { ok, data } = await acuityRequest(env, "PUT", `/appointments/${p.appointmentId}/reschedule?admin=true${quiet}`, { datetime: toLondonIso(p.start) });
    return ok ? { ok: true, result: { appointmentId: p.appointmentId, start: p.start } } : said(data);
  }
  if (kind === "cancel") {
    const { ok, data } = await acuityRequest(env, "PUT", `/appointments/${p.appointmentId}/cancel?admin=true${quiet}`, p.note ? { cancelNote: p.note } : {});
    return ok ? { ok: true, result: { appointmentId: p.appointmentId } } : said(data);
  }
  if (kind === "update") {
    const changes = {};
    for (const key of ["firstName", "lastName", "email", "phone", "notes"]) if (key in p) changes[key] = p[key];
    const { ok, data } = await acuityRequest(env, "PUT", `/appointments/${p.appointmentId}?admin=true`, changes);
    return ok ? { ok: true, result: { appointmentId: p.appointmentId } } : said(data);
  }
  if (kind === "extras") {
    if (!env.AGENT_NOVA_KEY) return { ok: false, error: "Nova Agent isn't connected (no AGENT_NOVA_KEY), so it can't change this. Change it in Acuity." };
    const changes = {};
    for (const key of ["type", "price", "paid"]) if (key in p) changes[key] = p[key];
    const summary = `${p.clientName || "Booking"} #${p.appointmentId}: ${Object.entries(changes).map(([k, v]) => `${k} → ${v}`).join(", ")}`;
    const job = await queueAgentJob(env, { appointmentId: p.appointmentId, clientName: p.clientName || "", changes, summary });
    return { ok: true, result: { appointmentId: p.appointmentId, job, note: "Queued for Nova Agent: it makes the change on Acuity's pages within a few minutes, and staff phones get a notification when it's done." } };
  }
  if (kind === "block_add") {
    let calendarID = p.calendarId;
    if (!calendarID) {
      calendarID = (await listCalendars(env))[0]?.id;
      if (!calendarID) return { ok: false, error: "Acuity has no calendar to block the time off in." };
    }
    const body = { start: toLondonIso(p.start), end: toLondonIso(p.end), calendarID };
    if (p.notes) body.notes = p.notes;
    const { ok, data } = await acuityRequest(env, "POST", "/blocks", body);
    return ok ? { ok: true, result: { blockId: data?.id ?? null, calendarId: calendarID } } : said(data);
  }
  if (kind === "block_remove") {
    const { ok, status, data } = await acuityRequest(env, "DELETE", `/blocks/${p.blockId}`);
    return ok || status === 204 ? { ok: true, result: { blockId: p.blockId } } : said(data);
  }
  return { ok: false, error: `Unknown kind ${kind}.` };
}

// ===== "BOOKINGS CHANGED" (for Nova Agent's /next) =====

export const BOOKINGS_CHANGED_KEY = "bookings_changed_at";

// Something changed in Acuity's diary (its webhook, or an approved change): note when
export async function markBookingsChanged(env, at = nowIso()) {
  await env.DB.prepare("INSERT INTO settings (key, value) VALUES (?, ?) ON CONFLICT (key) DO UPDATE SET value = excluded.value").bind(BOOKINGS_CHANGED_KEY, at).run();
}

export async function bookingsChangedAt(env) {
  return (await env.DB.prepare("SELECT value FROM settings WHERE key = ?").bind(BOOKINGS_CHANGED_KEY).first("value")) || null;
}

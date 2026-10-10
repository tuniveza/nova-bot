// Staff managing existing bookings from Portal's chat
//
// In Portal, staff can ask NovaBot to find, cancel, reschedule or change a
// booking ("cancel Dana's session on Saturday", "move Kai to 4pm"). These
// tools are only given to NovaBot in the staff chat, never on the website.
//
// Everything goes through Acuity's official API (src/acuity/api.js; needs
// ACUITY_USER_ID and ACUITY_API_KEY). Acuity sends the client its usual
// emails unless staff say not to.
//
// Safety:
// - Changes always name the booking by its Acuity ID, which NovaBot gets from
//   find_bookings, so it can't mix up two people with similar names.
// - Every change takes two calls. The first (confirmed false) changes nothing
//   and gives NovaBot a summary to show staff. A second call with confirmed
//   true, after staff have clearly said yes, still changes nothing in Acuity:
//   it PROPOSES the change (src/booking-actions.js, proposedBy "staff-chat"),
//   and an admin approves it in Portal → Approvals, which makes it.
// - Acuity's API can't change a booking's session type, price or paid
//   status. Those go to Nova Agent (the browser helper, agent-nova.js) as a
//   job; it does them in Acuity's admin pages within a few minutes, and staff
//   phones get a notification with the result.

import { agentNovaProblem, queueAgentJob } from "./agent-nova.js";
import { dayInWords, normaliseTime, ukToday } from "./booking.js";
import { acuityFailure, acuityRequest, availableTimes, ukWallToUtc } from "./acuity/api.js";
import { proposeAction } from "./booking-actions.js";

// The most bookings find_bookings lists in one go (keeps replies readable)
const MAX_LISTED = 15;

const ID = { type: "integer", description: "The booking's Acuity ID, from find_bookings" };
const CONFIRMED = {
  type: "boolean",
  description: "false: just check it and get a summary to show staff (nothing changes). true: do it, only after staff have seen that summary and clearly said yes.",
};
// For cancel, reschedule and update, which an admin approves in Portal
const PROPOSE = {
  type: "boolean",
  description:
    "false: just check it and get a summary to show staff (nothing changes). true: propose it, only after staff have seen that summary and clearly said yes. Nothing changes in Acuity until an admin approves it in Portal → Approvals.",
};

export const FIND_BOOKINGS_TOOL = {
  name: "find_bookings",
  description:
    "Find existing bookings in the studio's Acuity calendar, to answer staff questions or before changing one. Give a date range and/or part of the client's name, email or phone. Lists each booking with its ID.",
  input_schema: {
    type: "object",
    properties: {
      from: { type: "string", description: "First day to look at, YYYY-MM-DD (UK date). Default: today" },
      to: { type: "string", description: "Last day to look at, YYYY-MM-DD. Default: 60 days after `from`" },
      name: { type: "string", description: "All or part of the client's name" },
      email: { type: "string", description: "All or part of the client's email" },
      phone: { type: "string", description: "The client's phone number (any format)" },
    },
  },
};

export const CANCEL_BOOKING_TOOL = {
  name: "cancel_booking",
  description: "Propose cancelling a booking (an admin approves it in Portal before it happens). Find it with find_bookings first.",
  input_schema: {
    type: "object",
    properties: {
      appointment_id: ID,
      notify_client: { type: "boolean", description: "Send the client Acuity's cancellation email (usually yes)" },
      note: { type: "string", description: "Optional message included in the client's cancellation email" },
      confirmed: PROPOSE,
    },
    required: ["appointment_id", "notify_client", "confirmed"],
  },
};

export const RESCHEDULE_BOOKING_TOOL = {
  name: "reschedule_booking",
  description: "Propose moving a booking to a new day and/or start time (an admin approves it in Portal before it happens). Find it with find_bookings first.",
  input_schema: {
    type: "object",
    properties: {
      appointment_id: ID,
      date: { type: "string", description: "The new day, YYYY-MM-DD (UK date)" },
      time: { type: "string", description: "The new start time, 24-hour HH:MM (UK time)" },
      notify_client: { type: "boolean", description: "Send the client Acuity's rescheduling email (usually yes)" },
      ignore_availability: {
        type: "boolean",
        description: "Book it even if the calendar shows that time as not free. Only if staff explicitly ask to override.",
      },
      confirmed: PROPOSE,
    },
    required: ["appointment_id", "date", "time", "notify_client", "confirmed"],
  },
};

export const UPDATE_BOOKING_TOOL = {
  name: "update_booking",
  description:
    "Propose changing a booking's client details or notes: first name, last name, email, phone, notes (an admin approves it in Portal before it happens). Only give the fields that change. (Session type, price and paid status: use change_booking_extras.) Find it with find_bookings first.",
  input_schema: {
    type: "object",
    properties: {
      appointment_id: ID,
      first_name: { type: "string" },
      last_name: { type: "string" },
      email: { type: "string" },
      phone: { type: "string" },
      notes: { type: "string", description: "Replaces the booking's notes" },
      confirmed: PROPOSE,
    },
    required: ["appointment_id", "confirmed"],
  },
};

export const CHANGE_EXTRAS_TOOL = {
  name: "change_booking_extras",
  description:
    "Change a booking's session type, price or paid status (what Acuity's API can't do). Nova Agent does it in Acuity within a few minutes, and staff phones get a notification when it's done. Only give what changes. Find the booking with find_bookings first.",
  input_schema: {
    type: "object",
    properties: {
      appointment_id: ID,
      session_type: { type: "string", description: "The new session type's name, as on the booking page, e.g. \"Rap Package - 1 song\"" },
      price: { type: "string", description: "The new total price in pounds, e.g. \"80.00\"" },
      paid: { type: "boolean", description: "Mark it as paid (true) or not paid (false)" },
      confirmed: CONFIRMED,
    },
    required: ["appointment_id", "confirmed"],
  },
};

export const MANAGE_BOOKING_TOOLS = [FIND_BOOKINGS_TOOL, CANCEL_BOOKING_TOOL, RESCHEDULE_BOOKING_TOOL, UPDATE_BOOKING_TOOL, CHANGE_EXTRAS_TOOL];

// The extra instructions NovaBot gets in the staff chat
export const MANAGE_BOOKINGS_RULES = `STAFF CHAT: MANAGING BOOKINGS
You're talking to Novacane staff in Portal, not a customer. Besides everything
above, you can look up and change existing bookings:
- find_bookings lists bookings with their IDs. Use it to answer questions ("what's
  on Saturday?", "when is Kai in next?") and before any change.
- cancel_booking, reschedule_booking and update_booking PROPOSE a change to a
  booking by its ID. You can't make these changes yourself: an admin approves
  each one in Portal → Approvals, and only then does it happen in Acuity.
- Every change takes two steps: first call the tool with confirmed false. That
  changes nothing and tells you exactly what will be proposed: show staff that
  summary and ask them to confirm. Only after they clearly say yes, call it again
  with confirmed true, which proposes it. Then tell staff it's waiting for an
  admin to approve it in Portal → Approvals (give the link). If more than one
  booking could be the one they mean, ask which.
- Ask whether to email the client if staff haven't said (Acuity's emails are
  usually wanted).
- Session type, price and paid status: use change_booking_extras. Nova Agent does
  those in Acuity a few minutes later and staff get a phone notification; say
  that, and never say they're already done.
- Never say something is cancelled, moved or changed: proposed changes happen only
  once an admin approves them.`;

// Is this one of these tools?
export function isManageBookingTool(name) {
  return MANAGE_BOOKING_TOOLS.some((tool) => tool.name === name);
}

// Run one of these tools. Returns { ok, message } for Claude.
export async function runManageBookingTool(env, name, input, today = ukToday()) {
  if (!env.ACUITY_USER_ID || !env.ACUITY_API_KEY) {
    return { ok: false, message: "Managing bookings needs the ACUITY_USER_ID and ACUITY_API_KEY secrets, which aren't set. Tell staff to use Acuity directly." };
  }
  if (name === FIND_BOOKINGS_TOOL.name) return findBookings(env, input, today);
  if (name === CANCEL_BOOKING_TOOL.name) return cancelBooking(env, input);
  if (name === RESCHEDULE_BOOKING_TOOL.name) return rescheduleBooking(env, input, today);
  if (name === UPDATE_BOOKING_TOOL.name) return updateBooking(env, input);
  if (name === CHANGE_EXTRAS_TOOL.name) return changeExtras(env, input);
  return { ok: false, message: "Unknown tool." };
}

// ===== FIND =====

async function findBookings(env, input, today) {
  const from = isDate(input?.from) ? input.from : today;
  const to = isDate(input?.to) ? input.to : addDays(from, 60);
  if (to < from) return { ok: false, message: "The end date is before the start date. Check the dates." };

  // Acuity gives the bookings in the date range; the name/email/phone
  // filtering is done here, so it can match part of a name or any phone format
  const { ok, data } = await acuity(env, "GET", `/appointments?minDate=${from}&maxDate=${to}&max=500&direction=ASC`);
  if (!ok || !Array.isArray(data)) return { ok: false, message: "Couldn't read the calendar from Acuity just now. Tell staff to try again or check Acuity." };

  const name = lower(input?.name);
  const email = lower(input?.email);
  const phone = digits(input?.phone);
  const found = data.filter(
    (b) =>
      (!name || lower(`${b.firstName} ${b.lastName}`).includes(name)) &&
      (!email || lower(b.email).includes(email)) &&
      (!phone || (digits(b.phone).length > 0 && digits(b.phone).endsWith(phone.slice(-9))))
  );

  const range = from === to ? dayInWords(from) : `${dayInWords(from)} to ${dayInWords(to)}`;
  if (found.length === 0) return { ok: true, message: `No bookings found (${range}${filtersInWords(input)}).` };

  const lines = found.slice(0, MAX_LISTED).map(describe);
  const more = found.length > MAX_LISTED ? `\n…and ${found.length - MAX_LISTED} more. Narrow it down by date or name to see them.` : "";
  return { ok: true, message: `${found.length} booking(s) (${range}${filtersInWords(input)}):\n${lines.join("\n")}${more}` };
}

// ===== CANCEL, RESCHEDULE, UPDATE: proposed, and an admin approves in Portal =====

// Why staff-chat proposals are made (the admin sees it next to Nova Bot's own summary)
const STAFF_CHAT_REASON = "Asked for in Portal's staff chat, and confirmed there.";

// Save a proposal (src/booking-actions.js: nothing changes in Acuity until an admin approves)
// and tell NovaBot what to say
async function propose(env, kind, payload) {
  let result;
  try {
    result = await proposeAction(env, { kind, payload, reason: STAFF_CHAT_REASON, proposedBy: "staff-chat" });
  } catch (err) {
    return { ok: false, message: `Not proposed: ${acuityFailure(err).body.error} Tell staff to try again in a minute.` };
  }
  if (result.error) return { ok: false, message: `Not proposed: ${result.error} Tell staff.` };
  const action = result.action;
  return {
    ok: true,
    message:
      `Proposed, NOT done yet (#${action.id}): ${action.summary}.` +
      (result.repeated ? " (This was already proposed and is still waiting.)" : "") +
      ` It's waiting for an admin to approve it in Portal → Approvals: ${action.portalUrl}\n` +
      "Tell staff that. Nothing has changed in Acuity yet; never say it's done.",
  };
}

// ===== CANCEL =====

async function cancelBooking(env, input) {
  const booking = await getBooking(env, input?.appointment_id);
  if (booking.problem) return { ok: false, message: booking.problem };
  const notify = input?.notify_client !== false;
  const note = field(input?.note, 500);

  if (input?.confirmed !== true) {
    return {
      ok: true,
      message:
        `Not cancelled yet. Show staff this and ask them to confirm:\n- Cancel: ${describe(booking)}\n- Email the client: ${notify ? "yes" : "no"}` +
        (note ? `\n- Note to the client: "${note}"` : "") +
        "\nOnly after they clearly say yes, call cancel_booking again with confirmed true. That proposes it: an admin then approves it in Portal → Approvals.",
    };
  }

  // As staff (admin=true) once approved, so the client's cancellation rules don't apply
  return propose(env, "cancel", { appointmentId: booking.id, notifyClient: notify, ...(note && { note }) });
}

// ===== RESCHEDULE =====

async function rescheduleBooking(env, input, today) {
  const booking = await getBooking(env, input?.appointment_id);
  if (booking.problem) return { ok: false, message: booking.problem };

  const date = isDate(input?.date) ? input.date : "";
  const time = normaliseTime(input?.time);
  if (!date || !time) return { ok: false, message: "Not moved: I need the new day (YYYY-MM-DD) and start time (HH:MM). Ask staff." };
  if (date < today) return { ok: false, message: `Not moved: ${dayInWords(date)} is in the past. Check the date with staff.` };
  const start = ukWallToUtc(`${date}T${time}`);
  if (!start) return { ok: false, message: `Not moved: ${time} on ${dayInWords(date)} isn't a real UK time (the clocks change). Ask staff for another time.` };

  const notify = input?.notify_client !== false;
  const override = input?.ignore_availability === true;
  const newWhen = `${dayInWords(date)} at ${time}`;

  if (input?.confirmed !== true) {
    return {
      ok: true,
      message:
        `Not moved yet. Show staff this and ask them to confirm:\n- Move: ${describe(booking)}\n- To: ${newWhen} (UK time)\n- Email the client: ${notify ? "yes" : "no"}` +
        (override ? "\n- Even if the calendar shows that time as not free" : "") +
        "\nOnly after they clearly say yes, call reschedule_booking again with confirmed true. That proposes it: an admin then approves it in Portal → Approvals.",
    };
  }

  // Acuity makes the change as staff once approved (admin=true), so the time is checked here
  // first, like a client rescheduling would be, unless staff asked to override
  if (!override && booking.appointmentTypeID) {
    let free;
    try {
      free = (await availableTimes(env, { typeId: booking.appointmentTypeID, date })).some((t) => t.start === start.toISOString());
    } catch (err) {
      return { ok: false, message: `Not proposed: ${acuityFailure(err).body.error} Tell staff to try again in a minute.` };
    }
    if (!free) return { ok: false, message: `Not moved: ${newWhen} isn't free in the calendar. Tell staff; they can pick another time, or ask you to override it.` };
  }
  return propose(env, "reschedule", { appointmentId: booking.id, start: start.toISOString(), notifyClient: notify });
}

// ===== UPDATE DETAILS =====

async function updateBooking(env, input) {
  const booking = await getBooking(env, input?.appointment_id);
  if (booking.problem) return { ok: false, message: booking.problem };

  // Only the fields Acuity lets us change, and only the ones given
  const changes = {};
  if (field(input?.first_name, 60)) changes.firstName = field(input.first_name, 60);
  if (field(input?.last_name, 60)) changes.lastName = field(input.last_name, 60);
  if (field(input?.email, 200)) changes.email = field(input.email, 200).toLowerCase();
  if (field(input?.phone, 40)) changes.phone = field(input.phone, 40);
  if (typeof input?.notes === "string") changes.notes = input.notes.slice(0, 2000);
  if (Object.keys(changes).length === 0) return { ok: false, message: "Nothing to change. Ask staff what should change." };

  const list = Object.entries(changes)
    .map(([key, value]) => `- ${key}: "${booking[key] || ""}" → "${value}"`)
    .join("\n");

  if (input?.confirmed !== true) {
    return {
      ok: true,
      message: `Not changed yet. Show staff this and ask them to confirm:\n- Booking: ${describe(booking)}\n${list}\nOnly after they clearly say yes, call update_booking again with confirmed true. That proposes it: an admin then approves it in Portal → Approvals.`,
    };
  }

  return propose(env, "update", { appointmentId: booking.id, ...changes });
}

// ===== SESSION TYPE, PRICE, PAID (via Nova Agent) =====

async function changeExtras(env, input) {
  if (!env.AGENT_NOVA_KEY) {
    return { ok: false, message: "Nova Agent isn't connected (no AGENT_NOVA_KEY), so this can't be changed from here. Tell staff to change it in Acuity." };
  }
  const booking = await getBooking(env, input?.appointment_id);
  if (booking.problem) return { ok: false, message: booking.problem };

  // Only what changes, tidied
  const changes = {};
  if (field(input?.session_type, 150)) changes.type = field(input.session_type, 150);
  if (input?.price !== undefined) {
    const price = String(input.price).replace(/[£\s,]/g, "");
    if (!/^\d{1,5}(\.\d{1,2})?$/.test(price)) return { ok: false, message: "That price doesn't look right. Ask staff for the amount in pounds, e.g. 80.00." };
    changes.price = Number(price).toFixed(2);
  }
  if (typeof input?.paid === "boolean") changes.paid = input.paid;
  if (Object.keys(changes).length === 0) return { ok: false, message: "Nothing to change. Ask staff what should change." };

  const list = [
    changes.type ? `- Session type: "${booking.type}" → "${changes.type}"` : "",
    changes.price ? `- Price: £${booking.price || "?"} → £${changes.price}` : "",
    "paid" in changes ? `- Paid: ${changes.paid ? "yes" : "no"}` : "",
  ]
    .filter(Boolean)
    .join("\n");
  const offline = await agentNovaProblem(env);

  if (input?.confirmed !== true) {
    return {
      ok: true,
      message:
        `Not changed yet. Show staff this and ask them to confirm:\n- Booking: ${describe(booking)}\n${list}\n` +
        "Nova Agent makes this change in Acuity a few minutes after it's confirmed, and staff phones get a notification when it's done." +
        (offline ? ` Warn staff: ${offline}` : "") +
        "\nOnly after they clearly say yes, call change_booking_extras again with confirmed true.",
    };
  }

  const summary = `${booking.firstName} ${booking.lastName}, ${describe(booking).split(", ")[0].replace(/^#\d+: /, "")}:\n${list}`;
  const job = await queueAgentJob(env, { appointmentId: booking.id, clientName: `${booking.firstName} ${booking.lastName}`, changes, summary });
  return {
    ok: true,
    message:
      `Queued for Nova Agent (job #${job}). Tell staff it'll be done in Acuity within a few minutes and their phones will get a notification when it is. Don't say it's done yet.` +
      (offline ? ` Also warn them: ${offline}` : ""),
  };
}

// ===== HELPERS =====

// Call Acuity's API (through src/acuity/api.js: retries when it's busy or briefly down).
// Returns { ok, status, data }, never throws: Acuity down, busy or not set up is
// { ok: false, status: 0, data: {}, error }.
export async function acuity(env, method, path, body) {
  try {
    return await acuityRequest(env, method, path, body);
  } catch (err) {
    return { ok: false, status: 0, data: {}, error: acuityFailure(err).body.error };
  }
}

// Look up one booking by ID, checking it's real and not already cancelled
async function getBooking(env, id) {
  if (!Number.isInteger(id) || id <= 0) return { problem: "That isn't a booking ID. Use find_bookings to find the booking first." };
  const { ok, data } = await acuity(env, "GET", `/appointments/${id}`);
  if (!ok || data?.id !== id) return { problem: `Couldn't find booking ${id} in Acuity. Use find_bookings to find it again.` };
  if (data.canceled) return { problem: `That booking (${describe(data)}) is already cancelled.` };
  return data;
}

// "#1783087429: Saturday 31 October 17:00–21:00, Dana Hollis, Rap Package…, email…, phone…, paid…"
function describe(b) {
  const date = String(b.datetime || "").slice(0, 10);
  const start = String(b.datetime || "").slice(11, 16);
  const end = to24Hour(b.endTime);
  const parts = [
    `#${b.id}: ${date ? dayInWords(date) : b.date} ${start}${end ? "–" + end : ""}`,
    `${b.firstName} ${b.lastName}`.trim(),
    b.type,
    b.email ? `email ${b.email}` : "",
    b.phone ? `phone ${b.phone}` : "",
    b.paid === "yes" ? "paid" : b.amountPaid && Number(b.amountPaid) > 0 ? `£${b.amountPaid} paid` : "not paid",
    b.notes ? `notes: "${String(b.notes).slice(0, 100)}"` : "",
  ];
  return parts.filter(Boolean).join(", ");
}

// Acuity's "9:00pm" -> "21:00"
function to24Hour(value) {
  return value ? normaliseTime(String(value).replace(/\s/g, "")) : "";
}

function filtersInWords(input) {
  const bits = [input?.name && `name "${input.name}"`, input?.email && `email "${input.email}"`, input?.phone && `phone ${input.phone}`].filter(Boolean);
  return bits.length ? `, ${bits.join(", ")}` : "";
}

function field(value, max) {
  return typeof value === "string" ? value.trim().slice(0, max) : "";
}

function lower(value) {
  return typeof value === "string" ? value.trim().toLowerCase() : "";
}

function digits(value) {
  return String(value || "").replace(/\D/g, "");
}

function isDate(value) {
  return typeof value === "string" && /^\d{4}-\d{2}-\d{2}$/.test(value);
}

function addDays(ymd, n) {
  const d = new Date(ymd + "T00:00:00Z");
  d.setUTCDate(d.getUTCDate() + n);
  return d.toISOString().slice(0, 10);
}

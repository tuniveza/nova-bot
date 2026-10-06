// "Nova, what time is Eric ShortSaw's session?": questions about the studio's
// own bookings, enquiries and alerts, answered in Nova Hub (staff only).
//
//   POST /app/api/ask   { question, history }  ->  { answer }
//
// Like asking a receptionist who has the diary, the enquiries folder and the
// message pad in front of them: each question is sent to Claude together with
// the latest bookings (Acuity's calendar feed), enquiries and alerts.

// The latest bookings from Acuity's calendar feed
import { listBookings } from "./booking-calendar.js";
// With the switch on Nova Bot's own booking system, the diary is the studio's Google Calendar
import { usesNova } from "./mode.js";
import { listBookings as novaListBookings } from "./nova/booking-calendar.js";

// How many enquiries and alerts to include, and how much of each message
const MAX_ENQUIRIES = 40;
const MAX_ALERTS = 30;
const MAX_DETAILS = 300;

// What Nova is told about its job
const INSTRUCTIONS = `You are Nova, the assistant inside Nova Hub, the staff app for Novacane Studios (a recording studio in Forest Hill, London).
Staff ask you about the studio's own bookings, enquiries and alerts. Answer using only the data below.
- Be brief and natural: your answer may be read aloud. One to three short sentences, no lists or markdown unless asked for a list.
- Times are UK time. Say days like "Thursday 22 October" and times like "2:15pm".
- Match names loosely (people may say a first name only, or speech-to-text may spell it slightly wrong). If more than one person could match, say so.
- If the answer isn't in the data, say you can't see it in Nova Hub. Never make up bookings, times or contact details.
- BOOKINGS are the current Acuity diary (cancelled bookings aren't in it; recent cancellations and moves are in ALERTS).`;

// Answer one question
export async function askHub(request, env) {
  // The question, and the conversation so far (for follow-ups like "and his phone number?")
  let body = {};
  try {
    body = await request.json();
  } catch {}
  // The question, tidied and not too long
  const question = String(body.question || "").trim().slice(0, 500);
  // Nothing asked
  if (!question) return Response.json({ error: "No question" }, { status: 400 });
  // The last few questions and answers (text only)
  const history = (Array.isArray(body.history) ? body.history : [])
    .filter((m) => (m.role === "user" || m.role === "assistant") && typeof m.content === "string")
    .slice(-6)
    .map((m) => ({ role: m.role, content: m.content.slice(0, 1000) }));
  // The conversation must start with a question
  while (history.length && history[0].role !== "user") history.shift();
  // Sandbox without an AI key: a labelled stand-in answer
  if (!env.ANTHROPIC_API_KEY) return Response.json({ answer: `🧪 Sandbox: Nova isn't connected to an AI, so it can't answer "${question.slice(0, 120)}".` });
  // Everything Nova knows, as text
  const data = await snapshot(env);
  // Ask Claude
  const res = await fetch("https://api.anthropic.com/v1/messages", {
    // Sending a question
    method: "POST",
    // Our key and the API version
    headers: { "x-api-key": env.ANTHROPIC_API_KEY, "anthropic-version": "2023-06-01", "content-type": "application/json" },
    // The instructions, the data, and the conversation
    body: JSON.stringify({
      model: "claude-haiku-4-5",
      max_tokens: 400,
      system: [{ type: "text", text: INSTRUCTIONS }, { type: "text", text: data }],
      messages: [...history, { role: "user", content: question }],
    }),
  });
  // Claude didn't answer
  if (!res.ok) {
    // Note why in the logs
    console.log("Nova Hub question failed:", res.status, await res.text());
    // Tell the app
    return Response.json({ error: "Nova couldn't answer just now. Try again." }, { status: 502 });
  }
  // The answer's text
  const answer = (await res.json()).content
    .filter((part) => part.type === "text")
    .map((part) => part.text)
    .join("")
    .trim();
  // Hand it back
  return Response.json({ answer: answer || "Sorry, I don't have an answer for that." });
}

// The bookings, enquiries and alerts, written out as text for Claude
async function snapshot(env) {
  // Today, in UK time
  const today = new Date().toLocaleString("en-GB", { timeZone: "Europe/London", weekday: "long", day: "numeric", month: "long", year: "numeric", hour: "2-digit", minute: "2-digit" });
  // The parts of the text
  const parts = [`NOW: ${today} (UK time).`];

  // Bookings from Acuity's calendar feed (from a week ago onwards)
  try {
    // Read the diary (Acuity's, or the studio's Google Calendar with the switch on Nova)
    const nova = await usesNova(env);
    const bookings = nova ? await novaListBookings(env) : await listBookings(env);
    // Not set up
    if (!bookings) parts.push(nova ? "BOOKINGS: not available (Google Calendar isn't connected yet)." : "BOOKINGS: not available (the Acuity calendar feed isn't set up).");
    // One line per booking
    else {
      // A week ago, in the feed's date format ("20261022T131500Z")
      const weekAgo = new Date(Date.now() - 7 * 86400000).toISOString().replace(/[-:]/g, "").slice(0, 15);
      // Recent and upcoming bookings
      const lines = bookings
        .filter((b) => !b.start || b.start >= weekAgo)
        .map((b) => "- " + [b.when, b.session, b.name, b.phone && "phone " + b.phone, b.email && "email " + b.email, b.price && "price " + b.price, ...(b.extra || []).map(([l, v]) => l + ": " + v)].filter(Boolean).join(" | "));
      // Add them
      parts.push(`BOOKINGS (${nova ? "studio diary in Google Calendar" : "Acuity diary"}, soonest first):\n` + (lines.join("\n") || "none"));
    }
  } catch (err) {
    // The feed couldn't be read
    console.log("Nova Hub question: couldn't read bookings:", err);
    parts.push("BOOKINGS: couldn't be read just now.");
  }

  // Recent enquiries from NovaBot
  const { results: enquiries } = await env.DB.prepare(
    "SELECT created_at, name, email, phone, subject, details, status FROM enquiries ORDER BY id DESC LIMIT ?"
  )
    .bind(MAX_ENQUIRIES)
    .all();
  // One line per enquiry
  parts.push(
    "ENQUIRIES (newest first):\n" +
      (enquiries
        .map((q) => "- " + [q.created_at.slice(0, 16).replace("T", " "), q.status === "done" ? "done" : "new", q.name, q.email, q.phone, q.subject, String(q.details).slice(0, MAX_DETAILS).replace(/\s+/g, " ")].filter(Boolean).join(" | "))
        .join("\n") || "none")
  );

  // Recent alerts (notifications that reached a phone)
  const { results: alerts } = await env.DB.prepare("SELECT created_at, title, body FROM notifications ORDER BY id DESC LIMIT ?").bind(MAX_ALERTS).all();
  // One line per alert
  parts.push(
    "ALERTS (newest first):\n" +
      (alerts.map((a) => "- " + a.created_at.slice(0, 16).replace("T", " ") + " | " + a.title + " | " + a.body.replace(/\n/g, " · ")).join("\n") || "none")
  );

  // All together
  return parts.join("\n\n");
}

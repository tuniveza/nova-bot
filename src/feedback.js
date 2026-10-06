// Feedback about NovaBot, from the chat's Feedback button: a quick thumbs up
// or down, and what they think, typed or spoken (spoken feedback is turned
// into text by /listen first). Saved with the last few messages of the chat,
// so the team can see what it was about, and listed at /admin/feedback.
//
//   POST /feedback  { chatId, page, rating: "good" | "bad" | "", message, spoken, recent: [{ role, content }] }
//                   -> { ok, message }

const RATINGS = ["good", "bad", ""];
const RECENT_MESSAGES = 12;

// Save one piece of feedback (already checked to come from the website and not too often, see index.js)
export async function handleFeedback(request, env) {
  let body = {};
  try {
    body = await request.json();
  } catch {
    return { status: 400, data: { ok: false, message: "Sorry, that didn't send. Please try again." } };
  }
  const rating = RATINGS.includes(body.rating) ? body.rating : "";
  const message = typeof body.message === "string" ? body.message.trim().slice(0, 3000) : "";
  if (!message && !rating) return { status: 400, data: { ok: false, message: "Say or type what you think first." } };

  const chatId = /^[A-Za-z0-9-]{8,64}$/.test(body.chatId || "") ? body.chatId : null;
  const page = typeof body.page === "string" ? body.page.slice(0, 200) : null;
  // The last few messages, tidied (only who said it and what, cut short)
  const recent = (Array.isArray(body.recent) ? body.recent : [])
    .filter((m) => (m?.role === "user" || m?.role === "assistant") && typeof m.content === "string")
    .slice(-RECENT_MESSAGES)
    .map((m) => ({ role: m.role, content: m.content.slice(0, 600) }));

  await env.DB.prepare("INSERT INTO feedback (created_at, chat_id, page, rating, message, spoken, recent) VALUES (?, ?, ?, ?, ?, ?, ?)")
    .bind(new Date().toISOString(), chatId, page, rating, message, body.spoken ? 1 : 0, recent.length ? JSON.stringify(recent) : null)
    .run();
  return { status: 200, data: { ok: true, message: "That really helps make NovaBot better." } };
}

// The admin page's list: newest first
export async function recentFeedback(env, { rating = "", limit = 200 } = {}) {
  const where = RATINGS.includes(rating) && rating ? "WHERE rating = ?" : "";
  const query = env.DB.prepare(`SELECT * FROM feedback ${where} ORDER BY id DESC LIMIT ?`);
  const { results } = await (where ? query.bind(rating, limit) : query.bind(limit)).all();
  return results.map((row) => ({ ...row, recent: row.recent ? JSON.parse(row.recent) : [] }));
}

// How many there are of each, for the tabs
export async function feedbackCounts(env) {
  const { results } = await env.DB.prepare("SELECT rating, COUNT(*) AS count FROM feedback GROUP BY rating").all();
  const counts = { all: 0, good: 0, bad: 0 };
  for (const row of results) {
    counts.all += row.count;
    if (row.rating === "good" || row.rating === "bad") counts[row.rating] = row.count;
  }
  return counts;
}

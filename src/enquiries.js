// Enquiries NovaBot sends to the Novacane team, and the chat log
//
// When a visitor confirms their details in the chat, Claude calls the
// send_enquiry tool. The enquiry is saved (see /admin/enquiries) and, if the
// email secrets are set, emailed to the studio too (see README-ENQUIRIES.md).
//
// Every chat message is also saved for 90 days (see /admin/conversations).

// Sends Nova Hub notifications to staff phones
import { notifyPhones } from "./push.js";

// How many enquiries one visitor can send in 24 hours (stops spam)
const MAX_ENQUIRIES_PER_DAY = 5;

// How long conversations are kept
const KEEP_CHATS_DAYS = 90;

// The tool Claude uses to send an enquiry
export const ENQUIRY_TOOL = {
  name: "send_enquiry",
  description:
    "Send the customer's enquiry to the Novacane team, who reply by email. Only use this after the customer has seen a summary of the details and clearly confirmed they want it sent.",
  input_schema: {
    type: "object",
    properties: {
      name: { type: "string", description: "The customer's name" },
      email: { type: "string", description: "The customer's email address, for the team's reply" },
      phone: { type: "string", description: "The customer's phone number, if they gave one" },
      subject: { type: "string", description: "A short subject line, e.g. 'Album recording, 6 tracks'" },
      details: {
        type: "string",
        description:
          "Everything useful for the team, written for them: type of project, service wanted, approximate duration, preferred dates, number of people, equipment needs, links, and anything else the customer said that matters.",
      },
    },
    required: ["name", "email", "details"],
  },
};

const EMAIL_PATTERN = /^[^\s@<>"]+@[^\s@<>"]+\.[^\s@<>"]{2,}$/;

// Tidy one field: text only, trimmed and capped
function field(value, max) {
  return typeof value === "string" ? value.replace(/\s+\n/g, "\n").trim().slice(0, max) : "";
}

// Hash the visitor's IP address, so spam can be limited without storing it
export async function senderId(ip) {
  const bytes = new Uint8Array(await crypto.subtle.digest("SHA-256", new TextEncoder().encode("novacane:" + ip)));
  return [...bytes.slice(0, 12)].map((b) => b.toString(16).padStart(2, "0")).join("");
}

// Save an enquiry from the send_enquiry tool. Returns what to tell Claude.
export async function sendEnquiry(env, input, { chatId, page, ip }, waitUntil) {
  const enquiry = {
    name: field(input?.name, 100),
    email: field(input?.email, 200).toLowerCase(),
    phone: field(input?.phone, 40),
    subject: field(input?.subject, 150),
    details: field(input?.details, 4000),
  };

  if (!enquiry.name) return { sent: false, message: "Not sent: the customer's name is missing. Ask for it." };
  if (!EMAIL_PATTERN.test(enquiry.email)) {
    return { sent: false, message: "Not sent: that email address doesn't look right. Ask the customer to check it." };
  }
  if (enquiry.details.length < 10) {
    return { sent: false, message: "Not sent: there aren't enough details about the project yet. Ask what it's about." };
  }

  const now = new Date();
  const dayAgo = new Date(now.getTime() - 24 * 60 * 60 * 1000).toISOString();
  const sender = await senderId(ip || "unknown");

  // The same enquiry twice (e.g. the customer said yes twice): don't save it again
  const duplicate = await env.DB.prepare(
    "SELECT id FROM enquiries WHERE email = ? AND details = ? AND created_at > ?"
  )
    .bind(enquiry.email, enquiry.details, dayAgo)
    .first();
  if (duplicate) return { sent: true, message: "Already sent: this enquiry reached the team earlier. Don't send it again." };

  const { count } = await env.DB.prepare("SELECT COUNT(*) AS count FROM enquiries WHERE sender = ? AND created_at > ?")
    .bind(sender, dayAgo)
    .first();
  if (count >= MAX_ENQUIRIES_PER_DAY) {
    return {
      sent: false,
      message: "Not sent: too many enquiries from this visitor today. Apologise and give them the enquiry form link instead.",
    };
  }

  const { meta } = await env.DB.prepare(
    `INSERT INTO enquiries (created_at, name, email, phone, subject, details, page, chat_id, sender)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`
  )
    .bind(
      now.toISOString(),
      enquiry.name,
      enquiry.email,
      enquiry.phone || null,
      enquiry.subject || null,
      enquiry.details,
      page || null,
      chatId || null,
      sender
    )
    .run();

  waitUntil(emailTeam(env, { id: meta.last_row_id, ...enquiry, page }));
  // Ping staff phones with everything in the enquiry
  waitUntil(
    notifyPhones(env, {
      // "New enquiry: Jordan Test"
      title: "New enquiry: " + enquiry.name,
      // What it's about, how to reach them, then their message (leaving out anything missing)
      body: [enquiry.subject, enquiry.phone && "Phone: " + enquiry.phone, "Email: " + enquiry.email, enquiry.details].filter(Boolean).join("\n"),
      // Tapping it opens Nova Hub
      url: "/app/",
      // Which enquiry it is, for the Alerts tab
      enquiryId: meta.last_row_id,
    })
  );
  return { sent: true, message: "Sent: the enquiry is with the Novacane team, who will reply by email." };
}

// Email a copy of the enquiry to the studio, if it's set up (Resend)
async function emailTeam(env, enquiry) {
  if (!emailIsSetUp(env)) return;
  const lines = [
    `New enquiry from NovaBot (#${enquiry.id})`,
    "",
    `Name: ${enquiry.name}`,
    `Email: ${enquiry.email}`,
    enquiry.phone ? `Phone: ${enquiry.phone}` : null,
    enquiry.subject ? `Subject: ${enquiry.subject}` : null,
    enquiry.page ? `Sent from: ${enquiry.page}` : null,
    "",
    enquiry.details,
    "",
    "Reply to this email to answer them directly.",
  ].filter((line) => line !== null);
  const result = await sendEmail(env, {
    subject: `NovaBot enquiry: ${enquiry.subject || enquiry.name}`,
    text: lines.join("\n"),
    replyTo: enquiry.email,
  });
  if (result.ok) await env.DB.prepare("UPDATE enquiries SET emailed = 1 WHERE id = ?").bind(enquiry.id).run();
  else console.log("Enquiry email failed:", result.message);
}

export function emailIsSetUp(env) {
  return Boolean(env.RESEND_API_KEY && env.ENQUIRY_EMAIL_TO);
}

export function emailRecipients(env) {
  return String(env.ENQUIRY_EMAIL_TO || "")
    .split(",")
    .map((to) => to.trim())
    .filter(Boolean);
}

// For the "Send a test email" button on the admin page
export async function sendTestEmail(env) {
  if (!emailIsSetUp(env)) {
    return { ok: false, message: "Email copies aren't set up yet: add the RESEND_API_KEY and ENQUIRY_EMAIL_TO secrets (see README-ENQUIRIES.md)." };
  }
  const result = await sendEmail(env, {
    subject: "NovaBot test email",
    text: "This is a test from the Novacane admin page. If you're reading this, enquiry emails are working.",
  });
  return result.ok ? { ok: true, message: `Test email sent to ${emailRecipients(env).join(", ")}. Check the inbox (and spam folder).` } : result;
}

// Send an email through Resend
async function sendEmail(env, { subject, text, replyTo }) {
  try {
    const res = await fetch("https://api.resend.com/emails", {
      method: "POST",
      headers: { Authorization: `Bearer ${env.RESEND_API_KEY.trim()}`, "Content-Type": "application/json" },
      body: JSON.stringify({
        from: env.ENQUIRY_EMAIL_FROM || "NovaBot <onboarding@resend.dev>",
        to: emailRecipients(env),
        ...(replyTo ? { reply_to: replyTo } : {}),
        subject,
        text,
      }),
    });
    if (res.ok) return { ok: true };
    // Resend explains what's wrong (e.g. sending to an address it doesn't allow yet)
    let reason = `error ${res.status}`;
    try {
      reason = (await res.json()).message || reason;
    } catch {}
    return { ok: false, message: `Resend didn't send it: ${reason}` };
  } catch (err) {
    return { ok: false, message: "Couldn't reach Resend: " + err.message };
  }
}

// ===== CHAT LOG =====

// Save the visitor's message and NovaBot's reply
export async function logChat(env, { chatId, page, question, answer }) {
  if (!chatId || !env.DB) return;
  try {
    const now = new Date().toISOString();
    const insert = env.DB.prepare(
      "INSERT INTO chat_messages (chat_id, created_at, role, content, page) VALUES (?, ?, ?, ?, ?)"
    );
    await env.DB.batch([
      insert.bind(chatId, now, "user", question, page || null),
      insert.bind(chatId, now, "assistant", answer, page || null),
    ]);
    // Now and then, clear out old conversations
    if (Math.random() < 0.05) {
      const cutoff = new Date(Date.now() - KEEP_CHATS_DAYS * 24 * 60 * 60 * 1000).toISOString();
      await env.DB.prepare("DELETE FROM chat_messages WHERE created_at < ?").bind(cutoff).run();
    }
  } catch (err) {
    console.log("Chat log failed:", err);
  }
}

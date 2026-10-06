// The emails customers get about their booking, sent through the studio's Gmail
// (google.js). Each one is plain text plus a Novacane-styled HTML version, and the
// ones that change the booking carry a calendar file (.ics) so it lands in, moves
// in, or leaves the customer's own calendar.
//
//   confirmation     booked (deposit paid, or with a link to pay it)
//   payment-request  a link to pay the deposit or balance
//   receipt          a payment came through
//   moved            new day or time
//   cancelled        cancelled, and what happens to the money
//   reminder         the day before

import { sendEmail } from "./google.js";
import { publicUrl } from "./booking.js";
import { CANCEL_NOTICE_HOURS, STUDIO, money, whenInWords } from "./studio.js";

// What's paid and what's left, for a booking row
export function moneyState(b) {
  const net = b.paid_pence - b.refunded_pence;
  return {
    net,
    depositDue: Math.max(0, b.deposit_pence - net),
    balanceDue: Math.max(0, b.price_pence - net),
  };
}

export const manageLink = (env, b) => `${publicUrl(env)}/booking/${b.token}`;
export const payLink = (env, b, purpose) => `${publicUrl(env)}/pay/${b.token}${purpose ? `?for=${purpose}` : ""}`;

// Build one email. `extra` carries what's particular to it (amount, old time, refund wording…).
export function buildEmail(env, kind, b, extra = {}) {
  const when = whenInWords(b.starts_at, b.ends_at);
  const first = b.first_name || "there";
  const { depositDue, balanceDue, net } = moneyState(b);
  const manage = manageLink(env, b);
  const details = [
    ["Session", b.session],
    ["When", `${when} (UK time)`],
    ["Booking", `#${b.id}`],
    ["Price", money(b.price_pence)],
    ["Paid", net > 0 ? money(net) : "nothing yet"],
  ];

  let subject, intro, button, after = [], ics = null;
  switch (kind) {
    case "confirmation":
      subject = `You're booked in: ${shortDay(b.starts_at)} at Novacane`;
      intro = [`Hi ${first}, you're booked in at ${STUDIO.name}. Here are the details.`];
      if (depositDue > 0) {
        intro.push(`Your ${money(depositDue)} deposit secures the session. Please pay it soon: the time is yours once it's paid.`);
        button = ["Pay the deposit", payLink(env, b, "deposit")];
      } else if (balanceDue > 0) {
        after.push(`The remaining ${money(balanceDue)} is due on arrival, before the session starts. You can also pay it online from your booking page.`);
        button = ["View your booking", manage];
      } else {
        after.push("It's fully paid. See you at the studio.");
        button = ["View your booking", manage];
      }
      ics = calendarFile(env, b, "CONFIRMED");
      break;
    case "payment-request": {
      const purpose = extra.purpose || (depositDue > 0 ? "deposit" : "balance");
      const amount = purpose === "deposit" ? depositDue : balanceDue;
      subject = `${purpose === "deposit" ? "Pay your deposit" : "Pay your balance"}: ${money(amount)} for ${shortDay(b.starts_at)}`;
      intro = [
        `Hi ${first}, here's a secure link to pay the ${purpose} for your session at ${STUDIO.name}: ${money(amount)}.`,
        ...(purpose === "deposit" ? ["The deposit secures your booking."] : []),
      ];
      button = [`Pay ${money(amount)}`, payLink(env, b, purpose)];
      break;
    }
    case "receipt":
      subject = `Payment received: ${money(extra.amount)} for booking #${b.id}`;
      intro = [`Hi ${first}, thanks: we've received ${money(extra.amount)} for your session.`];
      after.push(balanceDue > 0 ? `${money(balanceDue)} is still to pay, due on arrival.` : "It's fully paid now.");
      button = ["View your booking", manage];
      break;
    case "moved":
      subject = `Your session has moved: now ${shortDay(b.starts_at)}`;
      intro = [`Hi ${first}, your session at ${STUDIO.name} has moved.`, ...(extra.was ? [`It was: ${extra.was}.`] : [])];
      button = ["View your booking", manage];
      ics = calendarFile(env, b, "CONFIRMED");
      break;
    case "cancelled":
      subject = `Cancelled: your session on ${shortDay(b.starts_at)}`;
      intro = [`Hi ${first}, your session at ${STUDIO.name} has been cancelled.`, ...(extra.note ? [extra.note] : [])];
      if (extra.money) after.push(extra.money);
      after.push(`To book again: ${publicUrl(env)}/book`);
      ics = calendarFile(env, b, "CANCELLED");
      break;
    case "reminder":
      subject = `See you tomorrow: ${shortTime(b.starts_at)} at Novacane`;
      intro = [`Hi ${first}, a reminder that your session at ${STUDIO.name} is tomorrow.`];
      after.push(balanceDue > 0 ? `${money(balanceDue)} is due on arrival, before the session starts.` : "It's fully paid.");
      after.push("Late arrival comes out of the booked time, so give yourself a few minutes.");
      button = ["View your booking", manage];
      break;
    default:
      throw new Error("Unknown email: " + kind);
  }

  const policy = kind === "cancelled" || kind === "receipt"
    ? ""
    : `Need to move or cancel? Use your booking page. Cancelling with less than ${CANCEL_NOTICE_HOURS} hours' notice loses the deposit.`;
  const contact = `Questions? Reply to this email or WhatsApp ${STUDIO.whatsapp}.`;

  const text = [
    ...intro,
    "",
    ...(kind === "cancelled" ? [] : details.map(([k, v]) => `${k}: ${v}`)),
    "",
    ...(button ? [`${button[0]}: ${button[1]}`, ""] : []),
    ...after,
    ...(policy ? ["", policy] : []),
    "",
    contact,
    "",
    STUDIO.name,
    STUDIO.website,
  ].join("\n");

  const html = page({
    title: subject,
    intro,
    rows: kind === "cancelled" ? [] : details,
    button,
    after,
    small: [policy, contact].filter(Boolean),
  });

  return { subject, text, html, attachments: ics ? [{ filename: "novacane-session.ics", type: `text/calendar; charset=UTF-8; method=${ics.method}`, content: ics.content }] : [] };
}

// Send one, keep a note of it in the outbox, never throw. Returns true if Gmail took it.
export async function sendBookingEmail(env, kind, b, extra = {}) {
  let sent = false, error = null, gmailId = null, subject = kind;
  try {
    const email = buildEmail(env, kind, b, extra);
    subject = email.subject;
    gmailId = await sendEmail(env, { to: b.email, subject: email.subject, text: email.text, html: email.html, attachments: email.attachments, replyTo: extra.replyTo });
    sent = true;
  } catch (err) {
    error = String(err?.message || err).slice(0, 300);
    console.log(`Couldn't send the ${kind} email for booking #${b.id}:`, error);
  }
  try {
    await env.DB.prepare("INSERT INTO outbox (booking_id, kind, to_email, subject, sent, error, gmail_id, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)")
      .bind(b.id, kind, b.email, subject, sent ? 1 : 0, error, gmailId, new Date().toISOString())
      .run();
  } catch (err) {
    console.log("Couldn't note the email in the outbox:", err);
  }
  return sent;
}

// ===== CALENDAR FILE =====

// An iCalendar file for the customer's own calendar. The same UID every time, so
// a move updates it and a cancellation removes it.
export function calendarFile(env, b, status) {
  const stamp = (iso) => new Date(iso).toISOString().replace(/[-:]/g, "").replace(/\.\d{3}/, "");
  const esc = (s) => String(s || "").replace(/[\\;,]/g, (c) => "\\" + c).replace(/\r?\n/g, "\\n");
  const method = status === "CANCELLED" ? "CANCEL" : "PUBLISH";
  const lines = [
    "BEGIN:VCALENDAR",
    "VERSION:2.0",
    "PRODID:-//Novacane Studios//Nova Bot//EN",
    `METHOD:${method}`,
    "BEGIN:VEVENT",
    `UID:nova-booking-${b.id}@novacane.co.uk`,
    `SEQUENCE:${Math.floor(Date.parse(b.updated_at || b.created_at) / 1000)}`,
    `DTSTAMP:${stamp(new Date().toISOString())}`,
    `DTSTART:${stamp(b.starts_at)}`,
    `DTEND:${stamp(b.ends_at)}`,
    `SUMMARY:${esc(`${b.session} at Novacane`)}`,
    `LOCATION:${esc(STUDIO.address)}`,
    `DESCRIPTION:${esc(`Booking #${b.id}. Manage it: ${manageLink(env, b)}`)}`,
    `URL:${manageLink(env, b)}`,
    `STATUS:${status}`,
    "END:VEVENT",
    "END:VCALENDAR",
    "",
  ];
  return { method, content: lines.map(fold).join("\r\n") };
}

// iCalendar lines are folded at 75 characters
function fold(line) {
  if (line.length <= 75) return line;
  const parts = [];
  for (let i = 0; i < line.length; i += i === 0 ? 75 : 74) parts.push((i === 0 ? "" : " ") + line.slice(i, i === 0 ? 75 : i + 74));
  return parts.join("\r\n");
}

// ===== LOOK =====

const shortDay = (iso) =>
  new Date(iso).toLocaleDateString("en-GB", { timeZone: "Europe/London", weekday: "short", day: "numeric", month: "short" }).replace(/,/g, "");
const shortTime = (iso) => new Date(iso).toLocaleTimeString("en-GB", { timeZone: "Europe/London", hour: "2-digit", minute: "2-digit" });

const h = (s) => String(s ?? "").replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c]);

// Email-safe HTML: tables and inline styles only, dark Novacane look with a light fallback
function page({ title, intro, rows, button, after, small }) {
  const p = (t) => `<p style="margin:0 0 14px;font-size:16px;line-height:1.55;color:#ead6e6">${h(t)}</p>`;
  return `<!DOCTYPE html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><meta name="color-scheme" content="dark light"><title>${h(title)}</title></head>
<body style="margin:0;padding:0;background:#100816">
<table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="background:#100816;padding:24px 12px">
<tr><td align="center">
<table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="max-width:560px;background:#1c1129;border-radius:24px;overflow:hidden;font-family:Saira,Jost,Arial,sans-serif">
<tr><td style="padding:28px 28px 18px;background:linear-gradient(120deg,#b01d68,#7a1f86 60%,#25194d)">
<div style="font-size:11px;letter-spacing:4px;text-transform:uppercase;color:#ffd1ea">Novacane Studios</div>
<div style="font-family:Archivo,'Arial Black',Arial,sans-serif;font-weight:900;font-size:24px;line-height:1.15;color:#ffffff;text-transform:uppercase;margin-top:6px">${h(title)}</div>
</td></tr>
<tr><td style="padding:24px 28px 8px">
${intro.map(p).join("")}
${rows.length ? `<table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="margin:6px 0 18px;border-collapse:collapse">${rows
    .map(([k, v]) => `<tr><td style="padding:8px 0;border-bottom:1px solid #3a2550;font-size:12px;letter-spacing:2px;text-transform:uppercase;color:#c4a6c1;width:34%;vertical-align:top">${h(k)}</td><td style="padding:8px 0;border-bottom:1px solid #3a2550;font-size:15px;color:#ffffff">${h(v)}</td></tr>`)
    .join("")}</table>` : ""}
${button ? `<table role="presentation" cellpadding="0" cellspacing="0" style="margin:4px 0 20px"><tr><td style="border-radius:16px 24px 32px 4px;background:#b01d68"><a href="${h(button[1])}" style="display:inline-block;padding:14px 24px;font-size:14px;font-weight:700;letter-spacing:1.5px;text-transform:uppercase;color:#ffffff;text-decoration:none">${h(button[0])}</a></td></tr></table>` : ""}
${after.map(p).join("")}
</td></tr>
<tr><td style="padding:8px 28px 26px">
${small.map((t) => `<p style="margin:0 0 8px;font-size:13px;line-height:1.5;color:#b997b5">${h(t)}</p>`).join("")}
<p style="margin:14px 0 0;font-size:12px;color:#8e7090"><a href="${h(STUDIO.website)}" style="color:#ff5fa8">${h(STUDIO.website.replace(/^https?:\/\//, ""))}</a></p>
</td></tr>
</table>
</td></tr>
</table>
</body></html>`;
}

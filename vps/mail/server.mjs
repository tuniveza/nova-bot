// Computer: the VPS's own mail service. Nova Bot hands single emails here exactly as it would to Resend
// (POST /emails with { from, to, reply_to, subject, text, html, headers }, Bearer key), and this
// gives them to Postfix on the same machine, which signs them (DKIM, selector "nova") and delivers
// them. Only on 127.0.0.1; only senders @novacane.co.uk; at most 50 recipients a message; a repeat
// of the same Idempotency-Key within a day gets the first answer back instead of a second email.
// Logs ids and counts only, never addresses or what an email says. No packages: Node and sendmail.
import http from "node:http";
import { spawn } from "node:child_process";
import { randomUUID } from "node:crypto";

const PORT = Number(process.env.MAIL_PORT || 8790);
const KEY = String(process.env.MAIL_KEY || "").trim();
const DOMAIN = String(process.env.MAIL_DOMAIN || "novacane.co.uk").toLowerCase();
const MAX_BODY = 25 * 1024 * 1024;
const MAX_TO = 50;
const DAY = 86400000;
const seen = new Map(); // idempotency key -> { at, answer }

const json = (res, status, body) => {
  res.writeHead(status, { "Content-Type": "application/json", "Cache-Control": "no-store" });
  res.end(JSON.stringify(body));
};

// "Name <a@b.c>" or "a@b.c" -> { name, address } (address lower-cased), or null
export function parseAddress(value) {
  const text = String(value || "").trim();
  const m = text.match(/^(?:"?([^"<]*?)"?\s*)?<([^<>\s@]+@[^<>\s@]+\.[^<>\s@]+)>$/) || text.match(/^()([^<>\s@]+@[^<>\s@]+\.[^<>\s@]+)$/);
  if (!m) return null;
  return { name: (m[1] || "").trim(), address: m[2].toLowerCase() };
}

// A header value with anything outside plain ASCII written the MIME way
const encodeWord = (s) => (/^[\x20-\x7e]*$/.test(s) ? s : `=?UTF-8?B?${Buffer.from(s, "utf8").toString("base64")}?=`);
const formatAddress = (a) => (a.name ? `${encodeWord(a.name.replace(/[\r\n"]/g, ""))} <${a.address}>` : a.address);
const noBreaks = (s) => String(s).replace(/[\r\n]+/g, " ");
const b64 = (s) => Buffer.from(String(s), "utf8").toString("base64").replace(/.{76}/g, "$&\r\n");

export function buildMessage({ from, to, replyTo, subject, text, html, headers = {}, messageId }) {
  const lines = [
    `From: ${formatAddress(from)}`,
    `To: ${to.map(formatAddress).join(", ")}`,
    ...(replyTo ? [`Reply-To: ${formatAddress(replyTo)}`] : []),
    `Subject: ${encodeWord(noBreaks(subject || ""))}`,
    `Date: ${new Date().toUTCString().replace("GMT", "+0000")}`,
    `Message-ID: ${messageId}`,
    "MIME-Version: 1.0",
  ];
  // Extra headers Nova Bot sends (List-Unsubscribe, In-Reply-To…), never ones that would change who it's from or to
  const blocked = /^(from|to|cc|bcc|subject|date|message-id|mime-version|content-type|content-transfer-encoding|reply-to|sender|return-path|dkim-signature|received)$/i;
  for (const [k, v] of Object.entries(headers || {})) {
    if (/^[A-Za-z0-9-]{1,60}$/.test(k) && !blocked.test(k)) lines.push(`${k}: ${noBreaks(v).slice(0, 900)}`);
  }
  const part = (type, body) => [`Content-Type: ${type}; charset=UTF-8`, "Content-Transfer-Encoding: base64", "", b64(body)].join("\r\n");
  if (html && text) {
    const boundary = `nova-${randomUUID()}`;
    lines.push(`Content-Type: multipart/alternative; boundary="${boundary}"`, "", `--${boundary}`, part("text/plain", text), `--${boundary}`, part("text/html", html), `--${boundary}--`, "");
  } else if (html) {
    lines.push(part("text/html", html).replace(/\r\n\r\n/, "\r\n\r\n"));
  } else {
    lines.push(part("text/plain", text || ""));
  }
  return lines.join("\r\n");
}

function sendmail(raw, envelopeFrom) {
  return new Promise((resolve, reject) => {
    const p = spawn("/usr/sbin/sendmail", ["-t", "-oi", "-f", envelopeFrom], { stdio: ["pipe", "ignore", "pipe"] });
    let err = "";
    p.stderr.on("data", (d) => (err += d).slice(0, 500));
    p.on("error", reject);
    p.on("close", (code) => (code === 0 ? resolve() : reject(new Error(err.trim() || `sendmail exited ${code}`))));
    p.stdin.end(raw);
  });
}

export async function handleEmail(body) {
  const from = parseAddress(body.from);
  if (!from) return [422, { message: "A from address is needed." }];
  if (!from.address.endsWith("@" + DOMAIN)) return [422, { message: `This mail server only sends from @${DOMAIN} addresses.` }];
  const toList = (Array.isArray(body.to) ? body.to : [body.to]).filter(Boolean);
  const to = toList.map(parseAddress);
  if (!to.length || to.some((a) => !a)) return [422, { message: "Every 'to' must be an email address." }];
  if (to.length > MAX_TO) return [422, { message: `At most ${MAX_TO} recipients.` }];
  const replyTo = body.reply_to ? parseAddress(Array.isArray(body.reply_to) ? body.reply_to[0] : body.reply_to) : null;
  if (!body.subject) return [422, { message: "A subject is needed." }];
  if (!body.text && !body.html) return [422, { message: "The email is empty." }];
  const id = randomUUID();
  const messageId = (body.headers && /^<[^<>\s]+@[^<>\s]+>$/.test(body.headers["Message-ID"] || "")) ? body.headers["Message-ID"] : `<nova-${id}@${DOMAIN}>`;
  const raw = buildMessage({ from, to, replyTo, subject: body.subject, text: body.text, html: body.html, headers: body.headers, messageId });
  await sendmail(raw, from.address);
  return [200, { id }];
}

function server() {
  return http.createServer(async (req, res) => {
    try {
      if (req.method === "GET" && req.url === "/health") return json(res, 200, { ok: true });
      if (req.method !== "POST" || req.url !== "/emails") return json(res, 404, { message: "Not found" });
      const auth = req.headers.authorization || "";
      if (!KEY || auth !== `Bearer ${KEY}`) return json(res, 401, { message: "Not allowed" });
      let size = 0;
      const chunks = [];
      for await (const c of req) {
        size += c.length;
        if (size > MAX_BODY) return json(res, 413, { message: "That email is too big." });
        chunks.push(c);
      }
      let body;
      try {
        body = JSON.parse(Buffer.concat(chunks).toString("utf8"));
      } catch {
        return json(res, 400, { message: "That isn't JSON." });
      }
      const idem = String(req.headers["idempotency-key"] || "").slice(0, 200);
      const now = Date.now();
      for (const [k, v] of seen) if (now - v.at > DAY) seen.delete(k);
      if (idem && seen.has(idem)) return json(res, 200, seen.get(idem).answer);
      const [status, answer] = await handleEmail(body);
      if (status === 200 && idem) seen.set(idem, { at: now, answer });
      console.log(status === 200 ? `sent ${answer.id} to ${(Array.isArray(body.to) ? body.to.length : 1)} recipient(s)` : `refused (${status})`);
      return json(res, status, answer);
    } catch (err) {
      console.log("mail error:", String(err.message || err).slice(0, 160).replace(/[^\s<>]+@[^\s<>]+/g, "…"));
      return json(res, 502, { message: "The mail server couldn't take it just now." });
    }
  });
}

if (process.argv[1] && import.meta.url === `file://${process.argv[1]}`) {
  if (!KEY) console.log("MAIL_KEY isn't set: every request will be refused");
  server().listen(PORT, "127.0.0.1", () => console.log(`Nova mail on 127.0.0.1:${PORT}`));
}

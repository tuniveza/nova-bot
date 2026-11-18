#!/usr/bin/env node
// The studio's Gmail, from the VPS itself (18 Nov 2026): the VPS company blocks the mail ports (25, 587,
// 465), so the Routes alerts and digests go through the Gmail API over HTTPS instead, with the same
// Google connection Nova Bot uses (Portal → Admin → Google). Its secrets stay sealed in Nova Bot's
// database (AES-GCM, key from AGENT_NOVA_KEY: src/nova/google-keys.js); this opens them the same way.
//
//   nova-gmail send <to> <subject>        (the text on stdin; a line "<html>…" at the start makes it HTML)
//   nova-gmail search '<gmail query>'     -> JSON lines: { id, date, to, subject, from }
//
// Never prints a secret or a token.
import { execFileSync } from "node:child_process";
import { readFileSync, writeFileSync } from "node:fs";
import { webcrypto as crypto } from "node:crypto";

const DB = "/srv/nova/state/v3/d1/miniflare-D1DatabaseObject/d90d47fba3bb21dba5b545a490babb5c3b96df40c9cb3acec2f427f2580d0c85.sqlite";
const CACHE = "/var/lib/nova/gmail-token.json";
const GMAIL = "https://gmail.googleapis.com/gmail/v1/users/me";

const setting = (key) => execFileSync("sqlite3", ["-readonly", DB, `SELECT value FROM settings WHERE key = '${key.replace(/'/g, "")}'`], { encoding: "utf8" }).trim();
const envValue = (file, name) => {
  const line = readFileSync(file, "utf8").split("\n").find((l) => l.startsWith(name + "="));
  return line ? line.slice(name.length + 1).trim().replace(/^"|"$/g, "") : "";
};

async function unseal(sealed, base) {
  const [v, iv, box] = String(sealed || "").split(".");
  if (v !== "v1") return "";
  const enc = new TextEncoder();
  const raw = await crypto.subtle.importKey("raw", enc.encode(base), "HKDF", false, ["deriveKey"]);
  const key = await crypto.subtle.deriveKey(
    { name: "HKDF", hash: "SHA-256", salt: enc.encode("nova-agent/google"), info: enc.encode("google-keys-v1") },
    raw, { name: "AES-GCM", length: 256 }, false, ["decrypt"]);
  const b = (t) => Uint8Array.from(Buffer.from(t, "base64"));
  return new TextDecoder().decode(await crypto.subtle.decrypt({ name: "AES-GCM", iv: b(iv) }, key, b(box)));
}

async function accessToken() {
  try {
    const c = JSON.parse(readFileSync(CACHE, "utf8"));
    if (c.until > Date.now() + 60_000) return c.token;
  } catch {}
  const base = envValue("/srv/nova/secrets.env", "AGENT_NOVA_KEY");
  const id = setting("google_client_id");
  const secret = await unseal(setting("google_client_secret_enc"), base);
  const refresh = await unseal(setting("google_refresh_token_enc"), base);
  if (!id || !secret || !refresh) throw new Error("The studio's Google connection can't be opened (Portal → Admin → Google)");
  const res = await fetch("https://oauth2.googleapis.com/token", {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({ client_id: id, client_secret: secret, refresh_token: refresh, grant_type: "refresh_token" }),
  });
  const data = await res.json();
  if (!res.ok || !data.access_token) throw new Error(`Google refused the token (${res.status} ${data.error || ""})`);
  writeFileSync(CACHE, JSON.stringify({ token: data.access_token, until: Date.now() + (data.expires_in || 3000) * 1000 }), { mode: 0o600 });
  return data.access_token;
}

async function gmail(path, init = {}) {
  const res = await fetch(GMAIL + path, { ...init, headers: { Authorization: "Bearer " + (await accessToken()), "Content-Type": "application/json", ...(init.headers || {}) } });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(`Gmail ${res.status}: ${data.error?.message || ""}`);
  return data;
}

const word = (s) => /^[\x20-\x7e]*$/.test(s) ? s : "=?UTF-8?B?" + Buffer.from(s).toString("base64") + "?=";

async function send(to, subject, body) {
  const from = setting("google_account");
  const html = body.startsWith("<html>");
  const mime = [
    `From: Nova <${from}>`, `To: ${to}`, `Subject: ${word(subject)}`, "MIME-Version: 1.0",
    `Content-Type: ${html ? "text/html" : "text/plain"}; charset=UTF-8`, "Content-Transfer-Encoding: base64", "",
    Buffer.from(body).toString("base64").replace(/.{76}/g, "$&\r\n"),
  ].join("\r\n");
  const out = await gmail("/messages/send", { method: "POST", body: JSON.stringify({ raw: Buffer.from(mime).toString("base64url") }) });
  console.log(JSON.stringify({ ok: true, id: out.id }));
}

async function search(q) {
  const list = await gmail("/messages?maxResults=50&q=" + encodeURIComponent(q));
  for (const m of list.messages || []) {
    const msg = await gmail(`/messages/${m.id}?format=metadata&metadataHeaders=To&metadataHeaders=Subject&metadataHeaders=Date&metadataHeaders=From`);
    const h = Object.fromEntries((msg.payload?.headers || []).map((x) => [x.name.toLowerCase(), x.value]));
    console.log(JSON.stringify({ id: m.id, date: h.date || "", to: h.to || "", from: h.from || "", subject: h.subject || "", labels: msg.labelIds || [] }));
  }
}

const [cmd, a, b] = process.argv.slice(2);
try {
  if (cmd === "send") await send(a, b, readFileSync(0, "utf8"));
  else if (cmd === "search") await search(a);
  else { console.error("nova-gmail send <to> <subject> < text | nova-gmail search '<query>'"); process.exit(2); }
} catch (e) {
  console.error(String(e.message || e));
  process.exit(1);
}

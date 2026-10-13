// The status page: is Nova working right now? Public, no sign-in, no personal data — safe to bookmark
// and to share in an emergency.
//
//   GET  /status              the page (calm, readable on a phone, refreshes itself every minute) —
//                             when a browser opens it; Nova Agent's own fetch('/status') isn't this
//                             (isStatusAddress)
//   GET  /status.json         the same as data: { ok, overall, parts[], laptopOffTest, at }.
//                             200 when nothing is red, 503 when something is — so an outside watchdog
//                             (any free uptime checker) can alert on the status code alone, or on the
//                             keyword "ok":true
//   POST /status/test-chat    "Test the chat now": one real website-chat round trip (rate limited:
//                             once every 5 minutes for everyone), then back to the page
//
// What's checked (cached for a minute, so refreshing the page costs nothing):
//   website chat   a real round trip through the public address, with a claude-test-status-… chat
//                  that's deleted straight after (the timed jobs do one every 6 hours: statusTick;
//                  or the button) — the page shows the last result, so loading it never waits
//   Portal         its page is there
//   sign-in        the staff accounts can be read
//   emails         the VPS's own mail sender, its queue and the last email that went (from the VPS's
//                  status service), and whether Gmail is connected as the backup
//   bookings feed  the Acuity calendar link answers with a calendar
//   timed jobs     the every-minute jobs ran in the last few minutes (a heartbeat they leave)
//   backups        the last nightly backup's age
//   Google         each part's last run
//   the server     disk and memory on the VPS
//   Nova Agent     linked or not, and where it runs (the server, or the studio PC) — when it's off,
//                  which parts keep working and which wait for it
// Plus the last "laptop off" test (vps/laptop-off-test.sh), when it ran and what passed.
//
// Nothing personal is ever shown: no names, emails, messages or keys; only states and times.

import { publicUrl } from "./nova/booking.js";
import { deskToken, vpsUrl } from "./desk.js";

const CACHE_KEY = "status_cache";
const HEARTBEAT_KEY = "cron_heartbeat_at";
const CHAT_TEST_KEY = "status_chat_test";
const LAPTOP_TEST_KEY = "status_laptop_off_test";
const CACHE_MS = 60_000;
const CHAT_EVERY_MS = 6 * 3600_000; // an automatic real chat round trip at most this often
const CHAT_RETRY_MS = 15 * 60_000; // …or this soon again after one that failed
const CHAT_BUTTON_GAP_MS = 5 * 60_000; // the button: once every 5 minutes for everyone

export let TIDY_AGAIN_MS = 3000;
export const setTidyDelay = (ms) => (TIDY_AGAIN_MS = ms); // tests

async function readSetting(env, key) {
  try {
    return await env.DB.prepare("SELECT value FROM settings WHERE key = ?").bind(key).first("value");
  } catch {
    return null;
  }
}
async function writeSetting(env, key, value) {
  await env.DB.prepare("INSERT INTO settings (key, value) VALUES (?, ?) ON CONFLICT (key) DO UPDATE SET value = excluded.value").bind(key, value).run();
}
const parse = (text) => {
  try {
    return JSON.parse(text || "null");
  } catch {
    return null;
  }
};

// The every-minute jobs (index.js's scheduled) leave a heartbeat, so the page can tell they're
// running, and test the website chat every 6 hours
export async function cronHeartbeat(env, at = Date.now(), fetcher = fetch) {
  await writeSetting(env, HEARTBEAT_KEY, new Date(at).toISOString()).catch(() => {});
  const last = parse(await readSetting(env, CHAT_TEST_KEY));
  if (last && at - Date.parse(last.at || 0) < (last.ok ? CHAT_EVERY_MS : CHAT_RETRY_MS)) return;
  await testChat(env, at, fetcher);
}

async function testChat(env, at, fetcher) {
  const chat = { ...(await chatRoundTrip(env, fetcher)), at: new Date(at).toISOString() };
  await writeSetting(env, CHAT_TEST_KEY, JSON.stringify(chat)).catch(() => {});
  return chat;
}

// "3 min ago", "2 h ago", "yesterday"…
export function ago(iso, now = Date.now()) {
  const t = Date.parse(iso || "");
  if (!Number.isFinite(t)) return "never";
  const s = Math.max(0, Math.round((now - t) / 1000));
  if (s < 90) return "just now";
  const m = Math.round(s / 60);
  if (m < 90) return `${m} min ago`;
  const h = Math.round(m / 60);
  if (h < 36) return `${h} h ago`;
  return `${Math.round(h / 24)} days ago`;
}

// ===== THE CHECKS =====

const part = (id, name, state, text, extra = {}) => ({ id, name, state, text, ...extra });

// One real website-chat round trip through the public address, as a visitor would, then the test
// chat is deleted. -> { ok, ms, reason? }
export async function chatRoundTrip(env, fetcher = fetch) {
  const chatId = `claude-test-status-${Date.now().toString(36)}${Math.random().toString(36).slice(2, 6)}`;
  const t0 = Date.now();
  let result;
  try {
    const res = await fetcher(`${publicUrl(env)}/`, {
      method: "POST",
      headers: { "Content-Type": "application/json", Origin: "https://novacane.co.uk" },
      body: JSON.stringify({ messages: [{ role: "user", content: "Status check: please just reply OK." }], chatId, page: "/status" }),
      signal: AbortSignal.timeout(30_000),
    });
    const data = await res.json().catch(() => ({}));
    result = res.ok && typeof data.reply === "string" && data.reply.trim()
      ? { ok: true, ms: Date.now() - t0 }
      : { ok: false, ms: Date.now() - t0, reason: res.status === 429 ? "busy (too many chats right now)" : `answered ${res.status}${data.error ? ` (${String(data.error).slice(0, 60)})` : ""}` };
  } catch (err) {
    result = { ok: false, ms: Date.now() - t0, reason: err?.name === "TimeoutError" ? "no answer within 30 seconds" : "couldn't be reached" };
  }
  // The test leaves nothing behind (and again a moment later: the chat saves itself after it answers)
  const tidy = () =>
    env.DB.batch(["chat_messages", "memory_progress", "chat_live", "chat_tickets"].map((t) => env.DB.prepare(`DELETE FROM ${t} WHERE chat_id = ?`).bind(chatId))).catch(() => {});
  await tidy();
  await new Promise((r) => setTimeout(r, TIDY_AGAIN_MS));
  await tidy();
  return result;
}

async function vpsStatus(env) {
  if (!env.AGENT_NOVA_KEY) return null;
  try {
    const res = await fetch(`${vpsUrl(env)}/desk-status/status`, {
      headers: { Authorization: `Bearer ${await deskToken(env.AGENT_NOVA_KEY)}` },
      signal: AbortSignal.timeout(8000),
    });
    return res.ok ? await res.json() : null;
  } catch {
    return null;
  }
}

async function pcLink(env) {
  if (!env.AGENT_LINK) return { connected: false };
  try {
    const stub = env.AGENT_LINK.get(env.AGENT_LINK.idFromName("studio-pc"));
    const res = await stub.fetch(new Request("https://agent-link/status"));
    return await res.json();
  } catch {
    return { connected: false };
  }
}

async function feedCheck(env) {
  const url = env.ACUITY_CALENDAR_URL;
  if (!url) return { ok: false, reason: "no calendar link is set" };
  try {
    const res = await fetch(url, { signal: AbortSignal.timeout(15_000) });
    const text = res.ok ? (await res.text()).slice(0, 4000) : "";
    return res.ok && text.includes("BEGIN:VCALENDAR") ? { ok: true } : { ok: false, reason: `answered ${res.status}` };
  } catch {
    return { ok: false, reason: "couldn't be reached" };
  }
}

async function portalCheck(env) {
  try {
    const res = await env.ASSETS.fetch(new Request("https://status.local/portal/"));
    return res.ok;
  } catch {
    return false;
  }
}

async function signInCheck(env) {
  try {
    const n = await env.DB.prepare("SELECT COUNT(*) AS n FROM staff WHERE status = 'active'").first("n");
    return n > 0;
  } catch {
    return false;
  }
}

const gb = (bytes) => `${(bytes / 1024 ** 3).toFixed(bytes > 10 * 1024 ** 3 ? 0 : 1)} GB`;

// Work out every part. `now` and `fetcher` are for tests.
export async function computeStatus(env, { now = Date.now(), fetcher = fetch, forceChat = false } = {}) {
  const [vps, link, feed, portal, signIn, heartbeat, googleRaw, chatRaw, laptopRaw, gmailAccount] = await Promise.all([
    vpsStatus(env),
    pcLink(env),
    feedCheck(env),
    portalCheck(env),
    signInCheck(env),
    readSetting(env, HEARTBEAT_KEY),
    readSetting(env, "google_status"),
    readSetting(env, CHAT_TEST_KEY),
    readSetting(env, LAPTOP_TEST_KEY),
    readSetting(env, "google_account"),
  ]);

  // Website chat: the last real round trip (the timed jobs do one every 6 hours; the button, now)
  const chat = forceChat ? await testChat(env, now, fetcher) : parse(chatRaw);
  const chatKey = Boolean(env.ANTHROPIC_API_KEY);

  const parts = [];
  parts.push(
    !chat
      ? part("chat", "Website chat", chatKey ? "amber" : "red", chatKey ? "Not tested yet: press \"Test the chat now\"." : "Its Claude key isn't set, so it can't answer.")
      : chat.ok
        ? part("chat", "Website chat", "green", `Answering visitors (a real test chat answered in ${(chat.ms / 1000).toFixed(1)} s, ${ago(chat.at, now)}).`, { checked: chat.at })
        : part("chat", "Website chat", "red", `The last test chat (${ago(chat.at, now)}) didn't get an answer: ${chat.reason || "unknown"}.`, { checked: chat.at })
  );
  parts.push(portal ? part("portal", "Portal", "green", "Portal opens.") : part("portal", "Portal", "red", "Portal's page didn't load."));
  parts.push(signIn ? part("signin", "Signing in", "green", "Staff accounts are there to sign in with.") : part("signin", "Signing in", "red", "The staff accounts couldn't be read."));

  // Emails: the VPS's own sender (and Gmail as the backup)
  const mail = vps && vps.mail;
  const gmail = gmailAccount ? "Gmail is connected as the backup." : "No Gmail backup connected.";
  if (!vps) {
    parts.push(part("email", "Emails", "amber", `The server's own status couldn't be read, so the email sender wasn't checked. ${gmail}`));
  } else if (mail && mail.sender === "active" && mail.postfix === "active" && (mail.queue ?? 0) < 20) {
    parts.push(part("email", "Emails", "green", `Sending from our own mail server${mail.lastSent ? ` (last email went ${ago(mail.lastSent, now)})` : ""}${mail.queue ? `, ${mail.queue} waiting` : ""}. ${gmail}`));
  } else if (mail && (mail.sender !== "active" || mail.postfix !== "active")) {
    parts.push(part("email", "Emails", gmailAccount ? "amber" : "red", `Our mail server isn't running (${mail.sender !== "active" ? "sender" : "postfix"} is ${mail.sender !== "active" ? mail.sender : mail.postfix}). ${gmail}`));
  } else if (mail) {
    parts.push(part("email", "Emails", "amber", `${mail.queue} emails are waiting to go (they're retried). ${gmail}`));
  } else {
    parts.push(part("email", "Emails", "amber", `The mail server's details weren't in the server's status. ${gmail}`));
  }

  parts.push(feed.ok ? part("feed", "Bookings feed", "green", "Acuity's calendar answers, so bookings come in.") : part("feed", "Bookings feed", "red", `Acuity's calendar ${feed.reason}.`));

  const beatAge = heartbeat ? now - Date.parse(heartbeat) : Infinity;
  parts.push(
    beatAge < 5 * 60_000
      ? part("jobs", "Timed jobs", "green", `Running every minute (last run ${ago(heartbeat, now)}).`, { checked: heartbeat })
      : beatAge < 30 * 60_000
        ? part("jobs", "Timed jobs", "amber", `Last run ${ago(heartbeat, now)}: a little late.`, { checked: heartbeat })
        : part("jobs", "Timed jobs", "red", heartbeat ? `Last run ${ago(heartbeat, now)}: reminders, emails and syncing wait until they run again.` : "They haven't run yet.", { checked: heartbeat })
  );

  if (vps) {
    const last = vps.lastBackup;
    const age = last ? now - Date.parse(last) : Infinity;
    parts.push(
      age < 36 * 3600_000
        ? part("backups", "Backups", "green", `Last nightly backup ${ago(last, now)} (kept for 14 days).`, { checked: last })
        : part("backups", "Backups", last ? "amber" : "red", last ? `Last backup ${ago(last, now)}: older than it should be.` : "No backup found yet.", { checked: last })
    );
    const disk = vps.disk;
    const memFree = vps.memory ? vps.memory.free / vps.memory.total : 1;
    const diskFree = disk ? disk.free / disk.total : 1;
    const words = `${disk ? `${gb(disk.free)} of ${gb(disk.total)} disk free` : "disk unknown"}, ${vps.memory ? `${gb(vps.memory.free)} memory free` : "memory unknown"}, up ${Math.round((vps.uptimeSeconds || 0) / 86400)} days.`;
    parts.push(part("server", "The server", diskFree < 0.05 || memFree < 0.03 ? "red" : diskFree < 0.15 || memFree < 0.08 ? "amber" : "green", words));
  } else {
    parts.push(part("backups", "Backups", "amber", "The server's own status couldn't be read, so backups weren't checked."));
    parts.push(part("server", "The server", "amber", "Its own status couldn't be read just now."));
  }

  // Google: each part's last run
  const google = parse(googleRaw);
  if (google && typeof google === "object") {
    const rows = Object.entries(google).filter(([, v]) => v && typeof v === "object");
    const bad = rows.filter(([, v]) => v.ok === false);
    parts.push(
      bad.length
        ? part("google", "Google", "amber", `Not working right now: ${bad.map(([k]) => k).join(", ")}. The rest is in step.`)
        : part("google", "Google", "green", rows.length ? `Calendar, Gmail and the rest in step (${rows.map(([k, v]) => `${k} ${ago(v.at, now)}`).slice(0, 4).join(", ")}).` : "Connected.")
    );
  } else {
    parts.push(part("google", "Google", "amber", "Google isn't connected, so nothing syncs with it."));
  }

  // Nova Agent: on the server (the laptop can be off), on the studio PC, or off and which parts wait for it
  // (the id stays "pc", which vps/laptop-off-test.sh and older pages read)
  parts.push(
    link.connected && link.where === "server"
      ? part("pc", "Nova Agent", "green", "On the server: Agent, quests, Calendar's own notes, Board, Files, Console and the Fixer all work with the studio PC off.", { checked: link.since || null })
      : link.connected
        ? part("pc", "Nova Agent", "green", "On the studio PC (linked): Agent, quests, Calendar's own notes, Board, Console's terminals and the Fixer are all available while the PC is on.", { checked: link.since || null })
        : part("pc", "Nova Agent", "amber", "Off or not linked. Still working without it: the website chat and bookings, Portal, enquiries, emails, clients, Money, Social, Campaigns, shared Notes and Google. Waiting for it: Agent, quests, Calendar's own notes, Board, Console's terminals and the Fixer.")
  );

  const red = parts.filter((p) => p.state === "red");
  const amber = parts.filter((p) => p.state === "amber" && p.id !== "pc");
  const ok = red.length === 0;
  return {
    ok,
    overall: !ok ? "Something needs attention" : amber.length ? "Working — a few things to keep an eye on" : "Everything's working",
    parts,
    laptopOffTest: parse(laptopRaw),
    at: new Date(now).toISOString(),
  };
}

async function cachedStatus(env, opts = {}) {
  const cached = parse(await readSetting(env, CACHE_KEY));
  const now = opts.now ?? Date.now();
  if (!opts.fresh && cached && now - Date.parse(cached.at || 0) < CACHE_MS) return cached;
  const status = await computeStatus(env, opts);
  await writeSetting(env, CACHE_KEY, JSON.stringify(status)).catch(() => {});
  return status;
}

// ===== THE PAGE =====

const esc = (s) => String(s ?? "").replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c]);
const LIGHTS = { green: ["#3ddc97", "OK"], amber: ["#ffb648", "Keep an eye on it"], red: ["#ff5f6d", "Needs attention"] };

export function statusPage(status, { notice = "" } = {}) {
  const rows = status.parts
    .map((p) => {
      const [colour, label] = LIGHTS[p.state] || LIGHTS.amber;
      return `<li class="row ${p.state}"><span class="dot" style="background:${colour}" role="img" aria-label="${label}"></span><div><b>${esc(p.name)}</b><span class="word">${label}</span><p>${esc(p.text)}</p></div></li>`;
    })
    .join("");
  const t = status.laptopOffTest;
  const laptop = t
    ? `<p class="laptop ${t.passed ? "pass" : "fail"}"><b>Last "laptop off" test:</b> ${esc(new Date(t.at).toLocaleString("en-GB", { timeZone: "Europe/London", day: "numeric", month: "short", hour: "2-digit", minute: "2-digit" }))} — ${t.passed ? "everything that should keep working did" : `didn't pass: ${esc((t.failed || []).join(", "))}`}.</p>`
    : `<p class="laptop">No "laptop off" test has been run yet.</p>`;
  const when = new Date(status.at).toLocaleTimeString("en-GB", { timeZone: "Europe/London", hour: "2-digit", minute: "2-digit" });
  return `<!doctype html><html lang="en-GB"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1">
<meta http-equiv="refresh" content="60"><title>Nova status</title><meta name="robots" content="noindex">
<style>
:root{--bg:#120a1c;--card:#1d1129;--line:#3a2450;--text:#f1e4ef;--muted:#bfa6bd;--hi:#ff5fa8}
@media (prefers-color-scheme: light){:root{--bg:#fbf6fa;--card:#fff;--line:#ead7e6;--text:#2a1530;--muted:#6f5470;--hi:#b01d68}}
*{box-sizing:border-box}body{margin:0;background:var(--bg);color:var(--text);font:16px/1.5 system-ui,-apple-system,"Segoe UI",sans-serif}
main{max-width:720px;margin:0 auto;padding:24px 16px 48px}
h1{margin:0 0 4px;font-size:15px;letter-spacing:.18em;text-transform:uppercase;color:var(--muted)}
.overall{font-size:28px;font-weight:700;margin:6px 0 4px}.overall.ok{color:#3ddc97}.overall.bad{color:#ff5f6d}
.small{color:var(--muted);font-size:14px;margin:0 0 18px}
ul{list-style:none;padding:0;margin:0;display:grid;gap:10px}
.row{display:flex;gap:12px;align-items:flex-start;background:var(--card);border:1px solid var(--line);border-radius:14px;padding:14px}
.dot{flex:none;width:14px;height:14px;border-radius:50%;margin-top:5px;box-shadow:0 0 10px currentColor}
.row b{font-size:17px}.word{margin-left:8px;font-size:13px;color:var(--muted)}.row p{margin:4px 0 0;color:var(--muted)}
.laptop{background:var(--card);border:1px solid var(--line);border-radius:14px;padding:14px;margin:16px 0}.laptop.fail{border-color:#ff5f6d}
form{margin:18px 0}button{font:inherit;font-weight:600;padding:12px 18px;border-radius:999px;border:0;background:var(--hi);color:#fff;cursor:pointer;min-height:44px}
.notice{background:var(--card);border-left:4px solid var(--hi);padding:10px 14px;border-radius:8px}
.help{background:var(--card);border:1px solid var(--line);border-radius:14px;padding:16px;margin-top:22px}
.help h2{margin:0 0 8px;font-size:19px}.help ol{margin:0;padding-left:22px}.help li{margin:6px 0}
code{background:rgba(127,127,127,.18);padding:2px 6px;border-radius:6px;font-size:14px;word-break:break-all}
a{color:var(--hi)}
</style></head><body><main>
<h1>Nova status</h1>
<p class="overall ${status.ok ? "ok" : "bad"}">${esc(status.overall)}</p>
<p class="small">Checked at ${when} (UK time) · updates every minute by itself</p>
${notice ? `<p class="notice">${esc(notice)}</p>` : ""}
<ul>${rows}</ul>
${laptop}
<form method="post" action="/status/test-chat"><button type="submit">Test the chat now</button></form>
<section class="help" aria-labelledby="sos"><h2 id="sos">If something's red, do this</h2><ol>
<li><b>Wait one minute and look again.</b> This page checks itself every minute; many things fix themselves.</li>
<li><b>Restart Nova</b> — admins: Portal → Admin → <a href="/portal/?view=computer">Computer</a> → <b>Restart Nova Bot</b>. Or in a terminal on the studio PC: <code>ssh root@185.185.126.195 systemctl restart nova</code></li>
<li><b>Nova Agent off?</b> On the server it starts again by itself; to restart it: <code>ssh root@185.185.126.195 systemctl restart nova-agent</code></li>
<li><b>Emails red?</b> Restart the mail sender: <code>ssh root@185.185.126.195 systemctl restart postfix nova-mail</code> — Gmail sends meanwhile if it's connected.</li>
<li><b>Server red (disk or memory)?</b> Computer shows how full it is; old backups live in <code>/srv/nova/backups</code> on the server (14 days are kept, plus copies in Google Drive → Nova Agent → Backups).</li>
<li><b>This page won't load at all?</b> Then the server itself is down: log in to the VPSdime panel and press <b>Reboot</b>, or open a support ticket with VPSdime. Nova starts again by itself when the server comes back.</li>
<li><b>Still stuck?</b> Ask Claude Code on the studio PC: "Nova's status page is red — please fix it."</li>
</ol></section>
</main></body></html>`;
}

// ===== ROUTES =====

const json = (data, status = 200) => new Response(JSON.stringify(data), { status, headers: { "Content-Type": "application/json", "Cache-Control": "no-store" } });

// /status is also Nova Agent's own address (its fetch('/status') goes to the studio PC), so the page
// answers there only when a browser opens it as a page; /status.json and the button are only ours
export function isStatusAddress(request, pathname) {
  if (pathname === "/status.json" || pathname === "/status/test-chat") return true;
  if (pathname !== "/status" || request.method !== "GET") return false;
  const dest = request.headers.get("Sec-Fetch-Dest");
  return dest ? dest === "document" : /text\/html/.test(request.headers.get("Accept") || "");
}

export async function handleStatus(request, env) {
  const url = new URL(request.url);
  if (url.pathname === "/status.json" && request.method === "GET") {
    const status = await cachedStatus(env);
    return json(status, status.ok ? 200 : 503);
  }
  if (url.pathname === "/status/test-chat" && request.method === "POST") {
    const last = parse(await readSetting(env, CHAT_TEST_KEY));
    let notice;
    if (last && Date.now() - Date.parse(last.at || 0) < CHAT_BUTTON_GAP_MS) {
      notice = "The chat was tested less than 5 minutes ago — the result is below.";
    } else {
      const status = await cachedStatus(env, { fresh: true, forceChat: true });
      const chat = status.parts.find((p) => p.id === "chat");
      notice = chat && chat.state === "green" ? "Tested just now: the website chat answered." : "Tested just now: the website chat didn't answer — see below.";
    }
    return Response.redirect(`${url.origin}/status?n=${encodeURIComponent(notice)}`, 303);
  }
  if (url.pathname === "/status" && request.method === "GET") {
    const status = await cachedStatus(env);
    const notice = (url.searchParams.get("n") || "").slice(0, 120);
    return new Response(statusPage(status, { notice: /^[\w .,:'—-]*$/.test(notice) ? notice : "" }), {
      status: 200,
      headers: {
        "Content-Type": "text/html; charset=utf-8",
        "Cache-Control": "no-store",
        "Content-Security-Policy": "default-src 'none'; style-src 'unsafe-inline'; form-action 'self'; frame-ancestors 'none'; base-uri 'none'",
        "X-Content-Type-Options": "nosniff",
        "Referrer-Policy": "no-referrer",
      },
    });
  }
  return new Response("Not found", { status: 404 });
}

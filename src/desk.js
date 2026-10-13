// Portal → Admin → Computer (admins): Nova Bot here (on Cloudflare, or on the VPS: DESK_HOST says
// which) and the VPS (vps/README.md), side by side, with how each is doing.
//
//   GET  /app/api/desk          { here, vps } — here: where this copy of Nova Bot runs, its version,
//                               the PC link, each job's last run; vps: the VPS's own status
//                               (vps/desk-status/server.mjs), or why it can't be reached
//   POST /app/api/desk/action   { do: "restart" | "restart-web" | "backup" } — passed to the VPS
//
// Admins only (and actions only from Portal open in a browser, the cookie). The VPS is asked with a
// token made from AGENT_NOVA_KEY (HMAC-SHA256 of "desk-status"), so nothing else is needed; the
// VPS refuses everything until its AGENT_NOVA_KEY is the same as this one. Nothing secret or
// personal is sent back: numbers, service states, times and problem lines with keys blanked out.

import { publicUrl } from "./nova/booking.js";

const DEFAULT_VPS = "https://185-185-126-195.sslip.io";
const JOB_KEYS = {
  campaigns_hourly_at: "Email campaigns (hourly check)",
  social_hourly_at: "Social posts (hourly check)",
  clients_synced_at: "Clients from the calendar",
  google_connected_at: "Google connected",
};

const json = (data, status = 200) => Response.json(data, { status, headers: { "Cache-Control": "no-store" } });

export const vpsUrl = (env) => String(env.DESK_VPS_URL || DEFAULT_VPS).replace(/\/+$/, "");

export async function deskToken(key) {
  const k = await crypto.subtle.importKey("raw", new TextEncoder().encode(key), { name: "HMAC", hash: "SHA-256" }, false, ["sign"]);
  const sig = new Uint8Array(await crypto.subtle.sign("HMAC", k, new TextEncoder().encode("desk-status")));
  return [...sig].map((b) => b.toString(16).padStart(2, "0")).join("");
}

async function askVps(env, method, path, body) {
  if (!env.AGENT_NOVA_KEY) return { ok: false, reason: "Nova Bot has no AGENT_NOVA_KEY, so it can't ask the VPS." };
  try {
    const res = await fetch(`${vpsUrl(env)}/desk-status${path}`, {
      method,
      headers: { Authorization: `Bearer ${await deskToken(env.AGENT_NOVA_KEY)}`, ...(body ? { "Content-Type": "application/json" } : {}) },
      body: body ? JSON.stringify(body) : undefined,
      signal: AbortSignal.timeout(8000),
    });
    const data = await res.json().catch(() => ({}));
    if (res.status === 401) return { ok: false, reason: "The VPS turned the request down: its AGENT_NOVA_KEY isn't set yet, or isn't the same as Nova Bot's (run set-secrets on the VPS)." };
    if (!res.ok) return { ok: false, reason: data.error || `The VPS answered ${res.status}.` };
    return { ok: true, data };
  } catch (err) {
    return { ok: false, reason: err?.name === "TimeoutError" ? "The VPS didn't answer within 8 seconds." : "The VPS couldn't be reached." };
  }
}

async function here(env) {
  const rows = await env.DB.prepare(`SELECT key, value FROM settings WHERE key IN (${Object.keys(JOB_KEYS).map(() => "?").join(", ")}) OR key = 'google_status'`)
    .bind(...Object.keys(JOB_KEYS))
    .all()
    .then((r) => r.results)
    .catch(() => []);
  const jobs = [];
  for (const r of rows) {
    if (r.key === "google_status") {
      let parts = {};
      try {
        parts = JSON.parse(r.value) || {};
      } catch {}
      for (const [part, s] of Object.entries(parts)) jobs.push({ name: `Google: ${part}`, at: s.at || null, ok: s.ok !== false, note: String(s.note || s.error || "").slice(0, 160) });
    } else jobs.push({ name: JOB_KEYS[r.key], at: r.value, ok: true, note: "" });
  }
  jobs.sort((a, b) => String(b.at || "").localeCompare(String(a.at || "")));
  let pc = { connected: false };
  if (env.AGENT_LINK) {
    try {
      const stub = env.AGENT_LINK.get(env.AGENT_LINK.idFromName("studio-pc"));
      pc = await (await stub.fetch(new Request("https://agent-link/status"))).json();
    } catch {}
  }
  const v = env.CF_VERSION_METADATA || {};
  const where = env.DESK_HOST === "vps" ? "vps" : "cloudflare";
  return {
    where,
    // Which one people are using: Cloudflare's own Nova Bot, or (after vps/switch.sh) the VPS behind
    // Cloudflare's address. A VPS still on its own address is standing by.
    live: where === "cloudflare" ? "cloudflare" : onLiveAddress(env) ? "vps" : "standby",
    switchHelp: { to: "vps/switch.sh", back: "vps/switch-back.sh", from: "the studio PC, in nb/novacane-worker" },
    warnings: await warnings(env),
    url: publicUrl(env),
    version: v.id ? { id: String(v.id).slice(0, 8), at: v.timestamp || null } : null,
    pc,
    jobs,
  };
}

// Nova's own address (and, while old links are moved over, the address it had before)
const LIVE_HOSTS = ["nova.novacane.co.uk", "novacane-worker.novacane-studio.workers.dev"];
function onLiveAddress(env) {
  try {
    return LIVE_HOSTS.includes(new URL(publicUrl(env)).host);
  } catch {
    return false;
  }
}

// Things that won't work as they are, in plain words (newsletters need a Resend key from the account
// that has the studio's domain). Resend is asked at most every 6 hours; the answer is kept in settings.
const RESEND_CHECK = "desk_resend_domains";
async function warnings(env) {
  const out = [];
  const from = String(env.CAMPAIGN_FROM || "").match(/@([a-z0-9.-]+)/i);
  const domain = from ? from[1].toLowerCase() : "novacane.co.uk";
  if (!env.RESEND_MARKETING_KEY) {
    out.push("Newsletters are off: there's no full-access Resend key (RESEND_MARKETING_KEY).");
    return out;
  }
  let check = null;
  try {
    check = JSON.parse((await env.DB.prepare("SELECT value FROM settings WHERE key = ?").bind(RESEND_CHECK).first("value")) || "null");
  } catch {}
  if (!check || Date.now() - (check.at || 0) > 6 * 3600 * 1000) {
    try {
      const res = await fetch("https://api.resend.com/domains", { headers: { Authorization: `Bearer ${env.RESEND_MARKETING_KEY}` }, signal: AbortSignal.timeout(6000) });
      const data = await res.json().catch(() => ({}));
      const names = res.ok ? (data.data || []).filter((d) => d.status === "verified").map((d) => String(d.name).toLowerCase()) : null;
      check = { at: Date.now(), names };
      await env.DB.prepare("INSERT INTO settings (key, value) VALUES (?, ?) ON CONFLICT (key) DO UPDATE SET value = excluded.value").bind(RESEND_CHECK, JSON.stringify(check)).run();
    } catch {
      check = null;
    }
  }
  if (check && Array.isArray(check.names) && !check.names.includes(domain)) {
    out.push(`Newsletters won't send: the Resend key here is from a Resend account without ${domain}. Make a new full-access key in the Resend account that has ${domain}, then on the VPS: set-key RESEND_MARKETING_KEY.`);
  }
  return out;
}

// Portal's /app/api/desk… (app-page.js has checked the sign-in). -> a Response, or null
export async function handleDeskForStaff(request, env, me, route) {
  if (route !== "/desk" && !route.startsWith("/desk/")) return null;
  if (me.role !== "admin") return json({ error: "Computer is for admins." }, 403);
  if (route === "/desk" && request.method === "GET") {
    const [h, vps] = await Promise.all([here(env), askVps(env, "GET", "/status")]);
    return json({ here: h, vps: vps.ok ? { reachable: true, url: vpsUrl(env), ...vps.data } : { reachable: false, url: vpsUrl(env), reason: vps.reason }, canAct: me.session_kind === "cookie" });
  }
  if (route === "/desk/action" && request.method === "POST") {
    if (me.session_kind !== "cookie") return json({ error: "Restarting or backing up needs Portal open in a browser, signed in as an admin." }, 403);
    let body = {};
    try {
      body = (await request.json()) || {};
    } catch {}
    const what = String(body.do || "");
    if (!["restart", "restart-web", "backup"].includes(what)) return json({ error: "Which? restart, restart-web or backup." }, 400);
    const r = await askVps(env, "POST", "/action", { do: what });
    console.log(`Computer: ${what} asked by ${me.id}: ${r.ok ? "done" : "refused"}`);
    return r.ok ? json({ ok: true, done: what }) : json({ error: r.reason }, 502);
  }
  return null;
}

// Computer's status service on the VPS (vps/README.md). Portal → Admin → Computer asks Nova Bot, and Nova
// Bot asks this, so the page can show how the VPS is doing and an admin can restart a part or
// back up now. It listens only on 127.0.0.1:8788; Caddy passes /desk-status/* to it.
//
// Never public: every request needs `Authorization: Bearer <token>`, where the token is the
// HMAC-SHA256 of "desk-status" with AGENT_NOVA_KEY (the key Nova Bot already has), compared in constant time. No key set here = everything refused.
//
//   GET  /status           how the VPS and Nova Bot and Nova Agent on it are doing (no secrets, no customer data),
//                          including its mail sender: running, how many emails wait, when the last went
//                          (counts and times only — never an address)
//   POST /action {do}      "restart" (Nova Bot) | "restart-agent" (Nova Agent) | "restart-web" (Caddy) | "backup"
//
// Runs as root (it reads the journal and restarts services), with no other powers than those.
import { createServer } from "node:http";
import { createHmac, timingSafeEqual } from "node:crypto";
import { execFile } from "node:child_process";
import { readFileSync, statSync, readdirSync, existsSync, statfsSync } from "node:fs";
import { cpus, loadavg, totalmem, freemem, uptime, hostname } from "node:os";

const PORT = 8788;
const SECRETS = "/srv/nova/secrets.env";
const STATE = "/srv/nova/state";
const BACKUPS = "/srv/nova/backups";
const SERVICES = ["nova", "nova-agent", "caddy", "nova-cron.timer", "nova-backup.timer", "desk-status", "nova-mail", "postfix"];

function key() {
  try {
    const line = readFileSync(SECRETS, "utf8").split("\n").find((l) => l.startsWith("AGENT_NOVA_KEY="));
    return line ? line.slice("AGENT_NOVA_KEY=".length).trim() : "";
  } catch {
    return "";
  }
}
export function tokenFor(k) {
  return createHmac("sha256", k).update("desk-status").digest("hex");
}
function allowed(req) {
  const k = key();
  if (!k) return false;
  const got = String(req.headers.authorization || "").replace(/^Bearer\s+/i, "");
  const want = tokenFor(k);
  const a = Buffer.from(got), b = Buffer.from(want);
  return a.length === b.length && timingSafeEqual(a, b);
}

const run = (cmd, args, timeout = 20000) =>
  new Promise((resolve) => execFile(cmd, args, { timeout, maxBuffer: 1 << 20 }, (err, stdout) => resolve({ ok: !err, out: String(stdout || "").trim() })));

const readText = (f) => {
  try {
    return readFileSync(f, "utf8").trim();
  } catch {
    return null;
  }
};

// The mail sender (vps/mail + Postfix): counts and times only, never who an email was to
async function mailInfo(active) {
  const q = await run("postqueue", ["-j"]);
  const queue = q.ok ? q.out.split("\n").filter((l) => l.trim().startsWith("{")).length : null;
  const sent = await run("journalctl", ["-t", "postfix/smtp", "--since", "-14d", "-o", "short-iso", "--no-pager", "--grep", "status=sent"]);
  const lastLine = sent.out.split("\n").filter((l) => /status=sent/.test(l)).pop() || "";
  const at = lastLine.match(/^(\S+)/);
  const bad = await run("journalctl", ["-t", "postfix/smtp", "--since", "-24h", "-o", "cat", "--no-pager", "--grep", "status=(deferred|bounced)"]);
  return {
    sender: active["nova-mail"],
    postfix: active.postfix,
    queue,
    lastSent: at && !Number.isNaN(Date.parse(at[1])) ? new Date(at[1]).toISOString() : null,
    troubleToday: bad.out.split("\n").filter((l) => /status=(deferred|bounced)/.test(l)).length,
  };
}

async function status() {
  const active = {};
  for (const s of SERVICES) active[s] = (await run("systemctl", ["is-active", s])).out || "unknown";
  const since = (await run("systemctl", ["show", "nova", "-p", "ActiveEnterTimestamp", "--value"])).out || null;
  const agentSince = (await run("systemctl", ["show", "nova-agent", "-p", "ActiveEnterTimestamp", "--value"])).out || null;
  const disk = (() => {
    try {
      const s = statfsSync("/srv/nova");
      return { total: s.blocks * s.bsize, free: s.bavail * s.bsize };
    } catch {
      return null;
    }
  })();
  const backups = existsSync(BACKUPS)
    ? readdirSync(BACKUPS).filter((f) => /^nova-.*\.tar\.gz$/.test(f)).sort().map((f) => ({ name: f, size: statSync(`${BACKUPS}/${f}`).size }))
    : [];
  // Recent problems: warnings and errors from Nova Bot, Nova Agent and Caddy in the last day (words only)
  const log = await run("journalctl", ["-u", "nova", "-u", "nova-agent", "-u", "caddy", "-p", "warning", "--since", "-24h", "-n", "15", "--no-pager", "-o", "short-iso"]);
  const problems = log.out
    .split("\n")
    .filter((l) => l && !/^-- /.test(l))
    .map((l) => l.replace(/\b(Bearer|key|token|secret|password)[=: ]+\S+/gi, "$1 …").slice(0, 300));
  const version = readText("/srv/nova/app/VERSION");
  const node = (await run("node", ["--version"])).out;
  return {
    host: hostname(),
    at: new Date().toISOString(),
    uptimeSeconds: Math.round(uptime()),
    novaSince: since,
    agentSince: active["nova-agent"] === "active" ? agentSince : null,
    cpu: { count: cpus().length, load: loadavg().map((n) => Math.round(n * 100) / 100) },
    memory: { total: totalmem(), free: freemem() },
    disk,
    services: active,
    jobsOn: active["nova-cron.timer"] === "active",
    mail: await mailInfo(active),
    lastSync: readText(`${STATE}/.last-sync`),
    lastBackup: readText(`${STATE}/.last-backup`),
    backups: backups.slice(-5),
    version,
    node,
    problems,
  };
}

const ACTIONS = {
  restart: () => run("systemctl", ["restart", "nova"]),
  "restart-agent": () => run("systemctl", ["restart", "nova-agent"]),
  "restart-web": () => run("systemctl", ["reload-or-restart", "caddy"]),
  backup: () => run("systemctl", ["start", "nova-backup.service"], 120000),
};

const json = (res, code, body) => {
  res.writeHead(code, { "Content-Type": "application/json", "Cache-Control": "no-store" });
  res.end(JSON.stringify(body));
};

createServer(async (req, res) => {
  try {
    if (!allowed(req)) return json(res, 401, { error: "Not allowed" });
    const path = new URL(req.url, "http://x").pathname.replace(/^\/desk-status/, "");
    if (req.method === "GET" && path === "/status") return json(res, 200, await status());
    if (req.method === "POST" && path === "/action") {
      let body = "";
      for await (const c of req) {
        body += c;
        if (body.length > 1000) break;
      }
      let what = "";
      try {
        what = String(JSON.parse(body || "{}").do || "");
      } catch {}
      if (!ACTIONS[what]) return json(res, 400, { error: "Which? restart, restart-web or backup." });
      const r = await ACTIONS[what]();
      return json(res, r.ok ? 200 : 500, { ok: r.ok, done: what });
    }
    return json(res, 404, { error: "Not found" });
  } catch (err) {
    return json(res, 500, { error: "Something went wrong" });
  }
}).listen(PORT, "127.0.0.1");

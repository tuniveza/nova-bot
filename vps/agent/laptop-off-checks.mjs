// The full laptop-off checks (vps/full-laptop-off-test.sh sends this to the server and runs it there
// as root, with plain Node). Everything goes through the public address, the way a phone or a
// browser elsewhere would, as a signed-in admin made just for the test: a temporary staff member
// "laptop-off-test" with a 20-minute session, written straight into Nova Bot's database and removed
// at the end, with everything it made (its chat, its quest, its board). No password is used anywhere.
//
// Each check prints one line: "PASS <name> — <what it saw>" or "FAIL <name> — <why>", and the last
// line is the summary as JSON (for the status page).
//
// Settings (environment): NOVA_URL (https://nova.novacane.co.uk)  EXPECT_WHERE (server: Nova Agent must
// be the server's; pc: the PC's, for trying the checks before a move)  TEST_TO (one email goes here)
// PUSH=0 (skip the one test ping to the studio owner's phone)  MAIL=0 (skip the email)
import { execFileSync } from "node:child_process";
import { createHash, randomBytes } from "node:crypto";
import { existsSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";

const URL_ = (process.env.NOVA_URL || "https://nova.novacane.co.uk").replace(/\/$/, "");
const ORIGIN = new URL(URL_).origin;
const WHERE = process.env.EXPECT_WHERE || "server";
const TO = process.env.TEST_TO || (await import("node:fs")).readFileSync("/srv/nova/owner-email", "utf8").trim();
const PUSH = process.env.PUSH !== "0";
const MAIL = process.env.MAIL !== "0";
const TEST_ID = "laptop-off-test";
const AGENT_DATA = "/srv/nova-agent/data";

const d1 = "/srv/nova/state/v3/d1/miniflare-D1DatabaseObject";
const DB = readdirSync(d1).filter((f) => f.endsWith(".sqlite") && f !== "metadata.sqlite").map((f) => `${d1}/${f}`)[0];
const sql = (q) => execFileSync("sqlite3", ["-cmd", ".timeout 8000", DB, q], { encoding: "utf8" }).trim();
const envValue = (file, name) => {
  try {
    const line = readFileSync(file, "utf8").split("\n").find((l) => l.startsWith(name + "="));
    return line ? line.slice(name.length + 1).trim().replace(/^["']|["']$/g, "") : "";
  } catch {
    return "";
  }
};

const results = [];
function line(ok, name, detail) {
  results.push({ ok, name, detail });
  console.log(`${ok ? "PASS" : "FAIL"} ${name} — ${detail}`);
}
async function check(name, fn) {
  try {
    const detail = await fn();
    line(true, name, detail || "ok");
  } catch (err) {
    line(false, name, String(err?.message || err).slice(0, 300));
  }
}
const must = (cond, why) => {
  if (!cond) throw new Error(why);
};

// ---- The test's own signed-in admin ----
const token = randomBytes(32).toString("base64url");
const sessionId = createHash("sha256").update(token).digest("base64url");
function signIn() {
  const now = new Date().toISOString();
  const later = new Date(Date.now() + 20 * 60_000).toISOString();
  sql(
    `INSERT OR REPLACE INTO staff (id, email, password_hash, display_name, role, status, created_at, planet_seed, index_partition) VALUES ('${TEST_ID}', '${TEST_ID}@nova.invalid', NULL, 'Laptop-off test', 'admin', 'active', '${now}', '${TEST_ID}', 'staff:${TEST_ID}');` +
      `INSERT INTO sessions (id, staff_id, kind, created_at, expires_at, last_seen_at, user_agent) VALUES ('${sessionId}', '${TEST_ID}', 'cookie', '${now}', '${later}', '${now}', 'laptop-off test');`,
  );
}
function signOut() {
  try {
    sql(`DELETE FROM sessions WHERE staff_id = '${TEST_ID}'; DELETE FROM staff WHERE id = '${TEST_ID}';`);
  } catch {}
  // What Nova Agent kept for the test person (when it runs here)
  for (const f of [`${AGENT_DATA}/chats/${TEST_ID}.json`, `${AGENT_DATA}/boards/${TEST_ID}.json`]) rmSync(f, { force: true });
  try {
    const file = `${AGENT_DATA}/people.json`;
    if (existsSync(file)) {
      const people = JSON.parse(readFileSync(file, "utf8"));
      if (people[TEST_ID]) {
        delete people[TEST_ID];
        writeFileSync(file, JSON.stringify(people, null, 2) + "\n");
      }
    }
  } catch {}
}

// A request as the test admin, from the site's own pages
async function call(path, { method = "GET", body, headers = {}, timeout = 60_000, raw = false } = {}) {
  const h = { Cookie: `nova_session=${token}`, Accept: "application/json", ...headers };
  if (method !== "GET") Object.assign(h, { Origin: ORIGIN, "Sec-Fetch-Site": "same-origin", "X-Nova-Visualizer": "1" });
  if (body !== undefined) h["Content-Type"] = "application/json";
  const res = await fetch(URL_ + path, { method, headers: h, body: body === undefined ? undefined : JSON.stringify(body), redirect: "manual", signal: AbortSignal.timeout(timeout) });
  if (raw) return res;
  const text = await res.text();
  let data = null;
  try {
    data = JSON.parse(text);
  } catch {}
  if (!res.ok) throw new Error(`${method} ${path} answered ${res.status}${data?.error || data?.message ? `: ${data.error || data.message}` : ""}`);
  return data ?? text;
}

signIn();
try {
  // ---- Nova Agent, through Nova Bot's link ----
  await check(`Nova Agent is linked (${WHERE === "server" ? "the server's" : "the PC's"})`, async () => {
    const s = await call("/nova-agent/link/status");
    must(s.connected, "Nova Bot has no Nova Agent linked");
    must((s.where || "pc") === WHERE, `the linked Nova Agent is the ${s.where || "pc"}'s`);
    return `linked since ${s.since}, where: ${s.where || "pc"}`;
  });

  await check("Agent answers a real question", async () => {
    const r = await call("/actions/chat", { method: "POST", body: { message: "This is an automatic test. What is 17 + 25? Reply with just the number." }, timeout: 180_000 });
    must(r.ok && typeof r.reply === "string", "no reply");
    must(/\b42\b/.test(r.reply), `the reply was: ${r.reply.slice(0, 80)}`);
    await call("/actions/chat/clear", { method: "POST", body: {} });
    return `“${r.reply.trim().slice(0, 40)}” (test chat cleared)`;
  });

  let questCount = 0;
  await check("Quests and plans load", async () => {
    const s = await call("/quests/state?who=everyone");
    must(Array.isArray(s.quests), "no quests in the answer");
    questCount = s.quests.length;
    return `${s.quests.length} quests`;
  });

  await check("A quest can be added and removed", async () => {
    const add = await call("/actions/quests", { method: "POST", body: { title: "Laptop-off test quest", minutes: 15 } });
    const id = add?.result?.id;
    must(id, "it wasn't added");
    const mid = await call("/quests/state");
    must(mid.quests.some((q) => q.id === id), "the new quest isn't in the plan");
    await call(`/actions/quests/${id}`, { method: "POST", body: { action: "remove" } });
    const after = await call("/quests/state");
    must(!after.quests.some((q) => q.id === id), "it's still there after removing");
    return "added, seen in the plan, removed";
  });

  await check("Calendar (with its own notes) loads and saves", async () => {
    const data = await call("/calendar-api/data");
    must(Array.isArray(data.notes) && Array.isArray(data.days), "not calendar data");
    const saved = await call("/calendar-api/data", { method: "PUT", body: data, headers: { "X-Nova-Rev": String(data.rev ?? "") } });
    must(saved.ok, saved.message || "not saved");
    return `${data.notes.length} notes, ${data.days.length} days; saved unchanged (rev ${saved.rev})`;
  });

  await check("Calendar's live updates connect", async () => {
    const res = await call("/calendar-api/events", { raw: true, headers: { Accept: "text/event-stream" }, timeout: 15_000 });
    must(res.ok, `answered ${res.status}`);
    must((res.headers.get("content-type") || "").includes("text/event-stream"), "not an event stream");
    await res.body?.cancel().catch(() => {});
    return "stream open";
  });

  await check("Notes: shared notes sync", async () => {
    const r = await call("/notes-api/changes?since=0");
    must(Array.isArray(r.notes), "no notes list");
    return `${r.notes.length} shared notes${r.more ? "+" : ""}`;
  });

  await check("Board: lists, a card saves, the board opens again", async () => {
    const list = await call("/board-api/boards");
    must(Array.isArray(list.boards), "no boards list");
    const id = `laptop-off-${randomBytes(4).toString("hex")}`;
    const now = new Date().toISOString();
    const card = { id: "c-test-1", kind: "sticky", x: 40, y: 40, w: 200, h: 160, z: 1, turn: 0, pinned: false, created: now, updated: now, text: "Laptop-off test", colour: "teal" };
    const put = await call(`/board-api/boards/${id}`, { method: "PUT", body: { board: { id, name: "Laptop-off test", cards: [card] } } });
    must(put.ok && put.board?.cards?.length === 1, put.message || "the card didn't save");
    const again = await call("/board-api/boards");
    const mine = again.boards.find((b) => b.id === id);
    must(mine && mine.cards?.length === 1, "the saved board didn't open again with its card");
    await call(`/actions/board/${id}/remove`, { method: "POST", body: {} });
    return `${list.boards.length} boards before; test board saved, reopened, removed`;
  });

  await check("Files list", async () => {
    const r = await call("/files/list");
    must(Array.isArray(r.files), "no files list");
    return `${r.files.length} files`;
  });

  await check("Console: status", async () => {
    const s = await call("/status");
    must(typeof s.live === "boolean", "not Nova Agent's status");
    return `live: ${s.live}, linked: ${s.connected}, model: ${s.model}`;
  });
  await check("Console: quests list", async () => {
    const s = await call("/quests/state");
    must(Array.isArray(s.quests), "no quests");
    return `${s.quests.length} of the test person's own`;
  });
  await check("Console: calendar today", async () => {
    const data = await call("/calendar-api/data");
    const today = new Intl.DateTimeFormat("en-CA", { timeZone: "Europe/London" }).format(new Date());
    const n = data.notes.filter((x) => String(x.date || "").startsWith(today)).length;
    return `${n} on the calendar today (${today})`;
  });
  await check("Console: terminals stay off online", async () => {
    const s = await call("/console-api/state");
    must(s.terminals === false, "terminals said they'd open online");
    return s.why ? s.why.slice(0, 90) : "refused";
  });

  await check("Index cache (Nova Agent's memory)", async () => {
    const c = await call("/cache");
    must(c && typeof c === "object", "no cache");
    return `${Object.keys(c).length} entries`;
  });
  await check("Index search", async () => {
    const r = await call("/app/api/memory/index?q=studio");
    must(Array.isArray(r.files), "no results list");
    return `${r.files.length} results for “studio”`;
  });

  await check("Fixer status", async () => {
    const s = await call("/fixer-api/state");
    must(s && typeof s === "object" && !s.error, "no Fixer state");
    const waiting = Array.isArray(s.needsYou) ? s.needsYou.length : "?";
    return `${waiting} waiting for an admin; hourly checks ${s.settings?.hourly === false ? "off" : "on"}`;
  });

  // ---- Phones, the website, Portal, emails ----
  await check("Reminders reach phones (a push sent from the server)", async () => {
    if (!PUSH) return "skipped (PUSH=0)";
    const key = envValue("/srv/nova/secrets.env", "AGENT_NOVA_KEY");
    must(key, "no AGENT_NOVA_KEY on the server");
    const res = await fetch(`${URL_}/nova-agent/notify`, {
      method: "POST",
      headers: { Authorization: `Bearer ${key}`, "Content-Type": "application/json" },
      body: JSON.stringify({ title: "Laptop-off test", message: "Reminders reach your phone with the laptop off. Nothing to do.", source: "quest", kind: "test", tag: "laptop-off-test", ttl: 900, keep: false }),
      signal: AbortSignal.timeout(30_000),
    });
    const r = await res.json().catch(() => ({}));
    must(res.ok && r.ok, `answered ${res.status}`);
    must(r.phones > 0, "sent, but no phone is signed up for the studio owner's reminders (add one: Nova Agent → Alerts on the phone)");
    return `delivered to ${r.phones} phone${r.phones === 1 ? "" : "s"}`;
  });

  await check("Website chat answers", async () => {
    const res = await fetch(`${URL_}/status/test-chat`, { method: "POST", redirect: "manual", signal: AbortSignal.timeout(90_000) });
    const where = res.headers.get("location") || "";
    if (/answered/.test(where)) return "a real chat round trip";
    if (/less(%20|\+| )than/.test(where)) {
      const s = await (await fetch(`${URL_}/status.json`)).json();
      const chat = s.parts.find((p) => p.id === "chat");
      must(chat?.state === "green", `tested a moment ago and it was ${chat?.state}`);
      return "tested within the last minute: green";
    }
    throw new Error(`no answer (${where || res.status})`);
  });

  await check("Booking form opens with free times", async () => {
    // (as the studio's website, where the chat and its booking card live)
    const post = (path, body) => fetch(`${URL_}${path}`, { method: "POST", headers: { "Content-Type": "application/json", Origin: "https://novacane.co.uk" }, body: JSON.stringify(body), signal: AbortSignal.timeout(30_000) }).then((r) => r.json());
    const open = await post("/booking-form/open", {});
    must(open && open.form, "the booking card didn't open");
    const types = open.form.sessions || open.form.types || open.form.sessionTypes || [];
    const first = types[0];
    if (!first) return "opens (no session types to try times with)";
    const date = new Intl.DateTimeFormat("en-CA", { timeZone: "Europe/London" }).format(new Date(Date.now() + 2 * 864e5));
    const times = await post("/booking-form/times", { session_type_id: first.id, date });
    must(Array.isArray(times.times) && !/couldn't check/i.test(times.message || ""), times.message || "no times answer");
    return `${types.length} session types; ${times.times.length} free times on ${date}${times.message ? ` (${times.message.slice(0, 40)})` : ""}`;
  });

  const sections = { me: "/app/api/me", enquiries: "/app/api/enquiries", clients: "/app/api/clients", campaigns: "/app/api/campaigns", services: "/app/api/services", alerts: "/app/api/notifications", quests: "/app/api/quests", links: "/app/api/links", bookings: "/app/api/booking-actions", social: "/app/api/social", money: "/app/api/money", inbox: "/app/api/inbox/saved", phones: "/app/api/push/phones" };
  await check("Portal sections", async () => {
    const bad = [];
    for (const [name, path] of Object.entries(sections)) {
      try {
        await call(path, { headers: { "X-Nova-App": "portal" } });
      } catch (err) {
        bad.push(`${name} (${String(err.message).replace(/^GET \S+ /, "")})`);
      }
    }
    must(!bad.length, `not loading: ${bad.join(", ")}`);
    return `${Object.keys(sections).length} sections load`;
  });

  await check("Emails send (the server's own mail)", async () => {
    if (!MAIL) return "skipped (MAIL=0)";
    const key = envValue("/srv/nova/mail.env", "MAIL_KEY");
    must(key, "no mail key");
    const res = await fetch("http://127.0.0.1:8790/emails", {
      method: "POST",
      headers: { Authorization: `Bearer ${key}`, "Content-Type": "application/json" },
      body: JSON.stringify({ from: "Novacane Studios <hello@novacane.co.uk>", to: [TO], subject: "Nova full laptop-off test", text: "This is the full laptop-off test: the studio PC was off and Nova still sent this email. Nothing to do." }),
      signal: AbortSignal.timeout(30_000),
    });
    must(res.ok, `answered ${res.status}`);
    return `sent to ${TO.replace(/^(.).*@/, "$1…@")}`;
  });

  await check("Status page all green, with Nova Agent on the server", async () => {
    sql("DELETE FROM settings WHERE key = 'status_cache';");
    const s = await (await fetch(`${URL_}/status.json`, { signal: AbortSignal.timeout(60_000) })).json();
    const row = s.parts.find((p) => p.id === "pc");
    must(row?.name === "Nova Agent", "no Nova Agent row");
    if (WHERE === "server") must(row.state === "green" && /^On the server/.test(row.text), `Nova Agent row: ${row.state}, “${row.text.slice(0, 60)}”`);
    const notGreen = s.parts.filter((p) => p.state !== "green").map((p) => `${p.name} ${p.state}`);
    must(!notGreen.length, `not green: ${notGreen.join(", ")}`);
    return `${s.parts.length} parts green; Nova Agent: ${row.text.split(":")[0].toLowerCase()}`;
  });
} finally {
  signOut();
}

const failed = results.filter((r) => !r.ok);
console.log(JSON.stringify({ passed: !failed.length, checks: results.filter((r) => r.ok).map((r) => r.name), failed: failed.map((r) => r.name) }));
process.exit(failed.length ? 1 : 0);

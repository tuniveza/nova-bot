// Google, everywhere it helps: the schedule, Portal's Admin → Google, and Nova Agent's read tools.
// The parts: calendar.js, gmail.js, contacts.js, drive.js, sheets.js (what they share: common.js).
//
//   Portal (/app/api/google…, signed-in staff; setting up and options for admins):
//     GET  /google                 everything Portal's Google page shows: the setup steps (with
//                                  what to copy), connected as whom, which parts are on, how each
//                                  last went, the Drive folder and the Money sheet
//     POST /google/key             { clientId, clientSecret }   the key made in Google Cloud
//     POST /google/key/remove
//     POST /google/disconnect
//     POST /google/options         { changes: { calendar: false, … } }
//     POST /google/sync            { part }   do that part now
//     POST /google/docs            { title, html } -> { url }   a note as a Google Doc (any staff)
//     POST /google/sheet           -> { url }   Money's sheet brought up to date (any staff)
//   Connecting itself is Nova Bot's /admin/google (Google's consent page, in a small window).
//
//   Nova Agent (/nova-agent/google/…, its key): read-only for its AI, and the PC's file copies
//     busy { from, to }     the studio's busy times in Google Calendar
//     gmail/search { q }    who, subject, when and a snippet (no whole emails)
//     contacts/find { q }   names, emails and phones
//     drive/put?kind=&id=&name=&type=   (body: the file) a copy of a picture, video, receipt or backup
//     drive/drop { kind, id }
//     status                what's connected (so the PC knows whether to send copies)
//
// Every minute (index.js's cron) one part may run, each at its own time, within the free Workers
// plan's 50 calls a run: Calendar every 5 minutes, replies at :20, contacts at :35, the Money sheet
// at :50, backups at about 3am (UK).

import { connectedAccount, disconnect, googleReady, grantedScopes, offline, FEATURE_SCOPES } from "../nova/google.js";
import { clientProblem, googleClient, removeClient, saveClient } from "../nova/google-keys.js";
import { publicUrl } from "../nova/booking.js";
import { OPTIONS, partOn, readOptions, readSetting, readStatus, runPart, setOptions } from "./common.js";
import { busyBetween, syncCalendar } from "./calendar.js";
import { pullReplies, searchGmail } from "./gmail.js";
import { findContacts, syncContacts } from "./contacts.js";
import { backupIndex, dropFile, folderUrl, keepFile, makeDoc } from "./drive.js";
import { refreshSheet, sheetStatus } from "./sheets.js";

const PC_ORIGIN = "http://localhost:4545";
const MAX_FILE = 100 * 1024 * 1024;
const BUDGET = 40;

// ===== THE PARTS =====

const PARTS = {
  calendar: { label: "Calendar", option: "calendar", run: (env, budget) => syncCalendar(env, budget) },
  replies: { label: "Replies", option: "replies", run: (env, budget) => pullReplies(env, budget) },
  contacts: { label: "Contacts", option: "contacts", run: (env, budget) => syncContacts(env, budget) },
  sheets: { label: "Money sheet", option: "sheets", run: async (env) => ((await refreshSheet(env)).written ? "Brought up to date · " : "Up to date · ") + (await sheetStatus(env)) },
  backups: { label: "Backups", option: "backups", run: (env) => backupIndex(env) },
};

export async function runGooglePart(env, name) {
  const part = PARTS[name];
  if (!part || !(await partOn(env, part.option))) return { ok: false, skipped: true };
  return runPart(env, name, () => part.run(env, { left: BUDGET }));
}

const ukClock = (at) => {
  const parts = new Intl.DateTimeFormat("en-GB", { timeZone: "Europe/London", hour: "2-digit", minute: "2-digit", hourCycle: "h23" }).formatToParts(new Date(at));
  return { h: Number(parts.find((p) => p.type === "hour").value), m: Number(parts.find((p) => p.type === "minute").value) };
};

// Every minute: at most one part, at its own time
export async function googleOnSchedule(env, at = Date.now()) {
  if (offline(env) || !(await googleReady(env).catch(() => false))) return null;
  const { h, m } = ukClock(at);
  const name = h === 3 && m === 10 ? "backups" : m === 20 ? "replies" : m === 35 ? "contacts" : m === 50 ? "sheets" : m % 5 === 0 ? "calendar" : null;
  if (!name) return null;
  return { part: name, ...(await runGooglePart(env, name)) };
}

// ===== PORTAL =====

// The setup, one sentence per step: what to press, what to copy
function setupSteps(origin) {
  return [
    {
      title: "Switch on Google's features",
      text: "Press the button, pick (or make) a project called Nova Agent, then press Next and Enable.",
      open: { href: "https://console.cloud.google.com/flows/enableapi?apiid=calendar-json.googleapis.com,gmail.googleapis.com,drive.googleapis.com,people.googleapis.com,sheets.googleapis.com,docs.googleapis.com", label: "Open Google Cloud" },
      copy: [],
    },
    {
      title: "Set up Google's permission screen",
      text: "Press Get started. App name: Nova Agent. Pick your own email for both email boxes. Audience: External. Then Create.",
      open: { href: "https://console.cloud.google.com/auth/overview", label: "Open the sign-in screen" },
      copy: ["Nova Agent"],
    },
    {
      title: "Keep it working",
      text: "Press Publish app, then Confirm. (If you skip this, Google stops the connection every 7 days.)",
      open: { href: "https://console.cloud.google.com/auth/audience", label: "Open Audience" },
      copy: [],
    },
    {
      title: "Make the key",
      text: "Type: Web application. Name: Nova Agent. Add the two web addresses under Authorised JavaScript origins and the last one under Authorised redirect URIs, then press Create.",
      open: { href: "https://console.cloud.google.com/auth/clients/create", label: "Make the key" },
      copy: [origin, PC_ORIGIN, `${origin}/admin/google/callback`],
    },
    { title: "Paste the key here", text: "Google shows a Client ID and a Client secret. Copy each one into the boxes below.", key: true, copy: [] },
    { title: "Connect the studio's Google account", text: "Press Connect Google and pick the studio's Google account. Tick every box. If Google says the app isn't verified, press Advanced, then Go to Nova Agent: that's expected.", connect: true, copy: [] },
  ];
}

const json = (data, status = 200) => Response.json(data, { status, headers: { "Cache-Control": "no-store" } });
const answer = (result) => (result?.error ? json({ error: result.error }, result.status || 400) : json({ ok: true, ...result }));

async function readJson(request) {
  try {
    return (await request.json()) || {};
  } catch {
    return {};
  }
}

export async function googleOverview(env, me) {
  const origin = publicUrl(env);
  const client = await googleClient(env);
  const ready = await googleReady(env).catch(() => false);
  const account = ready ? await connectedAccount(env) : "";
  const granted = ready ? await grantedScopes(env) : [];
  const has = Object.fromEntries(Object.entries(FEATURE_SCOPES).map(([k, s]) => [k, granted.includes(s)]));
  const options = await readOptions(env);
  const missing = [...new Set(Object.entries(OPTIONS).filter(([k, o]) => options[k] && !has[o.needs]).map(([, o]) => o.label))];
  return {
    sandbox: offline(env),
    canManage: me.role === "admin",
    hasKey: Boolean(client.id),
    keyFrom: client.from || null,
    keyShort: client.id ? client.id.slice(0, 14) + "…" : null,
    connected: Boolean(ready && account),
    account: account || null,
    connectedAt: (await readSetting(env, "google_connected_at")) || null,
    missing,
    options,
    parts: Object.entries(OPTIONS).map(([k, o]) => ({ id: k, label: o.label, help: o.help, on: options[k], allowed: Boolean(has[o.needs]) })),
    status: await readStatus(env),
    folderUrl: ready ? await folderUrl(env) : null,
    sheetUrl: ready ? await readSetting(env, "google_sheet_url") : null,
    steps: setupSteps(origin),
    connectUrl: `${origin}/admin/google?popup=1`,
  };
}

// Portal's /app/api/google… (app-page.js has checked the sign-in and the Origin). -> a Response, or null
export async function handleGoogleForStaff(request, env, me, route) {
  if (route === "/google" && request.method === "GET") return json(await googleOverview(env, me));
  if (request.method !== "POST") return null;
  // Anyone signed in: a note to Docs, Money's sheet
  if (route === "/google/docs") {
    if (!(await googleReady(env).catch(() => false)) || offline(env) || !(await grantedScopes(env)).includes(FEATURE_SCOPES.drive)) {
      return json({ error: "Google isn't connected for Docs yet (Portal → Admin → Google)." }, 409);
    }
    const body = await readJson(request);
    const html = String(body.html || "");
    if (html.length > 2_000_000) return json({ error: "That note is too big to send." }, 413);
    try {
      return json({ ok: true, ...(await makeDoc(env, { title: String(body.title || "Note").slice(0, 200), html })) });
    } catch (err) {
      return json({ error: "Google Docs didn't take it: " + String(err.message || err).slice(0, 160) }, 502);
    }
  }
  if (route === "/google/sheet") {
    if (!(await partOn(env, "sheets"))) return json({ error: "Money in Google Sheets is off, or Google isn't connected (Portal → Admin → Google)." }, 409);
    try {
      const { url } = await refreshSheet(env, { force: true });
      return json({ ok: true, url });
    } catch (err) {
      return json({ error: "Google Sheets didn't answer: " + String(err.message || err).slice(0, 160) }, 502);
    }
  }
  // Setting Google up: admins
  if (!route.startsWith("/google/")) return null;
  if (me.role !== "admin") return json({ error: "Only an admin can set Google up." }, 403);
  const body = await readJson(request);
  if (route === "/google/key") {
    const id = String(body.clientId || "").trim();
    const secret = String(body.clientSecret || "").trim();
    const problem = clientProblem(id, secret);
    if (problem) return json({ error: problem }, 400);
    await saveClient(env, id, secret);
    return json({ ok: true, message: "Saved ✓ Now press Connect Google." });
  }
  if (route === "/google/key/remove") {
    await removeClient(env);
    return json({ ok: true });
  }
  if (route === "/google/disconnect") {
    await disconnect(env);
    return json({ ok: true });
  }
  if (route === "/google/options") return json({ ok: true, options: await setOptions(env, body.changes) });
  if (route === "/google/sync") {
    const name = String(body.part || "");
    if (!PARTS[name]) return json({ error: "Which part? calendar, replies, contacts, sheets or backups." }, 400);
    const result = await runGooglePart(env, name);
    if (result.skipped) return json({ error: "That part is off, or Google isn't connected with its permission." }, 409);
    return answer(result.ok ? { note: result.note } : { error: result.error, status: 502 });
  }
  return null;
}

// ===== NOVA AGENT =====

// /nova-agent/google/… (agent-nova.js has checked the key). drive/put reads the request's body itself.
export async function handleGoogleForAgent(request, env, pathname, body) {
  if (pathname === "/nova-agent/google/status") {
    const ready = await googleReady(env).catch(() => false);
    return json({ connected: ready && !offline(env), drive: await partOn(env, "drive").catch(() => false), backups: await partOn(env, "backups").catch(() => false) });
  }
  if (pathname === "/nova-agent/google/drive/put") {
    const url = new URL(request.url);
    const kind = url.searchParams.get("kind");
    const id = String(url.searchParams.get("id") || "");
    if (!["media", "receipt", "backup"].includes(kind) || !/^[\w.:/-]{1,120}$/.test(id) || id.includes("..")) return json({ error: "kind (media, receipt or backup) and id, please." }, 400);
    if (!(await partOn(env, kind === "backup" ? "backups" : "drive"))) return json({ skipped: true, reason: "Google Drive is off or not connected." });
    const size = Number(request.headers.get("Content-Length") || 0);
    if (size > MAX_FILE) return json({ error: "That's too big for Drive here (100 MB at most)." }, 413);
    const bytes = new Uint8Array(await request.arrayBuffer());
    if (!bytes.byteLength || bytes.byteLength > MAX_FILE) return json({ error: "No file, or too big." }, 400);
    const type = /^[\w.+-]+\/[\w.+-]+$/.test(url.searchParams.get("type") || "") ? url.searchParams.get("type") : "application/octet-stream";
    const name = String(url.searchParams.get("name") || id).replace(/[\r\n/\\]/g, " ").slice(0, 200);
    try {
      return json({ ok: true, fileId: await keepFile(env, { kind, novaId: id, name, type, bytes }) });
    } catch (err) {
      return json({ error: "Google Drive didn't take it: " + String(err.message || err).slice(0, 160) }, 502);
    }
  }
  if (pathname === "/nova-agent/google/drive/drop") {
    if (!["media", "receipt", "backup"].includes(body?.kind) || typeof body?.id !== "string") return json({ error: "kind and id, please." }, 400);
    if (!(await googleReady(env).catch(() => false))) return json({ skipped: true });
    return json({ ok: true, dropped: await dropFile(env, body.kind, body.id) });
  }
  // The AI's read tools
  const need = { "/nova-agent/google/busy": "calendar", "/nova-agent/google/gmail/search": "replies", "/nova-agent/google/contacts/find": "contacts" }[pathname];
  if (!need) return json({ error: "Not found" }, 404);
  if (!(await googleReady(env).catch(() => false)) || !(await grantedScopes(env)).includes(FEATURE_SCOPES[need])) {
    return json({ error: "Google isn't connected for that yet (Portal → Admin → Google)." }, 409);
  }
  try {
    if (need === "calendar") {
      const from = Date.parse(body?.from || "") || Date.now();
      const to = Date.parse(body?.to || "") || from + 7 * 86400000;
      if (to <= from || to - from > 62 * 86400000) return json({ error: "from and to: up to two months apart." }, 400);
      return json({ busy: await busyBetween(env, new Date(from).toISOString(), new Date(to).toISOString()) });
    }
    if (need === "replies") {
      const q = String(body?.q || "").trim();
      if (!q) return json({ error: "What to search for (q)?" }, 400);
      return json({ messages: await searchGmail(env, q, Number(body?.max) || 8) });
    }
    const q = String(body?.q || "").trim();
    if (!q) return json({ error: "Who to look for (q)?" }, 400);
    return json({ contacts: await findContacts(env, q) });
  } catch (err) {
    return json({ error: "Google didn't answer: " + String(err.message || err).slice(0, 160) }, 502);
  }
}

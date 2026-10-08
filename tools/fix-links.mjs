// Brings Admin → Links (the "url_directory" setting in D1) up to date with Nova Agent as one app:
// plain panel names, Hub folded into Portal, every panel at its address on Nova Bot, the
// Nova Agent addresses at /nova-agent/*, and the old standalone sites and deleted folders gone.
//
// The list is only in the database (src/links.js), so this reads the live copy and writes SQL:
//   npx wrangler d1 execute novabot --remote --json --command "SELECT value FROM settings WHERE key='url_directory'" > links-now.json
//   node tools/fix-links.mjs links-now.json links-fix.sql
//   npx wrangler d1 execute novabot --remote --file links-fix.sql
// Running it again on an already-fixed list changes nothing.
import { readFileSync, writeFileSync } from "node:fs";
import { cleanLinks } from "../src/links.js";

const [input, output] = process.argv.slice(2);
if (!input || !output) {
  console.error("Usage: node tools/fix-links.mjs <wrangler --json output> <sql file to write>");
  process.exit(1);
}
let text = readFileSync(input, "utf8");
text = text.slice(text.indexOf("[")); // wrangler may print a line or two before the JSON
const rows = JSON.parse(text)[0].results;
if (!rows.length) throw new Error("There's no url_directory in the database yet.");
const list = JSON.parse(rows[0].value);

const W = "https://novacane-worker.novacane-studio.workers.dev";
const A = "http://localhost:4545";
const today = new Date().toISOString().slice(0, 10);

// Plain names: only Nova Agent, Nova Bot and Nova Club keep "Nova"
const plain = (s) =>
  String(s || "")
    .replace(/\bNova Hub\b/g, "Portal")
    .replace(/\bNova Portal\b/g, "Portal")
    .replace(/\bNova Index\b/g, "Index")
    .replace(/\bNova Notes\b/g, "Notes")
    .replace(/\bNova Calendar\b/g, "Calendar")
    .replace(/\bNova Observatory\b/g, "Observatory")
    .replace(/\bthe Nova suite\b/gi, "Nova Agent")
    .replace(/\bPortal and Portal\b/g, "Portal");

// Items in a group: renamed and moved by their address, dropped, or added
const RETIRED = [/\/\/nova-notes\./, /\/\/nova-calendar\./, /localhost:4610/, /github\.com\/tuniveza\/nova-portal$/];
const HUB = /\/app\/?$/;
const MOVED = [
  [/\/hub\/agent\/next$/, `${W}/nova-agent/next`],
  [/\/hub\/agent\/quests$/, `${W}/nova-agent/quests`],
  [/\/hub\/notify$/, `${W}/nova-agent/notify`],
];
const team = [
  { name: "Portal", url: `${W}/portal/`, kind: "live", note: "One sign-in; enquiries, chats, calendar, quests, alerts and Nova Bot (what Hub was); your profile and planet, the team, invites" },
  { name: "Index", url: `${W}/app/memory/`, kind: "live", note: "Everything Nova Agent remembers: browse, edit, approve (Portal sign-in)" },
  { name: "Calendar", url: `${W}/calendar/`, kind: "live", note: "Note cards and day cards; online it saves in the browser" },
  { name: "Notes", url: `${W}/notes/`, kind: "live", note: "Notes and documents, Google Docs export; online it saves in the browser" },
  { name: "Observatory", url: `${W}/observatory/`, kind: "live", note: "Every project, lines of code and the star map (projects for signed-in staff)" },
  { name: "Lossless audio", url: `${W}/lossless/`, kind: "live", note: "Raw PCM between two devices, anywhere (TURN relay once its key is set)" },
];
const agent = [
  { name: "Nova Agent: Portal", url: `${A}/portal/`, kind: "local", note: "Portal inside Nova Agent, signed in as you" },
  { name: "Nova Agent: Observatory", url: `${A}/observatory/`, kind: "local", note: "The project dashboard (always on)" },
  { name: "Nova Agent: Lossless audio", url: `${A}/lossless/`, kind: "local", note: "The same page; calls go through Nova Bot, so the other device can be anywhere" },
];

const byUrl = (items, url) => items.findIndex((i) => i.url.replace(/\/$/, "") === url.replace(/\/$/, ""));
function upsert(items, add, at = items.length) {
  const i = byUrl(items, add.url);
  if (i >= 0) items[i] = { ...items[i], ...add };
  else items.splice(at, 0, add);
}

for (const g of list.groups || []) {
  g.title = plain(g.title);
  g.note = plain(g.note);
  g.items = (g.items || [])
    .filter((i) => !RETIRED.some((r) => r.test(i.url)))
    // Hub is part of Portal now: its own entry goes (Portal's says what it does)
    .filter((i) => !(i.url.startsWith(W) && HUB.test(i.url)))
    .map((i) => {
      const moved = MOVED.find(([r]) => r.test(i.url));
      return { ...i, name: plain(i.name).replace(/^Nova Agent: plan for Portal$/, "Nova Agent: its plan (Portal's Quests)"), url: moved ? moved[1] : i.url, note: plain(i.note) };
    });
  if (/studio team/i.test(g.title)) {
    g.note = "Nova Agent's panels, online for phones and anywhere away from the studio PC. Sign in once with Portal.";
    team.forEach((t, n) => upsert(g.items, t, n));
  }
  if (/^Nova Agent\b/.test(g.title)) {
    for (const i of g.items) {
      if (i.url === `${A}/calendar/`) i.name = "Nova Agent: Calendar";
      if (i.url === `${A}/notes/`) i.name = "Nova Agent: Notes";
      if (i.url === `${A}/app/memory/`) i.name = "Nova Agent: Index";
      if (i.url === `${A}/observatory/`) i.name = "Nova Agent: Observatory";
    }
    for (const a of agent) upsert(g.items, a);
  }
  if (/behind the scenes/i.test(g.title)) {
    upsert(g.items, { name: "Lossless audio: calls", url: `${W}/lossless/ice`, kind: "machine", note: "Relay setup for a call; signalling is /lossless/ws" });
  }
  if (/^Accounts/i.test(g.title)) {
    for (const i of g.items) if (/dash\.cloudflare\.com/.test(i.url)) i.note = "Nova Bot (with Nova Agent's panels online)";
  }
}

for (const f of list.features || []) {
  f.app = plain(f.app);
  f.note = plain(f.note);
  for (const i of f.items || []) {
    i.name = plain(i.name);
    i.detail = plain(i.detail);
  }
}
// Hub's features are Portal's now: one Portal entry, Portal's own first
const portals = (list.features || []).filter((f) => f.app === "Portal");
if (portals.length > 1) {
  const [hub, own] = portals[0].note.includes("phone") ? portals : [portals[1], portals[0]];
  own.note = "One sign-in, and the studio's phone and web app: enquiries, chats, calendar, quests, alerts, Nova Bot, the team.";
  own.items = [...own.items, ...hub.items.filter((h) => !own.items.some((o) => o.name === h.name))];
  list.features = list.features.filter((f) => f !== hub);
}
for (const f of list.features || []) {
  if (f.app === "Index") f.note = "Nova Agent's memory, and the panel to see it.";
  if (f.app === "Observatory") f.note = "The project dashboard: a panel of Nova Agent, and online at /observatory/ for signed-in staff.";
  if (f.app === "Notes") f.note = "A note editor in Nova Agent's look; a panel of Nova Agent, and online at /notes/.";
  if (f.app === "Calendar") f.note = "Note cards and day cards; a panel of Nova Agent, and online at /calendar/.";
}

// The change, in the changelog (once)
const entry = {
  date: today,
  app: "Nova Agent",
  size: "small",
  title: "Every panel at its real address",
  what: "Links now lists the panels by their plain names and real addresses on Nova Bot, with Observatory and Lossless audio online too. The old standalone Notes and Calendar sites now move people (and their saved notes) to the new addresses.",
  why: "The list still pointed at addresses from before Nova Agent became one app.",
  benefit: "Every link here opens the app you expect.",
};
list.changelog = list.changelog || [];
if (!list.changelog.some((c) => c.title === entry.title)) list.changelog.unshift(entry);

const clean = cleanLinks(list);
const sql = `UPDATE settings SET value = '${JSON.stringify(clean).replace(/'/g, "''")}' WHERE key = 'url_directory';\n`;
writeFileSync(output, sql);

const urls = clean.groups.flatMap((g) => g.items.map((i) => `${g.title} · ${i.name} · ${i.url}`));
console.log(urls.join("\n"));
console.log(`\nWrote ${output}: ${clean.groups.length} groups, ${urls.length} links, ${clean.features.length} feature lists, ${clean.changelog.length} changes.`);

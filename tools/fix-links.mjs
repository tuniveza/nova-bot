// Brings Admin → Links (the "url_directory" setting in D1) up to date with Nova Agent as the one
// app: for the studio team there's Nova Agent online (Nova Bot's main address) and on the studio
// computer, and the panels (Portal, Calendar, Notes, Index, Observatory, Lossless audio, Admin)
// are inside it, so they aren't listed one by one. Also: plain names, Hub folded into Portal, the
// Nova Agent addresses at /nova-agent/*, and the old standalone sites and dead addresses gone.
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
const RETIRED = [/\/\/nova-notes\./, /\/\/nova-calendar\./, /\/\/nova-agent\.novacane-studio\./, /localhost:4610/, /github\.com\/tuniveza\/nova-portal$/];
// The panels' own addresses (online and on the studio computer): they open inside Nova Agent now
const PANEL = new RegExp(`^(${W}|${A})/(portal|calendar|notes|app/memory|observatory|lossless|visualizer|admin)(/|$)`);
const HUB = /\/app\/?$/;
const MOVED = [
  [/\/hub\/agent\/next$/, `${W}/nova-agent/next`],
  [/\/hub\/agent\/quests$/, `${W}/nova-agent/quests`],
  [/\/hub\/notify$/, `${W}/nova-agent/notify`],
];
const team = [
  { name: "Nova Agent", url: `${W}/agent/`, kind: "live", note: "The studio's one app, anywhere: chat, Missions and Quests (through the studio PC), with Portal, Calendar, Notes, Index, Observatory, Lossless audio and Admin inside it. Sign in once with the planet at the top." },
  { name: "Nova Agent on the studio computer", url: `${A}/agent/`, kind: "local", note: "The same app, on the studio PC (where its chat, Missions and Quests run)" },
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
  // The panels are inside Nova Agent: no separate links for them (or for Nova Agent's own pages)
  g.items = g.items.filter((i) => i.kind === "machine" || (!PANEL.test(i.url) && !(/^Nova Agent\b/.test(g.title) && i.url.startsWith(A))));
  if (/studio team/i.test(g.title)) {
    g.note = "Nova Agent is the one app: everything for the team is inside it.";
    team.forEach((t, n) => upsert(g.items, t, n));
  }
  if (/behind the scenes/i.test(g.title)) {
    upsert(g.items, { name: "Lossless audio: calls", url: `${W}/lossless/ice`, kind: "machine", note: "Relay setup for a call; signalling is /lossless/ws" });
  }
  if (/^Accounts/i.test(g.title)) {
    for (const i of g.items) if (/dash\.cloudflare\.com/.test(i.url)) i.note = "Nova Bot (with Nova Agent's panels online)";
  }
}

// A group left with nothing in it (Nova Agent's studio-computer pages) goes
list.groups = (list.groups || []).filter((g) => g.items.length);

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
  if (f.app === "Observatory") f.note = "The project dashboard: a panel of Nova Agent (projects for signed-in staff).";
  if (f.app === "Notes") f.note = "A note editor in Nova Agent's look: a panel of Nova Agent.";
  if (f.app === "Calendar") f.note = "Note cards and day cards: a panel of Nova Agent.";
}

// The change, in the changelog (once)
const entry = {
  date: today,
  app: "Nova Agent",
  size: "major",
  title: "Nova Agent is the one app, everywhere",
  what: "Nova Agent is at Nova Bot's main address online, as well as on the studio PC. Portal, Calendar, Notes, Index, Observatory, Lossless audio and Admin open only inside it; their old addresses open Nova Agent with that panel. One home-screen app, one sign-in (the planet at the top).",
  why: "There were pages and pages of separate apps; Nova Agent is the only app there is.",
  benefit: "One address, one app to install, and everything in one place.",
};
list.changelog = list.changelog || [];
if (!list.changelog.some((c) => c.title === entry.title)) list.changelog.unshift(entry);

const clean = cleanLinks(list);
const sql = `UPDATE settings SET value = '${JSON.stringify(clean).replace(/'/g, "''")}' WHERE key = 'url_directory';\n`;
writeFileSync(output, sql);

const urls = clean.groups.flatMap((g) => g.items.map((i) => `${g.title} · ${i.name} · ${i.url}`));
console.log(urls.join("\n"));
console.log(`\nWrote ${output}: ${clean.groups.length} groups, ${urls.length} links, ${clean.features.length} feature lists, ${clean.changelog.length} changes.`);

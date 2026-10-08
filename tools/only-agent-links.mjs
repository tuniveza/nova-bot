// Admin → Links (the "url_directory" setting in D1) down to the one address there is: Nova Agent,
// https://novacane-worker.novacane-studio.workers.dev/agent/. Everything else in the list goes.
// The list as it was is saved to a file on this computer first (never to the repo: it's public).
//
//   npx wrangler d1 execute novabot --remote --json --command "SELECT value FROM settings WHERE key='url_directory'" > links-now.json
//   node tools/only-agent-links.mjs links-now.json links-fix.sql ~/an/pj/ns/links-before-agent-only.json
//   npx wrangler d1 execute novabot --remote --file links-fix.sql
// Running it again changes nothing.
import { readFileSync, writeFileSync } from "node:fs";
import { cleanLinks } from "../src/links.js";

const [input, output, backup] = process.argv.slice(2);
if (!input || !output || !backup) {
  console.error("Usage: node tools/only-agent-links.mjs <wrangler --json output> <sql file to write> <backup file for the old list>");
  process.exit(1);
}
let text = readFileSync(input, "utf8");
text = text.slice(text.indexOf("[")); // wrangler may print a line or two before the JSON
const rows = JSON.parse(text)[0].results;
if (!rows.length) throw new Error("There's no url_directory in the database yet.");
const list = JSON.parse(rows[0].value);
writeFileSync(backup, JSON.stringify(list, null, 2) + "\n");

list.groups = [
  {
    title: "Nova Agent",
    note: "The only address. Everything is inside it; any other address opens it.",
    items: [
      {
        name: "Nova Agent",
        url: "https://novacane-worker.novacane-studio.workers.dev/agent/",
        kind: "live",
        note: "Chat, Missions and Quests, with Portal, Calendar, Notes, Index, Observatory, Lossless audio and Admin inside. Sign in with the planet at the top.",
      },
    ],
  },
];
const entry = {
  date: new Date().toISOString().slice(0, 10),
  app: "Nova Agent",
  size: "major",
  title: "One address: Nova Agent at /agent/",
  what: "https://novacane-worker.novacane-studio.workers.dev/agent/ is the only address. Any other page, old link or panel address opens Nova Agent (with that panel); the old Notes, Calendar and Lossless sites go there too.",
  why: "Nova Agent is the Nova app for everyone, so it should be the only place to go.",
  benefit: "One link to remember, share and install.",
};
list.changelog = list.changelog || [];
if (!list.changelog.some((c) => c.title === entry.title)) list.changelog.unshift(entry);

const clean = cleanLinks(list);
writeFileSync(output, `UPDATE settings SET value = '${JSON.stringify(clean).replace(/'/g, "''")}' WHERE key = 'url_directory';\n`);
console.log(clean.groups.flatMap((g) => g.items.map((i) => `${g.title} · ${i.name} · ${i.url}`)).join("\n"));
console.log(`\nWrote ${output}. The list as it was is in ${backup}.`);

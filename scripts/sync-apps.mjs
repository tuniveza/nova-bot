// Nova Agent online: the one app, at Nova Bot's main address, with its panels inside it (for
// phones and anywhere away from the studio PC; they share Nova Bot's sign-in and staff API).
// They live in Nova Agent's repo (web/), so before every deploy or local run (wrangler's build
// step) they're copied in:
//   na/web/agent/chat.html → public/agent/index.html   Nova Agent's page (/agent/)
//   na/web/agent/assets    → public/agent/       its icons; its manifest and service worker also
//                                                 go to the top (public/manifest.webmanifest, public/sw.js)
//   na/web/agent/page.html → public/visualizer.html   the Visualizer panel
//   na/web/portal    → public/portal/     Portal: sign-in, enquiries, chats, bookings, alerts,
//                                         push, your planet, the crew
//   na/web/portal/old-app-address → public/app/   what phones that installed Portal from its old address, /app/
//                                         still use: its push helper (sw.js), manifest and icons
//   na/web/index     → public/app/memory/ Index
//   na/web/calendar  → public/calendar/   Calendar (online, it saves in the browser)
//   na/web/quests    → public/quests/     Quests (online, its quests are Nova Agent's, through the link)
//   na/web/board     → public/board/      Board (online, it saves on the studio PC through the link)
//   na/web/console   → public/console/    Console (online: Nova commands only; terminals open on the studio PC itself)
//   na/web/notes     → public/notes/      Notes
//   na/web/shared    → public/shared/     the look, sounds, badge and manual they share
//   na/web/observatory → public/observatory/ Observatory (its projects and media only for signed-in staff)
//   na/web/lossless/public/lossless → public/lossless/  Lossless audio's page
//   na/web/fixer     → public/fixer/      the Fixer (its data comes from the studio PC, admins only)
//   na/web/lossless/src  → src/lossless/  its signalling (LosslessRoom) and relay setup (/lossless/ice)
//   na/web/portal/planet → src/portal/planet/  the planet generator (also draws planet.svg)
// NOVA_AGENT_DIR points somewhere else than ../../na (e.g. a branch's worktree).
// The page copies are never saved in this repo (.gitignore); the planet generator and
// Lossless copies are, so this project still builds and tests on its own.
// Observatory's scan (data/) and screenshots (media/) aren't in Nova Agent's git: they're made on
// the studio PC. A clean worktree has none, so they come from the studio PC's own Nova Agent folder.
import { cpSync, existsSync, rmSync } from "node:fs";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";

const here = (p) => fileURLToPath(new URL(p, import.meta.url));
const agent = process.env.NOVA_AGENT_DIR ? resolve(process.env.NOVA_AGENT_DIR) : here("../../../na");
const copies = [
  ["web/agent/assets/", "../public/agent/", "Nova Agent's icons"],
  ["web/agent/chat.html", "../public/agent/index.html", "Nova Agent"],
  ["web/agent/assets/manifest.webmanifest", "../public/manifest.webmanifest", "Nova Agent's manifest"],
  ["web/agent/assets/sw.js", "../public/sw.js", "Nova Agent's service worker"],
  ["web/agent/page.html", "../public/visualizer.html", "Visualizer"],
  ["web/agent/calendar-sync.js", "../public/calendar-sync.js", "Calendar's link to Nova Agent's calendar"],
  ["web/portal/old-app-address/", "../public/app/", "Portal's old address (push helper, manifest, icons)"],
  // after that, which replaces public/app/ whole
  ["web/index/", "../public/app/memory/", "Index"],
  ["web/portal/", "../public/portal/", "Portal"],
  ["web/calendar/", "../public/calendar/", "Calendar"],
  ["web/calendar/js/recur.js", "../src/calendar/recur.js", "Calendar's repeat rules (for reminders on phones)"],
  ["web/notes/", "../public/notes/", "Notes"],
  ["web/quests/", "../public/quests/", "Quests"],
  ["web/board/", "../public/board/", "Board"],
  ["web/console/", "../public/console/", "Console"],
  ["web/shared/", "../public/shared/", "the shared look, badge and manual"],
  ["web/portal/planet/", "../src/portal/planet/", "the planet generator"],
  ["web/observatory/", "../public/observatory/", "Observatory"],
  ["web/lossless/public/lossless/", "../public/lossless/", "Lossless audio"],
  ["web/fixer/", "../public/fixer/", "the Fixer"],
  ["web/lossless/src/", "../src/lossless/", "Lossless audio's signalling"],
];
// Nova Agent's page used to be the main address (public/index.html); the main address is Nova Bot's again
rmSync(here("../public/index.html"), { force: true });
for (const [from, to, name] of copies) {
  const src = resolve(agent, from);
  if (!existsSync(src)) {
    if (!existsSync(here(to))) console.log(`${name}: Nova Agent isn't at ${agent}, so it won't be included`);
    continue;
  }
  rmSync(here(to), { recursive: true, force: true });
  // The planet generator is code for this Worker, not a page; tests and samples stay behind
  cpSync(src, here(to), { recursive: true, filter: (f) => !/(test\.mjs|gallery\.html|README\.md)$/.test(f) && !(to.includes("public/portal") && /[\\/](planet|old-app-address)([\\/]|$)/.test(f.slice(src.length - 1))) });
  console.log(`${name}: copied in`);
}

// Observatory's scan and media, from wherever they were made (see the top)
for (const part of ["data", "media"]) {
  const to = here(`../public/observatory/${part}/`);
  if (existsSync(to)) continue;
  const from = [agent, here("../../../na"), resolve(agent, "../na")].map((d) => resolve(d, `web/observatory/${part}/`)).find((d) => existsSync(d));
  if (!from) {
    console.log(`Observatory: no ${part}/ yet (run "npm run scan" in Nova Agent's scripts/observatory), so it shows none`);
    continue;
  }
  cpSync(from, to, { recursive: true });
  console.log(`Observatory: ${part}/ copied in from ${from}`);
}

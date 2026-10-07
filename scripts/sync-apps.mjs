// Nova Agent's panels, served online from here for phones and for anywhere away from
// the studio PC (they share Nova Bot's sign-in and staff API). They live in Nova
// Agent's repo (web/), so before every deploy or local run (wrangler's build step)
// they're copied in:
//   na/web/studio    → public/studio/     Studio: enquiries, chats, bookings, alerts, push
//   na/web/crew      → public/crew/       Crew: sign-in, me, the team, invites
//   na/web/index     → public/index/      Nova Index
//   na/web/calendar  → public/calendar/   Nova Calendar (online, it saves in the browser)
//   na/web/notes     → public/notes/      Nova Notes
//   na/web/shared    → public/shared/     the look, sounds, badge and manual they share
//   na/web/crew/planet → src/portal/planet/  the planet generator (also draws planet.svg)
// NOVA_AGENT_DIR points somewhere else than ../../na (e.g. a branch's worktree).
// The page copies are never saved in this repo (.gitignore); the planet generator
// copy is, so this project still builds and tests on its own.
import { cpSync, existsSync, rmSync } from "node:fs";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";

const here = (p) => fileURLToPath(new URL(p, import.meta.url));
const agent = process.env.NOVA_AGENT_DIR ? resolve(process.env.NOVA_AGENT_DIR) : here("../../../na");
const copies = [
  ["web/studio/", "../public/studio/", "Studio"],
  ["web/crew/", "../public/crew/", "Crew"],
  ["web/index/", "../public/index/", "Nova Index"],
  ["web/calendar/", "../public/calendar/", "Nova Calendar"],
  ["web/notes/", "../public/notes/", "Nova Notes"],
  ["web/shared/", "../public/shared/", "the shared look, badge and manual"],
  ["web/crew/planet/", "../src/portal/planet/", "the planet generator"],
];
for (const [from, to, name] of copies) {
  const src = resolve(agent, from);
  if (!existsSync(src)) {
    if (!existsSync(here(to))) console.log(`${name}: Nova Agent isn't at ${agent}, so it won't be included`);
    continue;
  }
  rmSync(here(to), { recursive: true, force: true });
  // The planet generator is code for this Worker, not a page; tests and samples stay behind
  cpSync(src, here(to), { recursive: true, filter: (f) => !/(test\.mjs|gallery\.html|README\.md)$/.test(f) && !(to.includes("public/crew") && /[\\/]planet([\\/]|$)/.test(f.slice(src.length - 1))) });
  console.log(`${name}: copied in`);
}

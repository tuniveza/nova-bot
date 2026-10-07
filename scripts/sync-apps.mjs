// Nova Index (ns/ni) and Nova Portal (ns/np) live in their own folders and repos.
// They're served from here (so they share Nova Hub's sign-in), so before every
// deploy or local run (wrangler's build step) they're copied in:
//   ns/ni/app      → public/app/memory/     (Nova Index)
//   ns/np/app      → public/portal/         (Nova Portal's pages)
//   ns/np/planet   → src/portal/planet/     (the planet generator, also used to draw planet.svg)
// The page copies are never saved in this repo (.gitignore); the planet generator
// copy is, so this project still builds and tests on its own.
import { cpSync, existsSync, rmSync } from "node:fs";
import { fileURLToPath } from "node:url";

const here = (p) => fileURLToPath(new URL(p, import.meta.url));
const copies = [
  ["../../../ni/app/", "../public/app/memory/", "Nova Index"],
  ["../../../np/app/", "../public/portal/", "Nova Portal"],
  ["../../../np/planet/", "../src/portal/planet/", "the planet generator"],
];
for (const [from, to, name] of copies) {
  if (!existsSync(here(from))) {
    if (!existsSync(here(to))) console.log(`${name}: its folder isn't next to this project, so it won't be included`);
    continue;
  }
  rmSync(here(to), { recursive: true, force: true });
  cpSync(here(from), here(to), { recursive: true, filter: (src) => !/(test\.mjs|gallery\.html|README\.md)$/.test(src) });
  console.log(`${name}: copied in`);
}

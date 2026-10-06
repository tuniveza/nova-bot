// Nova Index lives in its own folder (ns/ni, the nova-index repo). It's served
// from here at /app/memory/ so it can use Nova Hub's sign-in, so before every
// deploy or local run (wrangler's build step) its app is copied in. The copy is
// never saved in this repo (.gitignore), so ns/ni stays the only real one.
import { cpSync, existsSync, rmSync } from "node:fs";
import { fileURLToPath } from "node:url";

const from = fileURLToPath(new URL("../../../ni/app/", import.meta.url));
const to = fileURLToPath(new URL("../public/app/memory/", import.meta.url));
if (existsSync(from)) {
  rmSync(to, { recursive: true, force: true });
  cpSync(from, to, { recursive: true });
  console.log("Nova Index: copied ns/ni/app into public/app/memory/");
} else if (!existsSync(to)) {
  console.log("Nova Index: ns/ni isn't next to this project, so /app/memory/ won't be served");
}

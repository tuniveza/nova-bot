// The pass-through's Worker config (src/passthrough.js, vps/README.md "The switch-over"): the SAME
// Worker name, Durable Objects and migrations as wrangler.jsonc (so Cloudflare keeps their saved
// state for a switch back), but its own entry, no panels to upload, and no timed jobs (they run on
// the VPS from the switch-over on).
// Usage: node vps/make-passthrough-config.mjs [https://<the VPS's address>] > wrangler.passthrough.jsonc
import { readFileSync } from "node:fs";

const vps = (process.argv[2] || "https://185-185-126-195.sslip.io").replace(/\/+$/, "");
if (!/^https:\/\/[a-z0-9.-]+$/i.test(vps)) {
  console.error("Usage: node vps/make-passthrough-config.mjs https://<the VPS's address>");
  process.exit(1);
}
const text = readFileSync(new URL("../wrangler.jsonc", import.meta.url), "utf8");
// JSONC → JSON: drop comments (not inside strings) and trailing commas
let out = "";
for (let i = 0, inStr = false; i < text.length; i++) {
  const c = text[i];
  if (inStr) {
    out += c;
    if (c === "\\") out += text[++i];
    else if (c === '"') inStr = false;
  } else if (c === '"') {
    inStr = true;
    out += c;
  } else if (c === "/" && text[i + 1] === "/") {
    while (i < text.length && text[i] !== "\n") i++;
    out += "\n";
  } else if (c === "/" && text[i + 1] === "*") {
    i = text.indexOf("*/", i + 2) + 1;
  } else out += c;
}
const config = JSON.parse(out.replace(/,(\s*[}\]])/g, "$1"));
config.main = "src/passthrough.js";
delete config.build;
delete config.assets;
delete config.env;
config.triggers = { crons: [] };
config.vars = { ...(config.vars || {}), VPS_ORIGIN: vps };
process.stdout.write(JSON.stringify(config, null, 2) + "\n");

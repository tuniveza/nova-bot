// The VPS's copy of wrangler.jsonc (vps/README.md): the same Worker, run by Cloudflare's own
// runtime (workerd, through `wrangler dev --local`) on the VPS instead of on Cloudflare.
// Differences from wrangler.jsonc, and only these:
//   - no build step (the panels are already copied into public/ before it's sent)
//   - no Workers AI binding (it only exists on Cloudflare: voice falls back to the browser's)
//   - PUBLIC_URL is the VPS's own address, and DESK_HOST says where it's running
//   - PDF_MAKER_URL: Nova Agent on the same server, which prints invoices as PDF files
// Usage: node vps/make-config.mjs https://185-185-126-195.sslip.io > wrangler.vps.jsonc
import { readFileSync } from "node:fs";

const url = (process.argv[2] || "").replace(/\/+$/, "");
if (!/^https:\/\/[a-z0-9.-]+$/i.test(url)) {
  console.error("Usage: node vps/make-config.mjs https://<address>");
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
delete config.build;
delete config.ai;
delete config.env;
delete config.observability;
delete config.upload_source_maps;
// (PDF_MAKER_URL: Nova Agent on this same server prints invoices as PDF files: na src/pdf.ts)
config.vars = { ...(config.vars || {}), PUBLIC_URL: url, DESK_HOST: "vps", PDF_MAKER_URL: "http://127.0.0.1:4545/pdf/make" };
process.stdout.write(JSON.stringify(config, null, 2) + "\n");

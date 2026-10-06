// Sets up the local sandbox: creates .dev.vars from the example and builds the
// local database. Nothing here touches Cloudflare or any live service.
import { copyFileSync, existsSync } from "node:fs";
import { execSync } from "node:child_process";

if (!existsSync(".dev.vars")) {
  copyFileSync(".dev.vars.example", ".dev.vars");
  console.log("Created .dev.vars (admin password: sandbox). Add an ANTHROPIC_API_KEY there for real answers.");
}
execSync("npx wrangler d1 migrations apply novabot-sandbox --local --env sandbox", { stdio: "inherit" });
console.log("\nSandbox ready. Start it with: npm run sandbox");

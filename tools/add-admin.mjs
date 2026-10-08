// Make an admin account in Portal straight away (no invite): asks for a name, an email and a
// password, then adds them to the live database. Run it in a terminal on the studio PC:
//   cd ~/an/pj/ns/nb/novacane-worker && node tools/add-admin.mjs
// The password is typed hidden and never shown or saved anywhere except as Portal's hash.
import { execFileSync } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createInterface } from "node:readline";
import { hashPassword } from "../src/portal/auth.js";

// One reader for every question: answers are queued, so piped ones (a test) aren't lost either
const rl = createInterface({ input: process.stdin, output: process.stdout, terminal: Boolean(process.stdin.isTTY) });
const lines = [];
let waiting = null;
rl.on("line", (line) => (waiting ? (waiting(line), (waiting = null)) : lines.push(line)));
let muted = false;
const write = rl._writeToOutput ? rl._writeToOutput.bind(rl) : null;
if (write) rl._writeToOutput = (s) => (muted ? undefined : write(s));
async function ask(question, hidden = false) {
  process.stdout.write(question);
  muted = hidden && Boolean(process.stdin.isTTY);
  const answer = lines.length ? lines.shift() : await new Promise((resolve) => (waiting = resolve));
  muted = false;
  if (hidden || !process.stdin.isTTY) process.stdout.write("\n");
  return answer.trim();
}
const sql = (v) => `'${String(v).replace(/'/g, "''")}'`;

const name = await ask("Name (e.g. Odysi): ");
const email = (await ask("Email they'll sign in with: ")).toLowerCase();
const password = await ask("Password (hidden as you type): ", true);
rl.close();
if (!name || !/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(email) || !password) {
  console.log("Need a name, an email and a password. Nothing was changed.");
  process.exit(1);
}
const id = name.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "") || "admin";
const now = new Date().toISOString();
const statement =
  "INSERT INTO staff (id, email, password_hash, display_name, role, status, created_at, planet_seed, index_partition) " +
  `VALUES (${sql(id)}, ${sql(email)}, ${sql(await hashPassword(password))}, ${sql(name)}, 'admin', 'active', ${sql(now)}, ${sql(id)}, ${sql("staff:" + id)}) ` +
  "ON CONFLICT(id) DO UPDATE SET email = excluded.email, password_hash = excluded.password_hash, display_name = excluded.display_name, role = 'admin', status = 'active';\n";

const dir = mkdtempSync(join(tmpdir(), "add-admin-"));
const file = join(dir, "add-admin.sql");
writeFileSync(file, statement, { mode: 0o600 });
try {
  execFileSync("npx", ["wrangler", "d1", "execute", "novabot", "--remote", "--file", file], { stdio: ["ignore", "ignore", "inherit"] });
  console.log(`\n✓ ${name} is an admin. They sign in with ${email} and that password (click the planet in Nova Agent).`);
} catch {
  console.log("\nThat didn't work: nothing was changed. Check the internet connection and try again.");
} finally {
  rmSync(dir, { recursive: true, force: true });
}

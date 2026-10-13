// The Fixer's job copies (git worktrees), on whichever computer Nova Agent now runs: its saved jobs
// (data/fixer.json) name their folders by the old computer's paths, so they're renamed here, and each
// job still waiting (a fix ready to approve, or one that failed and can be tried again) gets its copy
// back from its branch (vps/agent-sync.sh copies the data; agent-code-sync.sh the branches).
//   node worktrees.mjs <dataDir> <oldJobsDir> <newJobsDir> <naRepo> <nbRepo>
import { execFileSync } from "node:child_process";
import { existsSync, readFileSync, symlinkSync, writeFileSync } from "node:fs";
import { join } from "node:path";

const [dataDir, oldJobs, newJobs, naRepo, nbRepo] = process.argv.slice(2);
const strip = (p) => p.replace(/\/+$/, "");
const from = strip(oldJobs);
const to = strip(newJobs);
for (const name of ["fixer.json", "fixer.json.bak"]) {
  const file = join(dataDir, name);
  if (!existsSync(file)) continue;
  const text = readFileSync(file, "utf8");
  if (from !== to && text.includes(from + "/")) writeFileSync(file, text.split(from + "/").join(to + "/"));
}
const file = join(dataDir, "fixer.json");
if (!existsSync(file)) process.exit(0);
const git = (repo, args) => execFileSync("git", ["-C", repo, ...args], { encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] });
for (const repo of [naRepo, nbRepo]) git(repo, ["worktree", "prune"]);
let made = 0;
for (const job of JSON.parse(readFileSync(file, "utf8")).jobs || []) {
  if (!["ready", "failed"].includes(job.status) || !job.branch || !job.worktrees) continue;
  for (const [key, repo] of [["na", naRepo], ["nb", nbRepo]]) {
    const wt = job.worktrees[key];
    if (!wt || !wt.startsWith(to + "/") || existsSync(join(wt, ".git"))) continue;
    try {
      git(repo, ["rev-parse", "--verify", "--quiet", `refs/heads/${job.branch}`]);
    } catch {
      continue; // (its branch isn't here: the Fixer makes a fresh copy if it's tried again)
    }
    try {
      git(repo, ["worktree", "add", "-q", wt, job.branch]);
      if (existsSync(join(repo, "node_modules")) && !existsSync(join(wt, "node_modules"))) symlinkSync(join(repo, "node_modules"), join(wt, "node_modules"));
      made++;
    } catch (err) {
      console.log(`   (job ${job.id}: its ${key} copy couldn't be made: ${String(err.stderr || err.message).trim().split("\n")[0]})`);
    }
  }
}
console.log(`   Fixer: ${made} job cop${made === 1 ? "y" : "ies"} made here`);

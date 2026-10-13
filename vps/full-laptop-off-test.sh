#!/usr/bin/env bash
# The full laptop-off test: with the studio PC's Nova Agent fully stopped, does ALL of Nova work?
# Run on the studio PC from the novacane-worker folder (vps/agent-switch.sh runs it at the end):
#   vps/full-laptop-off-test.sh
# First it makes sure the PC's Nova Agent is really stopped (no service, no copy running from its
# folder, nothing on port 4545) and that Nova Agent runs on the server. Then, on the server, through
# https://nova.novacane.co.uk, as a temporary signed-in admin (vps/agent/laptop-off-checks.mjs):
# Agent answers a question; quests load, and one is added and removed; Calendar and its notes load and
# save; shared Notes; Board lists, a card saves and the board opens again; Files; Console's status,
# quests list and calendar today; the Index cache and Index search; the Fixer; one push to the studio
# owner's phone; the website chat and the booking form; Portal's sections; one email (to TEST_TO);
# and the status page all green with "Nova Agent: on the server". A PASS/FAIL line for each, and the
# result goes on the status page ("Last laptop-off test").
# Settings: TEST_TO=you@example.com  PUSH=0 skips the phone ping  EXPECT_WHERE=pc (trying the
# checks before the move: the PC's Nova Agent stays as it is)
set -uo pipefail
cd "$(dirname "$0")/.."
. vps/agent/lib.sh
WHERE=${EXPECT_WHERE:-server}
out=$(mktemp)
trap 'rm -f "$out"' EXIT
pc_lines=()
pc_fail=0
pc_line() { pc_lines+=("$1 $2 — $3"); echo "$1 $2 — $3"; [ "$1" = PASS ] || pc_fail=1; }

echo "Full laptop-off test ($(date '+%Y-%m-%d %H:%M'))"
if [ "$WHERE" = server ]; then
  if pc_agent_stopped; then pc_line PASS "The PC's Nova Agent is fully stopped" "no service, no copy running from $NA_DIR, nothing on port 4545"
  else pc_line FAIL "The PC's Nova Agent is fully stopped" "it's still running on the PC"; fi
  if vps 'systemctl is-active --quiet nova-agent'; then pc_line PASS "Nova Agent runs on the server" "nova-agent.service is active"
  else pc_line FAIL "Nova Agent runs on the server" "nova-agent.service isn't running"; fi
fi
vps "NOVA_URL='$URL' EXPECT_WHERE='$WHERE' TEST_TO='${TEST_TO:-}' PUSH='${PUSH:-1}' MAIL='${MAIL:-1}' node --input-type=module -" < vps/agent/laptop-off-checks.mjs | tee "$out" | grep -v '^{'
summary=$(tail -1 "$out")
case "$summary" in "{"*) ;; *) summary='{"passed":false,"checks":[],"failed":["the checks didn'"'"'t run"]}' ;; esac

# The result on the status page (the same place as vps/laptop-off-test.sh)
json=$(node -e '
const s = JSON.parse(process.argv[1]); const pc = process.argv[2].split("\n").filter(Boolean);
const passed = pc.filter((l) => l.startsWith("PASS")).map((l) => l.slice(5).split(" — ")[0]);
const failed = pc.filter((l) => l.startsWith("FAIL")).map((l) => l.slice(5).split(" — ")[0]);
console.log(JSON.stringify({ at: new Date().toISOString(), passed: s.passed && !failed.length, full: true, checks: [...passed, ...s.checks], failed: [...failed, ...s.failed], offSeconds: 0 }));
' "$summary" "$(printf '%s\n' "${pc_lines[@]+"${pc_lines[@]}"}")")
if [ "$WHERE" = server ]; then
  printf "INSERT INTO settings (key, value) VALUES ('status_laptop_off_test', '%s') ON CONFLICT (key) DO UPDATE SET value = excluded.value; DELETE FROM settings WHERE key = 'status_cache';\n" "${json//\'/\'\'}" \
    | vps 'sqlite3 -cmd ".timeout 5000" "$(ls /srv/nova/state/v3/d1/miniflare-D1DatabaseObject/*.sqlite | grep -v metadata | head -1)"'
fi
echo
if node -e 'process.exit(JSON.parse(process.argv[1]).passed ? 0 : 1)' "$json"; then
  echo "ALL PASSED: everything works with the laptop off."
  exit 0
fi
echo "NOT PASSED: $(node -e 'console.log(JSON.parse(process.argv[1]).failed.join("; "))' "$json")"
exit 1

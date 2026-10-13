#!/usr/bin/env bash
# The "laptop off" test: does everything that should keep working without the studio PC really work?
# Run on the studio PC:   vps/laptop-off-test.sh
# It unplugs the PC from Nova Bot for about 2 minutes (stops Nova Agent, the systemd user service
# agent-nova), checks the website chat, Portal, signing in, an email through the VPS's own mail
# server (to TEST_TO only), the bookings feed and the status page, then starts Nova Agent again and
# waits for "Nova Agent is online". The result goes on the status page ("Last laptop-off test").
# Settings (defaults): NOVA_URL=https://nova.novacane.co.uk  DESK_SSH=root@185.185.126.195
#   TEST_TO=you@example.com
# Nothing is left behind: the test chat removes itself (src/status.js); the email is one short note.
set -uo pipefail
URL=${NOVA_URL:-https://nova.novacane.co.uk}
SSH=${DESK_SSH:-root@185.185.126.195}
TO=${TEST_TO:-$(ssh "$SSH" cat /srv/nova/owner-email)}
DB_GLOB='/srv/nova/state/v3/d1/miniflare-D1DatabaseObject/*.sqlite'
passed=()
failed=()
check() { # name, then a command that succeeds when it works
  local name=$1; shift
  if "$@"; then passed+=("$name"); echo "  ✓ $name"; else failed+=("$name"); echo "  ✗ $name"; fi
}
part() { # the state of one part on the status page: green / amber / red
  curl -s -m 60 "$URL/status.json" | node -e 'let s="";process.stdin.on("data",d=>s+=d).on("end",()=>{try{const p=JSON.parse(s).parts.find(x=>x.id===process.argv[1]);console.log(p?p.state:"missing")}catch{console.log("unreadable")}})' "$1"
}
fresh() { ssh "$SSH" "sqlite3 $DB_GLOB \"DELETE FROM settings WHERE key = 'status_cache'\"" 2>/dev/null; }
restore() {
  if [ "$(systemctl --user is-active agent-nova)" != active ]; then
    echo "Starting Nova Agent again…"
    systemctl --user start agent-nova
  fi
}
trap restore EXIT

echo "1/5 Is the studio PC linked now?"
fresh
[ "$(part pc)" = green ] || echo "  (it wasn't linked to start with — testing anyway)"

echo "2/5 Unplugging the PC (Nova Agent stops for about 2 minutes)"
off_at=$(date -u +%Y-%m-%dT%H:%M:%SZ)
systemctl --user stop agent-nova
for _ in $(seq 1 12); do
  sleep 5
  fresh
  [ "$(part pc)" = amber ] && break
done
check "Nova Bot sees the PC is off" test "$(part pc)" = amber

echo "3/5 Checking what should keep working"
chat_ok() { # one real chat round trip (the button on the status page; it removes its test chat)
  local where
  where=$(curl -s -m 60 -o /dev/null -w '%{redirect_url}' -X POST "$URL/status/test-chat")
  case "$where" in
    *answered.*) return 0 ;;
    *less%20than*|*less+than*) fresh; [ "$(part chat)" = green ] ;;
    *) return 1 ;;
  esac
}
check "Website chat answers" chat_ok
check "Portal opens" bash -c "curl -s -m 20 '$URL/portal/?app=1' | grep -qi '<html'"
check "Sign-in page answers" bash -c "curl -s -m 20 '$URL/auth/status' | grep -q '\"signedIn\":false'"
mail_ok() { # one email through the VPS's own mail server, to TEST_TO only
  ssh "$SSH" "TO='$TO' bash -s" <<'REMOTE'
key=$(grep '^MAIL_KEY=' /srv/nova/mail.env | cut -d= -f2-)
body=$(printf '{"from":"Novacane Studios <hello@novacane.co.uk>","to":["%s"],"subject":"Nova laptop-off test","text":"This is the laptop-off test: the studio PC was off and Nova still sent this email. Nothing to do."}' "$TO")
curl -s -m 30 -o /dev/null -w '%{http_code}' -H "Authorization: Bearer $key" -H 'Content-Type: application/json' -d "$body" http://127.0.0.1:8790/emails | grep -q '^200$'
REMOTE
}
check "Email sends (VPS mail server)" mail_ok
check "Bookings feed answers" test "$(part feed)" = green
check "Timed jobs run" test "$(part jobs)" = green
on_for=$(( $(date +%s) - $(date -d "$off_at" +%s) ))

echo "4/5 Plugging the PC back in (it was off for ${on_for} s)"
since=$(date '+%Y-%m-%d %H:%M:%S')
systemctl --user start agent-nova
online=no
for _ in $(seq 1 24); do
  sleep 5
  if journalctl --user -u agent-nova --since "$since" --no-pager -o cat | grep -q "Nova Agent is online"; then online=yes; break; fi
done
check "Nova Agent is back online" test "$online" = yes

echo "5/5 Putting the result on the status page"
ok=$([ ${#failed[@]} -eq 0 ] && echo true || echo false)
json=$(node -e 'const [at,ok,p,f,s]=process.argv.slice(1);console.log(JSON.stringify({at,passed:ok==="true",checks:p?p.split("|"):[],failed:f?f.split("|"):[],offSeconds:+s}))' \
  "$(date -u +%Y-%m-%dT%H:%M:%SZ)" "$ok" "$(IFS='|'; echo "${passed[*]}")" "$(IFS='|'; echo "${failed[*]}")" "$on_for")
printf '%s' "$json" | ssh "$SSH" "v=\$(cat); v=\${v//\\'/\\'\\'}; sqlite3 $DB_GLOB \"INSERT INTO settings (key, value) VALUES ('status_laptop_off_test', '\$v') ON CONFLICT (key) DO UPDATE SET value = excluded.value; DELETE FROM settings WHERE key = 'status_cache';\""
echo
if [ "$ok" = true ]; then echo "All passed: everything that should keep working with the laptop off did."; else echo "Didn't pass: ${failed[*]}"; fi
echo "See $URL/status"

#!/usr/bin/env bash
# Desk: go back to Cloudflare after vps/switch.sh. Nova Bot runs on Cloudflare again (the normal
# Worker, its timed jobs included), the VPS stops its timed jobs (so nothing is ever sent twice),
# and the studio PC's Nova Agent reconnects. The VPS itself keeps running, ready for another switch.
# Run on the studio PC, from the novacane-worker folder:   vps/switch-back.sh
#
# Anything written while the VPS was live (new enquiries, chats, notes…) is in the VPS's database,
# not Cloudflare's. At the end this explains how to copy it back, and asks before doing anything.
set -euo pipefail
cd "$(dirname "$0")/.."
SSH=${DESK_SSH:-root@185.185.126.195}
LIVE=${DESK_LIVE_URL:-https://novacane-worker.novacane-studio.workers.dev}
export NOVA_AGENT_DIR=${NOVA_AGENT_DIR:-$HOME/an/pj/ns/na-release}
ok() { printf '   ✓ %s\n' "$*"; }
code() { curl -s -o /dev/null -m 20 -w '%{http_code}' "$@" || true; }

echo "Go back to Cloudflare."
if [ "${DESK_YES:-}" != "yes" ]; then
  read -r -p "Type yes to switch back now: " answer
  [ "$answer" = "yes" ] || { echo "Nothing changed."; exit 0; }
fi

echo "1/4 The VPS's timed jobs stop"
ssh -o BatchMode=yes "$SSH" "systemctl disable --now nova-cron.timer >/dev/null 2>&1; rm -f /srv/nova/state/.live-since" || echo "   ! couldn't reach the VPS: stop its jobs later with: systemctl disable --now nova-cron.timer"
ok "stopped"

echo "2/4 Nova Bot goes back on Cloudflare (with its timed jobs)"
deployed=""
for i in 1 2 3 4 5; do
  if out=$(npx wrangler deploy 2>&1) && echo "$out" | grep -q "Version ID"; then deployed=$(echo "$out" | grep -o 'Version ID: [0-9a-f-]*'); break; fi
  sleep 8
done
[ -n "$deployed" ] || { echo "✘ Cloudflare didn't take Nova Bot back. The pass-through is still live and the VPS's jobs are stopped: run this again, or turn the VPS's jobs back on (systemctl enable --now nova-cron.timer)."; exit 1; }
ok "$deployed"

echo "3/4 The studio PC's Nova Agent reconnects"
since=$(date '+%Y-%m-%d %H:%M:%S')
systemctl --user restart agent-nova.service
for i in $(seq 30); do
  journalctl --user -u agent-nova.service --since "$since" --no-pager 2>/dev/null | grep -q "Nova Agent is online" && { ok "online"; break; }
  sleep 2
done

echo "4/4 Checks"
for path in /privacy /portal/; do c=$(code "$LIVE$path"); [ "$c" = 200 ] && ok "$path" || echo "   ✘ $path answered $c"; done
c=$(code "$LIVE/app/api/me"); [ "$c" = 401 ] && ok "sign-in is checked" || echo "   ✘ /app/api/me answered $c"
echo "Back on Cloudflare ✓"

echo
echo "Copying what the VPS saved meanwhile back into Cloudflare's database:"
echo "  It replaces Cloudflare's whole database with the VPS's copy (export on the VPS, then import"
echo "  into D1 with wrangler). Only do it if things were saved while the VPS was live; it can't be undone"
echo "  except from a backup (the VPS keeps nightly ones in /srv/nova/backups)."
read -r -p "Copy the VPS's database back to Cloudflare now? [y/N] " again
if [ "$again" = "y" ] || [ "$again" = "Y" ]; then
  dump=$(mktemp --suffix=.sql)
  # Every table is dropped and made again from the VPS's copy (foreign keys checked at the end)
  ssh -o BatchMode=yes "$SSH" 'db=$(find /srv/nova/state/v3/d1 -name "*.sqlite" ! -name metadata.sqlite | head -1)
    echo "PRAGMA defer_foreign_keys = true;"
    sqlite3 "$db" "SELECT '"'"'DROP TABLE IF EXISTS \"'"'"' || name || '"'"'\";'"'"' FROM sqlite_master WHERE type = '"'"'table'"'"' AND name NOT LIKE '"'"'sqlite_%'"'"' AND name NOT LIKE '"'"'_cf_%'"'"'"
    sqlite3 "$db" .dump' | grep -vE '^(BEGIN TRANSACTION|COMMIT);$|_cf_KV|sqlite_sequence|^PRAGMA foreign_keys' > "$dump"
  echo "   (Very long rows, over Cloudflare's 100 KB per statement, can't go back this way: the import says so if there are any.)"
  echo "   $(grep -c '^INSERT' "$dump") rows. Importing into Cloudflare's database…"
  npx wrangler d1 execute novabot --remote --file "$dump" && echo "   ✓ copied back" || echo "   ✘ the import failed (Cloudflare's database is as it was before the switch-back)"
  rm -f "$dump"
else
  echo "   Left as it is."
fi

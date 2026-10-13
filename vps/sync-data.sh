#!/usr/bin/env bash
# Computer: copy the live database from Cloudflare (D1, read-only export) into the VPS's copy,
# replacing what's there. Run on the studio PC from the novacane-worker folder: vps/sync-data.sh
# Nova Bot on the VPS is stopped while the copy goes in, then started again.
set -euo pipefail
cd "$(dirname "$0")/.."
SSH=${DESK_SSH:-root@185.185.126.195}
dump=$(mktemp --suffix=.sql)
trap 'rm -f "$dump"' EXIT
echo "1/3 Exporting the live database from Cloudflare (read-only)"
for i in 1 2 3; do npx wrangler d1 export novabot --remote --output "$dump" >/dev/null 2>&1 && break; sleep 5; done
[ -s "$dump" ] || { echo "The export didn't come through"; exit 1; }
echo "   $(grep -c '^INSERT' "$dump") rows"
echo "2/3 Sending it to the VPS"
scp -q "$dump" "$SSH:/srv/nova/import.sql"
echo "3/3 Replacing the VPS's copy"
ssh "$SSH" 'bash -s' <<'REMOTE'
set -euo pipefail
# Whatever happens, Nova Bot is started again, and the copy file goes
trap 'rm -f /srv/nova/import.sql; systemctl start nova' EXIT
systemctl stop nova-cron.timer 2>/dev/null || true
systemctl stop nova
cd /srv/nova/app
chown nova:nova /srv/nova/import.sql
# The new copy is built beside the old one, and only swapped in once it's whole
rm -rf /srv/nova/state-new && mkdir -p /srv/nova/state-new && chown nova:nova /srv/nova/state-new
# (an empty database made by the runtime itself, so its file is named the way it expects)
sudo -u nova -H CI=1 WRANGLER_SEND_METRICS=false npx --no-install wrangler d1 execute novabot -c wrangler.vps.jsonc --local --persist-to /srv/nova/state-new --command "SELECT 1" >/dev/null
db=$(find /srv/nova/state-new/v3/d1 -name '*.sqlite' ! -name metadata.sqlite | head -1)
[ -n "$db" ] || { echo "The VPS's database file wasn't made"; exit 1; }
# sqlite3 itself loads it: the runtime's own loader refuses very long rows (a big note)
sudo -u nova sqlite3 "$db" < /srv/nova/import.sql
rm -rf /srv/nova/state/v3/d1
mv /srv/nova/state-new/v3/d1 /srv/nova/state/v3/d1
rm -rf /srv/nova/state-new
date -u +%Y-%m-%dT%H:%M:%SZ > /srv/nova/state/.last-sync
chown -R nova:nova /srv/nova/state
systemctl start nova
REMOTE
echo "Done: the VPS has a fresh copy"

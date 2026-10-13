#!/usr/bin/env bash
# Desk: copy the live database from Cloudflare (D1, read-only export) into the VPS's copy,
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
systemctl stop nova-cron.timer 2>/dev/null || true
systemctl stop nova
rm -rf /srv/nova/state/v3/d1
cd /srv/nova/app
chown nova:nova /srv/nova/import.sql
sudo -u nova -H CI=1 WRANGLER_SEND_METRICS=false npx --no-install wrangler d1 execute novabot -c wrangler.vps.jsonc --local --persist-to /srv/nova/state --file /srv/nova/import.sql >/dev/null
rm -f /srv/nova/import.sql
date -u +%Y-%m-%dT%H:%M:%SZ > /srv/nova/state/.last-sync
chown -R nova:nova /srv/nova/state
systemctl start nova
REMOTE
echo "Done: the VPS has a fresh copy"

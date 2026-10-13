#!/usr/bin/env bash
# Put this Nova Bot live wherever Nova Bot is live now. Use this instead of `wrangler deploy`
# (which would put the full Nova Bot back on Cloudflare and so undo the switch-over).
#   NOVA_AGENT_DIR=~/an/pj/ns/na-release vps/deploy-live.sh
# On the VPS (after vps/switch.sh): vps/deploy.sh with Cloudflare's address in links and emails.
# Not switched (or switched back): the normal `wrangler deploy` to Cloudflare.
set -euo pipefail
cd "$(dirname "$0")/.."
SSH=${DESK_SSH:-root@185.185.126.195}
if ssh -o BatchMode=yes -o ConnectTimeout=10 "$SSH" 'systemctl is-enabled --quiet nova-cron.timer && test -f /srv/nova/state/.live-since'; then
  echo "Nova Bot is live on the VPS: deploying there"
  DESK_PUBLIC_URL=https://nova.novacane.co.uk exec vps/deploy.sh
else
  echo "Nova Bot is live on Cloudflare: deploying there"
  exec npx wrangler deploy
fi

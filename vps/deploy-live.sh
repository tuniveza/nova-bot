#!/usr/bin/env bash
# Put this Nova Bot live wherever Nova Bot is live now. Use this instead of `wrangler deploy`
# (which would put the full Nova Bot back on Cloudflare and so undo the switch-over).
#   NOVA_AGENT_DIR=~/an/pj/ns/na-release vps/deploy-live.sh
# On the VPS (after vps/switch.sh): vps/deploy.sh with Cloudflare's address in links and emails.
# Not switched (or switched back): the normal `wrangler deploy` to Cloudflare.
# On the VPS itself (the Fixer, once Nova Agent runs on the server): deployed right there, without
# ssh to itself (/usr/local/sbin/nova-deploy-here, through its sudo rule; the app only).
set -euo pipefail
cd "$(dirname "$0")/.."
if [ "$(id -un)" = nova-agent ] && [ -x /usr/local/sbin/nova-deploy-here ]; then
  echo "On the server: deploying here"
  node scripts/sync-apps.mjs >/dev/null
  exec sudo -n /usr/local/sbin/nova-deploy-here
fi
SSH=${DESK_SSH:-root@185.185.126.195}
# Nova Agent on the server: its Fixer may have put Nova Bot changes live that this copy doesn't have
# yet. Deploying this copy would undo them, so bring them here first (vps/agent-code-sync.sh).
theirs=$(ssh -o BatchMode=yes -o ConnectTimeout=10 "$SSH" 'test -d /srv/nova-agent/nb/.git && sudo -u nova-agent git -C /srv/nova-agent/nb rev-parse main' 2>/dev/null || true)
if [ -n "$theirs" ] && ! git merge-base --is-ancestor "$theirs" HEAD 2>/dev/null; then
  echo "The server has Nova Bot changes this copy doesn't (the Fixer's, ${theirs:0:7})."
  echo "Bring them here first: vps/agent-code-sync.sh — then deploy again."
  exit 1
fi
if ssh -o BatchMode=yes -o ConnectTimeout=10 "$SSH" 'systemctl is-enabled --quiet nova-cron.timer && test -f /srv/nova/state/.live-since'; then
  echo "Nova Bot is live on the VPS: deploying there"
  DESK_PUBLIC_URL=https://nova.novacane.co.uk exec vps/deploy.sh
else
  echo "Nova Bot is live on Cloudflare: deploying there"
  exec npx wrangler deploy
fi

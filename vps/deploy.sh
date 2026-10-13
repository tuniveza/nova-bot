#!/usr/bin/env bash
# Desk: send this Nova Bot (and the panels from Nova Agent) to the VPS and (re)start it there.
# Run on the studio PC from the novacane-worker folder:
#   NOVA_AGENT_DIR=~/an/pj/ns/na-release vps/deploy.sh
# Settings (defaults): DESK_SSH=root@185.185.126.195  DESK_ADDRESS=185-185-126-195.sslip.io
# It never starts the every-minute jobs (that's the cutover: vps/README.md), and it only adds
# the secrets the studio PC already has (AGENT_NOVA_KEY, ANTHROPIC_API_KEY) if they're missing.
set -euo pipefail
cd "$(dirname "$0")/.."
SSH=${DESK_SSH:-root@185.185.126.195}
ADDR=${DESK_ADDRESS:-185-185-126-195.sslip.io}
PC_ENV=${PC_ENV:-$HOME/an/pj/ns/na/.env}

echo "1/5 Panels into public/ (from ${NOVA_AGENT_DIR:-the na folder})"
node scripts/sync-apps.mjs >/dev/null

echo "2/5 Files to the VPS"
rsync -az --delete \
  --exclude node_modules --exclude .wrangler --exclude .dev.vars --exclude .git \
  --exclude test --exclude 'wrangler.vps.jsonc' \
  ./ "$SSH:/srv/nova/app/"

echo "3/5 Settings and services"
node vps/make-config.mjs "https://$ADDR" | ssh "$SSH" "cat > /srv/nova/app/wrangler.vps.jsonc"
ssh "$SSH" "ADDR='$ADDR' bash -s" <<'REMOTE'
set -euo pipefail
cd /srv/nova/app
printf 'DESK_ADDRESS=%s\nDESK_HOSTNAME=%s\nDESK_URL=https://%s\n' "$ADDR" "$ADDR" "$ADDR" > /srv/nova/desk.env
sed "s/{\$DESK_HOSTNAME}/$ADDR/" vps/Caddyfile > /etc/caddy/Caddyfile
install -m 755 vps/bin/backup /srv/nova/bin/backup
install -m 700 -o root vps/bin/set-secrets /srv/nova/bin/set-secrets
cp vps/systemd/*.service vps/systemd/*.timer /etc/systemd/system/
touch /srv/nova/secrets.env && chmod 600 /srv/nova/secrets.env
ln -sf /srv/nova/secrets.env /srv/nova/app/.dev.vars
mkdir -p /var/log/caddy && chown caddy:caddy /var/log/caddy
chown -R nova:nova /srv/nova
systemctl daemon-reload
REMOTE

echo "4/5 Secrets the studio PC already has (only if missing; never shown)"
for name in AGENT_NOVA_KEY ANTHROPIC_API_KEY; do
  if ! ssh "$SSH" "grep -q '^$name=' /srv/nova/secrets.env"; then
    value=$(grep -m1 "^$name=" "$PC_ENV" | cut -d= -f2- | sed 's/^["'\'']//; s/["'\'']$//')
    if [ -n "$value" ]; then
      printf '%s=%s\n' "$name" "$value" | ssh "$SSH" "cat >> /srv/nova/secrets.env"
      echo "   $name copied"
    fi
    unset value
  fi
done

echo "5/5 Packages and restart"
ssh "$SSH" "cd /srv/nova/app && sudo -u nova -H npm ci --no-audit --no-fund --loglevel=error >/dev/null && systemctl enable --now nova >/dev/null 2>&1 && systemctl restart nova && systemctl enable --now nova-backup.timer >/dev/null 2>&1 && systemctl reload caddy || systemctl restart caddy"
echo "Done: https://$ADDR (the every-minute jobs stay off until the cutover)"

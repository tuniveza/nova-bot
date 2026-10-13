#!/usr/bin/env bash
# Desk: send this Nova Bot (and the panels from Nova Agent) to the VPS and (re)start it there.
# Run on the studio PC from the novacane-worker folder:
#   NOVA_AGENT_DIR=~/an/pj/ns/na-release vps/deploy.sh
# Settings (defaults): DESK_SSH=root@185.185.126.195  DESK_ADDRESS=185-185-126-195.sslip.io
#   DESK_PUBLIC_URL: the address Nova Bot puts in links and emails (default https://$DESK_ADDRESS;
#   after the switch-over vps/switch.sh sets it to Cloudflare's workers.dev address)
# It never starts the every-minute jobs (that's the cutover: vps/README.md). Secrets are typed in on
# the VPS (/srv/nova/bin/set-secrets); DESK_COPY_PC_SECRETS=1 also copies the two the PC has.
set -euo pipefail
cd "$(dirname "$0")/.."
SSH=${DESK_SSH:-root@185.185.126.195}
ADDR=${DESK_ADDRESS:-185-185-126-195.sslip.io}
PC_ENV=${PC_ENV:-$HOME/an/pj/ns/na/.env}

echo "1/5 Panels into public/ (from ${NOVA_AGENT_DIR:-the na folder})"
node scripts/sync-apps.mjs >/dev/null

echo "2/5 Files to the VPS"
printf '%s %s\n' "$(git rev-parse --short HEAD 2>/dev/null || echo unknown)" "$(date -u +%Y-%m-%dT%H:%M:%SZ)" > VERSION
rsync -az --delete \
  --exclude node_modules --exclude .wrangler --exclude .dev.vars --exclude .git \
  --exclude test --exclude 'wrangler.vps.jsonc' \
  ./ "$SSH:/srv/nova/app/"

echo "3/5 Settings and services"
node vps/make-config.mjs "${DESK_PUBLIC_URL:-https://$ADDR}" | ssh "$SSH" "cat > /srv/nova/app/wrangler.vps.jsonc"
ssh "$SSH" "ADDR='$ADDR' bash -s" <<'REMOTE'
set -euo pipefail
cd /srv/nova/app
printf 'DESK_ADDRESS=%s\nDESK_HOSTNAME=%s\nDESK_URL=https://%s\n' "$ADDR" "$ADDR" "$ADDR" > /srv/nova/desk.env
sed "s/{\$DESK_HOSTNAME}/$ADDR/" vps/Caddyfile > /etc/caddy/Caddyfile
install -m 755 vps/bin/backup /srv/nova/bin/backup
mkdir -p /srv/nova/desk-status && install -m 644 vps/desk-status/server.mjs /srv/nova/desk-status/server.mjs
# The VPS's own mail service (vps/mail): its key is made once, then Nova Bot is told to use it
mkdir -p /srv/nova/mail && install -m 644 vps/mail/server.mjs /srv/nova/mail/server.mjs
if [ ! -s /srv/nova/mail.env ]; then umask 077; printf 'MAIL_KEY=%s\nMAIL_PORT=8790\n' "$(openssl rand -hex 24)" > /srv/nova/mail.env; fi
chown nova:nova /srv/nova/mail.env; chmod 600 /srv/nova/mail.env
mailkey=$(grep '^MAIL_KEY=' /srv/nova/mail.env | cut -d= -f2-)
touch /srv/nova/secrets.env
for kv in "RESEND_API_URL=http://127.0.0.1:8790" "RESEND_API_KEY=$mailkey" "MAIL_FIRST=vps"; do
  k=${kv%%=*}; { grep -v "^$k=" /srv/nova/secrets.env || true; echo "$kv"; } > /srv/nova/secrets.env.new && mv /srv/nova/secrets.env.new /srv/nova/secrets.env
done
unset mailkey
# The from addresses (not secret): the studio's own domain, unless set already
for kv in "ENQUIRY_EMAIL_FROM=Novacane Studios <hello@novacane.co.uk>" "CAMPAIGN_FROM=Novacane Studios <hello@novacane.co.uk>"; do
  k=${kv%%=*}; grep -q "^$k=" /srv/nova/secrets.env || echo "$kv" >> /srv/nova/secrets.env
done
install -m 700 -o root vps/bin/set-secrets /srv/nova/bin/set-secrets
install -m 700 -o root vps/bin/switch-keys /srv/nova/bin/switch-keys
cp vps/systemd/*.service vps/systemd/*.timer /etc/systemd/system/
touch /srv/nova/secrets.env && chmod 600 /srv/nova/secrets.env
ln -sf /srv/nova/secrets.env /srv/nova/app/.dev.vars
mkdir -p /var/log/caddy && chown caddy:caddy /var/log/caddy
chown -R nova:nova /srv/nova
systemctl daemon-reload
REMOTE

echo "4/5 Secrets the studio PC already has (only with DESK_COPY_PC_SECRETS=1, only if missing; never shown)"
for name in $([ "${DESK_COPY_PC_SECRETS:-0}" = 1 ] && echo AGENT_NOVA_KEY ANTHROPIC_API_KEY); do
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
ssh "$SSH" "cd /srv/nova/app && sudo -u nova -H npm ci --no-audit --no-fund --loglevel=error >/dev/null && systemctl enable --now nova >/dev/null 2>&1 && systemctl restart nova && systemctl enable --now nova-backup.timer >/dev/null 2>&1 && systemctl enable --now desk-status >/dev/null 2>&1 && systemctl restart desk-status && systemctl enable --now nova-mail >/dev/null 2>&1 && systemctl restart nova-mail && (systemctl reload caddy || systemctl restart caddy)"
echo "Done: https://$ADDR (the every-minute jobs stay off until the cutover)"

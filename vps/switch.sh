#!/usr/bin/env bash
# Computer: the switch-over. From now on Nova Bot runs on the VPS, 24/7, and Cloudflare's address
# (novacane-worker.novacane-studio.workers.dev) stays the one everyone uses: a thin pass-through
# Worker (src/passthrough.js) forwards every request there. Run on the studio PC, from the
# novacane-worker folder, at a quiet time:   vps/switch.sh
# To go back:                                   vps/switch-back.sh
#
# Order (the database copy is taken as late as possible, so nothing written meanwhile is lost):
#   1 checks · 2 the VPS gets this code and Cloudflare's address · 3 its keys (phone notifications,
#   Acuity) · 4 the final copy of the database · 5 health check · 6 the pass-through goes live on
#   Cloudflare (Cloudflare's timed jobs stop with it) · 7 the VPS's timed jobs start · 8 the studio
#   PC's Nova Agent reconnects · then everything is checked from outside.
set -euo pipefail
cd "$(dirname "$0")/.."
SSH=${DESK_SSH:-root@185.185.126.195}
VPS_URL=${DESK_VPS_URL:-https://185-185-126-195.sslip.io}
LIVE=${DESK_LIVE_URL:-https://novacane-worker.novacane-studio.workers.dev}
export NOVA_AGENT_DIR=${NOVA_AGENT_DIR:-$HOME/an/pj/ns/na-release}
ok() { printf '   ✓ %s\n' "$*"; }
fail() { printf '\n✘ %s\n' "$*"; printf 'Nothing on Cloudflare has changed unless step 6 said so. To undo anything: vps/switch-back.sh\n'; exit 1; }
code() { curl -s -o /dev/null -m 20 -w '%{http_code}' "$@" || true; }

echo "Switch Nova Bot to the VPS (Cloudflare's address stays the same)."
if [ "${DESK_YES:-}" != "yes" ]; then
  read -r -p "Type yes to switch now: " answer
  [ "$answer" = "yes" ] || { echo "Not switched."; exit 0; }
fi

echo "1/8 Checks"
[ "$(code "$VPS_URL/privacy")" = 200 ] || fail "The VPS ($VPS_URL) isn't answering."
ok "the VPS answers"
ssh -o BatchMode=yes "$SSH" "grep -q '^AGENT_NOVA_KEY=.' /srv/nova/secrets.env" || fail "The VPS has no AGENT_NOVA_KEY yet (run set-secrets there first)."
ok "the VPS has Nova Agent's key"
[ -d "$NOVA_AGENT_DIR/web" ] || fail "Can't find Nova Agent's panels at $NOVA_AGENT_DIR (set NOVA_AGENT_DIR)."
ok "Nova Agent's panels: $NOVA_AGENT_DIR"

echo "2/8 The VPS gets this code, with Cloudflare's address in its links and emails"
DESK_PUBLIC_URL="$LIVE" vps/deploy.sh >/dev/null || fail "Sending the code to the VPS failed."
ok "done"

echo "3/8 The VPS's keys (phone notifications; Acuity's, made from Nova Agent's key)"
ssh -o BatchMode=yes "$SSH" "/srv/nova/bin/switch-keys && chown nova:nova /srv/nova/secrets.env && chmod 600 /srv/nova/secrets.env" | sed 's/^/   /' || fail "Setting the VPS's keys failed."

echo "4/8 The final copy of the database (Cloudflare → VPS)"
vps/sync-data.sh | sed 's/^/   /' || fail "The database copy failed (the VPS kept its old copy)."

echo "5/8 Health check on the VPS"
for i in $(seq 30); do [ "$(code "$VPS_URL/privacy")" = 200 ] && break; sleep 2; done
[ "$(code "$VPS_URL/privacy")" = 200 ] || fail "Nova Bot on the VPS didn't come back up."
[ "$(code "$VPS_URL/app/api/me")" = 401 ] || fail "The VPS's sign-in check didn't answer as expected."
ok "Nova Bot on the VPS is up"

echo "6/8 The pass-through goes live on Cloudflare (Cloudflare's timed jobs stop with it)"
node vps/make-passthrough-config.mjs "$VPS_URL" > wrangler.passthrough.jsonc
deployed=""
for i in 1 2 3 4 5; do
  if out=$(npx wrangler deploy -c wrangler.passthrough.jsonc 2>&1) && echo "$out" | grep -q "Version ID"; then deployed=$(echo "$out" | grep -o 'Version ID: [0-9a-f-]*'); break; fi
  sleep 8
done
[ -n "$deployed" ] || fail "Cloudflare didn't take the pass-through (Nova Bot is still running on Cloudflare as before)."
ok "$deployed"

echo "7/8 The VPS's timed jobs start"
ssh -o BatchMode=yes "$SSH" "systemctl enable --now nova-cron.timer >/dev/null 2>&1 && date -u +%Y-%m-%dT%H:%M:%SZ > /srv/nova/state/.live-since && chown nova:nova /srv/nova/state/.live-since" || fail "Starting the VPS's timed jobs failed: run vps/switch-back.sh, or on the VPS: systemctl enable --now nova-cron.timer"
ok "every minute, on the VPS"

echo "8/8 The studio PC's Nova Agent reconnects"
since=$(date '+%Y-%m-%d %H:%M:%S')
systemctl --user restart agent-nova.service
linked=""
for i in $(seq 30); do
  if journalctl --user -u agent-nova.service --since "$since" --no-pager 2>/dev/null | grep -q "Nova Agent is online"; then linked=yes; break; fi
  sleep 2
done
[ -n "$linked" ] && ok "Nova Agent is online through the VPS" || echo "   ! Nova Agent hasn't said it's online yet (it keeps trying; check Computer in a minute)"

echo "Checking everything from outside"
problems=0
for path in /privacy /portal/ /agent/; do
  c=$(code "$LIVE$path"); if [ "$c" = 200 ]; then ok "$path"; else echo "   ✘ $path answered $c"; problems=1; fi
done
c=$(code "$LIVE/app/api/me"); if [ "$c" = 401 ]; then ok "sign-in is checked"; else echo "   ✘ /app/api/me answered $c"; problems=1; fi
chat="claude-test-switch-$(date +%s)"
reply=$(curl -s -m 60 -X POST "$LIVE/" -H "Content-Type: application/json" -H "Origin: https://novacane.co.uk" \
  --data "{\"chatId\":\"$chat\",\"page\":\"/\",\"messages\":[{\"role\":\"user\",\"content\":\"Hi, what are your opening hours?\"}]}" || true)
if echo "$reply" | grep -q '"reply"'; then ok "the website chat answers"; else echo "   ✘ the website chat didn't answer: $(echo "$reply" | head -c 160)"; problems=1; fi
ssh -o BatchMode=yes "$SSH" "db=\$(find /srv/nova/state/v3/d1 -name '*.sqlite' ! -name metadata.sqlite | head -1); sudo -u nova sqlite3 \"\$db\" \"DELETE FROM chat_messages WHERE chat_id LIKE 'claude-test-switch-%'; DELETE FROM memory_progress WHERE chat_id LIKE 'claude-test-switch-%';\"" >/dev/null 2>&1 || true

echo
if [ "$problems" = 0 ]; then
  echo "Switched ✓ Nova Bot now runs on the VPS, 24/7, at the same address: $LIVE"
else
  echo "Switched, but something above didn't check out. Look at Computer (Portal → Admin → Computer); to go back: vps/switch-back.sh"
fi
echo "Phones: notifications turn themselves back on the next time Nova Agent or Portal is opened on each phone."
echo "To go back to Cloudflare: vps/switch-back.sh"

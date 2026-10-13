#!/usr/bin/env bash
# Retire the old address (novacane-worker.novacane-studio.workers.dev). Nova's own address is
# https://nova.novacane.co.uk. After this, anyone who opens the old address lands on the same page
# at the new one. Only Acuity's webhook and the Google email script keep using the old address
# (it still passes them on, with their old keys), so nothing has to change in Acuity.
#
# Run on the studio PC, from the novacane-worker folder, AFTER the website chat, Google sign-in and
# the phones use the new address:   vps/retire-old-address.sh
# Leave it like this for a few weeks. To undo: vps/switch.sh's step 6 again, i.e.
#   node vps/make-passthrough-config.mjs > wrangler.passthrough.jsonc && npx wrangler deploy -c wrangler.passthrough.jsonc
set -euo pipefail
cd "$(dirname "$0")/.."
NEW=${DESK_NEW_URL:-https://nova.novacane.co.uk}
OLD=${DESK_OLD_URL:-https://novacane-worker.novacane-studio.workers.dev}
VPS_URL=${DESK_VPS_URL:-https://185-185-126-195.sslip.io}
ok() { printf '   ✓ %s\n' "$*"; }
fail() { printf '\n✘ %s\n' "$*"; exit 1; }
code() { curl -s -o /dev/null -m 20 -w '%{http_code}' "$@" || true; }

echo "Send the old address on to $NEW."
if [ "${DESK_YES:-}" != "yes" ]; then
  read -r -p "Type yes to do it now: " answer
  [ "$answer" = "yes" ] || { echo "Nothing changed."; exit 0; }
fi

echo "1/3 Checks"
for path in /privacy /agent/; do
  [ "$(code "$NEW$path")" = 200 ] || fail "$NEW$path isn't answering, so nothing was changed."
done
ok "$NEW answers"

echo "2/3 The old address starts sending people on"
node vps/make-passthrough-config.mjs "$VPS_URL" "$NEW" > wrangler.passthrough.jsonc
deployed=""
for i in 1 2 3 4 5; do
  if out=$(npx wrangler deploy -c wrangler.passthrough.jsonc 2>&1) && echo "$out" | grep -q "Version ID"; then deployed=$(echo "$out" | grep -o 'Version ID: [0-9a-f-]*'); break; fi
  sleep 8
done
[ -n "$deployed" ] || fail "The old address didn't take the change (it still passes everything on, as before)."
ok "$deployed"

echo "3/3 Checking"
sleep 5
where=$(curl -s -o /dev/null -m 20 -w '%{http_code} %{redirect_url}' "$OLD/agent/" || true)
if [ "$where" = "308 $NEW/agent/" ]; then ok "the old address sends people to $NEW"; else echo "   ! the old address answered: $where (give it a minute, then open $OLD/agent/)"; fi
[ "$(code "$NEW/agent/")" = 200 ] && ok "$NEW/agent/ answers"
echo "Done. Acuity and the Google email script still go through the old address: nothing to change there."

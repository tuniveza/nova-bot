#!/usr/bin/env bash
# Every hour (nova-keys.timer): are the outside services' keys still working? (the user, 18 Nov 2026:
# "keep the api keys updated and fully functional all the time")
#
# Checks, without spending anything:
#   - the Claude key in Nova Bot (/srv/nova/secrets.env + app/.dev.vars) and Nova Agent (/etc/nova-agent/agent.env)
#   - Stripe's live and test secret keys
#   - Nova Agent's link key (AGENT_NOVA_KEY) the same on both sides
#   - Nova Bot's own log: new Claude errors in the last hour
# Fixes what it safely can: if one copy of the Claude key works and another doesn't, the working one is
# copied over (with a backup) and the service restarted.
# Tells the studio: one email a day per problem to ALERT_TO while it lasts, and one when it's fixed.
# Nothing secret is ever written to the log or the email (only the last 4 characters of a key).
set -uo pipefail

ALERT_TO="${ALERT_TO:-admin@kulturekingdom.uk}"
FROM="hello@novacane.co.uk"
STATE=/var/lib/nova/keys-check
mkdir -p "$STATE"
BOT=/srv/nova/secrets.env
VARS=/srv/nova/app/.dev.vars
AGENT=/etc/nova-agent/agent.env

val() { grep -m1 "^$2=" "$1" 2>/dev/null | cut -d= -f2- | sed 's/^"//; s/"$//'; }
tail4() { local k="$1"; echo "…${k: -4}"; }
code() { curl -s -o /dev/null -m 20 -w '%{http_code}' "$@"; }

claude_ok() { [ -n "$1" ] && [ "$(code https://api.anthropic.com/v1/models -H "x-api-key: $1" -H 'anthropic-version: 2023-06-01')" = 200 ]; }

problems=()

# --- Claude: each copy, and copy a working one over a broken one ---
kb=$(val $BOT ANTHROPIC_API_KEY); kv=$(val $VARS ANTHROPIC_API_KEY); ka=$(val $AGENT ANTHROPIC_API_KEY)
good=""
for k in "$kb" "$kv" "$ka"; do if claude_ok "$k"; then good="$k"; break; fi; done
if [ -z "$good" ]; then
  problems+=("claude|The Claude key is rejected everywhere (Nova Bot $(tail4 "$kb"), Nova Agent $(tail4 "$ka")). NovaBot on the website and Nova Agent can't answer. A new key is needed from console.anthropic.com → API keys.")
else
  T=$(date +%Y%m%d-%H%M)
  fixed=""
  for f in $BOT $VARS $AGENT; do
    if [ "$(val $f ANTHROPIC_API_KEY)" != "$good" ]; then
      cp -p "$f" "$f.bak-keys-$T"
      awk -v k="$good" 'BEGIN{FS=OFS="="} /^ANTHROPIC_API_KEY=/{print "ANTHROPIC_API_KEY=" k; next} {print}' "$f" > "$f.new" \
        && chown --reference="$f" "$f.new" && chmod --reference="$f" "$f.new" && mv "$f.new" "$f" && fixed="$fixed $f"
    fi
  done
  if [ -n "$fixed" ]; then
    case "$fixed" in *"$AGENT"*) systemctl restart nova-agent ;; esac
    case "$fixed" in *"/srv/nova/"*) systemctl restart nova ;; esac
    echo "copied the working Claude key ($(tail4 "$good")) to:$fixed"
    printf 'The Claude key had stopped working in part of Nova. The working key (%s) was copied to:%s\nand the services restarted. Nothing for you to do.\n' "$(tail4 "$good")" "$fixed" \
      | { printf 'From: Nova <%s>\nTo: %s\nSubject: Nova: Claude key fixed automatically\n\n' "$FROM" "$ALERT_TO"; cat; } | /usr/sbin/sendmail -t
  fi
fi

# --- Stripe ---
sl=$(val $BOT STRIPE_SECRET_KEY); st=$(val $BOT STRIPE_TEST_SECRET_KEY)
if [ -n "$sl" ] && [ "$(code https://api.stripe.com/v1/balance -u "$sl:")" != 200 ]; then
  problems+=("stripe-live|Stripe's live key ($(tail4 "$sl")) is rejected: card payments on invoices won't work. A new secret key is needed from dashboard.stripe.com → Developers → API keys.")
fi
if [ -n "$st" ] && [ "$(code https://api.stripe.com/v1/balance -u "$st:")" != 200 ]; then
  problems+=("stripe-test|Stripe's test key ($(tail4 "$st")) is rejected: test invoices can't take test payments.")
fi

# --- Nova Agent's link key: the same on both sides ---
if [ "$(val $BOT AGENT_NOVA_KEY)" != "$(val $AGENT AGENT_NOVA_KEY)" ]; then
  problems+=("agent-link|Nova Agent's link key differs between Nova Bot and Nova Agent: the online link and invoice PDFs stop working. (fix-nova-key.sh in the project puts it back.)")
fi

# --- Nova Bot's own log: Claude errors in the last hour ---
n=$(journalctl -u nova --since "-1h" --no-pager 2>/dev/null | grep -c "Claude error" || true)
if [ "${n:-0}" -ge 5 ]; then
  problems+=("claude-errors|NovaBot logged $n Claude errors in the last hour (the key itself answers, so it may be Claude being busy or out of credit).")
fi

# --- Tell the studio: once a day per problem, and when it's over ---
now=$(date +%s)
active=""
for p in "${problems[@]}"; do
  id="${p%%|*}"; msg="${p#*|}"; active="$active $id"
  echo "PROBLEM $id: $msg"
  last=$(cat "$STATE/$id" 2>/dev/null || echo 0)
  if [ $((now - last)) -ge 86400 ]; then
    { printf 'From: Nova <%s>\nTo: %s\nSubject: Nova: a key needs replacing (%s)\n\n' "$FROM" "$ALERT_TO" "$id"
      printf '%s\n\nChecked %s on the VPS. You will get this once a day until it is fixed.\n' "$msg" "$(date '+%d %b %Y %H:%M')"; } | /usr/sbin/sendmail -t
    echo "$now" > "$STATE/$id"
  fi
done
for f in "$STATE"/*; do
  [ -e "$f" ] || continue
  id=$(basename "$f")
  case " $active " in *" $id "*) ;; *)
    { printf 'From: Nova <%s>\nTo: %s\nSubject: Nova: %s is working again\n\n' "$FROM" "$ALERT_TO" "$id"
      printf 'The problem with %s is over (checked %s).\n' "$id" "$(date '+%d %b %Y %H:%M')"; } | /usr/sbin/sendmail -t
    rm -f "$f"; echo "recovered $id" ;;
  esac
done
[ ${#problems[@]} -eq 0 ] && echo "all keys OK"
exit 0

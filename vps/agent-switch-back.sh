#!/usr/bin/env bash
# Bring Nova Agent back from the server to the studio PC (the opposite of vps/agent-switch.sh).
# Run on the studio PC from the novacane-worker folder:  vps/agent-switch-back.sh   (asks for yes)
# The server's Nova Agent stops and is switched off; whatever changed there (data, and code the
# Fixer merged) comes back to the PC; the PC's Nova Agent starts again and links to Nova Bot.
set -euo pipefail
cd "$(dirname "$0")/.."
. vps/agent/lib.sh
[ "${1:-}" = --yes ] || ask_yes "Bring Nova Agent back to the studio PC? The server's Nova Agent stops; its data comes back here."

echo "1/4 Stopping Nova Agent on the server (and keeping it off)"
vps 'rm -f /srv/nova-agent/.live; systemctl disable --now nova-agent >/dev/null 2>&1 || true; ! systemctl is-active --quiet nova-agent' \
  || { echo "  It didn't stop. Nothing else was changed."; exit 1; }
# (the laptop-off test's own test person, if a run was cut short)
vps 'rm -f /srv/nova-agent/data/chats/laptop-off-test.json /srv/nova-agent/data/boards/laptop-off-test.json; f=/srv/nova-agent/data/people.json; [ -f $f ] && sudo -u nova-agent node -e "const fs=require(\"fs\");const p=JSON.parse(fs.readFileSync(\"$f\",\"utf8\"));delete p[\"laptop-off-test\"];fs.writeFileSync(\"$f\",JSON.stringify(p,null,2)+\"\\n\")" || true'

echo "2/4 Code: what the Fixer merged on the server comes back here"
vps/agent-code-sync.sh || echo "  (the code needs a look, see above; the data still comes back)"

echo "3/4 Data: the server's copy comes back to the PC"
if ! pc_agent_stopped; then systemctl --user stop agent-nova 2>/dev/null || true; sleep 3; fi
vps/agent-sync.sh --reverse

echo "4/4 Starting the PC's Nova Agent"
rm -f "$PC_MARKER" "$PC_DROPIN"
systemctl --user daemon-reload
since=$(date '+%Y-%m-%d %H:%M:%S')
systemctl --user enable --now agent-nova >/dev/null 2>&1
if wait_online pc 120 "$since"; then
  echo "Done: \"Nova Agent is online\" on the studio PC again"
else
  echo "The PC's Nova Agent didn't say it's online within 2 minutes: journalctl --user -u agent-nova"
  exit 1
fi

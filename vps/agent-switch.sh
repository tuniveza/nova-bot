#!/usr/bin/env bash
# Move Nova Agent from the studio PC to the server, so everything works with the laptop off.
# Run on the studio PC from the novacane-worker folder:
#   vps/agent-switch.sh              the move (asks for yes first)
#   vps/agent-switch.sh --rehearse   the same, the full laptop-off test, then straight back to the PC
# Steps: a backup of the PC's data; the PC's Nova Agent stopped, switched off and kept off (a marker
# file and a systemd condition, so it can't start again by itself); the code and then the data
# copied over; Nova Agent started on the server; "Nova Agent is online" seen in the server's journal;
# then vps/full-laptop-off-test.sh through https://nova.novacane.co.uk. If the server's Nova Agent
# doesn't come online, it goes straight back to the PC. Back again: vps/agent-switch-back.sh
set -euo pipefail
cd "$(dirname "$0")/.."
. vps/agent/lib.sh
rehearse=$([ "${1:-}" = --rehearse ] && echo 1 || echo 0)

echo "Before anything changes:"
# (these leave stdin alone: the yes below is read from it)
vps 'test -f /etc/systemd/system/nova-agent.service && test -s /etc/nova-agent/agent.env && test -d /srv/nova-agent/na/node_modules' </dev/null \
  || { echo "  The server isn't set up for Nova Agent yet: run vps/agent-setup.sh first"; exit 1; }
vps 'grep -q X-Nova-Agent-Where /srv/nova/app/src/agent-relay.js' </dev/null \
  || { echo "  Nova Bot on the server is from before 'only one Nova Agent': deploy it first (vps/deploy-live.sh)"; exit 1; }
busy=$(node -e 'const f=JSON.parse(require("fs").readFileSync(process.argv[1],"utf8"));console.log((f.jobs||[]).filter(j=>["approved","landing","restarting","verifying","rolling-back"].includes(j.status)).length)' "$NA_DIR/data/fixer.json" 2>/dev/null || echo 0)
[ "$busy" = 0 ] || { echo "  The Fixer is putting a change live right now: wait for it to finish, then run this again"; exit 1; }
echo "  the server is ready, Nova Bot knows about the move, the Fixer is idle"
if [ "$rehearse" = 1 ]; then
  ask_yes "REHEARSAL: the PC's Nova Agent stops, the server's takes over and is tested end to end, then the PC's comes back (a few minutes)."
else
  ask_yes "Move Nova Agent to the server now? The PC's Nova Agent stops and stays off (back: vps/agent-switch-back.sh)."
fi

backup="$HOME/an/pj/ns/backups/agent-move-$(date +%Y%m%d-%H%M%S)"
echo "1/6 Backing up the PC's data → $backup"
mkdir -p "$backup" && chmod 700 "$backup"
sqlite3 "$NA_DIR/data/nova.db" ".backup '$backup/nova.db'"
tar -C "$NA_DIR" -czf "$backup/data.tgz" data

echo "2/6 Stopping the PC's Nova Agent (and keeping it off)"
mkdir -p "$(dirname "$PC_MARKER")" "$(dirname "$PC_DROPIN")"
echo "vps/agent-switch.sh moved Nova Agent to the server at $(date -u +%Y-%m-%dT%H:%M:%SZ)" > "$PC_MARKER"
printf '# Nova Agent runs on the server (vps/agent-switch.sh in Nova Bot); vps/agent-switch-back.sh removes this\n[Unit]\nConditionPathExists=!%s\n' "$PC_MARKER" > "$PC_DROPIN"
systemctl --user daemon-reload
systemctl --user disable --now agent-nova >/dev/null 2>&1 || true
for _ in $(seq 1 12); do pc_agent_stopped && break; sleep 5; done
if ! pc_agent_stopped; then
  echo "  The PC's Nova Agent didn't stop; putting everything back"
  rm -f "$PC_MARKER" "$PC_DROPIN"; systemctl --user daemon-reload; systemctl --user enable --now agent-nova >/dev/null 2>&1
  exit 1
fi
echo "  stopped: no service, no copy running from $NA_DIR, nothing on port 4545"
# (the laptop-off test's own test person, if a check run before left anything here)
rm -f "$NA_DIR/data/chats/laptop-off-test.json" "$NA_DIR/data/boards/laptop-off-test.json"
node -e 'const fs=require("fs"),f=process.argv[1];try{const p=JSON.parse(fs.readFileSync(f,"utf8"));if(p["laptop-off-test"]){delete p["laptop-off-test"];fs.writeFileSync(f,JSON.stringify(p,null,2)+"\n")}}catch{}' "$NA_DIR/data/people.json"

back_now() { echo "Going back to the PC…"; vps/agent-switch-back.sh --yes; }

echo "3/6 Code: the same on both"
vps/agent-code-sync.sh || { back_now; exit 1; }
echo "4/6 Data: the final copy (the PC's Nova Agent is stopped)"
vps/agent-sync.sh || { back_now; exit 1; }

echo "5/6 Starting Nova Agent on the server"
since=$(vps "date '+%Y-%m-%d %H:%M:%S'")
# (.ran-here: from now on the server's data is the newest, so switching back brings it to the PC)
vps 'touch /srv/nova-agent/.live && install -o nova-agent -g nova-agent -m 640 /dev/null /srv/nova-agent/data/.ran-here && systemctl enable --now nova-agent >/dev/null 2>&1'
if wait_online vps 120 "$since"; then
  echo "  \"Nova Agent is online\" (the server's journal)"
else
  echo "  The server's Nova Agent didn't come online within 2 minutes. Its journal:"
  vps "journalctl -u nova-agent --since '$since' --no-pager -o cat | tail -15" || true
  back_now
  exit 1
fi

echo "6/6 The full laptop-off test"
result=0
vps/full-laptop-off-test.sh || result=$?

if [ "$rehearse" = 1 ]; then
  echo
  echo "Rehearsal over: back to the PC"
  vps/agent-switch-back.sh --yes
fi
exit $result

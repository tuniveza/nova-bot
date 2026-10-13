#!/usr/bin/env bash
# Nova Agent's data (na/data: quests, chats, Calendar, Board and its files, Files, the Fixer's jobs,
# the Acuity session, its database…), copied between the studio PC and the server.
# Run on the studio PC from the novacane-worker folder:
#   vps/agent-sync.sh             PC → server (/srv/nova-agent/data), replacing the server's copy
#   vps/agent-sync.sh --reverse   server → PC (for vps/agent-switch-back.sh), replacing the PC's copy
# Safe to run again. While the sending side's Nova Agent is running it's a preview copy; the real
# move (vps/agent-switch.sh) runs it with the sending side stopped. The receiving side must be stopped.
# The database (nova.db) goes as a clean copy (sqlite's own backup), never half-written.
set -euo pipefail
cd "$(dirname "$0")/.."
. vps/agent/lib.sh
PC_DATA="$NA_DIR/data"
tmp=$(mktemp -d)
trap 'rm -rf "$tmp"' EXIT

if [ "${1:-}" != --reverse ]; then
  if vps 'systemctl is-active --quiet nova-agent'; then echo "Nova Agent is running on the server: stop it first (vps/agent-switch-back.sh)"; exit 1; fi
  echo "1/3 Nova Agent's data → the server ($(du -sh "$PC_DATA" | cut -f1))"
  sqlite3 "$PC_DATA/nova.db" ".backup '$tmp/nova.db'"
  rsync -a --delete --exclude 'nova.db' --exclude 'nova.db-wal' --exclude 'nova.db-shm' "$PC_DATA/" "$SSH:$HOME_VPS/data/"
  rsync -a "$tmp/nova.db" "$SSH:$HOME_VPS/data/nova.db"
  echo "2/3 On the server: owner, and the Fixer's jobs renamed to the server's folders"
  scp -q vps/agent/worktrees.mjs "$SSH:$HOME_VPS/.worktrees.mjs"
  vps "PC_JOBS='$PC_JOBS' bash -s" <<'REMOTE'
set -euo pipefail
cd /srv/nova-agent
rm -f data/nova.db-wal data/nova.db-shm data/.ran-here
chown -R nova-agent:nova-agent data .worktrees.mjs
chmod 750 data
sudo -u nova-agent node .worktrees.mjs /srv/nova-agent/data "$PC_JOBS" /srv/nova-agent/fixer-jobs /srv/nova-agent/na /srv/nova-agent/nb
rm -f .worktrees.mjs
date -u +%Y-%m-%dT%H:%M:%SZ > data/.copied-from-pc
REMOTE
  echo "3/3 Done: the server has the PC's data"
else
  if ! pc_agent_stopped; then echo "Nova Agent is running on the PC: stop it first"; exit 1; fi
  echo "1/3 Nova Agent's data → the PC (from the server)"
  vps "sqlite3 $HOME_VPS/data/nova.db \".backup '/tmp/nova-agent-back.db'\""
  rsync -a --delete --exclude 'nova.db' --exclude 'nova.db-wal' --exclude 'nova.db-shm' --exclude '.copied-from-pc' --exclude '.ran-here' "$SSH:$HOME_VPS/data/" "$PC_DATA/"
  rsync -a "$SSH:/tmp/nova-agent-back.db" "$tmp/nova.db"
  vps 'rm -f /tmp/nova-agent-back.db'
  rm -f "$PC_DATA/nova.db-wal" "$PC_DATA/nova.db-shm"
  mv "$tmp/nova.db" "$PC_DATA/nova.db"
  echo "2/3 On the PC: the Fixer's jobs renamed back to the PC's folders"
  node vps/agent/worktrees.mjs "$PC_DATA" "$HOME_VPS/fixer-jobs" "$PC_JOBS" "$NA_DIR" "$NB_DIR"
  echo "3/3 Done: the PC has the server's data"
fi

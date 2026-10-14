#!/usr/bin/env bash
# Nova Agent's and Nova Bot's code, the same on the studio PC and the server.
# Run on the studio PC from the novacane-worker folder:   vps/agent-code-sync.sh [--to-server]
# Once Nova Agent runs on the server, its Fixer merges approved changes into the server's copies
# (/srv/nova-agent/na and nb), and work done on the PC lands in the PC's. For each of the two, main:
#   - the server is ahead (the Fixer's changes): the PC's main moves forward to it (fast-forward only);
#   - the PC is ahead: it's sent to the server; Nova Agent on the server restarts with it if it's running;
#   - both changed: nothing is touched, and it says so (merge by hand, then run this again).
# The Fixer's job branches (fixer/*) go both ways, never overwriting one. --to-server only sends.
set -euo pipefail
cd "$(dirname "$0")/.."
. vps/agent/lib.sh
only_send=$([ "${1:-}" = --to-server ] && echo 1 || echo 0)
na_changed=0
for repo in na nb; do
  dir=$(local_of $repo)
  remote=$(remote_of $repo)
  label=$([ $repo = na ] && echo "Nova Agent" || echo "Nova Bot")
  theirs=""
  if [ "$only_send" = 0 ] || vps "test -n \"\$(sudo -u nova-agent git -C $HOME_VPS/$repo rev-parse --verify --quiet main)\"" 2>/dev/null; then
    git -C "$dir" fetch -q "$UPLOAD" "$remote" '+refs/heads/main:refs/remotes/server/main' '+refs/heads/fixer/*:refs/remotes/server/fixer/*' 2>/dev/null || true
    theirs=$(git -C "$dir" rev-parse --verify --quiet refs/remotes/server/main || true)
  fi
  mine=$(git -C "$dir" rev-parse main)
  if [ -n "$theirs" ] && [ "$theirs" != "$mine" ]; then
    if git -C "$dir" merge-base --is-ancestor "$mine" "$theirs"; then
      if [ "$only_send" = 1 ]; then echo "$label: the server is ahead (${theirs:0:7}); run vps/agent-code-sync.sh first"; exit 1; fi
      if [ "$(git -C "$dir" branch --show-current)" = main ]; then
        git -C "$dir" merge -q --ff-only "$theirs" || { echo "$label: couldn't move the PC's main forward (local edits in the way?)"; exit 1; }
      else
        git -C "$dir" update-ref refs/heads/main "$theirs" "$mine"
      fi
      echo "$label: the PC's main moved forward to the server's (${theirs:0:7})"
      mine=$theirs
    elif ! git -C "$dir" merge-base --is-ancestor "$theirs" "$mine"; then
      echo "$label: main changed on both the PC and the server. Nothing was touched."
      echo "   Merge server/main into the PC's main by hand (git -C $dir merge server/main), then run this again."
      exit 1
    fi
  fi
  if [ "$theirs" != "$mine" ]; then
    git -C "$dir" push -q "$RECEIVE" "$remote" "main:main"
    echo "$label: the server now has the PC's main (${mine:0:7})"
    [ $repo = na ] && na_changed=1
  else
    echo "$label: the same on both (${mine:0:7})"
  fi
  # The Fixer's job branches: whatever one side has and the other doesn't
  git -C "$dir" push -q "$RECEIVE" "$remote" 'refs/heads/fixer/*:refs/heads/fixer/*' 2>/dev/null || true
  if [ "$only_send" = 0 ]; then
    for b in $(git -C "$dir" for-each-ref --format='%(refname:strip=4)' 'refs/remotes/server/fixer/'); do
      git -C "$dir" rev-parse --verify --quiet "refs/heads/fixer/$b" >/dev/null || git -C "$dir" branch -q "fixer/$b" "refs/remotes/server/fixer/$b"
    done
  fi
done
# Nova Agent on the server runs from its copy: new code means new packages (if they changed) and a restart
if [ "$na_changed" = 1 ] && vps 'systemctl is-active --quiet nova-agent'; then
  vps 'bash -s' <<'REMOTE'
set -euo pipefail
cd /srv/nova-agent/na
if [ "$(sha256sum package-lock.json | cut -c1-64)" != "$(cat /srv/nova-agent/.npm-na 2>/dev/null)" ]; then
  systemctl stop nova-agent # (npm ci under a running Nova Agent can crash it half-way; it restarts below)
  sudo -u nova-agent -H npm ci --no-audit --no-fund --loglevel=error >/dev/null && sha256sum package-lock.json | cut -c1-64 > /srv/nova-agent/.npm-na
fi
systemctl restart nova-agent
echo "Nova Agent on the server restarted with the new code"
REMOTE
fi

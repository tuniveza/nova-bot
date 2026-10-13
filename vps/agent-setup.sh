#!/usr/bin/env bash
# Nova Agent on the server, step 1 (safe to run again): get the VPS ready to run Nova Agent. Nothing
# is switched: the PC's Nova Agent keeps running and stays the one that's linked.
# Run on the studio PC from the novacane-worker folder:  vps/agent-setup.sh
#   - user nova-agent, home /srv/nova-agent: its code (git copies of Nova Agent and Nova Bot, so its
#     Fixer can prepare and land changes there; na-release for Nova Bot's panels), data/, fixer-jobs/
#   - packages (node-pty built for Console's terminals), Playwright's Chromium (the Acuity helper and
#     the Fixer's sweep, hidden), Claude Code (the Fixer's hands; signed in once by an admin over ssh)
#   - nova-agent.service (not started), its two sudo rules, /usr/local/sbin/nova-deploy-here
#   - /etc/nova-agent/agent.env (root only): the PC's na/.env plus the server's own settings. Never shown.
set -euo pipefail
cd "$(dirname "$0")/.."
. vps/agent/lib.sh

echo "1/7 User, folders and system packages"
vps 'bash -s' <<'REMOTE'
set -euo pipefail
id nova-agent >/dev/null 2>&1 || useradd --system --home-dir /srv/nova-agent --create-home --shell /bin/bash nova-agent
install -d -o nova-agent -g nova-agent -m 750 /srv/nova-agent /srv/nova-agent/data /srv/nova-agent/fixer-jobs
install -d -o root -g root -m 700 /etc/nova-agent
need=""
for p in build-essential python3 rsync sqlite3 git; do dpkg -s "$p" >/dev/null 2>&1 || need="$need $p"; done
[ -z "$need" ] || DEBIAN_FRONTEND=noninteractive apt-get install -y -qq $need >/dev/null
REMOTE

echo "2/7 Code: git copies of Nova Agent and Nova Bot (main and the Fixer's job branches)"
name=$(git -C "$NA_DIR" config user.name || echo "Nova Fixer")
email=$(git -C "$NA_DIR" config user.email || echo "fixer@nova.invalid")
for repo in na nb; do
  vps "NAME='$name' EMAIL='$email' REPO=$repo bash -s" <<'REMOTE'
set -euo pipefail
d=/srv/nova-agent/$REPO
if [ ! -d "$d/.git" ]; then sudo -u nova-agent git init -q -b main "$d"; fi
sudo -u nova-agent git -C "$d" config receive.denyCurrentBranch updateInstead
sudo -u nova-agent git -C "$d" config user.name "$NAME"
sudo -u nova-agent git -C "$d" config user.email "$EMAIL"
REMOTE
done
vps/agent-code-sync.sh --to-server
vps 'bash -s' <<'REMOTE'
set -euo pipefail
cd /srv/nova-agent
# (a fresh copy: its files, from main)
for r in na nb; do [ -f "$r/package.json" ] || sudo -u nova-agent git -C "$r" checkout -q -f main; done
[ -e na-release/.git ] || sudo -u nova-agent git -C na worktree add -q --detach /srv/nova-agent/na-release main
REMOTE

echo "3/7 Packages (Nova Agent with node-pty, and Nova Bot for the Fixer's checks)"
vps 'bash -s' <<'REMOTE'
set -euo pipefail
for r in na nb; do
  cd /srv/nova-agent/$r
  stamp=/srv/nova-agent/.npm-$r
  if [ ! -d node_modules ] || [ "$(sha256sum package-lock.json | cut -c1-64)" != "$(cat $stamp 2>/dev/null)" ]; then
    sudo -u nova-agent -H npm ci --no-audit --no-fund --loglevel=error >/dev/null
    sha256sum package-lock.json | cut -c1-64 > $stamp
  fi
done
cd /srv/nova-agent/na
sudo -u nova-agent -H node -e 'require("node-pty"); console.log("   node-pty works")'
REMOTE

echo "4/7 Chromium for the Acuity helper and the Fixer's sweep (hidden)"
vps 'bash -s' <<'REMOTE'
set -euo pipefail
cd /srv/nova-agent/na
npx --no-install playwright install-deps chromium >/dev/null 2>&1
sudo -u nova-agent -H npx --no-install playwright install chromium >/dev/null
sudo -u nova-agent -H node -e 'require("playwright").chromium.launch({headless:true}).then(b=>b.close()).then(()=>console.log("   Chromium starts"))'
REMOTE

echo "5/7 Claude Code for the Fixer"
vps 'bash -s' <<'REMOTE'
set -euo pipefail
if [ ! -x /srv/nova-agent/.local/bin/claude ]; then
  sudo -u nova-agent -H bash -c 'curl -fsSL https://claude.ai/install.sh | bash' >/dev/null 2>&1
fi
v=$(sudo -u nova-agent -H /srv/nova-agent/.local/bin/claude --version 2>/dev/null || echo "not installed")
echo "   Claude Code: $v"
if [ -f /srv/nova-agent/.claude/.credentials.json ]; then echo "   signed in"; else echo "   not signed in yet: ssh $(hostname -I | cut -d' ' -f1), then: sudo -iu nova-agent claude  (and /login)"; fi
REMOTE

echo "6/7 Service, sudo rules, the server's own deploy"
scp -q vps/agent/nova-agent.service "$SSH:/etc/systemd/system/nova-agent.service"
scp -q vps/agent/sudoers "$SSH:/etc/nova-agent/sudoers.new"
scp -q vps/agent/nova-deploy-here "$SSH:/usr/local/sbin/nova-deploy-here"
vps 'bash -s' <<'REMOTE'
set -euo pipefail
chown root:root /usr/local/sbin/nova-deploy-here && chmod 755 /usr/local/sbin/nova-deploy-here
visudo -cqf /etc/nova-agent/sudoers.new
install -m 440 -o root -g root /etc/nova-agent/sudoers.new /etc/sudoers.d/nova-agent && rm /etc/nova-agent/sudoers.new
systemctl daemon-reload
REMOTE

echo "7/7 Settings and keys (from the PC's na/.env; never shown)"
{
  grep -vE '^\s*(#|$)' "$NA_DIR/.env" | grep -vE '^(HEADLESS|NOVA_ON_SERVER|NOVA_DATA_DIR|VISUALIZER_PORT|NOVA_LOCAL_UI|FIXER_[A-Z_]+|WATCHDOG)='
  cat <<'SERVER'
# The server's own (vps/agent-setup.sh)
NOVA_ON_SERVER=1
NOVA_DATA_DIR=/srv/nova-agent/data/
VISUALIZER_PORT=4545
HEADLESS=true
FIXER_NA_DIR=/srv/nova-agent/na
FIXER_NB_DIR=/srv/nova-agent/nb
FIXER_RELEASE_DIR=/srv/nova-agent/na-release
FIXER_JOBS_DIR=/srv/nova-agent/fixer-jobs
FIXER_CLAUDE=/srv/nova-agent/.local/bin/claude
SERVER
} | vps 'umask 077; cat > /etc/nova-agent/agent.env.new && chmod 600 /etc/nova-agent/agent.env.new && mv /etc/nova-agent/agent.env.new /etc/nova-agent/agent.env && echo "   $(grep -c = /etc/nova-agent/agent.env) settings"'
echo "Ready. Nothing is switched: the PC's Nova Agent is still the linked one. Next: vps/agent-switch.sh"

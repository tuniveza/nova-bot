# Shared by vps/agent-*.sh (run on the studio PC): where things are, and small helpers.
# Settings (defaults): DESK_SSH=root@185.185.126.195  NOVA_URL=https://nova.novacane.co.uk
#   NA_DIR=~/an/pj/ns/na (Nova Agent on the PC)  NB_DIR=~/an/pj/ns/nb/novacane-worker (Nova Bot on the PC)
SSH=${DESK_SSH:-root@185.185.126.195}
URL=${NOVA_URL:-https://nova.novacane.co.uk}
NA_DIR=${NA_DIR:-$HOME/an/pj/ns/na}
NB_DIR=${NB_DIR:-$HOME/an/pj/ns/nb/novacane-worker}
PC_JOBS=${PC_JOBS:-$HOME/an/pj/ns/fixer-jobs}
PC_MARKER=${NOVA_ON_SERVER_MARKER:-$HOME/.config/nova/agent-on-server}
PC_DROPIN=$HOME/.config/systemd/user/agent-nova.service.d/on-server.conf
HOME_VPS=/srv/nova-agent
AGENT_DIR=$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)

vps() { ssh -o BatchMode=yes -o ConnectTimeout=15 "$SSH" "$@"; }
# git on the VPS's copies, as Nova Agent's user (pushes and fetches go through ssh as root)
RECEIVE="--receive-pack=sudo -u nova-agent git-receive-pack"
UPLOAD="--upload-pack=sudo -u nova-agent git-upload-pack"
remote_of() { [ "$1" = na ] && echo "$SSH:$HOME_VPS/na" || echo "$SSH:$HOME_VPS/nb"; }
local_of() { [ "$1" = na ] && echo "$NA_DIR" || echo "$NB_DIR"; }

# Is the PC's Nova Agent fully stopped? (its service, any copy running from its folder, its port)
pc_agent_stopped() {
  [ "$(systemctl --user is-active agent-nova 2>/dev/null)" != active ] || return 1
  local pid
  for pid in $(pgrep -f 'src/visualizer/server.ts' || true); do
    [ "$(readlink "/proc/$pid/cwd" 2>/dev/null)" = "$NA_DIR" ] && return 1
  done
  ! ss -ltn 2>/dev/null | grep -q '127.0.0.1:4545 '
}

# Wait (up to $2 seconds) for "Nova Agent is online" in a journal: pc or vps, since $3 (date)
wait_online() {
  local where=$1 secs=$2 since=$3 i
  for i in $(seq 1 $((secs / 5))); do
    sleep 5
    if [ "$where" = pc ]; then
      journalctl --user -u agent-nova --since "$since" --no-pager -o cat 2>/dev/null | grep -q "Nova Agent is online" && return 0
    else
      vps "journalctl -u nova-agent --since '$since' --no-pager -o cat" 2>/dev/null | grep -q "Nova Agent is online" && return 0
    fi
  done
  return 1
}

ask_yes() { # the question; anything but "yes" stops
  local answer
  printf '%s\nType yes to go ahead: ' "$1"
  read -r answer || answer=""
  [ "$answer" = yes ] || { echo "Stopped: nothing was changed."; exit 1; }
}

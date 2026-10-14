#!/usr/bin/env bash
# The VPS's desktop, shown in Nova Agent's Computer panel (run on the VPS as root:
#   ssh root@185.185.126.195 'bash -s' < vps/desktop-setup.sh ).
# - A light XFCE desktop for the nova-agent user in TigerVNC on 127.0.0.1:5901 only (never public).
# - websockify on 127.0.0.1:6081, started by systemd only when a browser connects (socket activation);
#   it exits after 15 minutes with nobody watching and the desktop stops with it (saves memory).
# - Caddy serves noVNC at /vps-desktop/ and the desktop's websocket at /vps-desktop/websockify, and asks
#   Nova Bot first (GET /app/api/admin-check): signed-in admins only, everyone else is turned away.
set -euo pipefail

echo "1/4 Packages"
export DEBIAN_FRONTEND=noninteractive
apt-get update -qq
apt-get install -y -qq --no-install-recommends \
  xfce4-session xfwm4 xfce4-panel xfdesktop4 xfce4-settings xfconf thunar xfce4-terminal mousepad htop \
  tigervnc-standalone-server novnc python3-websockify dbus-x11 xfonts-base fonts-dejavu-core adwaita-icon-theme >/dev/null

echo "2/4 The desktop (nova-agent, display :1, localhost only)"
cat > /usr/local/sbin/nova-desktop-run <<'EOF'
#!/bin/sh
# The VPS's desktop: an X display in TigerVNC (127.0.0.1:5901, no VNC password: only reachable
# through Caddy's admin check) with XFCE in it. Stops when XFCE does.
Xtigervnc :1 -geometry 1600x900 -depth 24 -localhost=1 -rfbport 5901 -SecurityTypes None -AlwaysShared -desktop "Nova VPS" &
x=$!
for i in $(seq 1 50); do [ -e /tmp/.X11-unix/X1 ] && break; sleep 0.1; done
export DISPLAY=:1
dbus-launch --exit-with-session startxfce4
kill $x 2>/dev/null
EOF
chmod 755 /usr/local/sbin/nova-desktop-run

cat > /etc/systemd/system/nova-desktop.service <<'EOF'
[Unit]
Description=The VPS's desktop for Nova Agent's Computer panel (localhost only)
StopWhenUnneeded=yes

[Service]
User=nova-agent
Group=nova-agent
WorkingDirectory=/srv/nova-agent
Environment=HOME=/srv/nova-agent
ExecStart=/usr/local/sbin/nova-desktop-run
Restart=on-failure
MemoryMax=1200M
Nice=5
EOF

cat > /etc/systemd/system/nova-desktop-web.socket <<'EOF'
[Unit]
Description=The VPS's desktop in the browser (websocket, localhost only)

[Socket]
ListenStream=127.0.0.1:6081
Accept=no

[Install]
WantedBy=sockets.target
EOF

cat > /etc/systemd/system/nova-desktop-web.service <<'EOF'
[Unit]
Description=The VPS's desktop in the browser (websockify to the desktop)
Requires=nova-desktop.service
After=nova-desktop.service

[Service]
User=nova-agent
Group=nova-agent
ExecStartPre=/bin/sh -c 'for i in $(seq 1 60); do (exec 3<>/dev/tcp/127.0.0.1/5901) 2>/dev/null && exit 0; sleep 0.25; done; exit 1'
ExecStart=/usr/bin/websockify --inetd --idle-timeout=900 127.0.0.1:5901
StandardInput=socket
StandardOutput=journal
EOF

systemctl daemon-reload
systemctl enable --now nova-desktop-web.socket

echo "3/4 Caddy: /vps-desktop/ for admins only"
CF=/etc/caddy/Caddyfile
cp "$CF" "$CF.bak-$(date +%Y%m%d%H%M%S)"
if ! grep -q 'vps-desktop' "$CF"; then
  python3 - "$CF" <<'PY'
import sys
p = sys.argv[1]; s = open(p).read()
block = '''	# The VPS's desktop (Computer panel; vps/desktop-setup.sh): signed-in admins only, asked of Nova Bot first
	@desk path /vps-desktop /vps-desktop/*
	handle @desk {
		forward_auth 127.0.0.1:8787 {
			uri /app/api/admin-check
			header_up X-Forwarded-Proto {scheme}
		}
		handle /vps-desktop/websockify {
			reverse_proxy 127.0.0.1:6081
		}
		handle_path /vps-desktop/* {
			root * /usr/share/novnc
			file_server
		}
	}
'''
anchor = '\t# Computer\'s status service'
assert anchor in s, "anchor not found"
s = s.replace(anchor, block + anchor, 1)
open(p, 'w').write(s)
PY
fi
caddy validate --config "$CF" --adapter caddyfile >/dev/null
systemctl reload caddy

echo "4/4 Check"
systemctl is-active nova-desktop-web.socket
code=$(curl -s -o /dev/null -w '%{http_code}' https://nova.novacane.co.uk/vps-desktop/vnc.html)
echo "Signed out, /vps-desktop/vnc.html answers $code (should be 401 or 403 until Nova Bot's admin check is live: then 401)"
free -m | sed -n 2p
echo "Done"

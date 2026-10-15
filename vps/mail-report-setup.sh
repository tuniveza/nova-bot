#!/usr/bin/env bash
# The studio's mail delivery, counted, for the Fixer (run on the VPS as root, once:
#   ssh root@185.185.126.195 'bash -s' < vps/mail-report-setup.sh ).
# Every 10 minutes, a root job reads the mail server's log for the last hour and writes how many emails
# were delivered, delayed and bounced to /var/lib/nova/mail-report.json, readable by Nova Agent's Fixer
# (which can't read the log itself: it holds people's addresses). The report says counts, the
# receiving domains of anything that didn't go, and why, never anyone's address.
set -euo pipefail

mkdir -p /var/lib/nova
cat > /usr/local/sbin/nova-mail-report <<'EOF'
#!/usr/bin/env python3
# The last hour of the studio's mail delivery, counted (vps/mail-report-setup.sh)
import json, re, subprocess, time, os
out = subprocess.run(["journalctl", "-u", "postfix@-", "--since", "-60min", "-o", "cat", "--no-pager"], capture_output=True, text=True).stdout
counts = {"sent": 0, "deferred": 0, "bounced": 0, "expired": 0}
problems = []
for line in out.splitlines():
    m = re.search(r"to=<[^@>]*@([^>]+)>.*?status=(sent|deferred|bounced|expired) \((.*)\)$", line)
    if not m:
        continue
    domain, status, why = m.group(1).lower(), m.group(2), m.group(3)
    counts[status] += 1
    if status != "sent" and len(problems) < 10:
        why = re.sub(r"<?[^\s<>@]+@[^\s<>]+>?", "<address>", why)[:160]
        problems.append({"status": status, "domain": domain, "why": why})
queue = subprocess.run(["mailq"], capture_output=True, text=True).stdout
m = re.search(r"in (\d+) Request", queue)
waiting = int(m.group(1)) if m else (0 if "Mail queue is empty" in queue else None)
report = {"at": time.strftime("%Y-%m-%dT%H:%M:%SZ", time.gmtime()), "window_minutes": 60, "counts": counts, "waiting": waiting, "problems": problems}
tmp = "/var/lib/nova/mail-report.json.tmp"
with open(tmp, "w") as f:
    json.dump(report, f)
os.chmod(tmp, 0o644)
os.replace(tmp, "/var/lib/nova/mail-report.json")
EOF
chmod 755 /usr/local/sbin/nova-mail-report

cat > /etc/systemd/system/nova-mail-report.service <<'EOF'
[Unit]
Description=The studio's mail delivery, counted, for the Fixer (no addresses)

[Service]
Type=oneshot
ExecStart=/usr/local/sbin/nova-mail-report
Nice=10
EOF
cat > /etc/systemd/system/nova-mail-report.timer <<'EOF'
[Unit]
Description=Count the studio's mail delivery every 10 minutes

[Timer]
OnBootSec=2min
OnUnitActiveSec=10min

[Install]
WantedBy=timers.target
EOF
systemctl daemon-reload
systemctl enable --now nova-mail-report.timer
systemctl start nova-mail-report.service
python3 -c "import json; r=json.load(open('/var/lib/nova/mail-report.json')); print('report:', r['counts'], 'waiting', r['waiting'], 'problems', len(r['problems']))"

#!/usr/bin/env python3
"""Every 5 minutes (nova-routes.timer): how every exchange in Nova is doing, for the Routes page
(https://nova.novacane.co.uk/routes/, signed-in admins only). The user, 18 Nov 2026: "a website that
shows all these various routes so we can always know if there is a bottleneck … this will include
knowing if invoices went out".

Writes /srv/nova-routes/data/routes.json (now) and keeps 24 hours of each route's state in
/var/lib/nova/routes-history.json. Spends nothing: Claude and Stripe are asked who they are, not to
do work; voice and mic are tried with a few words / a second of silence, at most every 30 minutes.
Nothing secret is written: keys show only their last 4 characters, client emails only their domain.
"""
import json, os, re, socket, sqlite3, subprocess, time, urllib.request, urllib.error, io, wave
from datetime import datetime, timezone, timedelta

OUT_DIR = "/srv/nova-routes/data"
OUT = OUT_DIR + "/routes.json"
HIST = "/var/lib/nova/routes-history.json"
SLOW = "/var/lib/nova/routes-slow.json"  # voice + mic results, re-tried every 30 minutes
DB = "/srv/nova/state/v3/d1/miniflare-D1DatabaseObject/d90d47fba3bb21dba5b545a490babb5c3b96df40c9cb3acec2f427f2580d0c85.sqlite"
BOT_ENV, VARS_ENV, AGENT_ENV = "/srv/nova/secrets.env", "/srv/nova/app/.dev.vars", "/etc/nova-agent/agent.env"
SITE = "https://nova.novacane.co.uk"
NOW = datetime.now(timezone.utc)


def env(path, name):
    try:
        for line in open(path):
            if line.startswith(name + "="):
                return line.split("=", 1)[1].strip().strip('"')
    except OSError:
        pass
    return ""


def last4(k):
    return "…" + k[-4:] if k else "(none)"


def http(url, method="GET", headers=None, data=None, timeout=25):
    """(status, milliseconds, body bytes) — status 0 when it couldn't connect"""
    t = time.time()
    req = urllib.request.Request(url, method=method, headers=headers or {}, data=data)
    try:
        with urllib.request.urlopen(req, timeout=timeout) as r:
            body = r.read()
            return r.status, int((time.time() - t) * 1000), body
    except urllib.error.HTTPError as e:
        return e.code, int((time.time() - t) * 1000), e.read()[:2000]
    except Exception as e:  # noqa: BLE001 - any failure to connect is a result here
        return 0, int((time.time() - t) * 1000), str(e).encode()


def sh(cmd, timeout=30):
    try:
        return subprocess.run(cmd, shell=True, capture_output=True, text=True, timeout=timeout).stdout
    except Exception:  # noqa: BLE001
        return ""


def ago(iso):
    """'3 h ago' style, from an ISO time"""
    if not iso:
        return ""
    try:
        t = datetime.fromisoformat(iso.replace("Z", "+00:00"))
        if t.tzinfo is None:
            t = t.replace(tzinfo=timezone.utc)
    except ValueError:
        return ""
    s = (NOW - t).total_seconds()
    if s < 90:
        return "just now"
    if s < 5400:
        return f"{int(s // 60)} min ago"
    if s < 172800:
        return f"{int(s // 3600)} h ago"
    return f"{int(s // 86400)} days ago"


routes = []


def route(group, rid, name, state, says, detail="", ms=None):
    """state: ok | slow | down | idle (not in use / not checkable)"""
    routes.append({"group": group, "id": rid, "name": name, "state": state, "says": says, "detail": detail, "ms": ms})


# ---------------------------------------------------------------- Website chat (NovaBot)
G = "chat"
st, ms, _ = http(SITE + "/novabot.js")
route(G, "widget", "Website loads NovaBot", "ok" if st == 200 else "down",
      "The chat button and window load on novacane.co.uk." if st == 200 else f"NovaBot's files don't load (answer {st}).", ms=ms)

def claude_ok(k):
    if not k:
        return 0, 0
    s, m, _ = http("https://api.anthropic.com/v1/models", headers={"x-api-key": k, "anthropic-version": "2023-06-01"})
    return s, m

kb, kv, ka = env(BOT_ENV, "ANTHROPIC_API_KEY"), env(VARS_ENV, "ANTHROPIC_API_KEY"), env(AGENT_ENV, "ANTHROPIC_API_KEY")
s_bot, ms_bot = claude_ok(kb)
errors = sh("journalctl -u nova --since -1h --no-pager -o cat | grep -c 'Claude error'").strip() or "0"
errors = int(errors) if errors.isdigit() else 0
if s_bot != 200:
    route(G, "claude", "NovaBot → Claude", "down", f"Claude rejects NovaBot's key ({last4(kb)}): every visitor gets \"NovaBot's having a moment\".", f"answer {s_bot}", ms_bot)
elif errors >= 3:
    route(G, "claude", "NovaBot → Claude", "slow", f"The key works, but {errors} replies failed in the last hour.", "Claude busy or out of credit", ms_bot)
else:
    route(G, "claude", "NovaBot → Claude", "ok", "NovaBot can answer visitors.", f"key {last4(kb)}; {errors} failed replies in the last hour", ms_bot)

slow = {}
try:
    slow = json.load(open(SLOW))
except (OSError, ValueError):
    pass
if time.time() - slow.get("at", 0) > 1800:
    s1, m1, b1 = http(SITE + "/speak", "POST", {"Content-Type": "application/json", "Origin": "https://novacane.co.uk"}, json.dumps({"text": "Test."}).encode(), 60)
    buf = io.BytesIO()
    w = wave.open(buf, "wb"); w.setnchannels(1); w.setsampwidth(2); w.setframerate(16000); w.writeframes(b"\x00\x00" * 8000); w.close()
    s2, m2, b2 = http(SITE + "/listen", "POST", {"Content-Type": "audio/wav", "Origin": "https://novacane.co.uk"}, buf.getvalue(), 60)
    slow = {"at": time.time(), "speak": [s1, m1, len(b1)], "listen": [s2, m2, b2[:60].decode("utf-8", "replace")]}
    try:
        json.dump(slow, open(SLOW, "w"))
    except OSError:
        pass
s1, m1, n1 = slow["speak"]
route(G, "voice", "Voice (reads replies aloud)", "ok" if s1 == 200 and n1 > 1000 else "down",
      "Replies can be spoken." if s1 == 200 and n1 > 1000 else f"The voice doesn't answer (answer {s1}).", "tried every 30 minutes", m1)
s2, m2, b2 = slow["listen"]
route(G, "mic", "Mic (speech to words)", "ok" if s2 == 200 and '"text"' in b2 else "down",
      "Visitors can talk to NovaBot." if s2 == 200 else f"The mic doesn't answer (answer {s2}).", "tried every 30 minutes", m2)
st, ms, body = http(SITE + "/chat/live", "POST", {"Content-Type": "application/json", "Origin": "https://novacane.co.uk"}, json.dumps({"chatId": "routes-check", "after": 0}).encode())
route(G, "live", "Staff can take over a chat", "ok" if st == 200 else "down",
      "A chat can be handed to the studio." if st == 200 else f"Live hand-over doesn't answer (answer {st}).", ms=ms)

# ---------------------------------------------------------------- Email
G = "email"
mx_ok, mx_ms, mx_err = False, 0, ""
for host in ("gmail-smtp-in.l.google.com", "mx00.ionos.co.uk"):
    t = time.time()
    try:
        socket.create_connection((host, 25), timeout=8).close()
        mx_ok, mx_ms = True, int((time.time() - t) * 1000)
        break
    except OSError as e:
        mx_err = str(e)
VIA_GMAIL = env(BOT_ENV, "MAIL_VIA") == "gmail"
route(G, "port25", "Email leaves the server", "ok" if mx_ok else ("idle" if VIA_GMAIL else "down"),
      "Nova can hand emails to other mail servers." if mx_ok else
      ("Not used: the VPS company blocks the mail ports (25, 587, 465), so every Nova email goes from the studio's Gmail instead (MAIL_VIA=gmail)." if VIA_GMAIL else
      "The VPS company blocks the mail ports (25, 587, 465). Invoices, reminders, replies, bookings, receipts and outreach go from the studio's Gmail instead; still lost: new-enquiry emails to staff, fan sign-ups and newsletters."),
      "" if mx_ok else mx_err, mx_ms if mx_ok else None)

# Postfix's log, 35 days (the invoice list covers 30): each message's recipient, tries and outcome
log = sh("journalctl -t postfix/smtp -t postfix/qmgr -t postfix/bounce -t postfix/error --since -35d --no-pager -o short-iso", 60)
msgs = {}
for line in log.splitlines():
    m = re.match(r"(\S+) \S+ postfix/(\w+)\[\d+\]: ([0-9A-F]{8,12}): (.*)", line)
    if not m:
        continue
    when, part, q, rest = m.groups()
    d = msgs.setdefault(q, {"first": when, "to": "", "status": "", "why": "", "last": when, "tries": 0})
    d["last"] = when
    to = re.search(r"to=<([^>]+)>", rest)
    if to:
        d["to"] = to.group(1).lower()
    stt = re.search(r"status=(\w+)", rest)
    if stt:
        d["status"] = stt.group(1)
        d["tries"] += 1
        why = re.search(r"status=\w+ \((.*)\)$", rest)
        if why:  # (the "expired" line has no reason of its own: keep the last try's)
            d["why"] = why.group(1)[:200]
    if "expired" in rest and "returned to sender" in rest:
        d["status"] = "expired"
q_out = sh("mailq | tail -1").strip()
stuck = int(re.search(r"in (\d+) Request", q_out).group(1)) if re.search(r"in (\d+) Request", q_out) else 0
week = [d for d in msgs.values() if d["first"] >= (NOW - timedelta(days=7)).isoformat()[:19]]
delivered = [d for d in week if d["status"] == "sent"]
lost = [d for d in week if d["status"] in ("expired", "bounced")]
last_sent = max((d["last"] for d in msgs.values() if d["status"] == "sent"), default="")
state = "ok" if (not lost and stuck == 0) else ("down" if not delivered and (lost or stuck) else "slow")
if VIA_GMAIL and stuck <= 1:
    state = "idle"  # nothing new goes this way (the one left is held on purpose: Rome Fortune #59, 18 Nov 2026)
route(G, "delivery", "Mail-server emails (7 days)", state,
      f"Through the VPS's own mail server: {len(delivered)} delivered, {stuck} stuck now, {len(lost)} lost or refused.",
      f"last delivered {ago(last_sent) or 'not in 35 days'}")

# The studio's Gmail (the route that works: invoices, reminders, replies, bookings, receipts, outreach)
gm = subprocess.run(["/usr/local/sbin/nova-gmail", "search", "in:sent newer_than:2d"], capture_output=True, text=True, timeout=60)
gsent = [json.loads(l) for l in gm.stdout.splitlines() if l.strip()]
if gm.returncode != 0:
    route(G, "gmail", "Studio Gmail sends", "down", "Nova can't use the studio's Gmail: invoices, bookings and replies can't be emailed. Connect Google again in Portal → Admin → Google.", gm.stderr.strip()[:160])
else:
    route(G, "gmail", "Studio Gmail sends", "ok", f"Gmail works: {len(gsent)}{'+' if len(gsent) >= 50 else ''} emails sent from it in the last 2 days.",
          ("last: " + gsent[0]["subject"][:70]) if gsent else "")

# ---------------------------------------------------------------- Invoices: did each email arrive?
invoices = []
db_ok = os.path.exists(DB)
if db_ok:
    con = sqlite3.connect(f"file:{DB}?mode=ro", uri=True)
    con.row_factory = sqlite3.Row
    since = (NOW - timedelta(days=30)).isoformat()[:19]
    rows = con.execute(
        "SELECT id, seq, status, created_by, sent_at, total_pence, paid_pence, bill_name, bill_email FROM invoices "
        "WHERE sent_at >= ? AND status != 'void' ORDER BY sent_at DESC", (since,)).fetchall()
    rem = con.execute(
        "SELECT r.invoice_id, r.sent_at, i.bill_name, i.bill_email, i.total_pence FROM invoice_reminders r JOIN invoices i ON i.id = r.invoice_id "
        "WHERE r.status = 'sent' AND r.sent_at >= ?", (since,)).fetchall()

    # Bounces that came back to the studio's Gmail (for emails Gmail sent): who and when
    bounces = []
    try:
        bq = subprocess.run(["/usr/local/sbin/nova-gmail", "search", "newer_than:35d (from:mailer-daemon OR from:postmaster OR subject:(\"delivery status notification\") OR subject:undeliverable)"],
                            capture_output=True, text=True, timeout=90)
        for l in bq.stdout.splitlines():
            b = json.loads(l)
            try:
                when = datetime.strptime(re.sub(r"\s*\(.*\)$", "", b["date"]).strip(), "%a, %d %b %Y %H:%M:%S %z").astimezone(timezone.utc).isoformat()[:16]
            except ValueError:
                when = ""
            bounces.append({"at": when, "text": (b["subject"] + " " + b["snippet"]).lower()})
    except Exception:  # noqa: BLE001
        pass
    gmail_sent = {}  # invoice id -> when Gmail last sent an email about it (google_links "gmail-thread")
    for row in con.execute("SELECT nova_id, synced_at FROM google_links WHERE kind = 'gmail-thread' AND nova_id LIKE 'invoice:%'"):
        gmail_sent[row[0].split(":", 1)[1]] = row[1] or ""

    def outcome(email, sent_at, inv_id=None):
        """What happened to the email sent to `email` around `sent_at`"""
        if not email:
            return "link", "Not emailed (shared by link or paid in person)", ""
        email = email.lower()
        t0 = sent_at[:19]
        best = None
        for d in msgs.values():
            if d["to"] != email:
                continue
            if abs((datetime.fromisoformat(d["first"][:19]) - datetime.fromisoformat(t0)).total_seconds()) <= 300:
                best = d
                break
        if not best:
            # Not through the mail server: sent from the studio's Gmail instead (since 18 Nov 2026 the
            # first choice); Gmail took it, and anything that bounces comes back to the studio's inbox
            g = gmail_sent.get(str(inv_id), "")
            if g and g[:10] >= t0[:10]:
                back = next((b for b in bounces if email in b["text"] and (not b["at"] or b["at"] >= t0[:16])), None)
                if back:
                    why = "the address doesn't exist" if re.search(r"not found|does not exist|no such user|unknown user|address couldn", back["text"]) else "it came back undelivered"
                    return "lost", f"Bounced back to the studio's Gmail: {why}", back["at"]
                return "arrived", "Sent from the studio's Gmail (no bounce)", g[:16]
            return "unknown", "Not found in the mail log", ""
        if best["status"] == "sent":
            return "arrived", "Arrived in their inbox", best["last"][:16]
        if best["status"] in ("expired", "bounced"):
            why = best["why"]
            if "refused to talk" in why or "554" in why:
                why = "their mail server refused Nova's server"
            elif " 550" in why or "5.7.1" in why:
                why = "their mail server turned it away as spam"
            elif "timed out" in why:
                why = "Nova's server couldn't reach the internet's mail servers"
            return "lost", "Never arrived: " + why, best["last"][:16]
        return "stuck", f"Stuck, still trying ({best['tries']} tries)", best["last"][:16]

    for r in rows:
        kind, says, at = outcome(r["bill_email"], r["sent_at"], r["id"])
        invoices.append({"no": r["seq"], "name": r["bill_name"], "what": "Invoice", "by": r["created_by"], "sent": r["sent_at"][:16],
                         "total": r["total_pence"], "paid": r["paid_pence"], "status": r["status"],
                         "to": (r["bill_email"] or "").split("@")[-1], "result": kind, "says": says, "at": at})
    for r in rem:
        kind, says, at = outcome(r["bill_email"], r["sent_at"], r["invoice_id"])
        invoices.append({"no": r["invoice_id"], "name": r["bill_name"], "what": "Reminder", "by": "", "sent": r["sent_at"][:16],
                         "total": r["total_pence"], "paid": None, "status": "", "to": (r["bill_email"] or "").split("@")[-1],
                         "result": kind, "says": says, "at": at})
    invoices.sort(key=lambda x: x["sent"], reverse=True)
    phones = con.execute("SELECT count(*) FROM push_subscriptions").fetchone()[0]
    con.close()
else:
    phones = 0
mailed = [i for i in invoices if i["result"] != "link"]
bad = [i for i in mailed if i["result"] in ("lost", "stuck", "unknown")]
route("email", "invoice-mail", "Invoice emails reach clients",
      "ok" if not bad else ("down" if len(bad) == len(mailed) else "slow"),
      (f"All {len(mailed)} invoice emails in the last 30 days arrived." if not bad else
       f"{len(bad)} of {len(mailed)} invoice emails in the last 30 days did not arrive: " + ", ".join(sorted({i['name'] for i in bad})) + "."),
      "Nova marks them \"sent\" when it hands them to the mail server; this checks they really arrived")

# ---------------------------------------------------------------- Payments
G = "pay"
for rid, name, key, mode in (("stripe-live", "Card payments (Stripe live)", "STRIPE_SECRET_KEY", "live"),
                             ("stripe-test", "Test payments (Stripe test)", "STRIPE_TEST_SECRET_KEY", "test")):
    k = env(BOT_ENV, key)
    if not k:
        route(G, rid, name, "idle", "No key set.")
        continue
    import base64
    s, m, _ = http("https://api.stripe.com/v1/balance", headers={"Authorization": "Basic " + base64.b64encode((k + ":").encode()).decode()})
    route(G, rid, name, "ok" if s == 200 else "down",
          ("Clients can pay invoices by card." if mode == "live" else "Test invoices can take test payments.") if s == 200 else
          f"Stripe rejects the {mode} key ({last4(k)}).", f"key {last4(k)}", m)
route(G, "acuity", "Bookings via Acuity's API", "idle", "Acuity's plan doesn't allow its API (answer 403); bookings come in by Acuity's webhooks.", "known since 14 Oct 2026")

# ---------------------------------------------------------------- Nova Agent and alerts
G = "agent"
active = sh("systemctl is-active nova-agent").strip()
same = env(BOT_ENV, "AGENT_NOVA_KEY") and env(BOT_ENV, "AGENT_NOVA_KEY") == env(AGENT_ENV, "AGENT_NOVA_KEY")
route(G, "agent-link", "Nova Agent ↔ Nova Bot", "ok" if active == "active" and same else "down",
      "Nova Agent is running and linked (invoice PDFs, the Agent chat)." if active == "active" and same else
      ("Nova Agent isn't running." if active != "active" else "Nova Agent's link key differs on the two sides: PDFs and the online link fail."))
s_ag, ms_ag = claude_ok(ka)
route(G, "agent-claude", "Nova Agent → Claude", "ok" if s_ag == 200 else "down",
      "The Agent can think and answer." if s_ag == 200 else f"Claude rejects Nova Agent's key ({last4(ka)}).", f"key {last4(ka)}", ms_ag)
refused = sh("journalctl -u nova --since -7d --no-pager -o cat | grep 'Push refused' | grep -oE 'reason\":\"[A-Za-z]+' | sort | uniq -c | sort -rn | head -1").strip()
if not phones:
    route(G, "phones", "Alerts reach phones", "slow", "No phone is signed up for alerts: they only show in Portal → Alerts. Switch Alerts on in Nova Phone.")
elif "VapidPkHashMismatch" in refused:
    route(G, "phones", "Alerts reach phones", "down",
          f"{phones} phone(s) signed up, but with an old key, so Apple/Google refuse every alert. On that phone: Nova Phone → switch Alerts off, then on again.",
          "push refused: " + refused.replace('reason":"', ""))
elif refused:
    route(G, "phones", "Alerts reach phones", "slow", f"{phones} phone(s) signed up; some alerts were refused this week.", "push refused: " + refused.replace('reason":"', ""))
else:
    route(G, "phones", "Alerts reach phones", "ok", f"{phones} phone(s) get Nova's alerts.")

# ---------------------------------------------------------------- Server
G = "server"
svc = {s: sh(f"systemctl is-active {s}").strip() for s in ("nova", "nova-agent", "nova-mail", "nova-voice", "caddy", "postfix")}
down = [s for s, v in svc.items() if v != "active"]
route(G, "services", "Nova's services", "ok" if not down else "down",
      "All running: " + ", ".join(svc) + "." if not down else "Not running: " + ", ".join(down) + ".")
mem = sh("systemctl show nova -p MemoryCurrent --value").strip()
mem_mb = int(mem) // 1048576 if mem.isdigit() else 0
disk = sh("df -P / | tail -1").split()
used = int(disk[4].rstrip("%")) if len(disk) > 4 else 0
load = open("/proc/loadavg").read().split()[0]
route(G, "health", "Memory and disk", "ok" if mem_mb < 2400 and used < 85 else "slow",
      f"Nova Bot uses {mem_mb} MB (restarted itself at 2,600 MB); disk {used}% full; load {load}.")
b = sh("systemctl show nova-backup -p ExecMainExitTimestamp -p ExecMainStatus --value").split("\n")
bt, bs = (b + ["", ""])[0:2]
route(G, "backup", "Nightly backup", "ok" if bs.strip() == "0" else "slow",
      f"Last backup {bt.strip() or 'unknown'}." if bs.strip() == "0" else f"The last backup failed (status {bs.strip()}).")

# ---------------------------------------------------------------- Outreach
paused = os.path.exists("/root/outreach/auto/PAUSED")
lastlog = sh("tail -1 /root/outreach/auto/engine.log").strip()
m = re.match(r"(\d{4}-\d\d-\d\d)T[\d:.]+Z (.*)", lastlog)
lastlog = (f"last: {m.group(2)} ({m.group(1)})" if m else lastlog)[:140]
# (errors in the last 24 hours only: old ones, e.g. the dead Claude key on 16 Nov, don't count)
cutoff = (NOW - timedelta(hours=24)).isoformat()[:19]
out_err = str(sum(1 for l in sh("tail -200 /root/outreach/auto/engine.log").splitlines()
                  if l[:19] >= cutoff and re.search(r"error|fail", l, re.I)))
route("email", "outreach", "Outreach campaign", "idle" if paused else ("slow" if out_err not in ("", "0") else "ok"),
      "Paused." if paused else ("Running (sends from the studio's Gmail), with errors in its log." if out_err not in ("", "0") else "Running; sends from the studio's Gmail."),
      lastlog)

# ---------------------------------------------------------------- History (24 h) and the file
hist = {}
try:
    hist = json.load(open(HIST))
except (OSError, ValueError):
    pass
stamp = int(time.time())
for r in routes:
    h = [x for x in hist.get(r["id"], []) if x[0] > stamp - 86400]
    h.append([stamp, r["state"]])
    hist[r["id"]] = h
    r["history"] = [x[1] for x in h][-96:]
    first_bad = next((x[0] for x in reversed(h) if x[1] == "ok"), None)
    r["since"] = "" if r["state"] == "ok" else (datetime.fromtimestamp(first_bad, timezone.utc).isoformat()[:16] if first_bad else "over 24 h")
try:
    json.dump(hist, open(HIST, "w"))
except OSError:
    pass

out = {
    "checked": NOW.isoformat()[:19] + "Z",
    "groups": [
        {"id": "chat", "name": "Website chat", "path": "Visitor → novacane.co.uk → NovaBot → Claude → reply (voice, mic)"},
        {"id": "email", "name": "Email, invoices and outreach", "path": "Invoicer, NovaBot, outreach → mail server → port 25 → their inbox"},
        {"id": "pay", "name": "Payments and bookings", "path": "Client → Stripe → Nova Bot; Acuity → Nova Bot"},
        {"id": "agent", "name": "Nova Agent and alerts", "path": "Nova Bot ↔ Nova Agent → Claude; alerts → phones"},
        {"id": "server", "name": "The server", "path": "VPS: services, memory, disk, backups"},
    ],
    "routes": routes,
    "invoices": invoices,
}
os.makedirs(OUT_DIR, exist_ok=True)
tmp = OUT + ".tmp"
json.dump(out, open(tmp, "w"), ensure_ascii=False)
os.chmod(tmp, 0o644)
os.replace(tmp, OUT)
print("routes:", ", ".join(f"{r['id']}={r['state']}" for r in routes))

# ---------------------------------------------------------------- Telling the owner (18 Nov 2026)
# The owner asked: an email when there's a bottleneck (one per new problem, never every run), and a
# digest three times a day (morning, afternoon, end of day: nova-routes-digest.timer runs this with
# --digest). Sent from the studio's Gmail (nova-gmail): the VPS can't use the mail ports.
import html as _html, sys
from zoneinfo import ZoneInfo

OWNER = open("/srv/nova/owner-email").read().strip()
ALERTED = "/var/lib/nova/routes-alerted.json"
DIGEST = "/var/lib/nova/routes-digest.json"
PAGE = SITE + "/routes/"
e = _html.escape


def mail(subject, body_html):
    page = ('<html><body style="font:15px/1.5 -apple-system,Segoe UI,Roboto,sans-serif;color:#1d1230;max-width:620px">'
            + body_html + f'<p style="margin-top:18px"><a href="{PAGE}" style="color:#b01d68">Open Nova Routes</a> (sign in to Nova first).</p></body></html>')
    try:
        r = subprocess.run(["/usr/local/sbin/nova-gmail", "send", OWNER, subject], input=page, text=True, capture_output=True, timeout=60)
        if r.returncode != 0:
            print("owner email failed:", r.stderr.strip()[:200])
        return r.returncode == 0
    except Exception as ex:  # noqa: BLE001
        print("owner email failed:", ex)
        return False


def since_text(r):
    if not r.get("since"):
        return ""
    return "over 24 h" if r["since"] == "over 24 h" else "since " + datetime.fromisoformat(r["since"] + ":00+00:00").astimezone(ZoneInfo("Europe/London")).strftime("%-d %b %H:%M")


def line(r):
    colour = "#d0244c" if r["state"] == "down" else "#b07a00"
    return (f'<li style="margin:6px 0"><b style="color:{colour}">{e(r["name"])}</b> <span style="color:#777">{e(since_text(r))}</span><br>'
            f'{e(r["says"])}</li>')


bad_now = [r for r in routes if r["state"] in ("down", "slow")]
try:
    alerted = json.load(open(ALERTED))
except (OSError, ValueError):
    alerted = {}
# New problems: bad for two checks in a row (10 minutes), so a blip never sends an email; and a step
# getting worse (slow → down) counts as new
new = [r for r in bad_now if len(r["history"]) >= 2 and r["history"][-2] in ("down", "slow")
       and (r["id"] not in alerted or (alerted[r["id"]] == "slow" and r["state"] == "down"))]
# Over: working again for two checks in a row
fixed = [r for r in routes if r["id"] in alerted and r["state"] in ("ok", "idle") and len(r["history"]) >= 2 and r["history"][-2] in ("ok", "idle")]
if new:
    worst = sorted(new, key=lambda r: r["state"] != "down")
    subject = f"Nova: bottleneck: {worst[0]['name']}" + (f" (+{len(new) - 1} more)" if len(new) > 1 else "")
    body = (f'<p><b>{"A new bottleneck" if len(new) == 1 else str(len(new)) + " new bottlenecks"} in Nova.</b></p><ul style="padding-left:18px">'
            + "".join(line(r) for r in worst) + "</ul>")
    others = [r for r in bad_now if r not in new]
    if others:
        body += '<p style="color:#777">Still going on (already told): ' + e(", ".join(r["name"] for r in others)) + ".</p>"
    if mail(subject, body):
        for r in new:
            alerted[r["id"]] = r["state"]
if fixed:
    if mail("Nova: working again: " + ", ".join(r["name"] for r in fixed),
            "<p><b>Working again:</b></p><ul>" + "".join(f"<li>{e(r['name'])}: {e(r['says'])}</li>" for r in fixed) + "</ul>"):
        for r in fixed:
            alerted.pop(r["id"], None)
try:
    json.dump(alerted, open(ALERTED, "w"))
except OSError:
    pass

if "--digest" in sys.argv:
    london = NOW.astimezone(ZoneInfo("Europe/London"))
    part = "morning" if london.hour < 12 else "afternoon" if london.hour < 17 else "end of day"
    try:
        last = json.load(open(DIGEST)).get("at", "")
    except (OSError, ValueError):
        last = ""
    last = last or (NOW - timedelta(hours=12)).isoformat()[:16]
    head = (f"{len(bad_now)} bottleneck{'s' if len(bad_now) != 1 else ''}" if bad_now else "every route working")
    body = f'<p><b>Nova, {part}: {e(head)}.</b> <span style="color:#777">{e(london.strftime("%a %-d %b %H:%M"))}</span></p>'
    if bad_now:
        body += '<ul style="padding-left:18px">' + "".join(line(r) for r in sorted(bad_now, key=lambda r: r["state"] != "down")) + "</ul>"
    recent = [i for i in invoices if i["sent"] > last[:16]]
    if recent:
        body += "<p><b>Invoices and reminders since the last digest:</b></p><ul style='padding-left:18px'>"
        for i in recent:
            colour = "#178a5c" if i["result"] == "arrived" else "#777" if i["result"] == "link" else "#d0244c"
            amount = f"£{i['total'] / 100:,.2f}".replace(".00", "") if i["total"] is not None else ""
            body += f'<li>{e(i["name"])}, {e(i["what"])} #{e(str(i["no"]))} {e(amount)}: <b style="color:{colour}">{e(i["says"])}</b></li>'
        body += "</ul>"
    else:
        body += "<p>No invoices or reminders sent since the last digest.</p>"
    missing = [i for i in invoices if i["result"] in ("lost", "stuck", "unknown")]
    if missing:
        body += (f'<p style="color:#777">Not arrived in the last 30 days: {len(missing)} '
                 f'({e(", ".join(sorted({i["name"] for i in missing})))}). Nothing is re-sent without your yes.</p>')
    if mail(f"Nova {part}: {head}", body):
        json.dump({"at": NOW.isoformat()[:16]}, open(DIGEST, "w"))

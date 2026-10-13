# Computer: Nova Bot on the VPS

(Portal → Admin → **Computer** was called Desk once: inside, the files, addresses and services still
say `desk`: `src/desk.js`, `/app/api/desk`, `desk-status.service`.)

The same Nova Bot (this repo, unchanged) runs on the studio's VPSdime server next to Cloudflare, so
the studio can be online 24/7 without Cloudflare's free-plan limits (10 ms of CPU per request,
Durable Object time). Portal → Admin → **Computer** shows both side by side.

## What's on the VPS (root@185.185.126.195, "odysi", Ubuntu 24.04)

| Part | Where | What it does |
|---|---|---|
| `nova.service` | `/srv/nova/app` (user `nova`) | Nova Bot, run by Cloudflare's own runtime (workerd, via `wrangler dev --local`) on 127.0.0.1:8787. D1 → SQLite and the Durable Objects are kept on disk in `/srv/nova/state`. Restarts by itself. |
| Caddy | `/etc/caddy/Caddyfile` | HTTPS at **https://185-185-126-195.sslip.io** (automatic certificate), WebSockets included. Blocks the runtime's own `/__scheduled` door from outside. |
| `nova-cron.timer` | | Fires the Worker's every-minute jobs. **Off until the switch-over**, so the VPS and Cloudflare never both send emails, posts or pings. |
| `nova-backup.timer` | `/srv/nova/backups` | 03:30 every night: every SQLite file, copied safely while running, 14 kept. |
| `desk-status.service` | `/srv/nova/desk-status` | How the VPS is doing, for Computer. 127.0.0.1:8788, reached through Caddy at `/desk-status/*`, and **only** with a token made from AGENT_NOVA_KEY. |
| Firewall (ufw) | | 22, 80, 443 open (and whatever was there: 3389 stays as it was). |

Workers AI (voice) only exists on Cloudflare, so on the VPS voice falls back to the browser's own.

## Commands (run on the studio PC, in `nb/novacane-worker`)

- `NOVA_AGENT_DIR=~/an/pj/ns/na-release vps/deploy.sh`: send this code and the panels to the VPS and restart it (the every-minute jobs stay as they are).
- `vps/sync-data.sh`: copy the live database from Cloudflare (a read-only export) into the VPS, replacing its copy.
- On the VPS (Console → **+ VPS**, or ssh): `sudo /srv/nova/bin/set-secrets` asks for each secret key with hidden typing; Enter keeps what's there. `sudo /srv/nova/bin/backup` backs up now.

## Is it working? The status page

- **https://nova.novacane.co.uk/status**: public, no sign-in, nothing personal. A light per part
  (website chat, Portal, signing in, emails, bookings feed, timed jobs, backups, Google, the server,
  the studio PC), the last laptop-off test, a "Test the chat now" button and an "If something's red,
  do this" card. **/status.json** is the same as data: 200 when nothing is red, 503 when something is
  (src/status.js).
- **Outside watchdog** (tells you even if the whole VPS is down): a free UptimeRobot account
  (uptimerobot.com → Register → confirm the email) → **New monitor** → type **Keyword**, URL
  `https://nova.novacane.co.uk/status.json`, keyword `"ok":true`, alert when it **doesn't exist**,
  every 5 minutes → alert contact **admin@kulturekingdom.uk** → Create. (Better Stack's free plan
  works the same way: Monitors → Create → "Keyword", same URL and keyword.)
- **The PC's watchdog** (Nova Agent's src/watchdog.ts): every 5 minutes; after 2 misses in a row a
  desktop notification (and a phone one through ntfy.sh if NTFY_TOPIC is set in Nova Agent's .env).
- **The laptop-off test**: `vps/laptop-off-test.sh` unplugs the PC for about 2 minutes, checks what
  should keep working, plugs it back in and puts the result on the status page.

## Secrets

Cloudflare never gives secrets back, so they're typed in once on the VPS (`set-secrets`) into
`/srv/nova/secrets.env` (mode 600). The list: AGENT_NOVA_KEY (must be **the same** as Cloudflare's and
the studio PC's `na/.env`, because Google's saved keys in the database are locked with it, and Computer
uses it), ANTHROPIC_API_KEY, RESEND_API_KEY, RESEND_MARKETING_KEY, CAMPAIGN_FROM, ENQUIRY_EMAIL_FROM,
ENQUIRY_EMAIL_TO, ACUITY_USER_ID, ACUITY_API_KEY, ACUITY_CALENDAR_URL, and optional Stripe, Meta and TURN keys.
VAPID_PUBLIC_KEY + VAPID_PRIVATE_KEY, ACUITY_WEBHOOK_KEY and ACUITY_EMAIL_KEY are made by
`switch-keys` at the switch-over (see below).

## The switch-over (ready; nothing has been switched yet)

Keep `novacane-worker.novacane-studio.workers.dev` as the address everyone uses: Cloudflare runs a
thin **pass-through** Worker there (`src/passthrough.js`) that forwards every request (pages, the
API, streams, WebSockets) to the VPS, and all the real work (the database, the jobs, the PC link,
Claude) happens on the VPS. Phones' installed apps, browser sign-ins, Google's return address, the
website's chat script and the webhooks all keep working, because the address doesn't change.

**One command each way** (on the studio PC, in `nb/novacane-worker`, at a quiet time; each asks
you to type `yes` first):

- `vps/switch.sh`: checks the VPS; sends it this code with the workers.dev address as its
  `PUBLIC_URL`; makes its keys (`/srv/nova/bin/switch-keys`: a new notification key pair, and the
  Acuity keys); takes the final copy of the database; checks the VPS is healthy; deploys the
  pass-through (`wrangler deploy -c wrangler.passthrough.jsonc`, which has no timed jobs, so
  Cloudflare's stop); starts the VPS's timed jobs (`nova-cron.timer`); restarts Nova Agent on the
  PC; then checks everything from outside (pages, sign-in, a website chat that's deleted after).
- `vps/switch-back.sh`: stops the VPS's timed jobs, redeploys the normal Worker on Cloudflare (with
  its jobs), restarts Nova Agent, checks. Then asks **y/N** before copying the VPS's database back
  into Cloudflare's (anything saved while the VPS was live is only there). Rows over Cloudflare's
  100 KB per statement (the biggest shared note) can't go back that way; the import says so.

How the pieces fit:
- **Who's asking:** the pass-through signs each request (`src/pass-sign.js`: when, the visitor's IP,
  the address asked for; HMAC with a key made from AGENT_NOVA_KEY). The VPS (`src/vps-front.js`)
  trusts it only when the signature is right and under 5 minutes old; then Nova Bot sees the
  workers.dev address and the visitor's IP, exactly as on Cloudflare. Anything else keeps Caddy's
  caller and the VPS's own address. The VPS always sees https (the runtime itself only hears http).
- **Acuity: nothing to change.** Acuity's webhook (`/acuity/webhook?key=…`) and the Google script
  (`/acuity/email`, `X-Nova-Key`) still send Cloudflare's old keys. The pass-through checks them
  against Cloudflare's ACUITY_WEBHOOK_KEY / ACUITY_EMAIL_KEY and swaps in the VPS's, which are
  made from AGENT_NOVA_KEY (`switch-keys`). ADMIN_PASSWORD isn't needed (only the first Portal
  account setup used it).
- **Notifications:** Cloudflare can't give its VAPID keys back, so the VPS gets a new pair. The next
  time Portal opens on a phone, it notices the server's key changed and quietly signs the phone up
  again (it already said Allow); if the phone wants a tap, it says once, calmly, to turn
  notifications on again (Alerts → Turn on notifications).
- **Durable Objects:** the pass-through still exports `AgentLink` and `LosslessRoom` (unused), so
  Cloudflare keeps their saved state for a switch back.
- **Down:** when the VPS can't be reached (or Caddy has no Nova Bot behind it), the pass-through
  answers a calm "Nova is restarting" page (or JSON, for the apps) that refreshes by itself.
- **Computer** shows which side is live, the commands, and warnings (e.g. newsletters won't send while
  RESEND_MARKETING_KEY is from a Resend account without novacane.co.uk).

**Later, your own address:** point e.g. `desk.novacane.co.uk` at 185.185.126.195 (one DNS A record),
then deploy with `DESK_ADDRESS=desk.novacane.co.uk`. Caddy gets the certificate by itself.

## Nova Agent on the server (the laptop can be off)

Nova Agent itself (Agent, quests and reminders, Calendar's own notes, Board, Files, the Index cache,
Console, the Fixer, the Acuity helper, the watchdog) can run on the VPS too, so nothing needs the
studio PC. Run these on the studio PC, in `nb/novacane-worker`:

| Command | What it does |
|---|---|
| `vps/agent-setup.sh` | Gets the VPS ready (safe to run again): user `nova-agent`, `/srv/nova-agent` (git copies of Nova Agent and Nova Bot, `na-release`, `data/`, `fixer-jobs/`), packages with node-pty, hidden Chromium, Claude Code, `nova-agent.service` (not started), two sudo rules, `/usr/local/sbin/nova-deploy-here`, and `/etc/nova-agent/agent.env` (root only: the PC's `na/.env` + `NOVA_ON_SERVER=1`). |
| `vps/agent-switch.sh` | **The move** (asks for yes): backs up the PC's data to `~/an/pj/ns/backups/agent-move-…`, stops the PC's Nova Agent and keeps it off, copies the code and then the data, starts Nova Agent on the server, waits for "Nova Agent is online", then runs the full laptop-off test. `--rehearse` does all that, then comes straight back. |
| `vps/agent-switch-back.sh` | Back to the PC (asks for yes): stops the server's, brings its data and the Fixer's merged code back, starts the PC's. |
| `vps/full-laptop-off-test.sh` | PASS/FAIL for everything, through https://nova.novacane.co.uk as a temporary admin (removed after). Also on the status page. |
| `vps/agent-sync.sh [--reverse]` | Just the data, PC → server (or back). |
| `vps/agent-code-sync.sh` | Just the code: the Fixer's merges on the server come to the PC, the PC's work goes to the server (fast-forward only; it stops if both changed). Run it before working on the PC's code while Nova Agent is on the server; `deploy-live.sh` refuses to undo the server's changes. |

- **Only one Nova Agent.** The link says which one it is; Nova Bot keeps the server's and turns a PC's
  away (4002), and the PC's then stops and stays off (`~/.config/nova/agent-on-server`, plus a
  systemd condition). The server's only starts while `/srv/nova-agent/.live` exists.
- **The Fixer on the server** prepares fixes with Claude Code there. Sign it in once:
  `ssh root@185.185.126.195`, then `sudo -iu nova-agent claude` and `/login`. Until then a fix says
  "Claude Code isn't signed in on the server". Its deploys run `nova-deploy-here` (the app only, no ssh).
- **Console:** online it's Nova commands only, as before. + Shell is the server's own shell, opened on
  your computer through a tunnel: `ssh -L 4545:localhost:4545 root@185.185.126.195`, then
  http://localhost:4545/console/?here=1.
- **Restart it:** `ssh root@185.185.126.195 systemctl restart nova-agent`. Logs: `journalctl -u nova-agent`.

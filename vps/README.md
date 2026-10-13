# Desk: Nova Bot on the VPS

The same Nova Bot (this repo, unchanged) runs on the studio's VPSdime server next to Cloudflare, so
the studio can be online 24/7 without Cloudflare's free-plan limits (10 ms of CPU per request,
Durable Object time). Portal → Admin → **Desk** shows both side by side.

## What's on the VPS (root@185.185.126.195, "odysi", Ubuntu 24.04)

| Part | Where | What it does |
|---|---|---|
| `nova.service` | `/srv/nova/app` (user `nova`) | Nova Bot, run by Cloudflare's own runtime (workerd, via `wrangler dev --local`) on 127.0.0.1:8787. D1 → SQLite and the Durable Objects are kept on disk in `/srv/nova/state`. Restarts by itself. |
| Caddy | `/etc/caddy/Caddyfile` | HTTPS at **https://185-185-126-195.sslip.io** (automatic certificate), WebSockets included. Blocks the runtime's own `/__scheduled` door from outside. |
| `nova-cron.timer` | | Fires the Worker's every-minute jobs. **Off until the cutover**, so the VPS and Cloudflare never both send emails, posts or pings. |
| `nova-backup.timer` | `/srv/nova/backups` | 03:30 every night: every SQLite file, copied safely while running, 14 kept. |
| `desk-status.service` | `/srv/nova/desk-status` | How the VPS is doing, for Desk. 127.0.0.1:8788, reached through Caddy at `/desk-status/*`, and **only** with a token made from AGENT_NOVA_KEY. |
| Firewall (ufw) | | 22, 80, 443 open (and whatever was there: 3389 stays as it was). |

Workers AI (voice) only exists on Cloudflare, so on the VPS voice falls back to the browser's own.

## Commands (run on the studio PC, in `nb/novacane-worker`)

- `NOVA_AGENT_DIR=~/an/pj/ns/na-release vps/deploy.sh`: send this code and the panels to the VPS and restart it (the every-minute jobs stay as they are).
- `vps/sync-data.sh`: copy the live database from Cloudflare (a read-only export) into the VPS, replacing its copy.
- On the VPS (Console → **+ VPS**, or ssh): `sudo /srv/nova/bin/set-secrets` asks for each secret key with hidden typing; Enter keeps what's there. `sudo /srv/nova/bin/backup` backs up now.

## Secrets

Cloudflare never gives secrets back, so they're typed in once on the VPS (`set-secrets`) into
`/srv/nova/secrets.env` (mode 600). The list: AGENT_NOVA_KEY (must be **the same** as Cloudflare's and
the studio PC's `na/.env`, because Google's saved keys in the database are locked with it, and Desk
uses it), ANTHROPIC_API_KEY, RESEND_API_KEY, RESEND_MARKETING_KEY, CAMPAIGN_FROM, ENQUIRY_EMAIL_FROM,
ENQUIRY_EMAIL_TO, VAPID_PUBLIC_KEY + VAPID_PRIVATE_KEY (the **same** pair as Cloudflare's, or every
phone must sign up for notifications again), ACUITY_USER_ID, ACUITY_API_KEY, ACUITY_CALENDAR_URL,
ACUITY_WEBHOOK_KEY, ACUITY_EMAIL_KEY, and optional Stripe, Meta and TURN keys.

## The cutover (when you're ready; nothing here has been done yet)

**Recommended: keep `novacane-worker.novacane-studio.workers.dev` as the address everyone uses, and
make the Cloudflare Worker a thin pass-through to the VPS.** Phones' installed apps, their
notification sign-ups, browser sign-ins, Google's sign-in return address, the website's chat
script, and the Acuity/Stripe/Resend webhooks are all tied to that address. A pass-through keeps
every one of them working with no changes, while all the real work (the database, the jobs, the
PC link, Claude) happens on the VPS. The pass-through itself is tiny (it just forwards each request,
WebSockets too), well inside the free plan. Moving everything to the VPS's own address instead
would mean re-installing the phone apps, re-subscribing every phone, adding a Google redirect
address, changing the Squarespace script tag and every webhook.

Steps (about 10 minutes, at a quiet time):
1. Run `set-secrets` on the VPS (once). Check Desk shows the VPS as reachable (this proves
   AGENT_NOVA_KEY matches).
2. Set `PUBLIC_URL` on the VPS to the workers.dev address (one line in `vps/make-config.mjs`'s call
   inside `deploy.sh`), so emails and links keep pointing at the same address; deploy.
3. `vps/sync-data.sh`: the final copy of the database.
4. Deploy the pass-through Worker on Cloudflare (to write: it forwards every request to
   https://185-185-126-195.sslip.io with the visitor's address in a signed header, and Caddy is set
   to trust that header only when the signature is right).
5. On the VPS: `systemctl enable --now nova-cron.timer` (the jobs now run there, and Cloudflare no
   longer runs them because the pass-through has no cron).
6. Restart Nova Agent on the PC (it reconnects through the same address).

**Rollback:** redeploy the normal Worker (`npx wrangler deploy`), stop the VPS's jobs
(`systemctl disable --now nova-cron.timer`). Anything written on the VPS in between would need
copying back, so roll back quickly or not at all.

**Later, your own address:** point e.g. `desk.novacane.co.uk` at 185.185.126.195 (one DNS A record),
then deploy with `DESK_ADDRESS=desk.novacane.co.uk`. Caddy gets the certificate by itself.

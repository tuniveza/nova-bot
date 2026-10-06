# Referral tracking for Acuity bookings

How it works:

1. A client books in Acuity. Acuity notifies the Worker (webhook), and the Worker
   saves the appointment.
2. Acuity's confirmation page shows a link: "Did anyone refer you?". It opens a
   Novacane page where the client answers Yes/No and can enter a referral code
   (optional) and who referred them (optional).
3. The code is checked against the active codes straight away and saved on that
   appointment. A client can only add a referral to their own booking (the
   appointment number and email must match), and gets 5 tries at a code.
4. Optional extra: if the Acuity booking form has a field with "referral" in its
   name, a code typed there is checked and saved too. Invalid ones are flagged in
   the report, and the client can still correct them on the referral page.
5. The studio manages codes and sees every appointment with its referral at
   `/admin` (password protected), with a CSV download.

Worker addresses (live):

- Admin: https://novacane-worker.novacane-studio.workers.dev/admin
- Webhook: https://novacane-worker.novacane-studio.workers.dev/acuity/webhook
- Referral page: https://novacane-worker.novacane-studio.workers.dev/referral

## One-time setup

Run these from the `novacane-worker` folder.

### 1. Create the database

```sh
npx wrangler d1 create novabot
```

Copy the `database_id` it prints into `wrangler.jsonc` (replace
`00000000-0000-0000-0000-000000000000`), then create the tables:

```sh
npx wrangler d1 migrations apply novabot --remote
```

Until the real `database_id` is in `wrangler.jsonc`, `npm run deploy` will fail.

### 2. Add the secrets

In Acuity: **Integrations → API** shows your **User ID** and **API Key**. Acuity's
API and webhooks need a plan that includes them.

```sh
npx wrangler secret put ACUITY_USER_ID
npx wrangler secret put ACUITY_API_KEY
npx wrangler secret put ADMIN_PASSWORD     # choose a strong password for /admin
```

### 3. Deploy

```sh
npm run deploy
```

### 4. Connect Acuity

**Webhook:** Acuity → Integrations → API → Webhooks. Set the URL for appointment
**scheduled**, **rescheduled** and **canceled** to:

```
https://novacane-worker.novacane-studio.workers.dev/acuity/webhook
```

(Don't also set "changed"; Acuity says that can send duplicates.)

**Confirmation page link:** Acuity → Integrations → **Custom conversion tracking**
→ paste this into the HTML tracking code box and save:

```html
<div style="margin:24px 0;text-align:center;font-family:Arial,sans-serif">
  <a href="https://novacane-worker.novacane-studio.workers.dev/referral?id=%id%&email=%email%"
     target="_blank" rel="noopener"
     style="display:inline-block;padding:14px 22px;border-radius:16px;background:#b01d68;color:#fff;font-weight:bold;text-decoration:none">
    Did anyone refer you? Add a referral code
  </a>
</div>
```

Acuity fills in `%id%` and `%email%` for each booking. **Test it with a real
booking**: if the link doesn't show on your confirmation page, use the backup
option below instead.

**Backup / extra: a field on the booking form.** Acuity → Intake Form Questions →
add an optional text field named e.g. "Referral code (optional)". Any field
with "referral" in its name is picked up automatically.

### 5. Add your first codes

Open `/admin`, sign in (any username, your ADMIN_PASSWORD) and add codes, e.g.
`JAMES10` belonging to "James Smith". Codes are 3–32 letters, numbers or dashes,
and aren't case-sensitive for clients. **Retire** a code to stop it being accepted.
Past bookings keep it.

## Tests

```sh
npx vitest run
```

The tests use a local database and a fake Acuity. They never touch the real
account.

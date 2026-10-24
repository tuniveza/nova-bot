# Referral tracking

How it works:

1. A client books on Nova Bot's booking page (`/book`). The booking is saved with
   its appointment row, ready for a referral.
2. The booking page has a referral code box (optional). A code typed there is
   checked against the active codes straight away and saved on that booking.
   One that isn't active is kept and flagged in the report, and the client can
   correct it on the referral page.
3. The referral page, "Did anyone refer you?", lets a client answer Yes/No and
   enter a referral code (optional) and who referred them (optional):
   `/referral?id=<booking number>&email=<their email>`. A client can only add a
   referral to their own booking (the booking number and email must match), and
   gets 5 tries at a code.
4. The studio manages codes and sees every booking with its referral at
   `/admin` (Portal admins only), with a CSV download.

Worker addresses (live):

- Admin: https://nova.novacane.co.uk/admin
- Referral page: https://nova.novacane.co.uk/referral

(Bookings from Acuity's days keep their referrals in the report. Acuity isn't
used any more.)

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

### 2. Add your first codes

Open `/admin`, sign in with Portal as an admin and add codes, e.g.
`JAMES10` belonging to "James Smith". Codes are 3–32 letters, numbers or dashes,
and aren't case-sensitive for clients. **Retire** a code to stop it being accepted.
Past bookings keep it.

## Tests

```sh
npx vitest run
```

The tests use a local database (`test/referrals-nova.spec.js`). They never touch
anything real.

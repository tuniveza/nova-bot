# Enquiries and the chat log

## Enquiries in the chat

When someone needs the enquiry route (an album, custom work, a large group,
an unusual setup, a question NovaBot can't answer...), NovaBot offers two
options:

- **NovaBot takes the details in the chat.** It asks for their name, email and
  what the project is, shows them a summary, and sends it to the team only
  after they say yes.
- **The enquiry form:** https://novacane.co.uk/bookings-contact#enquiry (the
  page scrolls down to the form).

Enquiries sent from the chat appear on the admin page:
https://novacane-worker.novacane-studio.workers.dev/admin/enquiries

Each one shows the visitor's name, email (click to reply), phone, the details,
the page they were on and a link to the whole chat. Click **Mark done** once it's
dealt with. The tab shows how many new ones there are.

To stop spam, one visitor can send at most 5 enquiries a day, and the same
enquiry is never saved twice.

### Getting an email for each enquiry (optional, recommended)

Squarespace manages the novacane.co.uk domain and Google handles its email, so
the Worker sends email through [Resend](https://resend.com) (free for up to
3,000 emails a month):

1. Sign up at resend.com with the email address that should receive enquiries.
2. Create an API key (API Keys → Create).
3. Run these from the `novacane-worker` folder:

   ```sh
   npx wrangler secret put RESEND_API_KEY      # paste the API key
   npx wrangler secret put ENQUIRY_EMAIL_TO    # the address you signed up with
   ```

Each enquiry then arrives by email from "NovaBot" with the details. Pressing
reply answers the visitor directly.

**Test it:** open the Enquiries tab on the admin page. The top line says whether
email copies are on. Click **Send a test email**: you'll get a "NovaBot test
email" within a minute (check spam the first time). If something's wrong, the
page shows Resend's reason. Then try the real thing: ask NovaBot on the website
to send an enquiry for you. It should appear on the Enquiries tab (marked
"Email copy sent") and in your inbox.

Until you verify a domain in Resend, it can only send to the address you signed
up with. To send from an address like `novabot@novacane.co.uk`, or to more than
one address, verify `novacane.co.uk` in Resend (it gives you DNS records to add
in Squarespace → Domains → DNS). Then also run
`npx wrangler secret put ENQUIRY_EMAIL_FROM` with e.g.
`NovaBot <novabot@novacane.co.uk>`. `ENQUIRY_EMAIL_TO` can then hold several
addresses separated by commas.

Enquiries are always saved on the admin page, even if the email fails.

## Booking links (getting bookings into Acuity)

Acuity's API needs its Powerhouse plan, so NovaBot can't write to the calendar
itself. Instead it sends people a direct link to book:

- **In the chat:** when someone wants a standard session, NovaBot gives them a
  "Book this session" link. It opens the Acuity booking calendar straight on the
  right package (e.g. Rap Package, 2 songs), with their name and email filled in
  if they gave them. They pick a time and pay the deposit, and the booking goes
  into Acuity like any other.
- **For enquiries:** on the Enquiries tab, open **Booking link** on an enquiry,
  choose the session you've agreed with them and click **Make link**. Copy the
  link or click **Email it to them** (opens a ready-written email), and they book
  it themselves.

The session list is read from the public booking calendar every hour, so new or
renamed packages in Acuity show up on their own. Private and inactive packages
are left out. The studio's Acuity account number (`ACUITY_OWNER`) is at the top
of `src/booking.js`.

### Free times in the chat

NovaBot can answer "is next Tuesday free?" or "what's your soonest slot?". It
reads the same free times your public booking calendar shows any visitor (no
login, no password stored, read-only), then gives the booking link.

- It only ever says a time "shows as free right now", and never promises or
  holds one: a time is only theirs once they book it and pay the deposit.
- It can look at up to 14 days at a time, up to 6 months ahead. Lookups are
  remembered for 2 minutes so Acuity isn't asked over and over.
- This uses the address Acuity's own booking page uses behind the scenes, not
  an official Acuity feature, so Acuity could change it. If it stops working,
  NovaBot doesn't guess: it says to check the calendar and gives the link.
- The calendar's own rules (opening hours, minimum notice, how far ahead people
  can book) decide what shows as free, so change those in Acuity as usual.

## The chat log

Every NovaBot conversation is saved, so you can see what people ask and spot
anything NovaBot answers badly:
https://novacane-worker.novacane-studio.workers.dev/admin/conversations

Conversations are deleted automatically after 90 days. Visitors' IP addresses
aren't stored (only a scrambled version, to limit spam).

**Privacy policy:** PRIVACY-POLICY-NOVABOT.md has a section ready to paste into
https://novacane.co.uk/privacy-policy. The chat window links to that page
("Chats are saved for 90 days. Privacy policy").

## Limits

To stop anyone running up the bill, each visitor (by IP address) can send up to
20 chat messages and 40 voice requests a minute. These are set in
`wrangler.jsonc` (`ratelimits`).

## Admin password

All of this is behind the same password as the referral admin page (the
`ADMIN_PASSWORD` secret, see README-REFERRALS.md).

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
https://nova.novacane.co.uk/admin/enquiries

Each one shows the visitor's name, email (click to reply), phone, the details,
the page they were on and a link to the whole chat. Click **Mark done** once it's
dealt with. The tab shows how many new ones there are.

To stop spam, one visitor can send at most 5 enquiries a day, and the same
enquiry is never saved twice.

### Getting an email for each enquiry (optional, recommended)

Emails go through the studio's own mail server on the VPS (vps/mail: Postfix, signed with
DKIM as novacane.co.uk; see vps/README.md and vps/mail-dns.txt). `vps/deploy.sh` sets
`MAIL_API_URL` and `MAIL_KEY` for Nova Bot. Where the copies go is `ENQUIRY_EMAIL_TO`
(several addresses, separated by commas), and the from address `ENQUIRY_EMAIL_FROM`
(e.g. `Novacane Studios <hello@novacane.co.uk>`), both in `/srv/nova/secrets.env`.

Each enquiry then arrives by email with the details. Pressing reply answers the visitor
directly.

**Test it:** open the Enquiries tab on the admin page. The top line says whether
email copies are on. Click **Send a test email**: you'll get a "NovaBot test
email" within a minute (check spam the first time). If something's wrong, the
page shows the mail server's reason. Then try the real thing: ask NovaBot on the website
to send an enquiry for you. It should appear on the Enquiries tab (marked
"Email copy sent") and in your inbox.

Enquiries are always saved on the admin page, even if the email fails.

## Replying to enquiries (Portal and Agent)

Open an enquiry in Portal → Enquiries (**Open & reply**) to see their message and the
whole conversation: replies sent, internal notes, and drafts from Agent.

- **Send** emails the customer from the studio address, to their address only, with
  reply-to set to the studio inbox (their answers land there). Each reply shows
  Sending… / Sent ✓ / Didn't send (with the mail server's reason and **Retry**).
- **Note** is for the team only, never sent.
- **Agent** (Nova Agent's AI) can only **draft**. A draft waits in the conversation (and on
  a card under Agent's reply) until a signed-in person presses **Approve & send**. Staff
  phones get a quiet ping when a draft is waiting. Sending needs Portal open in a browser,
  signed in; on the studio PC's own page, approve in Portal online.
- **Don't contact** (Portal toggle, or the stop link in every email) blocks every send. A
  customer's own stop can't be switched off in Portal.
- Every email ends: "You're getting this because you sent Novacane Studios an enquiry on
  <date> …" plus the stop link (also the email's one-click unsubscribe header). These are
  replies to people who asked to be contacted, not marketing.

### The inbox: sorting, Spam and saved replies

Portal → Enquiries works like a support-ticket inbox (`src/inbox.js`,
migrations/0030_inbox.sql). Every enquiry is in one place, and moving it is one press on its card:

- **New** (not looked at yet) → **Open** (someone's on it) → **Waiting on them** (replied;
  stored as `replied`) → **Done**. Sending a reply moves New or Open to Waiting by itself.
  The tab's badge and Today count New and Open.
- **Who's on it**: pick a person on the card. **Label**: type a short one (labels used before
  are suggested). **Search** looks through names, emails, subjects, messages and labels.
- **Spam** is a folder: nothing is ever deleted. When an enquiry arrives, a few plain rules
  score it: 3+ links (2 links count half), a throwaway email address (mailinator.com and
  friends), spam phrases ("SEO services", "backlinks", "crypto investment"…), keyboard
  mashing or symbol soup, and a visitor sending their 4th+ enquiry today (half). A score of 2
  or more goes to Spam with the reasons shown on the card. Spam doesn't ping phones or email
  the team a copy, and the visitor sees the usual "Sent". **Not spam** moves it back to New.
  Spam is also left out of the client list and Ask Nova.
- **Saved replies** (the button by the search, or the picker in the reply box): the team's
  answers to routine questions: prices, opening times, how to book. `{name}` becomes the
  customer's first name. Picking one only fills the box; it still goes only when someone
  presses **Send**, exactly as before.
- **Agent** can sort enquiries (`enquiry_set_state`: new, open, waiting, done, spam, and a
  label) and read the saved replies (`saved_replies_list`), to draft replies to routine
  questions with the studio's own wording. It can't choose who's on it, change saved replies,
  or send anything.
- **Conversations** (website chats) can be marked **Needs a person** (you're put on it) or
  **Done**, and filtered by either, so chats that need following up don't get lost. Press
  the lit mark again to clear it.

### What it needs

1. **The studio's mail server** (see above): `MAIL_API_URL` and `MAIL_KEY`.
2. `ENQUIRY_EMAIL_FROM` in `/srv/nova/secrets.env`, e.g. `Novacane Studios <hello@novacane.co.uk>`
   (optional: `ENQUIRY_REPLY_FROM` for a different sender on replies, and
   `ENQUIRY_REPLY_TO` for the inbox replies go to; it defaults to the first
   `ENQUIRY_EMAIL_TO` address).
3. The database change: `npx wrangler d1 migrations apply novabot --remote`
   (migrations/0022_enquiry_replies.sql).
4. For the inbox: the same command applies migrations/0030_inbox.sql (it only adds columns
   and two tables; every existing enquiry keeps its status).

### WhatsApp, calls and texts (from your own phone)

Portal shows **WhatsApp**, **Call** and **Text** for the customer's mobile, and the reply box
has **WhatsApp** and **Text** next to Reply and Note. They use the staff member's own phone
and WhatsApp: nothing extra to pay for or set up, and the message comes from a real person.

- **WhatsApp** opens WhatsApp's own link (`api.whatsapp.com/send`) with the number and the
  message filled in: the app on a phone, the app or WhatsApp Web on a computer.
- **Text** opens Messages (`sms:`) with both filled in. **Call** opens the dialler (`tel:`).
  On a computer, where those often do nothing, Portal shows the number (and message) with
  Copy buttons, plus "Try on this computer" for a Mac with an iPhone or a PC with Phone Link.
- Afterwards Portal asks "Did it send?" (or "How did the call go?") and writes the answer into
  the conversation (`POST /app/api/enquiries/logged`, `staffLogged()`), so the whole team sees
  it. A WhatsApp or text, or a call where they spoke or left a voicemail, marks a new enquiry
  "Replied". "Don't contact" hides all three and the server refuses to record them.
- Numbers are sent as full international numbers (`dialNumber()` in `src/enquiries.js`:
  07… becomes +447…). A landline gets Call only.

To have Nova send texts itself later, add a provider to `CHANNELS` in `src/enquiry-replies.js`:
an account with a UK sender (e.g. Twilio or Vonage; WhatsApp needs a WhatsApp Business sender
and approved templates), its API key as a secret, a `send()` that adds "Reply STOP to opt
out", and a webhook for STOP replies that sets "don't contact".

### How it works (Portal → You)

Portal's You page lists each part of Nova and the service behind it (the studio's own mail server for email,
Anthropic Claude for the AI, Stripe…) with a green dot when it's set up
(`GET /app/api/services`, `src/services.js`; only yes/no and plain addresses, never a key).
**Send me a test email** emails whoever pressed it through the studio's mail server, at most once a minute.

## Booking links

NovaBot books on Nova Bot's own booking page (`/book`: the studio's Google Calendar,
Gmail and a Stripe deposit). It sends people a direct link to book:

- **In the chat:** when someone wants a standard session, NovaBot gives them a
  "Book this session" link, or opens the booking card. It opens the booking page
  straight on the right package (e.g. Rap Package, 2 songs), with their name and
  email filled in if they gave them. They pick a time and pay the deposit, and the
  booking goes into the studio's calendar.
- **For enquiries:** on the Enquiries tab, open **Booking link** on an enquiry,
  choose the session you've agreed with them and click **Make link**. Copy the
  link or click **Email it to them** (opens a ready-written email), and they book
  it themselves.

The sessions and prices are in `src/nova/studio.js`.

### Free times in the chat

NovaBot can answer "is next Tuesday free?" or "what's your soonest slot?". It
reads the free times from the studio's Google Calendar (opening hours, the time a
session takes and its changeover, minimum notice), then gives the booking link.

- It only ever says a time "shows as free right now", and never promises or
  holds one: a time is only theirs once they book it and pay the deposit.
- Anything in the studio's Google Calendar that isn't marked "free" blocks the time.
- The rules (opening hours, minimum notice, how far ahead people can book) are in
  `src/nova/studio.js`.

## The chat log

Every NovaBot conversation is saved, so you can see what people ask and spot
anything NovaBot answers badly:
https://nova.novacane.co.uk/admin/conversations

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

All of this is behind the same sign-in as the referral admin page: a Portal
admin.

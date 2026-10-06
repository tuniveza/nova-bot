# Putting NovaBot on the Squarespace site

The chat widget lives in `public/` and is hosted by this Worker:

- `public/novabot.css`: how the widget looks
- `public/novabot.js`: the chat bubble, window, messages, mic and voice

## 1. Deploy the Worker

```sh
npm run deploy
```

This publishes the chatbot, the voice/mic features and the widget files together.
Check they're live by opening
https://novacane-worker.novacane-studio.workers.dev/novabot.js in a browser.

## 2. Add the widget to Squarespace (one time only)

In the Squarespace dashboard, open **Code Injection** (search "Code Injection"
in the dashboard, or Settings → Developer Tools / Advanced → Code Injection).
Paste this into the **Footer** box and save:

```html
<!-- NovaBot chat -->
<link rel="stylesheet" href="https://novacane-worker.novacane-studio.workers.dev/novabot.css">
<script src="https://novacane-worker.novacane-studio.workers.dev/novabot.js" defer></script>
```

The chat bubble then appears on every page of the site.

Code Injection needs a Squarespace plan that includes it (the Personal/Basic plans
don't).

## 3. Making changes later

Edit the files here, test with `src/index.html`, then `npm run deploy`.
The live site picks up the changes automatically. There's no need to touch
Squarespace again.

## Notes

- The chat only answers on the domains listed in `ALLOWED_ORIGINS` in
  `src/index.js` (novacane.co.uk and www.novacane.co.uk). In Squarespace's
  editor preview (a `*.squarespace.com` address) the bubble shows, but replies
  won't come through. Check it on https://novacane.co.uk instead.
- The booking link is set in two places: `BOOKING_LINK` in `src/index.js` (what
  NovaBot tells people) and `BOOKING_LINK` in `public/novabot.js` (the
  "Book a session" button).
- The enquiry link is `ENQUIRY_LINK` in `src/index.js`:
  https://novacane.co.uk/bookings-contact#enquiry. The `#enquiry` part makes the
  widget scroll down to the form on that page (the first Squarespace form block
  on the page). Any link to a page ending in `#enquiry` does the same.
- The conversation carries over as visitors move between pages (until they close
  the browser tab), so links to pages on the site open in the same tab. Links
  elsewhere (e.g. WhatsApp) open in a new tab.
- Enquiries NovaBot sends, and the chat log, are explained in README-ENQUIRIES.md.
- To remove the chat, delete the two lines from Code Injection.

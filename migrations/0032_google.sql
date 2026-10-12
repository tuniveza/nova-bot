-- Google, everywhere it helps: the studio's Google account kept in step with Nova Agent
-- (src/google/). Once an admin connects Google (Portal → Admin → Google):
--
--   Calendar   Nova's Calendar ⇄ Google Calendar: Nova's events (and, if switched on, quests and
--              music time) go into a "Novacane Studio" calendar; events from the studio's own
--              Google Calendar come into Nova's Calendar (and so count as busy time for quests).
--              Bookings stay Acuity's: they're copied into Google, never booked from it.
--   Gmail      approved replies, one-to-one emails, invoices and reminders can go from the
--              studio's Gmail (so they're in its Sent folder); customers' replies come back into
--              Enquiries. Nothing is sent that a person didn't approve.
--   Contacts   Clients ⇄ Google Contacts, under a "Novacane clients" label (consent stays Nova's).
--   Drive      a "Nova Agent" folder: social posts' pictures and videos, receipts, nightly backups.
--   Sheets     Money's invoices, payments and expenses in one Google Sheet for the accountant.
--
-- This table remembers which Nova thing is which Google thing, so nothing is made twice and a
-- deletion on one side can be done on the other. What the settings table keeps: the options
-- (google_opt_*), where each sync got to (Google's sync tokens) and when it last ran.
--
-- No personal details are kept here beyond the ids that link the two sides.
-- Times are UTC (ISO 8601).
--
-- This only adds a new table (and its index). Nothing already saved changes.

CREATE TABLE google_links (
  kind       TEXT NOT NULL,   -- 'event' | 'contact' | 'media' | 'receipt' | 'backup' | 'gmail-thread' | 'gmail-in'
  nova_id    TEXT NOT NULL,   -- the calendar item's id, the client's id, the file's id, "enquiry:12"...
  google_id  TEXT NOT NULL,   -- the event's id, the contact's resourceName, the Drive file's id, the Gmail thread's id...
  extra      TEXT,            -- which calendar an event is in; a contact's etag; the Message-ID an email went with
  hash       TEXT,            -- a hash of what was last synced (so an unchanged thing isn't sent again)
  synced_at  TEXT NOT NULL,   -- UTC
  PRIMARY KEY (kind, nova_id)
);

CREATE INDEX google_links_google ON google_links (kind, google_id);

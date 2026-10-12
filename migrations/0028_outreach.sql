-- One-to-one emails ("outreach"): a personal email to one person, written by Nova Agent's AI or
-- anyone in the team, sent through Resend only after an admin approves it
--
-- It works like email campaigns (migrations/0025_email_campaigns.sql): a new email waits as
-- 'pending_approval' until an admin, signed in to Portal in a browser, presses Approve. Approving
-- stores a hash of exactly what was approved (who it's to, the subject, the email); the sender
-- refuses if anything changed since, and any edit puts it back to 'pending_approval' with the
-- approval cleared. See src/outreach.js.
--
-- Who can be emailed (UK GDPR / PECR), checked when it's written, approved and sent:
--   business  a work address at an organisation (B2B: allowed, with an easy way to say no)
--   client    a studio client: only if they said yes to studio news (marketing_consent = 1), or
--             when the email is about their own booking (about_booking = 1: a service email)
--   reply     someone who wrote to the studio first (they have an enquiry): a service email
-- Never to an address on outreach_optouts (anyone who said no to these emails), and never a
-- business email to a client or fan who hasn't agreed to news. Every email ends with who it's from
-- and a line saying how to stop them, with a link to Nova Bot's /no-thanks page.
--
-- Times are UTC (ISO 8601); Portal shows them in UK time.
--
-- This only adds new tables (and their indexes). Nothing already saved changes.

CREATE TABLE outreach_emails (
  id              INTEGER PRIMARY KEY AUTOINCREMENT,
  to_name         TEXT NOT NULL DEFAULT '',
  to_email        TEXT NOT NULL,                      -- lower-case
  organisation    TEXT NOT NULL DEFAULT '',           -- needed for 'business'
  kind            TEXT NOT NULL CHECK (kind IN ('business', 'client', 'reply')),
  client_id       INTEGER REFERENCES clients (id),    -- for 'client'
  about_booking   INTEGER NOT NULL DEFAULT 0 CHECK (about_booking IN (0, 1)), -- 'client': 1 = about their own booking
  subject         TEXT NOT NULL,
  body            TEXT NOT NULL,                      -- plain text, a blank line between paragraphs
  status          TEXT NOT NULL CHECK (status IN ('draft', 'pending_approval', 'approved', 'rejected', 'sent', 'failed')),
  created_by      TEXT NOT NULL,                      -- 'agent' or a staff.id
  created_at      TEXT NOT NULL,
  updated_at      TEXT NOT NULL,
  submitted_at    TEXT,
  decided_by      TEXT,                               -- staff.id of the admin who approved or rejected it
  decided_at      TEXT,
  decision_note   TEXT,
  -- SHA-256 of exactly what was approved; NULL when not approved
  approved_hash   TEXT,
  -- Set the moment the sender takes it (so it's only ever sent once)
  sending_at      TEXT,
  resend_id       TEXT,                               -- Resend's id for the email, once sent
  sent_at         TEXT,
  error           TEXT,
  -- The secret in this email's "don't email me again" link
  optout_token    TEXT NOT NULL UNIQUE
);

CREATE INDEX outreach_emails_status ON outreach_emails (status, id);
CREATE INDEX outreach_emails_to ON outreach_emails (to_email);

-- What happened to each one, for the record
CREATE TABLE outreach_log (
  id           INTEGER PRIMARY KEY AUTOINCREMENT,
  outreach_id  INTEGER NOT NULL REFERENCES outreach_emails (id),
  at           TEXT NOT NULL,                         -- UTC
  event        TEXT NOT NULL CHECK (event IN ('created', 'edited', 'submitted', 'approved', 'rejected', 'sent', 'failed')),
  "by"         TEXT,                                  -- 'agent', a staff.id, or 'nova' for what happened by itself
  detail       TEXT
);

CREATE INDEX outreach_log_email ON outreach_log (outreach_id, id);

-- People who said no to one-to-one emails: never emailed this way again
CREATE TABLE outreach_optouts (
  email        TEXT PRIMARY KEY,                      -- lower-case
  at           TEXT NOT NULL,                         -- UTC
  source       TEXT NOT NULL,                         -- "The link in an email", "Replied no thanks (recorded by …)"
  outreach_id  INTEGER                                -- the email whose link they used, if any
);

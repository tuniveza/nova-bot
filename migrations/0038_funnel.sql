-- The outreach funnel (Portal → Outreach → Funnel): first emails to people in music (artists,
-- producers, engineers, managers, labels, podcasters), from a list of prospects, sent slowly from
-- the studio's Gmail so its address stays out of spam folders. See src/funnel.js.
--
-- Each prospect moves through these states (status):
--   pending   on the list, not emailed yet (being read and written, or waiting for an admin's Approve)
--   warming   approved: in the queue for the warm-up (a few a day at first, a few minutes apart)
--   sent      the first email has gone (sent_at, message_id: Gmail's id for it, thread_id)
--   bounced   didn't arrive, they said no to these emails, or the team stopped it (stop_reason says which)
--   replied   they wrote back: nothing more goes to them by itself
-- One row per address (email is UNIQUE), so nobody is added, or emailed, twice.
--
-- An admin, signed in to Portal in a browser, approves exactly what's written: approved_hash is a
-- hash of who it's to, the subject and the email. The sender refuses if anything changed since; any
-- edit puts it back to 'pending' with the approval cleared. The same rules as one-to-one emails
-- (migrations/0028_outreach.sql) decide who may be emailed (UK GDPR / PECR): a work address at an
-- organisation, never anyone on outreach_optouts, and every email ends with how to stop them.
--
-- Times are UTC (ISO 8601); Portal shows them in UK time. The settings (daily limit, warm-up, gaps,
-- sending hours, what the studio offers each kind of person) are JSON in settings.funnel_settings.
--
-- This only adds new tables (and their indexes). Nothing already saved changes.

CREATE TABLE funnel_prospects (
  id              INTEGER PRIMARY KEY AUTOINCREMENT,
  name            TEXT NOT NULL DEFAULT '',
  email           TEXT NOT NULL UNIQUE,                 -- lower-case
  company         TEXT NOT NULL DEFAULT '',             -- the company or project
  bio             TEXT NOT NULL DEFAULT '',             -- bio and notes, from the list
  role            TEXT CHECK (role IN ('artist', 'producer', 'engineer', 'manager', 'label', 'podcaster')),
  role_why        TEXT,                                 -- why that role, in a few words
  role_by         TEXT,                                 -- 'claude', 'words' (keywords), 'list' (the CSV) or a staff.id
  status          TEXT NOT NULL DEFAULT 'pending' CHECK (status IN ('pending', 'warming', 'sent', 'bounced', 'replied')),
  stop_reason     TEXT CHECK (stop_reason IN ('bounced', 'opted_out', 'rejected')),
  subject         TEXT,                                 -- the email, once written
  body            TEXT,
  scores          TEXT,                                 -- JSON: { deliverability, open, reply, tips: [...] } (1–10 each)
  swaps           TEXT,                                 -- JSON: risky words that were rewritten [{ from, to }]
  drafted_by      TEXT,                                 -- 'claude', 'templates' or a staff.id
  drafted_at      TEXT,
  approved_hash   TEXT,                                 -- SHA-256 of exactly what was approved; NULL when not
  approved_by     TEXT,                                 -- staff.id of the admin
  approved_at     TEXT,
  queued_at       TEXT,                                 -- when it joined the warm-up queue (the order they go)
  sending_at      TEXT,                                 -- set the moment the sender takes it (so it goes once)
  sent_at         TEXT,
  message_id      TEXT,                                 -- Gmail's id for the email
  thread_id       TEXT,                                 -- Gmail's thread (replies and bounces land in it)
  replied_at      TEXT,
  stopped_at      TEXT,
  checked_at      TEXT,                                 -- when its Gmail thread was last looked at
  error           TEXT,
  optout_token    TEXT NOT NULL UNIQUE,                 -- the secret in its "don't email me again" link
  created_by      TEXT NOT NULL,
  created_at      TEXT NOT NULL,
  updated_at      TEXT NOT NULL
);

CREATE INDEX funnel_prospects_status ON funnel_prospects (status, id);
CREATE INDEX funnel_prospects_queue ON funnel_prospects (status, queued_at);
CREATE INDEX funnel_prospects_sent ON funnel_prospects (sent_at);

-- What happened to each one, for the record
CREATE TABLE funnel_log (
  id           INTEGER PRIMARY KEY AUTOINCREMENT,
  prospect_id  INTEGER NOT NULL REFERENCES funnel_prospects (id),
  at           TEXT NOT NULL,                         -- UTC
  event        TEXT NOT NULL,                         -- added, read, written, edited, approved, held, sent, bounced, opted_out, rejected, replied, failed
  "by"         TEXT,                                  -- a staff.id, 'claude', or 'nova' for what happened by itself
  detail       TEXT
);

CREATE INDEX funnel_log_prospect ON funnel_log (prospect_id, id);

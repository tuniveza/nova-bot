-- Email campaigns (Quest 3): newsletters to fans and studio clients, sent through Resend,
-- only after an admin approves them
--
-- Nova Agent's AI (or staff) writes a campaign; it waits as 'pending_approval' until an admin,
-- signed in to Portal in a browser, presses Approve. Approving stores a hash of exactly what
-- was approved (subject, body, audience, send time): the sender refuses if anything changed
-- since, and any edit puts it back to 'pending_approval' with the approval cleared. Then Nova
-- Bot puts the opted-in people into Resend, and Resend sends it (now, or at send_at). See
-- src/campaigns.js.
--
-- Who gets them (UK GDPR / PECR): only people who opted in. Fans sign up on Nova Bot's /join
-- page and confirm by email (double opt-in); clients only with marketing_consent = 1 (Quest 2,
-- migrations/0024_clients.sql). Every email says who it's from and why they're getting it, and
-- has Resend's unsubscribe link. An unsubscribe in Resend comes back here every hour: a fan
-- becomes 'unsubscribed', a client's consent goes to NO with a client_consent_log entry.
--
-- Times are UTC (ISO 8601); Portal shows them in UK time.
--
-- This only adds new tables (and their indexes). Nothing already saved changes.

-- People who signed up for news on the /join page
CREATE TABLE fans (
  id               INTEGER PRIMARY KEY AUTOINCREMENT,
  email            TEXT NOT NULL UNIQUE,              -- lower-case
  name             TEXT NOT NULL DEFAULT '',
  -- pending: signed up, not confirmed yet (never emailed a campaign); confirmed: clicked the
  -- link in the confirmation email; unsubscribed: used the unsubscribe link in a campaign
  status           TEXT NOT NULL DEFAULT 'pending' CHECK (status IN ('pending', 'confirmed', 'unsubscribed')),
  -- The secret in the confirmation link (the time it was made, then random); NULL once used
  confirm_token    TEXT UNIQUE,
  consent_at       TEXT,                              -- UTC: when they confirmed
  consent_source   TEXT,                              -- "Fan sign-up form, confirmed by email"
  created_at       TEXT NOT NULL,                     -- UTC
  confirmed_at     TEXT,                              -- UTC
  unsubscribed_at  TEXT,                              -- UTC
  -- SHA-256 of the sign-up's IP address with a secret salt: only for limiting sign-ups per
  -- visitor. The address itself is never stored.
  signup_ip_hash   TEXT
);

CREATE INDEX fans_status ON fans (status);
CREATE INDEX fans_signup_ip ON fans (signup_ip_hash, created_at);

-- The campaigns themselves
CREATE TABLE email_campaigns (
  id              INTEGER PRIMARY KEY AUTOINCREMENT,
  subject         TEXT NOT NULL,
  -- The text as written: plain text, a blank line between paragraphs, **bold**, links
  body            TEXT NOT NULL,
  audience        TEXT NOT NULL CHECK (audience IN ('fans', 'clients', 'everyone')),
  send_at         TEXT,                               -- UTC; NULL = as soon as it's approved
  status          TEXT NOT NULL CHECK (status IN ('draft', 'pending_approval', 'approved', 'rejected', 'scheduled', 'sent', 'failed')),
  created_by      TEXT NOT NULL,                      -- 'agent', 'staff-chat' or a staff.id
  created_at      TEXT NOT NULL,
  updated_at      TEXT NOT NULL,
  submitted_at    TEXT,                               -- when it last went for approval
  decided_by      TEXT,                               -- staff.id of the admin who approved or rejected it
  decided_at      TEXT,
  decision_note   TEXT,
  -- SHA-256 of exactly what was approved (subject, body, audience, send_at); NULL when not approved
  approved_hash   TEXT,
  broadcast_id    TEXT,                               -- Resend's broadcast id, once it's made
  recipients      INTEGER,                            -- how many it went (or will go) to, at send
  sent_at         TEXT,
  error           TEXT,
  -- JSON: { sent, delivered, opened, clicked, bounced, unsubscribed, complained, fetchedAt }
  stats           TEXT
);

CREATE INDEX email_campaigns_status ON email_campaigns (status, id);

-- What happened to each campaign, for the record: what was sent, when, to which list
CREATE TABLE email_campaign_log (
  id           INTEGER PRIMARY KEY AUTOINCREMENT,
  campaign_id  INTEGER NOT NULL REFERENCES email_campaigns (id),
  at           TEXT NOT NULL,                         -- UTC
  event        TEXT NOT NULL CHECK (event IN ('created', 'edited', 'submitted', 'approved', 'rejected', 'sent', 'scheduled', 'failed', 'stats')),
  "by"         TEXT,                                  -- 'agent', 'staff-chat', a staff.id, or 'resend' / 'nova' for what happened by itself
  detail       TEXT
);

CREATE INDEX email_campaign_log_campaign ON email_campaign_log (campaign_id, id);

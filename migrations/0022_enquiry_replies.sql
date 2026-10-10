-- Replying to enquiries from Portal and Nova Agent
--
-- Until now an enquiry was one message from the customer, and the studio answered from
-- its own inbox. This gives each enquiry a conversation the whole team can see: replies
-- staff send from Portal, internal notes, and replies Nova Agent's AI has drafted for a
-- person to check.
--
-- Nothing already saved changes meaning. Existing enquiries keep their status
-- ('new' or 'done'); a third one, 'replied', is used from now on once the studio has
-- emailed them. ('done' is what Portal calls "Done", i.e. closed.)

-- ===== The enquiry itself: consent and "don't contact me" =====

-- When and where the customer asked to be contacted (UK GDPR: the reason we may email
-- them). For an enquiry that's when they sent it, and from where: the NovaBot chat on
-- the page they were on.
ALTER TABLE enquiries ADD COLUMN consent_at TEXT;      -- UTC, ISO 8601
ALTER TABLE enquiries ADD COLUMN consent_source TEXT;  -- e.g. "NovaBot chat on /bookings-contact"

-- Set when the customer asks the studio to stop (the link in every email), or staff
-- switch on "Don't contact" in Portal. While it's set, nothing can be sent to them.
ALTER TABLE enquiries ADD COLUMN do_not_contact_at TEXT;  -- UTC; NULL = fine to reply
ALTER TABLE enquiries ADD COLUMN do_not_contact_by TEXT;  -- 'customer' (the stop link) or the staff member's id

-- The secret in the stop link of the emails sent about this enquiry (made the first time
-- one is sent). Only someone with the email can use it.
ALTER TABLE enquiries ADD COLUMN stop_token TEXT;
CREATE UNIQUE INDEX enquiries_stop_token ON enquiries (stop_token);

-- Fill in consent for enquiries saved before this change, from what they already hold
UPDATE enquiries
SET consent_at = created_at,
    consent_source = 'NovaBot chat' || COALESCE(' on ' || page, '')
WHERE consent_at IS NULL;

-- ===== The conversation =====

-- Every message after the customer's first one (which stays in enquiries.details)
CREATE TABLE enquiry_messages (
  id              INTEGER PRIMARY KEY AUTOINCREMENT,
  enquiry_id      INTEGER NOT NULL REFERENCES enquiries (id) ON DELETE CASCADE,
  -- out  = to the customer (a reply, or a draft of one)
  -- in   = from the customer (for later, when replies are read in automatically)
  -- note = for the team only, never sent
  direction       TEXT NOT NULL CHECK (direction IN ('out', 'in', 'note')),
  -- How it reaches them: only 'email' works today. 'sms' and 'whatsapp' are kept for a
  -- text-message provider added later.
  channel         TEXT NOT NULL DEFAULT 'email' CHECK (channel IN ('email', 'sms', 'whatsapp')),
  body            TEXT NOT NULL,
  -- For 'out' messages:
  --   draft     = written by Nova Agent's AI, waiting for a person to approve it
  --   approved  = a person pressed Send / Approve & send; it's being sent now
  --   sent      = it went (sent_at says when)
  --   failed    = it didn't go (error says why); staff can Retry
  --   discarded = a draft staff threw away (kept for the record, not shown)
  -- Notes and 'in' messages have no status.
  status          TEXT CHECK (status IS NULL OR status IN ('draft', 'approved', 'sent', 'failed', 'discarded')),
  created_by      TEXT NOT NULL CHECK (created_by IN ('staff', 'agent', 'customer')),
  author_staff_id TEXT,              -- who wrote it (NULL for the AI and the customer)
  created_at      TEXT NOT NULL,     -- UTC
  updated_at      TEXT NOT NULL,     -- UTC; changes on every edit or status change (Portal redraws only what changed)
  approved_by     TEXT,              -- the staff member who pressed Send / Approve & send
  approved_at     TEXT,              -- UTC
  sent_at         TEXT,              -- UTC
  sent_to         TEXT,              -- the address it went to (always the enquiry's own)
  attempts        INTEGER NOT NULL DEFAULT 0,  -- how many times sending was tried
  error           TEXT,              -- why the last try failed
  -- A random id the page makes for each Send press, so a double click or a retried
  -- request can't create (or send) the same reply twice
  client_key      TEXT
);

CREATE INDEX enquiry_messages_thread ON enquiry_messages (enquiry_id, id);
CREATE INDEX enquiry_messages_status ON enquiry_messages (status);
CREATE UNIQUE INDEX enquiry_messages_client_key ON enquiry_messages (enquiry_id, client_key);

-- Booking changes waiting for a person to approve them
--
-- Nova Agent's AI and the AI in Portal's staff chat can suggest a change in Acuity: make a
-- booking, move one, cancel one, change a booking's details, or add or remove a blocked-off
-- time. They can't make the change themselves. Each suggestion is saved here as "pending",
-- and nothing happens in Acuity until a signed-in admin presses Approve in Portal (then it's
-- done straight away, and the row says how it went). See src/booking-actions.js.
--
-- This only adds a new table (and its indexes). Nothing already saved changes.

CREATE TABLE booking_actions (
  id           INTEGER PRIMARY KEY AUTOINCREMENT,
  -- What to do in Acuity
  kind         TEXT NOT NULL CHECK (kind IN ('create', 'reschedule', 'cancel', 'update', 'block_add', 'block_remove')),
  -- The details (JSON), checked and tidied by Nova Bot; times in UTC (ISO 8601)
  payload      TEXT NOT NULL,
  -- What it does, in plain English, written by Nova Bot from Acuity's own data (never the AI's words)
  summary      TEXT NOT NULL,
  -- Why the AI suggested it (its words, shown to the admin)
  reason       TEXT,
  -- pending -> approved -> executed | failed, or pending -> rejected
  status       TEXT NOT NULL DEFAULT 'pending' CHECK (status IN ('pending', 'approved', 'rejected', 'executed', 'failed')),
  -- Who suggested it: 'agent' (Nova Agent) or 'staff-chat' (Portal's staff chat)
  proposed_by  TEXT NOT NULL CHECK (proposed_by IN ('agent', 'staff-chat')),
  created_at   TEXT NOT NULL,              -- UTC, ISO 8601
  updated_at   TEXT NOT NULL,              -- UTC; last edit or change of status
  -- The admin who approved or rejected it (staff.id), when, and their note on a rejection
  decided_by   TEXT,
  decided_at   TEXT,
  decision_note TEXT,
  -- Set once, by the one request that carries out an approved action (so it can't run twice)
  started_at   TEXT,
  executed_at  TEXT,                       -- when Acuity answered
  result       TEXT,                       -- JSON: what Acuity gave back (ids only)
  error        TEXT                        -- why it failed, in words
);

CREATE INDEX booking_actions_status ON booking_actions (status, created_at);
CREATE INDEX booking_actions_created ON booking_actions (created_at);

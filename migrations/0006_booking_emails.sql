-- Details from Acuity's booking emails (passed on by a small Google script),
-- and each booking change waiting for its notification.

-- What Acuity's latest email about a booking said (name, phone, email, session,
-- day and time, price, and every form answer), as one bundle of JSON
ALTER TABLE booking_details ADD COLUMN email_info TEXT;
-- When that email arrived
ALTER TABLE booking_details ADD COLUMN email_at TEXT;

-- Each booking change Acuity tells us about, until its notification has gone out
CREATE TABLE booking_events (
  id             INTEGER PRIMARY KEY AUTOINCREMENT,  -- a number for each change
  appointment_id INTEGER NOT NULL,                   -- Acuity's booking number
  action         TEXT NOT NULL,                      -- scheduled, rescheduled, canceled or changed
  type_id        INTEGER,                            -- the session type's number
  received_at    TEXT NOT NULL,                      -- when Acuity's webhook arrived
  notified_at    TEXT                                -- when the notification went out (empty = still waiting)
);
CREATE INDEX booking_events_waiting ON booking_events (notified_at, received_at);

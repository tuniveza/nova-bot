-- Bookings now belong to Nova Bot (no more Acuity).
--   Google Calendar holds every booking as an event: that's what the studio diary,
--   free times and Nova Club all read.
--   This table holds what a calendar event shouldn't: the customer's contact
--   details, money paid and refunded, and the secret token in their links.
--   Gmail sends every email; Stripe takes every payment (see payments).

CREATE TABLE bookings (
  id              INTEGER PRIMARY KEY AUTOINCREMENT,  -- the booking number staff and customers see
  token           TEXT NOT NULL UNIQUE,               -- secret part of the customer's manage/pay links
  status          TEXT NOT NULL,                      -- hold (waiting for the deposit at checkout), booked, cancelled, expired
  source          TEXT NOT NULL,                      -- website, chat, staff
  type_id         INTEGER,                            -- the session type (src/studio.js)
  session         TEXT NOT NULL,                      -- the session's name when it was booked
  duration        INTEGER NOT NULL,                   -- minutes
  changeover      INTEGER NOT NULL DEFAULT 0,         -- minutes kept free after it
  starts_at       TEXT NOT NULL,                      -- UTC, ISO 8601
  ends_at         TEXT NOT NULL,                      -- UTC, ISO 8601 (the session, without changeover)
  first_name      TEXT NOT NULL,
  last_name       TEXT NOT NULL,
  email           TEXT NOT NULL,
  phone           TEXT,
  notes           TEXT,
  price_pence     INTEGER NOT NULL DEFAULT 0,         -- the session's full price
  deposit_pence   INTEGER NOT NULL DEFAULT 0,         -- what secures it
  paid_pence      INTEGER NOT NULL DEFAULT 0,         -- paid so far (Stripe or marked paid by staff)
  refunded_pence  INTEGER NOT NULL DEFAULT 0,
  event_id        TEXT,                               -- the Google Calendar event
  event_link      TEXT,                               -- opens the event in Google Calendar
  hold_until      TEXT,                               -- a hold is released after this
  checkout_id     TEXT,                               -- the latest Stripe Checkout session
  referral_code   TEXT,
  chat_id         TEXT,                               -- the chat it was booked from
  sender          TEXT,                               -- hashed IP, only to stop one visitor booking too much
  reminded_at     TEXT,                               -- when the day-before reminder went
  created_at      TEXT NOT NULL,
  updated_at      TEXT NOT NULL,
  cancelled_at    TEXT,
  cancel_reason   TEXT
);

CREATE INDEX bookings_time ON bookings (starts_at);
CREATE INDEX bookings_email ON bookings (email);
CREATE INDEX bookings_status ON bookings (status, hold_until);
CREATE INDEX bookings_sender ON bookings (sender, created_at);

-- Every payment, refund and "marked paid" against a booking
CREATE TABLE payments (
  id            INTEGER PRIMARY KEY AUTOINCREMENT,
  booking_id    INTEGER NOT NULL,
  kind          TEXT NOT NULL,          -- payment, refund, manual (staff marked it paid, e.g. cash)
  amount_pence  INTEGER NOT NULL,
  stripe_id     TEXT UNIQUE,            -- payment intent (payment) or refund id (refund)
  note          TEXT,
  created_at    TEXT NOT NULL
);

CREATE INDEX payments_booking ON payments (booking_id);

-- Emails Nova Bot sent (or, in the sandbox, would have sent)
CREATE TABLE outbox (
  id          INTEGER PRIMARY KEY AUTOINCREMENT,
  booking_id  INTEGER,
  kind        TEXT NOT NULL,            -- confirmation, payment-request, receipt, moved, cancelled, reminder
  to_email    TEXT NOT NULL,
  subject     TEXT NOT NULL,
  sent        INTEGER NOT NULL,         -- 1 = Gmail accepted it, 0 = not sent (see error)
  error       TEXT,
  gmail_id    TEXT,
  created_at  TEXT NOT NULL
);

CREATE INDEX outbox_booking ON outbox (booking_id);

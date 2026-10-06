-- Referral tracking for Acuity bookings

-- Referral codes the studio hands out
CREATE TABLE referral_codes (
  code       TEXT PRIMARY KEY,           -- stored in capitals, e.g. "JAMES10"
  referrer   TEXT NOT NULL,              -- who the code belongs to
  note       TEXT,
  active     INTEGER NOT NULL DEFAULT 1, -- 1 = accepted, 0 = retired
  created_at TEXT NOT NULL
);

-- One row per Acuity appointment, with its referral alongside
CREATE TABLE appointments (
  id                INTEGER PRIMARY KEY, -- Acuity appointment ID
  first_name        TEXT,
  last_name         TEXT,
  email             TEXT,
  phone             TEXT,
  appointment_type  TEXT,
  starts_at         TEXT,                -- as Acuity sends it, e.g. 2026-10-03T14:00:00+0100
  status            TEXT NOT NULL DEFAULT 'scheduled', -- scheduled | canceled
  booked_at         TEXT,
  updated_at        TEXT NOT NULL,

  referral_answer   TEXT,                -- 'yes' | 'no' | NULL (not answered)
  referral_code     TEXT,                -- a valid, active code (NULL if none)
  referrer_name     TEXT,                -- the code's owner at the time it was used
  referred_by       TEXT,                -- name the customer typed, if any
  invalid_code      TEXT,                -- code typed on the Acuity form that wasn't active
  referral_source   TEXT,                -- 'after booking' | 'booking form'
  referral_at       TEXT,
  referral_attempts INTEGER NOT NULL DEFAULT 0 -- wrong codes tried (capped)
);

CREATE INDEX appointments_referral_code ON appointments (referral_code);
CREATE INDEX appointments_starts_at ON appointments (starts_at);

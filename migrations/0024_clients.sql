-- The client list (Quest 2): everyone who has booked or enquired, in one place
--
-- The studio's Acuity plan has no API, so Nova Bot builds its own list of clients from
-- what it can read: Acuity's private calendar feed (every 30 minutes, and Portal's
-- "Sync with Acuity now"), Acuity's webhook (each booking as it's made, moved or
-- cancelled), enquiries, and the appointments and clients spreadsheets (CSV) an admin
-- downloads from Acuity and imports in Portal. See src/clients.js.
--
-- One person is one row, matched by email (any case), else by mobile number, else (with
-- neither) by exact name, so running a sync or an import twice changes nothing. A sync
-- only fills in contact details that are missing: what staff typed is never overwritten.
--
-- Marketing consent (UK GDPR) starts as NO for everyone, past clients included. It only
-- becomes yes when staff record it with a date and where it came from, and every change
-- is written to client_consent_log (who, when, why). An enquiry's consent to be replied
-- to is not marketing consent, so enquiries come in as NO too.
--
-- Money is whole pence, typed in by staff (a payments module comes later).
--
-- This only adds new tables (and their indexes). Nothing already saved changes.

CREATE TABLE clients (
  id                   INTEGER PRIMARY KEY AUTOINCREMENT,
  name                 TEXT NOT NULL,
  email                TEXT,                       -- lower-case; NULL if none
  phone                TEXT,                       -- as typed; NULL if none
  -- The number for matching: the full international mobile ("+447700900123", dialNumber()
  -- in src/enquiries.js), else just its digits; NULL if none
  phone_key            TEXT,
  -- Marketing consent: 0 = no (the default), 1 = yes. When it was given or taken back, where
  -- from ("Ticked on the booking form", "Said yes in person"), and who recorded it (staff.id)
  marketing_consent    INTEGER NOT NULL DEFAULT 0 CHECK (marketing_consent IN (0, 1)),
  consent_at           TEXT,                       -- UTC, ISO 8601
  consent_source       TEXT,
  consent_by           TEXT,
  notes                TEXT NOT NULL DEFAULT '',
  -- Money, in whole pence (Portal shows pounds)
  deposits_paid_pence  INTEGER NOT NULL DEFAULT 0,
  invoiced_pence       INTEGER NOT NULL DEFAULT 0,
  outstanding_pence    INTEGER NOT NULL DEFAULT 0,
  -- How they first came in
  source               TEXT NOT NULL CHECK (source IN ('booking', 'enquiry', 'import', 'staff')),
  created_at           TEXT NOT NULL,              -- UTC
  updated_at           TEXT NOT NULL,              -- UTC; any change
  updated_by           TEXT                        -- staff.id, or 'acuity' / 'enquiry' / 'import' for a sync
);

CREATE UNIQUE INDEX clients_email ON clients (email) WHERE email IS NOT NULL;
CREATE INDEX clients_phone_key ON clients (phone_key);
CREATE INDEX clients_name ON clients (name);

-- Each booking a client has had (or has coming up)
CREATE TABLE client_sessions (
  id          INTEGER PRIMARY KEY AUTOINCREMENT,
  acuity_id   INTEGER UNIQUE,                     -- Acuity's booking number; NULL for an imported row without one
  client_id   INTEGER NOT NULL REFERENCES clients (id),
  session     TEXT,                               -- the session type ("Rap Package - 2 songs")
  starts_at   TEXT NOT NULL,                      -- UTC, ISO 8601
  ends_at     TEXT,                               -- UTC
  price       TEXT,                               -- as Acuity wrote it
  -- booked, or cancelled (a cancelled booking drops out of the feed, so it's never deleted here;
  -- old bookings drop out too, so nothing is deleted for being missing)
  status      TEXT NOT NULL CHECK (status IN ('booked', 'cancelled')),
  source      TEXT CHECK (source IN ('feed', 'webhook', 'import')),
  updated_at  TEXT NOT NULL                       -- UTC
);

CREATE INDEX client_sessions_client ON client_sessions (client_id, starts_at);
CREATE INDEX client_sessions_starts ON client_sessions (starts_at);
-- A row without Acuity's number is the same row if it's the same client, time and session
CREATE UNIQUE INDEX client_sessions_no_id ON client_sessions (client_id, starts_at, COALESCE(session, '')) WHERE acuity_id IS NULL;

-- Every change to a client's marketing consent, for the record (never edited or deleted)
CREATE TABLE client_consent_log (
  id           INTEGER PRIMARY KEY AUTOINCREMENT,
  client_id    INTEGER NOT NULL REFERENCES clients (id),
  consent      INTEGER NOT NULL CHECK (consent IN (0, 1)),
  at           TEXT NOT NULL,                     -- UTC: when they said yes (or no)
  source       TEXT,                              -- where it came from
  "by"         TEXT NOT NULL,                     -- staff.id, 'customer' or 'import'
  recorded_at  TEXT NOT NULL                      -- UTC: when it was written down here
);

CREATE INDEX client_consent_log_client ON client_consent_log (client_id, id);

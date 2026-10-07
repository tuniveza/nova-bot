-- Nova Portal: one sign-in for the whole Nova suite (see src/portal/).
-- A staff member's id is the key everything hangs off: their planet's seed,
-- their partition of Nova Index (staff memory with owner_id = id), and what
-- they're allowed to do.
CREATE TABLE staff (
  id               TEXT PRIMARY KEY,           -- e.g. "dominic"; the planet seed and Nova Index partition
  email            TEXT NOT NULL UNIQUE COLLATE NOCASE,
  password_hash    TEXT,                       -- PBKDF2 (salted); NULL until an invite is accepted
  display_name     TEXT NOT NULL,
  role             TEXT NOT NULL DEFAULT 'staff', -- admin | staff
  status           TEXT NOT NULL DEFAULT 'invited', -- active | invited | disabled
  created_at       TEXT NOT NULL,
  planet_seed      TEXT NOT NULL,              -- the id at first; re-rolled if someone wants a new look
  planet_overrides TEXT,                       -- JSON, hand-tuned traits (checked against the theme)
  index_partition  TEXT NOT NULL,              -- "staff:<id>"
  invite_hash      TEXT,                       -- SHA-256 of the invite link's token (the token itself is never stored)
  invite_expires   TEXT,
  last_login_at    TEXT
);

-- Signed-in sessions (the cookie or app token holds a random token; only its hash is kept)
CREATE TABLE sessions (
  id           TEXT PRIMARY KEY,               -- SHA-256 of the token
  staff_id     TEXT NOT NULL,
  kind         TEXT NOT NULL DEFAULT 'cookie', -- cookie (web) | token (native apps)
  created_at   TEXT NOT NULL,
  expires_at   TEXT NOT NULL,
  last_seen_at TEXT NOT NULL,
  user_agent   TEXT
);
CREATE INDEX sessions_staff ON sessions (staff_id);
CREATE INDEX sessions_expires ON sessions (expires_at);

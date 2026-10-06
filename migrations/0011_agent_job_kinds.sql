-- Nova Agent jobs can now be bookings as well as changes. A booking has no
-- Acuity appointment number yet, so that column becomes optional, and each
-- job says which kind it is ('change' or 'book').
-- (SQLite can't change a column in place, so the table is rebuilt.)

CREATE TABLE agent_jobs_new (
  id             INTEGER PRIMARY KEY AUTOINCREMENT,
  created_at     TEXT NOT NULL,
  kind           TEXT NOT NULL DEFAULT 'change', -- 'change' an existing booking, or 'book' a new one
  appointment_id INTEGER,                -- Acuity's appointment number (changes only)
  client_name    TEXT NOT NULL,
  changes        TEXT NOT NULL,          -- JSON: for 'change' { type?, price?, paid? }; for 'book' the booking details
  summary        TEXT NOT NULL,
  status         TEXT NOT NULL DEFAULT 'waiting',
  result         TEXT,
  picked_at      TEXT,
  finished_at    TEXT
);

INSERT INTO agent_jobs_new (id, created_at, kind, appointment_id, client_name, changes, summary, status, result, picked_at, finished_at)
  SELECT id, created_at, 'change', appointment_id, client_name, changes, summary, status, result, picked_at, finished_at FROM agent_jobs;

DROP TABLE agent_jobs;
ALTER TABLE agent_jobs_new RENAME TO agent_jobs;
CREATE INDEX agent_jobs_status ON agent_jobs (status, created_at);

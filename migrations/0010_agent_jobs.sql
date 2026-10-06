-- Jobs for Nova Agent, the browser helper that does what Acuity's API can't
-- (change a booking's session type, price or paid status)

-- One row per job staff asked for in Nova Hub's chat. Nova Agent checks in
-- every minute, takes the oldest waiting job, does it in Acuity, and reports
-- back; staff phones then get a notification with the result.
CREATE TABLE agent_jobs (
  id             INTEGER PRIMARY KEY AUTOINCREMENT,
  created_at     TEXT NOT NULL,
  appointment_id INTEGER NOT NULL,       -- Acuity's appointment number
  client_name    TEXT NOT NULL,          -- checked on the page before changing anything
  changes        TEXT NOT NULL,          -- JSON: { type?, price?, paid? }
  summary        TEXT NOT NULL,          -- plain-English description, for notifications
  status         TEXT NOT NULL DEFAULT 'waiting', -- waiting, working, done, failed
  result         TEXT,                   -- Nova Agent's report
  picked_at      TEXT,                   -- when Nova Agent took it
  finished_at    TEXT
);

CREATE INDEX agent_jobs_status ON agent_jobs (status, created_at);

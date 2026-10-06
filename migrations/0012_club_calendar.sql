-- Nova Club (the members' app) reads when the studio is booked from here
-- (club-calendar.js): a short-lived copy of Acuity's busy times for each
-- stretch of dates the app asks about, so the app can check every second
-- without asking Acuity every second.
-- The row with span 'changed' records when Acuity's webhook last said a
-- booking changed; copies made before then are out of date.

CREATE TABLE club_calendar (
  span       TEXT PRIMARY KEY,  -- the dates, e.g. '2026-10-01..2026-11-01', or 'changed'
  fetched_at INTEGER NOT NULL,  -- when we started asking Acuity (ms); for 'changed', when it changed
  busy       TEXT               -- what Acuity said, as JSON (empty for 'changed')
);

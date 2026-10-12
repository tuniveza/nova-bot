-- Portal → Test stuff (admins): things that look like tests or copies, with Delete and "Not a test"
-- (src/tidy.js)
--
-- Deleting copies what's removed into tidy_bin first, whole (the rows as JSON), so "Recently
-- deleted" can put it back for 30 days. Index pages also go through Index's own bin
-- (memory_removed), and shared notes and expenses are deleted the way their apps do it; tidy_bin
-- remembers which. "Not a test" goes in tidy_real, so that thing is never shown again (Undo takes it
-- out). tidy_log records each delete, restore and mark: ids and kinds only, never anyone's details.
--
-- Times are UTC (ISO 8601); Portal shows them in UK time.
--
-- This only adds new tables (and an index). Nothing already saved changes.

CREATE TABLE tidy_bin (
  id           TEXT PRIMARY KEY,              -- random
  item_key     TEXT NOT NULL,                 -- "<kind>:<id>", e.g. "chat:1e90…" or "enquiry:7"
  kind         TEXT NOT NULL,
  title        TEXT NOT NULL,                 -- what Portal showed, for the "Recently deleted" list
  -- JSON: { rows: { table: [row…] }, indexBins: [memory_removed id…], notes: [row…], expenses: [id…] }
  data         TEXT NOT NULL,
  deleted_by   TEXT NOT NULL,
  deleted_at   TEXT NOT NULL,                 -- UTC
  restored_by  TEXT,
  restored_at  TEXT                           -- UTC; set once it's been put back
);

CREATE INDEX tidy_bin_deleted ON tidy_bin (deleted_at);

-- Things an admin said aren't tests: never flagged again
CREATE TABLE tidy_real (
  key        TEXT PRIMARY KEY,                -- "<kind>:<id>"
  kind       TEXT NOT NULL,
  title      TEXT NOT NULL,
  marked_by  TEXT NOT NULL,
  marked_at  TEXT NOT NULL                    -- UTC
);

-- What was done, for the record (no titles, names or text)
CREATE TABLE tidy_log (
  id        INTEGER PRIMARY KEY AUTOINCREMENT,
  at        TEXT NOT NULL,                    -- UTC
  action    TEXT NOT NULL CHECK (action IN ('delete', 'restore', 'real', 'unreal')),
  item_key  TEXT NOT NULL,
  "by"      TEXT NOT NULL                     -- staff id
);

-- Nova Index cleanup (P0-5): a record of every cleanup, and a 30-day bin for what's removed
--
-- In plain English: this only ADDS two new tables (and their indexes). It doesn't change,
-- move or delete anything already saved in memory_files or memory_pending.
--
--   memory_cleanups  one row per "Check for junk" an admin runs in Index: the dry-run report
--                    exactly as it was shown (every item, with its reason), who ran it and when,
--                    then who applied it, when, how many were removed and which were skipped.
--                    Applying only ever removes items listed in that saved report, each one
--                    re-checked first (see src/memory/cleanup.js).
--   memory_removed   the bin: a copy of every removed entry (a whole file, one fact line, or a
--                    fact waiting for approval), why, by whom and when. An admin can put any of
--                    them back for 30 days; after that they're cleared out for good.
--                    Deleting a file in Index puts it here too.
--
-- Times are milliseconds since 1970 (like memory_files.updated_at).
CREATE TABLE memory_cleanups (
  id          TEXT PRIMARY KEY,
  checked_by  TEXT NOT NULL,
  checked_at  INTEGER NOT NULL,
  report      TEXT NOT NULL,               -- JSON: { keeps, counts, items: [{ id, kind, reason, ... }] }
  applied_by  TEXT,
  applied_at  INTEGER,
  removed     INTEGER NOT NULL DEFAULT 0,
  skipped     TEXT NOT NULL DEFAULT '[]'   -- JSON: [{ id, why }] items that no longer qualified
);
CREATE INDEX idx_mem_cleanups_checked ON memory_cleanups (checked_at);

CREATE TABLE memory_removed (
  id           TEXT PRIMARY KEY,
  cleanup_id   TEXT,                       -- the cleanup that removed it (NULL: deleted by hand in Index)
  kind         TEXT NOT NULL,              -- 'file' | 'line' | 'pending'
  reason       TEXT NOT NULL,
  scope        TEXT NOT NULL,
  owner_id     TEXT,
  path         TEXT NOT NULL,              -- the file's path (for a pending fact: the file it was meant for)
  content      TEXT NOT NULL,              -- the line itself, or the whole row as JSON (file, pending fact)
  removed_by   TEXT NOT NULL,
  removed_at   INTEGER NOT NULL,
  restored_by  TEXT,
  restored_at  INTEGER
);
CREATE INDEX idx_mem_removed_at ON memory_removed (removed_at);

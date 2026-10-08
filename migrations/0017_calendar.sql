-- Calendar, kept here so it works from anywhere, even with the studio PC off.
-- Nova Agent on the PC keeps a copy (data/calendar.json) and syncs with this.

-- Every event and day card. `data` is the item itself (JSON); the columns beside it are
-- for finding things. `rev` goes up with every change, so a copy can ask "what changed
-- since rev N?". Deleting keeps a row (deleted = 1) so copies hear about it too.
CREATE TABLE calendar_items (
  id       TEXT PRIMARY KEY,               -- the item's id (the same everywhere)
  kind     TEXT NOT NULL,                  -- event | day
  data     TEXT NOT NULL,                  -- the item (JSON)
  start    TEXT NOT NULL DEFAULT '',       -- an event's start, a day card's date (local time)
  updated  TEXT NOT NULL,                  -- when it was last changed (ISO 8601)
  deleted  INTEGER NOT NULL DEFAULT 0,     -- 1 once deleted
  rev      INTEGER NOT NULL                -- its place in the order of changes
);
CREATE INDEX calendar_items_rev ON calendar_items (rev);

-- Reminders already sent to phones, so each goes once (id|date|minutes)
CREATE TABLE calendar_reminders_sent (
  key      TEXT PRIMARY KEY,
  sent_at  TEXT NOT NULL
);

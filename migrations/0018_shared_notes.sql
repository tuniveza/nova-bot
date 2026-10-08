-- Shared notes (src/notes-shared.js): notes the whole team sees and edits, in Notes inside Nova
-- Agent, online and on the studio PC. Notes kept only on one device ("Local") never come here.
CREATE TABLE shared_notes (
  id               TEXT PRIMARY KEY,               -- the note's own id (made by Notes, the same everywhere)
  title            TEXT NOT NULL DEFAULT '',
  html             TEXT NOT NULL DEFAULT '',       -- '' once deleted
  meta             TEXT NOT NULL DEFAULT '{}',     -- JSON: pinned, named, gdocId, gdocUrl
  created_at       TEXT NOT NULL,                  -- when the note was made
  updated_at       TEXT NOT NULL,                  -- when it was last changed
  created_by       TEXT NOT NULL DEFAULT '',       -- staff.id of who made it
  created_by_name  TEXT NOT NULL DEFAULT '',
  updated_by       TEXT NOT NULL DEFAULT '',       -- staff.id of who changed it last
  updated_by_name  TEXT NOT NULL DEFAULT '',
  deleted_at       TEXT,                           -- set once deleted (kept so every copy deletes it too)
  rev              INTEGER NOT NULL,               -- the team's change counter: what a copy has seen
  size             INTEGER NOT NULL DEFAULT 0      -- bytes of title + html
);
CREATE INDEX shared_notes_by_rev ON shared_notes (rev);

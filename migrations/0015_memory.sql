-- Nova Index: the Nova suite's shared memory (see src/memory/).
-- Small files of one-line facts, one file per subject, in three scopes:
--   studio   (shared facts about the studio; owner_id NULL)
--   staff    (one set per staff member; owner_id = their id)
--   customer (one set per client; owner_id = their email, or "chat:<id>" until known)
CREATE TABLE memory_files (
  id          TEXT PRIMARY KEY,
  scope       TEXT NOT NULL,
  owner_id    TEXT,
  path        TEXT NOT NULL,              -- 'profile' | 'people/kai' | 'topics/pricing' | 'areas/ep-release' | 'studio' | 'public'
  name        TEXT NOT NULL,
  description TEXT NOT NULL,              -- one line: what's inside and when to read it (this is the index)
  aliases     TEXT NOT NULL DEFAULT '[]', -- JSON array
  body        TEXT NOT NULL,              -- '- [tag] fact' lines
  version     TEXT NOT NULL,              -- changes on every write (optimistic concurrency)
  source_app  TEXT,
  updated_at  INTEGER NOT NULL,
  UNIQUE (scope, owner_id, path)
);
CREATE INDEX idx_mem_lookup ON memory_files (scope, owner_id);
CREATE INDEX idx_mem_updated ON memory_files (updated_at);

-- Facts waiting for a person to approve them (everything learned from customers)
CREATE TABLE memory_pending (
  id         TEXT PRIMARY KEY,
  scope      TEXT NOT NULL,
  owner_id   TEXT,
  target     TEXT NOT NULL,               -- the path the fact would go into
  tag        TEXT NOT NULL,
  fact       TEXT NOT NULL,
  source_app TEXT NOT NULL,
  source_ref TEXT,                        -- the conversation it came from
  created_at INTEGER NOT NULL
);
CREATE INDEX idx_mem_pending_created ON memory_pending (created_at);

-- How far each website chat has been read for facts (so nothing is read twice)
CREATE TABLE memory_progress (
  chat_id         TEXT PRIMARY KEY,
  last_message_id INTEGER NOT NULL,
  updated_at      INTEGER NOT NULL
);

-- The inbox: enquiries sorted like support tickets, a spam folder, saved replies, and
-- website chats marked "needs a person" or "done"
--
-- Enquiries already have a status ('new', 'replied', 'done'; the column has no fixed list).
-- From now on two more are used, so an enquiry is always in exactly one place:
--   new      not looked at yet
--   open     someone's working on it
--   replied  the studio answered and is waiting on them (Portal: "Waiting on them")
--   done     finished
--   spam     the spam filter (or a person) put it in the Spam folder; "Not spam" moves it back
-- Nothing is ever deleted: Spam is just another folder. Spam never pings phones.
--
-- This only adds columns, two tables and an index. Nothing already saved changes: every
-- existing enquiry keeps its status, and the new columns start empty.

-- Who's on it (a staff id; NULL = nobody yet)
ALTER TABLE enquiries ADD COLUMN assigned_to TEXT;
-- A short label staff choose, e.g. "Mixing" or "Price question" (NULL = none)
ALTER TABLE enquiries ADD COLUMN label TEXT;
-- Why it's in Spam: the filter's reasons ("3 links; a throwaway email address"), or who moved it
ALTER TABLE enquiries ADD COLUMN spam_reason TEXT;
-- When its state last changed (UTC), and who changed it (a staff id, 'agent' or 'filter')
ALTER TABLE enquiries ADD COLUMN state_at TEXT;
ALTER TABLE enquiries ADD COLUMN state_by TEXT;

CREATE INDEX enquiries_status ON enquiries (status, created_at);

-- Saved replies: short answers to routine questions (prices, opening times, how to book).
-- Picking one fills the reply box; the reply still goes only when a person presses Send.
CREATE TABLE saved_replies (
  id          INTEGER PRIMARY KEY AUTOINCREMENT,
  title       TEXT NOT NULL,                 -- what it's for, e.g. "Prices"
  body        TEXT NOT NULL,                 -- the reply text
  created_by  TEXT NOT NULL,                 -- staff id
  created_at  TEXT NOT NULL,                 -- UTC
  updated_by  TEXT,
  updated_at  TEXT NOT NULL                  -- UTC
);

-- Website chats as tickets: one row per chat a person has marked (no row = not marked yet).
-- The chat itself stays in chat_messages (kept for 90 days, as before).
CREATE TABLE chat_tickets (
  chat_id      TEXT PRIMARY KEY,
  state        TEXT NOT NULL CHECK (state IN ('needs-person', 'done')),
  assigned_to  TEXT,                         -- staff id, or NULL
  updated_by   TEXT,                         -- staff id
  updated_at   TEXT NOT NULL                 -- UTC
);

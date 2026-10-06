-- Enquiries NovaBot sends to the team, and a log of chat conversations

-- One row per enquiry a visitor confirmed in the chat
CREATE TABLE enquiries (
  id         INTEGER PRIMARY KEY AUTOINCREMENT,
  created_at TEXT NOT NULL,
  name       TEXT NOT NULL,
  email      TEXT NOT NULL,
  phone      TEXT,
  subject    TEXT,
  details    TEXT NOT NULL,
  page       TEXT,                        -- the website page they were on
  chat_id    TEXT,                        -- links to chat_messages
  sender     TEXT,                        -- hashed IP address, only used to stop spam
  emailed    INTEGER NOT NULL DEFAULT 0,  -- 1 = an email copy was sent
  status     TEXT NOT NULL DEFAULT 'new'  -- new | done
);

CREATE INDEX enquiries_created_at ON enquiries (created_at);
CREATE INDEX enquiries_sender ON enquiries (sender, created_at);

-- Every message in every chat (kept for 90 days)
CREATE TABLE chat_messages (
  id         INTEGER PRIMARY KEY AUTOINCREMENT,
  chat_id    TEXT NOT NULL,
  created_at TEXT NOT NULL,
  role       TEXT NOT NULL,               -- user | assistant
  content    TEXT NOT NULL,
  page       TEXT
);

CREATE INDEX chat_messages_chat ON chat_messages (chat_id, id);
CREATE INDEX chat_messages_created_at ON chat_messages (created_at);

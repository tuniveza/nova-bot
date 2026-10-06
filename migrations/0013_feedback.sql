-- Feedback visitors give about NovaBot from the chat's Feedback button
-- (feedback.js), typed or spoken, shown on the admin pages.

CREATE TABLE feedback (
  id         INTEGER PRIMARY KEY AUTOINCREMENT,
  created_at TEXT NOT NULL,     -- when it was sent (ISO time)
  chat_id    TEXT,              -- which chat it came from (links to the conversation)
  page       TEXT,              -- the website page it was sent from
  rating     TEXT,              -- 'good', 'bad' or empty
  message    TEXT NOT NULL,     -- what they said (spoken feedback is turned into text)
  spoken     INTEGER NOT NULL DEFAULT 0, -- 1 if any of it was spoken
  recent     TEXT               -- the last few messages of the chat, as JSON, for context
);

CREATE INDEX feedback_created ON feedback (created_at);

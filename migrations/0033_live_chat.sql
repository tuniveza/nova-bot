-- Live chat: someone from the studio typing straight to a visitor in a website chat
-- (Portal → Conversations), as well as NovaBot
--
-- A staff member opens a website chat in Portal and presses Take over (or just replies): NovaBot
-- stops answering that chat and the visitor sees "Sam from the studio has joined the chat." Their
-- messages show in the visitor's chat with their first name. Hand back gives the chat back to
-- NovaBot. The visitor's chat checks for new messages from the studio every few seconds (a quick
-- read of the small chat_live table; nothing is held open). See src/livechat.js.
--
-- These are replies to someone who started the conversation (a service, not marketing), so they
-- need no approval. NovaBot's AI never writes as a person, and Nova Agent has no tool to post here.
--
-- Times are UTC (ISO 8601); Portal shows them in UK time.
--
-- This only adds a column and a new table. Nothing already saved changes.

-- Who wrote a chat message, when it wasn't the visitor or NovaBot: the staff member's first name
-- (role 'staff': their message; role 'note': "… has joined the chat" and the like)
ALTER TABLE chat_messages ADD COLUMN sender TEXT;

-- One row per website chat a person from the studio has taken over (or that asked for a person)
CREATE TABLE chat_live (
  chat_id     TEXT PRIMARY KEY,
  mode        TEXT NOT NULL CHECK (mode IN ('bot', 'staff')),   -- staff: NovaBot is paused for this chat
  staff_id    TEXT,                                             -- who took it over (staff.id)
  staff_name  TEXT,                                             -- their first name, as the visitor sees it
  since       TEXT,                                             -- when it was taken over (UTC)
  visitor_at  TEXT,                                             -- the visitor's last message (UTC)
  pinged_at   TEXT,                                             -- the last phone ping about this chat (UTC)
  updated_at  TEXT NOT NULL
);

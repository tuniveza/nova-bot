-- Sessions NovaBot booked straight into Acuity for a customer in the chat

-- One row per booking NovaBot made (so the same one isn't made twice, and to
-- stop one visitor making too many)
CREATE TABLE chat_bookings (
  id             INTEGER PRIMARY KEY AUTOINCREMENT,
  created_at     TEXT NOT NULL,
  appointment_id INTEGER,                -- Acuity's appointment number
  type_id        INTEGER NOT NULL,       -- the session type
  starts_at      TEXT NOT NULL,          -- UK time, "2026-10-06 14:00"
  name           TEXT NOT NULL,
  email          TEXT NOT NULL,
  phone          TEXT,
  pay_link       TEXT,                   -- where the customer pays the deposit
  chat_id        TEXT,                   -- links to chat_messages
  sender         TEXT NOT NULL           -- hashed IP address, only used to stop spam
);

CREATE INDEX chat_bookings_sender ON chat_bookings (sender, created_at);
CREATE INDEX chat_bookings_booking ON chat_bookings (email, type_id, starts_at);

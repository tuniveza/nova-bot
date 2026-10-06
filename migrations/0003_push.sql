-- Phones signed up for Nova Hub notifications (one row per phone)

CREATE TABLE push_subscriptions (
  endpoint   TEXT PRIMARY KEY,  -- the phone's delivery address, given by Apple (or Google)
  p256dh     TEXT NOT NULL,     -- the phone's public key, used to seal each message
  auth       TEXT NOT NULL,     -- the phone's secret, also used to seal each message
  created_at TEXT NOT NULL      -- when the phone signed up
);

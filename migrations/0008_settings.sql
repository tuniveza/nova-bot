-- Nova Hub settings that staff change in the app (one row per setting).
-- First one: "alerts_auto_delete_days" (empty or 0 = keep alerts for 90 days).

CREATE TABLE settings (
  key   TEXT PRIMARY KEY,  -- the setting's name
  value TEXT NOT NULL      -- its value, as text
);

-- Notifications that reached at least one phone, listed in Nova Hub's Alerts tab

CREATE TABLE notifications (
  id         INTEGER PRIMARY KEY AUTOINCREMENT,  -- a number for each notification
  created_at TEXT NOT NULL,                      -- when it was sent
  title      TEXT NOT NULL,                      -- the first line ("New booking")
  body       TEXT NOT NULL,                      -- the text under it
  url        TEXT NOT NULL,                      -- what opens when it's tapped
  phones     INTEGER NOT NULL                    -- how many phones Apple accepted it for
);

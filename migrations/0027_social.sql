-- Social posts (Quest 4): Facebook and Instagram posts, only after an admin approves them
--
-- Nova Agent's AI or anyone on the staff writes a post (the words, which platforms, its pictures
-- or videos, and when it should go out). It waits as 'pending_approval' until an admin, signed in
-- to Portal in a browser, presses Approve. Approving stores a hash of exactly what was approved
-- (the words, the platforms, the pictures and videos, the time): nothing is posted if anything
-- changed since, and any edit puts the post back to 'pending_approval' with the approval cleared.
-- Then Nova Bot posts it through Meta's Graph API (now, or at post_at). Until Meta is connected
-- (the META_* secrets), an approved post waits as 'manual': Portal shows the words and the files
-- so someone posts it by hand, then presses "I posted it". See src/social.js.
--
-- The pictures and videos themselves aren't kept here: they live on the studio computer (Nova
-- Agent's data folder, social-media/) until the VPS takes over. Only their ids are kept here.
--
-- Comments on the studio's posts come in every hour so the team can answer them. A reply is a
-- draft until an admin approves it, like the posts. People's names and comments are kept only
-- to answer them: dealt-with comments are deleted after 90 days.
--
-- Times are UTC (ISO 8601); Portal shows them in UK time.
--
-- This only adds new tables (and their indexes). Nothing already saved changes.

CREATE TABLE social_posts (
  id              INTEGER PRIMARY KEY AUTOINCREMENT,
  caption         TEXT NOT NULL DEFAULT '',
  platforms       TEXT NOT NULL,                      -- JSON: ["facebook", "instagram"] (one or both)
  -- JSON: [{ id, ext, kind: "image" | "video", name, size }]: files on the studio computer
  media           TEXT NOT NULL DEFAULT '[]',
  post_at         TEXT,                               -- UTC; NULL = as soon as it's approved
  status          TEXT NOT NULL CHECK (status IN ('draft', 'pending_approval', 'approved', 'scheduled', 'posting', 'manual', 'posted', 'failed', 'rejected')),
  created_by      TEXT NOT NULL,                      -- 'agent', 'staff-chat' or a staff.id
  created_at      TEXT NOT NULL,
  updated_at      TEXT NOT NULL,
  submitted_at    TEXT,                               -- when it last went for approval
  decided_by      TEXT,                               -- staff.id of the admin who approved or rejected it
  decided_at      TEXT,
  decision_note   TEXT,
  -- SHA-256 of exactly what was approved; NULL when not approved
  approved_hash   TEXT,
  -- JSON, per platform: { mode: "auto" | "manual", state, id, objectId, url, container, children, error, postedAt }
  targets         TEXT,
  posted_at       TEXT,
  error           TEXT,
  -- JSON: { facebook: { reach, likes, comments, shares, clicks }, instagram: { … }, fetchedAt }
  stats           TEXT,
  -- A step of posting is running until then (so the minute's check and a press never post twice)
  lease_until     TEXT
);

CREATE INDEX social_posts_status ON social_posts (status, id);
CREATE INDEX social_posts_due ON social_posts (status, post_at);

-- What happened to each post, for the record
CREATE TABLE social_post_log (
  id        INTEGER PRIMARY KEY AUTOINCREMENT,
  post_id   INTEGER NOT NULL REFERENCES social_posts (id),
  at        TEXT NOT NULL,                            -- UTC
  event     TEXT NOT NULL CHECK (event IN ('created', 'edited', 'submitted', 'approved', 'rejected', 'scheduled', 'posting', 'posted', 'manual', 'marked_posted', 'failed', 'stats', 'reply_drafted', 'reply_approved', 'reply_rejected', 'reply_sent', 'reply_failed')),
  "by"      TEXT,                                     -- 'agent', 'staff-chat', a staff.id, or 'meta' / 'nova' for what happened by itself
  detail    TEXT
);

CREATE INDEX social_post_log_post ON social_post_log (post_id, id);

-- Comments on the studio's posts (read from Meta every hour), and the team's replies
CREATE TABLE social_comments (
  id                 INTEGER PRIMARY KEY AUTOINCREMENT,
  post_id            INTEGER REFERENCES social_posts (id),
  platform           TEXT NOT NULL CHECK (platform IN ('facebook', 'instagram')),
  external_id        TEXT NOT NULL,                   -- Meta's id for the comment
  author             TEXT,                            -- the name or @username Meta gives
  text               TEXT NOT NULL,
  commented_at       TEXT NOT NULL,                   -- UTC
  seen_at            TEXT NOT NULL,                   -- UTC: when Nova first read it
  handled            INTEGER NOT NULL DEFAULT 0,      -- 1 = dealt with (answered, or nothing to say)
  reply              TEXT,                            -- the reply as written (a draft until approved)
  reply_status       TEXT CHECK (reply_status IS NULL OR reply_status IN ('pending_approval', 'approved', 'sent', 'failed', 'rejected')),
  reply_by           TEXT,                            -- 'agent', 'staff-chat' or a staff.id
  reply_at           TEXT,
  reply_hash         TEXT,                            -- SHA-256 of the approved reply; NULL when not approved
  reply_decided_by   TEXT,
  reply_decided_at   TEXT,
  reply_note         TEXT,
  reply_external_id  TEXT,
  reply_sent_at      TEXT,
  reply_error        TEXT,
  UNIQUE (platform, external_id)
);

CREATE INDEX social_comments_post ON social_comments (post_id, id);
CREATE INDEX social_comments_open ON social_comments (handled, reply_status);

-- Followers, once a day per platform (for "followers this month")
CREATE TABLE social_followers (
  day        TEXT NOT NULL,                           -- YYYY-MM-DD (UK)
  platform   TEXT NOT NULL CHECK (platform IN ('facebook', 'instagram')),
  followers  INTEGER NOT NULL,
  PRIMARY KEY (day, platform)
);

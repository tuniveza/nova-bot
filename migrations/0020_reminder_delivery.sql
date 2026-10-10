-- Calendar reminders: which phones get each one, and proof it arrived.
--
-- Each phone now remembers who turned notifications on (staff_id) and what it is (name,
-- like "iPhone" or "Android · Pixel 7"), so a reminder can go to just one phone. Phones
-- signed up before this have no owner: they count as the studio owner's (the first admin)
-- until they're turned on again while someone is signed in.
ALTER TABLE push_subscriptions ADD COLUMN staff_id TEXT;
ALTER TABLE push_subscriptions ADD COLUMN name TEXT;

-- A reminder only counts as sent once a phone took it. Until then it's tried again each
-- minute (for 15 minutes); after that it's marked failed, and Portal's Alerts says so.
--   status: sending | retrying | sent | failed      tries: how many goes it's had
ALTER TABLE calendar_reminders_sent ADD COLUMN status TEXT NOT NULL DEFAULT 'sent';
ALTER TABLE calendar_reminders_sent ADD COLUMN tries INTEGER NOT NULL DEFAULT 0;

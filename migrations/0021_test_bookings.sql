-- Test bookings: an admin can run a pretend booking from Portal → Admin → Test booking,
-- to check the booking flow still works without anyone paying real money.
--
-- A test booking is an ordinary row in the bookings table with "test" switched on.
-- Everything that matters skips it: free times for customers (unless the admin chose to
-- block the time), Nova Club's busy times, reminders, emails to anyone but the admin
-- who made it, staff phone alerts, referrals and NovaBot's booking tools.
-- It removes itself after 24 hours (the every-minute timer), or straight away with
-- "Remove all test bookings".
--
-- Only adds columns; every booking already saved stays a real one (test = 0).

-- 1 = a test booking (shown as TEST everywhere), 0 = a real one
ALTER TABLE bookings ADD COLUMN test INTEGER NOT NULL DEFAULT 0;
-- Which admin made it (staff.id): the only person its email and alert can go to
ALTER TABLE bookings ADD COLUMN test_by TEXT;
-- 1 = the admin chose to let it block the time for customers; 0 = customers can still book over it
ALTER TABLE bookings ADD COLUMN test_blocks INTEGER NOT NULL DEFAULT 0;

-- Finding test bookings quickly (the list, the clean-up and the 24-hour timer)
CREATE INDEX bookings_test ON bookings (test, created_at);

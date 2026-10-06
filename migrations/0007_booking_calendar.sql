-- Details from Acuity's private calendar feed (Sync with Other Calendars →
-- 1-way Calendar Sync): name, phone, email, price, session and time for every
-- booking, including ones staff add themselves.

-- What the calendar feed said about a booking, as one bundle of JSON
ALTER TABLE booking_details ADD COLUMN calendar_info TEXT;
-- When we read it
ALTER TABLE booking_details ADD COLUMN calendar_at TEXT;

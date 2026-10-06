-- Booking details for notifications. Two halves arrive separately, like the two
-- halves of a torn ticket that only count when they match:
--   1. Acuity's webhook (trusted, has the secret key) says booking #id exists
--   2. Acuity's confirmation page (in the customer's browser) sends its details
-- The details are only shown when both halves arrived within 15 minutes.

CREATE TABLE booking_details (
  id         INTEGER PRIMARY KEY,  -- Acuity's booking number
  webhook_at TEXT,                 -- when Acuity's webhook said it was booked
  details_at TEXT,                 -- when the confirmation page sent the details
  session    TEXT,                 -- the session booked ("Rap Package – 2 songs")
  date       TEXT,                 -- the day, as Acuity writes it ("October 4, 2026")
  time       TEXT,                 -- the time, as Acuity writes it ("2:00pm")
  price      TEXT,                 -- the price paid
  email      TEXT,                 -- the customer's email
  calendar   TEXT                  -- which Acuity calendar it's on
);

-- Which booking or enquiry each Alerts entry is about (for its details and buttons)
ALTER TABLE notifications ADD COLUMN appointment_id INTEGER;
ALTER TABLE notifications ADD COLUMN enquiry_id INTEGER;

-- Money: invoices to clients, the payments against them, and the studio's expenses
--
-- Staff (or Nova Agent's AI) write an invoice; it waits as 'pending_approval' until an admin,
-- signed in to Portal in a browser, presses Approve. Approving stores a hash of exactly what was
-- approved (who it's to, the lines, VAT, dates, notes, total): the sender refuses if anything
-- changed since, and any edit puts it back to 'pending_approval' with the approval cleared. Then
-- Nova Bot emails the client a link to their invoice's own page (/invoice/<token>), which they can
-- print or save as a PDF, and pay by card (Stripe, when it's set up) or bank transfer.
--
-- Reminders for an unpaid invoice are emails too, so they wait for an admin's Approve the same way.
--
-- Payments are recorded by staff in Portal (bank, cash, card machine…) or come in from Stripe's
-- webhook (the invoice page's "Pay by card"). An invoice is 'part_paid' or 'paid' from its payments.
--
-- Expenses are typed in by staff; Nova Agent's AI can only log them as 'unconfirmed', and those
-- don't count in any total until someone in the team confirms them. A receipt's photo is kept on
-- the studio PC (receipt_id names it), not here.
--
-- Money is whole pence. Days (issue, due, paid, spent) are UK days, YYYY-MM-DD; moments are UTC
-- (ISO 8601). Portal shows pounds and UK time.
--
-- This only adds new tables (and their indexes). Nothing already saved changes.

CREATE TABLE invoices (
  id               INTEGER PRIMARY KEY AUTOINCREMENT,
  seq              INTEGER NOT NULL UNIQUE,            -- 1, 2, 3… (the number shown is NS-0001)
  -- The random secret in the client's link to their invoice page (nothing else is in the link)
  token            TEXT NOT NULL UNIQUE,
  client_id        INTEGER REFERENCES clients (id),    -- NULL: someone not on the client list
  bill_name        TEXT NOT NULL,
  bill_email       TEXT,                               -- lower-case; where it's emailed
  bill_address     TEXT NOT NULL DEFAULT '',
  -- JSON: [{ "description": "Mixing, 2 songs", "qty": 2, "unit_pence": 15000 }]
  lines            TEXT NOT NULL,
  vat_rate         REAL NOT NULL DEFAULT 0,            -- percent (0 or 20)
  subtotal_pence   INTEGER NOT NULL,
  vat_pence        INTEGER NOT NULL,
  total_pence      INTEGER NOT NULL,
  issue_date       TEXT NOT NULL,                      -- UK day
  due_date         TEXT NOT NULL,                      -- UK day
  notes            TEXT NOT NULL DEFAULT '',           -- shown on the invoice
  status           TEXT NOT NULL CHECK (status IN ('draft', 'pending_approval', 'approved', 'rejected', 'failed', 'sent', 'part_paid', 'paid', 'void')),
  created_by       TEXT NOT NULL,                      -- 'agent' or a staff.id
  created_at       TEXT NOT NULL,
  updated_at       TEXT NOT NULL,
  submitted_at     TEXT,
  decided_by       TEXT,                               -- staff.id of the admin who approved or rejected it
  decided_at       TEXT,
  decision_note    TEXT,
  approved_hash    TEXT,                               -- SHA-256 of exactly what was approved
  sent_at          TEXT,
  email_id         TEXT,                               -- the mail server's id for the email
  paid_pence       INTEGER NOT NULL DEFAULT 0,         -- sum of its payments
  paid_at          TEXT,                               -- when it became fully paid
  voided_at        TEXT,
  error            TEXT
);

CREATE INDEX invoices_status ON invoices (status, due_date);
CREATE INDEX invoices_client ON invoices (client_id);

CREATE TABLE invoice_payments (
  id            INTEGER PRIMARY KEY AUTOINCREMENT,
  invoice_id    INTEGER NOT NULL REFERENCES invoices (id),
  amount_pence  INTEGER NOT NULL CHECK (amount_pence > 0),
  paid_on       TEXT NOT NULL,                         -- UK day
  method        TEXT NOT NULL CHECK (method IN ('bank', 'card', 'cash', 'stripe', 'other')),
  note          TEXT NOT NULL DEFAULT '',
  stripe_id     TEXT UNIQUE,                           -- Stripe's payment, so a webhook counts once
  "by"          TEXT NOT NULL,                         -- staff.id, or 'stripe'
  created_at    TEXT NOT NULL,
  removed_at    TEXT,                                  -- a mistake taken back by an admin (kept for the record)
  removed_by    TEXT
);

CREATE INDEX invoice_payments_invoice ON invoice_payments (invoice_id);
CREATE INDEX invoice_payments_day ON invoice_payments (paid_on);

-- Reminder emails for unpaid invoices (each waits for an admin's Approve)
CREATE TABLE invoice_reminders (
  id             INTEGER PRIMARY KEY AUTOINCREMENT,
  invoice_id     INTEGER NOT NULL REFERENCES invoices (id),
  body           TEXT NOT NULL,
  status         TEXT NOT NULL CHECK (status IN ('pending_approval', 'approved', 'rejected', 'sent', 'failed')),
  created_by     TEXT NOT NULL,
  created_at     TEXT NOT NULL,
  updated_at     TEXT NOT NULL,
  decided_by     TEXT,
  decided_at     TEXT,
  approved_hash  TEXT,
  sent_at        TEXT,
  error          TEXT
);

CREATE INDEX invoice_reminders_invoice ON invoice_reminders (invoice_id, id);
CREATE INDEX invoice_reminders_status ON invoice_reminders (status);

CREATE TABLE expenses (
  id            INTEGER PRIMARY KEY AUTOINCREMENT,
  spent_on      TEXT NOT NULL,                         -- UK day
  amount_pence  INTEGER NOT NULL CHECK (amount_pence > 0),
  category      TEXT NOT NULL,
  supplier      TEXT NOT NULL DEFAULT '',
  note          TEXT NOT NULL DEFAULT '',
  receipt_id    TEXT,                                  -- the receipt's photo on the studio PC
  -- confirmed: counts in the totals; unconfirmed: logged by Nova Agent's AI, waiting for a person
  status        TEXT NOT NULL CHECK (status IN ('confirmed', 'unconfirmed')),
  created_by    TEXT NOT NULL,                         -- 'agent' or a staff.id
  created_at    TEXT NOT NULL,
  updated_at    TEXT NOT NULL,
  deleted_at    TEXT,                                  -- removed (kept for the record)
  deleted_by    TEXT
);

CREATE INDEX expenses_day ON expenses (spent_on);

-- What happened, for the record (who, when, what)
CREATE TABLE money_log (
  id          INTEGER PRIMARY KEY AUTOINCREMENT,
  invoice_id  INTEGER,                                 -- NULL for an expense or a setting
  expense_id  INTEGER,
  at          TEXT NOT NULL,                           -- UTC
  event       TEXT NOT NULL,                           -- created, edited, submitted, approved, rejected, sent, failed, paid, payment, payment_removed, reminder, voided, expense, settings
  "by"        TEXT,                                    -- 'agent', a staff.id, 'stripe' or 'nova'
  detail      TEXT
);

CREATE INDEX money_log_invoice ON money_log (invoice_id, id);

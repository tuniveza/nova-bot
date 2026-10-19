-- Monzo as a way an invoice was paid (Portal → Money and the Invoicer: Record a payment → Monzo), next
-- to bank transfer, card, cash, Stripe and other. Its receipt then says "Monzo".
--
-- SQLite can't change a CHECK, so the payments table is made again with 'monzo' allowed and every
-- payment copied across as it is (same ids, so nothing that points at one changes).

PRAGMA defer_foreign_keys = true;

CREATE TABLE invoice_payments_new (
  id            INTEGER PRIMARY KEY AUTOINCREMENT,
  invoice_id    INTEGER NOT NULL REFERENCES invoices (id),
  amount_pence  INTEGER NOT NULL CHECK (amount_pence > 0),
  paid_on       TEXT NOT NULL,                         -- UK day
  method        TEXT NOT NULL CHECK (method IN ('bank', 'monzo', 'card', 'cash', 'stripe', 'other')),
  note          TEXT NOT NULL DEFAULT '',
  stripe_id     TEXT UNIQUE,                           -- Stripe's payment, so a webhook counts once
  "by"          TEXT NOT NULL,                         -- staff.id, or 'stripe'
  created_at    TEXT NOT NULL,
  removed_at    TEXT,                                  -- a mistake taken back by an admin (kept for the record)
  removed_by    TEXT
);

INSERT INTO invoice_payments_new (id, invoice_id, amount_pence, paid_on, method, note, stripe_id, "by", created_at, removed_at, removed_by)
  SELECT id, invoice_id, amount_pence, paid_on, method, note, stripe_id, "by", created_at, removed_at, removed_by FROM invoice_payments;

DROP TABLE invoice_payments;
ALTER TABLE invoice_payments_new RENAME TO invoice_payments;

CREATE INDEX invoice_payments_invoice ON invoice_payments (invoice_id);
CREATE INDEX invoice_payments_day ON invoice_payments (paid_on);

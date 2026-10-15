-- Receipts: the queued emails for an invoice (invoice_reminders) say what they are. A reminder (the
-- balance due, or overdue: the invoice at its stage) or a receipt (paid in full). A receipt is
-- written by itself when an invoice is paid in full, and like every email waits for an admin's
-- Approve before it goes.
--
-- This only adds a column; every reminder already saved stays a reminder.

ALTER TABLE invoice_reminders ADD COLUMN kind TEXT NOT NULL DEFAULT 'reminder' CHECK (kind IN ('reminder', 'receipt'));

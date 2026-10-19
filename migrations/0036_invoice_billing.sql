-- How each invoice is billed: 'deposit' (before the session: a deposit secures the date, the rest is
-- due on the session day) or 'full' (after the session: the full amount, no deposit). Its emails
-- follow it: before the session, the welcoming one that asks for the deposit; after it, the thank-you
-- that asks for the full amount (src/invoicer.js, stageMessage).
--
-- This only adds a column; every invoice already saved stays 'deposit', as they all were before.

ALTER TABLE invoices ADD COLUMN billing TEXT NOT NULL DEFAULT 'deposit';

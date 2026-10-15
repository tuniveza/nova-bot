-- Each invoice's own look: the colour, Bright or Dark, and the paper chosen for it in the Invoicer
-- (JSON: { "theme": "jade", "mode": "dark", "paper": "pearl" }). Its email, its page, its PDF and its
-- receipt all use it. NULL: the studio's look (Money's settings: invoiceTheme, invoiceMode,
-- invoicePaper), as every invoice did before.
--
-- This only adds a column; every invoice already saved keeps the studio's look.

ALTER TABLE invoices ADD COLUMN look TEXT;

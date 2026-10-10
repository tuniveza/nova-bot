-- The staff app is Portal, everywhere: stored text that still used its old name now says Portal.
--   memory_files / memory_pending: which app a remembered fact came from (shown in Index)
--   memory_files.body / memory_pending.fact: the facts themselves
--   notifications: the alert history listed in Portal's Alerts tab
-- Only whole-word uses change (never inside another word, such as GitHub). Nothing is deleted.
UPDATE memory_files SET source_app = 'Portal' WHERE source_app IN ('Hub', 'Nova Hub', 'hub');
UPDATE memory_pending SET source_app = 'Portal' WHERE source_app IN ('Hub', 'Nova Hub', 'hub');

UPDATE memory_files SET body = REPLACE(REPLACE(REPLACE(REPLACE(body, 'Nova Hub', 'Portal'), ' Hub ', ' Portal '), ' Hub.', ' Portal.'), ' Hub''s', ' Portal''s')
  WHERE body LIKE '%Hub%';
UPDATE memory_pending SET fact = REPLACE(REPLACE(REPLACE(REPLACE(fact, 'Nova Hub', 'Portal'), ' Hub ', ' Portal '), ' Hub.', ' Portal.'), ' Hub''s', ' Portal''s')
  WHERE fact LIKE '%Hub%';

UPDATE notifications SET
  title = REPLACE(REPLACE(REPLACE(title, 'Nova Hub', 'Portal'), ' Hub ', ' Portal '), ' Hub.', ' Portal.'),
  body = REPLACE(REPLACE(REPLACE(body, 'Nova Hub', 'Portal'), ' Hub ', ' Portal '), ' Hub.', ' Portal.')
  WHERE title LIKE '%Hub%' OR body LIKE '%Hub%';
-- …and where the old name starts the text
UPDATE notifications SET title = 'Portal' || substr(title, 4) WHERE title LIKE 'Hub %' OR title LIKE 'Hub:%';
UPDATE notifications SET body = 'Portal' || substr(body, 4) WHERE body LIKE 'Hub %' OR body LIKE 'Hub:%';

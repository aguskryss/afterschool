-- Rebrand: the seeded administrator's display name.
--
-- server/database.py only sets this name when it creates the very first admin,
-- so existing databases keep the old value and it shows in the app header and
-- on every "reviewed by" record. This updates it in place.
--
-- Narrow on purpose: only the exact legacy string is touched, so an admin who
-- has been renamed by hand is left alone. Safe to re-run.

UPDATE users
   SET name = 'Kikar Afterschool Administrator'
 WHERE role = 'admin'
   AND name = 'J Club Administrator';

-- Verify:
--   SELECT id, email, name FROM users WHERE role = 'admin';

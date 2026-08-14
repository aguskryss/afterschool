-- Rollback for 16_rebrand_admin_display_name.sql.

UPDATE users
   SET name = 'J Club Administrator'
 WHERE role = 'admin'
   AND name = 'Kikar Afterschool Administrator';

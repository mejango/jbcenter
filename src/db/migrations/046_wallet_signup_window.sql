-- A signup may take up to fifteen minutes inside one app request: a passkey, a backup file, and a
-- passkey manager that needs a moment. The registration ceremony and the enrollment live as long;
-- 047 widens the app request's own bound.
ALTER TABLE rest_wallet_ceremonies DROP CONSTRAINT rest_wallet_ceremonies_check;
ALTER TABLE rest_wallet_ceremonies ADD CONSTRAINT rest_wallet_ceremonies_check CHECK (expires_at > created_at AND expires_at <= created_at + 900000);
ALTER TABLE rest_wallet_enrollments DROP CONSTRAINT rest_wallet_enrollments_check;
ALTER TABLE rest_wallet_enrollments ADD CONSTRAINT rest_wallet_enrollments_check CHECK (expires_at > created_at AND expires_at <= created_at + 900000);

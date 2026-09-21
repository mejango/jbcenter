-- App grants may now be issued for up to 90 days (the per-application policy bounds each one).
ALTER TABLE rest_wallet_app_grants DROP CONSTRAINT rest_wallet_app_grants_check;
ALTER TABLE rest_wallet_app_grants
  ADD CONSTRAINT rest_wallet_app_grants_check
  CHECK (expires_at>created_at AND expires_at<=created_at+7776000 AND expires_at<=9007199168340);

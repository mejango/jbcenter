-- Each application's grants live for its own configured lifetime (an hour by default, up to 90
-- days), instead of the central session's hour. The lifetime is policy, set by the operator.
ALTER TABLE rest_wallet_policy_apps
  ADD COLUMN grant_lifetime_seconds integer NOT NULL DEFAULT 3600
  CHECK (grant_lifetime_seconds BETWEEN 60 AND 7776000);

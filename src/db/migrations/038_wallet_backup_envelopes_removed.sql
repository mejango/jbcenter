-- The chosen-password backup option was withdrawn after review: a sealed envelope fetchable by
-- wallet address allows offline password guessing. Nothing reads this table any more.
DROP TABLE IF EXISTS rest_wallet_backup_envelopes;

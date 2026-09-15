-- Backup words sealed under a password the user chose, stored beside the enrollment they belong
-- to. The browser seals them; Center wraps that ciphertext again under its own key and hands it
-- back for recovery by wallet address, a few reads per hour. Unverified enrollments cascade away.
CREATE TABLE rest_wallet_backup_envelopes (
  enrollment_id uuid PRIMARY KEY REFERENCES rest_wallet_enrollments(id) ON DELETE CASCADE,
  version text NOT NULL CHECK (version='center-wallet-backup-wrap-v1'),
  wrap_iv text NOT NULL CHECK (wrap_iv ~ '^[A-Za-z0-9_-]{16}$'),
  wrapped text NOT NULL CHECK (length(wrapped) BETWEEN 1 AND 4096 AND wrapped ~ '^[A-Za-z0-9_-]+$'),
  created_at bigint NOT NULL CHECK (created_at>0),
  reads integer NOT NULL DEFAULT 0 CHECK (reads>=0),
  window_started_at bigint NOT NULL DEFAULT 0 CHECK (window_started_at>=0)
);

-- One-use challenge receipts only. No account, credential, session, payment or budget authority is stored here.
CREATE TABLE rest_wallet_ceremonies (
  id uuid PRIMARY KEY,
  account_id text NOT NULL CHECK (account_id ~ '^[A-Za-z0-9][A-Za-z0-9:._-]{0,255}$'),
  purpose text NOT NULL CHECK (purpose IN ('registration','login','session','deploy','payment','rotate')),
  context_digest text NOT NULL CHECK (context_digest ~ '^[0-9a-f]{64}$'),
  challenge text NOT NULL UNIQUE CHECK (challenge ~ '^[A-Za-z0-9_-]{43}$'),
  created_at bigint NOT NULL,
  expires_at bigint NOT NULL CHECK (expires_at > created_at AND expires_at <= created_at + 300000),
  retain_until bigint NOT NULL CHECK (retain_until = expires_at + 86400000),
  consumed_at bigint CHECK (consumed_at >= created_at AND consumed_at < expires_at),
  proof_digest text CHECK (proof_digest ~ '^[0-9a-f]{64}$'),
  result_id uuid,
  CHECK ((consumed_at IS NULL AND proof_digest IS NULL AND result_id IS NULL)
      OR (consumed_at IS NOT NULL AND proof_digest IS NOT NULL AND result_id IS NOT NULL))
);
CREATE INDEX rest_wallet_ceremonies_account ON rest_wallet_ceremonies(account_id);
CREATE INDEX rest_wallet_ceremonies_retention ON rest_wallet_ceremonies(retain_until,id);

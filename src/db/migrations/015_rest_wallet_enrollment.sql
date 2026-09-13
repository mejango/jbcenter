-- Possession-verified creation intent only: this does not enroll a REST account, deploy a wallet or create a session.
CREATE TABLE rest_wallet_enrollments (
  id uuid PRIMARY KEY,
  user_handle text NOT NULL UNIQUE CHECK (user_handle ~ '^[A-Za-z0-9_-]{43}$'),
  state text NOT NULL CHECK (state IN ('awaiting_registration','awaiting_possession','verified')),
  intent_digest text NOT NULL CHECK (intent_digest ~ '^[0-9a-f]{64}$'),
  created_at bigint NOT NULL,
  expires_at bigint NOT NULL CHECK (expires_at > created_at AND expires_at <= created_at + 300000),
  retain_until bigint NOT NULL CHECK (retain_until = expires_at + 86400000),
  intent jsonb NOT NULL CHECK ((jsonb_typeof(intent) = 'object' AND octet_length(intent::text) <= 65536
    AND intent->>'id' = id::text AND intent->>'userHandle' = user_handle
    AND (intent->>'expiresAt')::bigint = expires_at) IS TRUE),
  candidate jsonb CHECK (jsonb_typeof(candidate) = 'object' AND octet_length(candidate::text) <= 4096),
  candidate_digest text CHECK (candidate_digest ~ '^[0-9a-f]{64}$'),
  creation jsonb CHECK (jsonb_typeof(creation) = 'object' AND octet_length(creation::text) <= 65536),
  possession jsonb CHECK (jsonb_typeof(possession) = 'object' AND octet_length(possession::text) <= 4096),
  safe_address text CHECK (safe_address ~ '^0x[0-9a-f]{40}$'),
  account_id text UNIQUE,
  verified_at bigint CHECK (verified_at >= created_at AND verified_at < expires_at),
  receipt jsonb CHECK (jsonb_typeof(receipt) = 'object' AND octet_length(receipt::text) <= 4096),
  UNIQUE(id,account_id,user_handle),
  CHECK ((
    (state='awaiting_registration' AND candidate IS NULL AND candidate_digest IS NULL AND creation IS NULL
      AND possession IS NULL AND safe_address IS NULL AND account_id IS NULL AND verified_at IS NULL AND receipt IS NULL)
    OR
    (state IN ('awaiting_possession','verified') AND candidate IS NOT NULL AND candidate_digest IS NOT NULL AND creation IS NOT NULL
      AND possession IS NOT NULL AND safe_address IS NOT NULL AND lower(creation->>'address')=safe_address
      AND (creation->>'chainId')::bigint=8453 AND candidate->>'userHandle'=user_handle
      AND possession->'ceremony'->>'accountId'='wallet-enrollment:' || id::text
      AND (possession->'ceremony'->>'expiresAt')::bigint=expires_at
      AND ((state='awaiting_possession' AND account_id IS NULL AND verified_at IS NULL AND receipt IS NULL)
        OR (state='verified' AND account_id='eip155:8453:' || safe_address AND verified_at IS NOT NULL
          AND receipt IS NOT NULL AND receipt->>'id'=id::text AND receipt->>'enrollmentId'=id::text
          AND receipt->>'accountId'=account_id AND receipt->>'credentialId'=candidate->>'credentialId'
          AND (receipt->>'verifiedAt')::bigint=verified_at)))
  ) IS TRUE)
);
CREATE INDEX rest_wallet_enrollment_pending_retention ON rest_wallet_enrollments(retain_until,id) WHERE state <> 'verified';
CREATE UNIQUE INDEX rest_wallet_enrollment_verified_safe ON rest_wallet_enrollments(safe_address) WHERE state='verified';

-- Never reserve a credential from none-attestation data. This table receives only verified possession mappings.
CREATE TABLE rest_wallet_credentials (
  rp_id text NOT NULL CHECK (length(rp_id) BETWEEN 1 AND 253),
  credential_id text NOT NULL CHECK (length(credential_id) BETWEEN 1 AND 1364 AND credential_id ~ '^[A-Za-z0-9_-]+$'),
  enrollment_id uuid NOT NULL,
  account_id text NOT NULL CHECK (account_id ~ '^eip155:8453:0x[0-9a-f]{40}$'),
  user_handle text NOT NULL CHECK (user_handle ~ '^[A-Za-z0-9_-]{43}$'),
  public_key_x text NOT NULL CHECK (public_key_x ~ '^0x[0-9a-f]{64}$'),
  public_key_y text NOT NULL CHECK (public_key_y ~ '^0x[0-9a-f]{64}$'),
  backup_eligible boolean NOT NULL,
  verified_at bigint NOT NULL,
  superseded_at bigint CHECK (superseded_at >= verified_at),
  PRIMARY KEY(rp_id,credential_id),
  -- Mapping may be inserted before the final parent UPDATE, but both must agree at COMMIT.
  FOREIGN KEY(enrollment_id,account_id,user_handle) REFERENCES rest_wallet_enrollments(id,account_id,user_handle)
    ON DELETE RESTRICT DEFERRABLE INITIALLY DEFERRED
);
-- Historical mappings remain immutable identities when W5 later replaces the primary credential.
CREATE UNIQUE INDEX rest_wallet_credential_current_primary ON rest_wallet_credentials(account_id) WHERE superseded_at IS NULL;

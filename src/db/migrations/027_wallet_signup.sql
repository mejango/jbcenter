ALTER TABLE rest_wallet_ceremonies DROP CONSTRAINT rest_wallet_ceremonies_purpose_check;
ALTER TABLE rest_wallet_ceremonies ADD CONSTRAINT rest_wallet_ceremonies_purpose_check
  CHECK (purpose IN ('registration','login','session','deploy','payment','rotate','signup-resume'));

-- Continuation only. These tokens never represent a login, app grant or Safe owner.
-- An enrollment and its flow are admitted atomically before an account exists.
CREATE TABLE rest_wallet_signup_flows (
  id uuid PRIMARY KEY,
  enrollment_id uuid NOT NULL UNIQUE REFERENCES rest_wallet_enrollments(id) ON DELETE CASCADE,
  token_hash text NOT NULL UNIQUE CHECK (token_hash ~ '^[0-9a-f]{64}$'),
  passkey_name text NOT NULL CHECK (octet_length(passkey_name) BETWEEN 1 AND 120),
  created_at_ms bigint NOT NULL,
  expires_at_ms bigint NOT NULL CHECK (expires_at_ms > created_at_ms),
  revision bigint NOT NULL DEFAULT 1 CHECK (revision >= 1),
  deployment_id uuid,
  setup_document jsonb CHECK (jsonb_typeof(setup_document) = 'object' AND octet_length(setup_document::text) <= 65536)
);

-- One fresh discoverable proof rotates one flow. The original result is retained for
-- lost-response recovery; it cannot roll back a subsequent token rotation.
CREATE TABLE rest_wallet_signup_resumes (
  id uuid PRIMARY KEY,
  draft jsonb NOT NULL CHECK (jsonb_typeof(draft) = 'object' AND octet_length(draft::text) <= 4096),
  resume_token_hash text NOT NULL CHECK (resume_token_hash ~ '^[0-9a-f]{64}$'),
  next_token_hash text NOT NULL CHECK (next_token_hash ~ '^[0-9a-f]{64}$'),
  expires_at_ms bigint NOT NULL,
  retain_until_ms bigint NOT NULL CHECK (retain_until_ms = expires_at_ms + 86400000),
  completed_at_ms bigint,
  flow_id uuid,
  proof_digest text CHECK (proof_digest ~ '^[0-9a-f]{64}$'),
  CHECK ((completed_at_ms IS NULL AND flow_id IS NULL AND proof_digest IS NULL) OR
    (completed_at_ms IS NOT NULL AND flow_id IS NOT NULL AND proof_digest IS NOT NULL AND completed_at_ms < expires_at_ms))
);
CREATE INDEX rest_wallet_signup_resumes_retention ON rest_wallet_signup_resumes(retain_until_ms,id);

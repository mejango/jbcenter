-- Browser continuation is separate from the immutable accepted recovery evidence.
-- A token grants no login, spending or owner-rotation authority.
CREATE TABLE rest_wallet_recovery_flows (
  id uuid PRIMARY KEY REFERENCES rest_wallet_recoveries(id) ON DELETE CASCADE,
  token_hash text NOT NULL UNIQUE CHECK (token_hash ~ '^[0-9a-f]{64}$'),
  passkey_name text NOT NULL CHECK (octet_length(passkey_name) BETWEEN 1 AND 120),
  created_at_ms bigint NOT NULL,
  expires_at_ms bigint NOT NULL CHECK (expires_at_ms > created_at_ms),
  revision bigint NOT NULL DEFAULT 1 CHECK (revision BETWEEN 1 AND 9007199254740991),
  setup_document jsonb CHECK (jsonb_typeof(setup_document)='object' AND octet_length(setup_document::text)<=65536)
);
CREATE FUNCTION rest_wallet_recovery_flow_transition() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF NEW.id IS DISTINCT FROM OLD.id OR NEW.passkey_name IS DISTINCT FROM OLD.passkey_name
    OR NEW.created_at_ms IS DISTINCT FROM OLD.created_at_ms OR NEW.revision<>OLD.revision+1 THEN
    RAISE EXCEPTION 'Recovery flow identity is fixed and revision advances once' USING ERRCODE='23514';
  END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER rest_wallet_recovery_flow_transition BEFORE UPDATE ON rest_wallet_recovery_flows
  FOR EACH ROW EXECUTE FUNCTION rest_wallet_recovery_flow_transition();

CREATE TABLE rest_wallet_recovery_resumes (
  id uuid PRIMARY KEY,
  recovery_id uuid NOT NULL REFERENCES rest_wallet_recovery_flows(id) ON DELETE CASCADE,
  draft jsonb NOT NULL CHECK ((jsonb_typeof(draft)='object' AND octet_length(draft::text)<=8192
    AND draft->>'id'=id::text AND draft->>'recoveryId'=recovery_id::text) IS TRUE),
  resume_token_hash text NOT NULL UNIQUE CHECK (resume_token_hash ~ '^[0-9a-f]{64}$'),
  next_token_hash text NOT NULL CHECK (next_token_hash ~ '^[0-9a-f]{64}$'),
  expires_at_ms bigint NOT NULL,
  retain_until_ms bigint NOT NULL CHECK (retain_until_ms=expires_at_ms+86400000),
  completed_at_ms bigint,
  proof_digest text CHECK (proof_digest ~ '^[0-9a-f]{64}$'),
  CHECK ((completed_at_ms IS NULL AND proof_digest IS NULL) OR
    (completed_at_ms IS NOT NULL AND proof_digest IS NOT NULL AND completed_at_ms<expires_at_ms))
);
CREATE INDEX rest_wallet_recovery_resumes_retention ON rest_wallet_recovery_resumes(retain_until_ms,id);
CREATE INDEX rest_wallet_recovery_resumes_recovery ON rest_wallet_recovery_resumes(recovery_id,id);
CREATE FUNCTION rest_wallet_recovery_resume_transition() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF (to_jsonb(NEW)-'completed_at_ms'-'proof_digest') IS DISTINCT FROM (to_jsonb(OLD)-'completed_at_ms'-'proof_digest')
    OR (OLD.completed_at_ms IS NOT NULL AND to_jsonb(NEW) IS DISTINCT FROM to_jsonb(OLD)) THEN
    RAISE EXCEPTION 'Recovery resume challenge and accepted result are immutable' USING ERRCODE='23514';
  END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER rest_wallet_recovery_resume_transition BEFORE UPDATE ON rest_wallet_recovery_resumes
  FOR EACH ROW EXECUTE FUNCTION rest_wallet_recovery_resume_transition();

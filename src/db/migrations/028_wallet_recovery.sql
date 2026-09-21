-- A recovery proof is not a credential switch, owner transaction or session.
-- Keep accepted proofs durable: an unknown chain submission must never be forgotten.
CREATE TABLE rest_wallet_recoveries (
  id uuid PRIMARY KEY,
  account_id text NOT NULL REFERENCES rest_accounts(id) ON DELETE RESTRICT,
  enrollment_id uuid NOT NULL REFERENCES rest_wallet_enrollments(id) ON DELETE RESTRICT,
  token_hash text NOT NULL UNIQUE CHECK (token_hash ~ '^[0-9a-f]{64}$'),
  created_at_ms bigint NOT NULL,
  expires_at_ms bigint NOT NULL CHECK (expires_at_ms > created_at_ms AND expires_at_ms <= created_at_ms+300000),
  retain_until_ms bigint NOT NULL CHECK (retain_until_ms=expires_at_ms+86400000),
  intent jsonb NOT NULL CHECK ((jsonb_typeof(intent)='object' AND octet_length(intent::text)<=65536
    AND intent->>'id'=id::text AND intent->>'accountId'=account_id AND intent->>'enrollmentId'=enrollment_id::text
    AND (intent->>'issuedAtMs')::bigint=created_at_ms AND (intent->>'expiresAtMs')::bigint=expires_at_ms) IS TRUE),
  candidate jsonb CHECK (jsonb_typeof(candidate)='object' AND octet_length(candidate::text)<=98304),
  proof jsonb CHECK (proof IS NULL OR (jsonb_typeof(proof)='object' AND octet_length(proof::text)<=4096
    AND proof->>'recoveryId'=id::text AND proof->>'accountId'=account_id AND proof->>'enrollmentId'=enrollment_id::text
    AND proof->>'verificationDigest' ~ '^[0-9a-f]{64}$'
    AND (proof->>'verifiedAtMs')::bigint>=created_at_ms AND (proof->>'verifiedAtMs')::bigint<expires_at_ms) IS TRUE),
  CHECK (candidate IS NULL OR (candidate->'intent'=intent) IS TRUE),
  CHECK (proof IS NULL OR candidate IS NOT NULL)
);
CREATE INDEX rest_wallet_recoveries_account ON rest_wallet_recoveries(account_id,created_at_ms,id);
CREATE INDEX rest_wallet_recoveries_retention ON rest_wallet_recoveries(retain_until_ms,id) WHERE proof IS NULL;

CREATE FUNCTION rest_wallet_recovery_transition() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF TG_OP='DELETE' THEN
    IF OLD.proof IS NOT NULL OR OLD.retain_until_ms>floor(extract(epoch FROM clock_timestamp())*1000)::bigint THEN
      RAISE EXCEPTION 'Accepted or retained recovery evidence cannot be deleted' USING ERRCODE='23514';
    END IF;
    RETURN OLD;
  END IF;
  IF (to_jsonb(NEW)-'candidate'-'proof') IS DISTINCT FROM (to_jsonb(OLD)-'candidate'-'proof')
    OR (OLD.candidate IS NOT NULL AND NEW.candidate IS DISTINCT FROM OLD.candidate)
    OR (OLD.proof IS NOT NULL AND NEW.proof IS DISTINCT FROM OLD.proof) THEN
    RAISE EXCEPTION 'Recovery identity, selected credential and accepted proof are immutable' USING ERRCODE='23514';
  END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER rest_wallet_recovery_transition BEFORE UPDATE OR DELETE ON rest_wallet_recoveries
  FOR EACH ROW EXECUTE FUNCTION rest_wallet_recovery_transition();

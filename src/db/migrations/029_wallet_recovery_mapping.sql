ALTER TABLE rest_wallet_credentials ADD COLUMN recovery_receipt jsonb CHECK (recovery_receipt IS NULL OR (
  jsonb_typeof(recovery_receipt)='object' AND octet_length(recovery_receipt::text)<=16384
  AND recovery_receipt->>'version'='center-wallet-credential-recovery-v1'
  AND recovery_receipt->>'accountId'=account_id AND recovery_receipt->>'enrollmentId'=enrollment_id::text
  AND recovery_receipt->>'rpId'=rp_id AND recovery_receipt->'credential'->>'credentialId'=credential_id
  AND recovery_receipt->'credential'->>'userHandle'=user_handle
  AND recovery_receipt->'credential'->'publicKey'->>'x'=public_key_x
  AND recovery_receipt->'credential'->'publicKey'->>'y'=public_key_y
  AND (recovery_receipt->'credential'->>'backupEligible')::boolean=backup_eligible
  AND (recovery_receipt->>'verifiedAtMs')::bigint=verified_at) IS TRUE);

CREATE FUNCTION rest_wallet_credential_identity() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF TG_OP='DELETE' THEN
    RAISE EXCEPTION 'Wallet credential history is retained' USING ERRCODE='23514';
  END IF;
  IF (to_jsonb(NEW)-'superseded_at') IS DISTINCT FROM (to_jsonb(OLD)-'superseded_at')
    OR (OLD.superseded_at IS NOT NULL AND NEW.superseded_at IS DISTINCT FROM OLD.superseded_at) THEN
    RAISE EXCEPTION 'Credential identity is immutable and supersession cannot be reversed' USING ERRCODE='23514';
  END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER rest_wallet_credential_identity BEFORE UPDATE OR DELETE ON rest_wallet_credentials
  FOR EACH ROW EXECUTE FUNCTION rest_wallet_credential_identity();

ALTER TABLE rest_wallet_recoveries ADD COLUMN activation jsonb CHECK (activation IS NULL OR (
  proof IS NOT NULL AND jsonb_typeof(activation)='object' AND octet_length(activation::text)<=16384
  AND activation->>'version'='center-wallet-credential-recovery-v1' AND activation->>'id'=id::text
  AND activation->>'accountId'=account_id AND activation->>'enrollmentId'=enrollment_id::text
  AND activation->>'proofDigest'=proof->>'verificationDigest') IS TRUE);

CREATE OR REPLACE FUNCTION rest_wallet_recovery_transition() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF TG_OP='DELETE' THEN
    IF OLD.proof IS NOT NULL OR OLD.retain_until_ms>floor(extract(epoch FROM clock_timestamp())*1000)::bigint THEN
      RAISE EXCEPTION 'Accepted or retained recovery evidence cannot be deleted' USING ERRCODE='23514';
    END IF;
    RETURN OLD;
  END IF;
  IF (to_jsonb(NEW)-'candidate'-'proof'-'activation') IS DISTINCT FROM (to_jsonb(OLD)-'candidate'-'proof'-'activation')
    OR (OLD.candidate IS NOT NULL AND NEW.candidate IS DISTINCT FROM OLD.candidate)
    OR (OLD.proof IS NOT NULL AND NEW.proof IS DISTINCT FROM OLD.proof)
    OR (OLD.activation IS NOT NULL AND NEW.activation IS DISTINCT FROM OLD.activation) THEN
    RAISE EXCEPTION 'Recovery identity and accepted evidence are immutable' USING ERRCODE='23514';
  END IF;
  RETURN NEW;
END $$;

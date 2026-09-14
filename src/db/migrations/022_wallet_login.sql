-- Anonymous discoverable login intent plus its one fixed central-session receipt. No app grant,
-- deployment or spending authority is conferred by this table or a public session identifier.
CREATE TABLE rest_wallet_logins (
  id uuid PRIMARY KEY,
  session_id uuid NOT NULL UNIQUE,
  -- Logical ceremony reference: its independent 24h cleanup must not delete the longer session
  -- receipt or be blocked by it. Consumption and completion share one transaction in the store.
  ceremony_id uuid NOT NULL UNIQUE,
  rp_id text NOT NULL CHECK (length(rp_id) BETWEEN 1 AND 253),
  flow_token_hash text NOT NULL UNIQUE CHECK (flow_token_hash ~ '^[0-9a-f]{64}$'),
  issued_at_ms bigint NOT NULL CHECK (issued_at_ms BETWEEN 1 AND 9007199164740991),
  expires_at_ms bigint NOT NULL CHECK (expires_at_ms>issued_at_ms AND expires_at_ms<=issued_at_ms+180000 AND expires_at_ms%1000=0),
  retain_until_ms bigint NOT NULL CHECK (retain_until_ms=expires_at_ms+3600000+86400000),
  draft jsonb NOT NULL CHECK ((jsonb_typeof(draft)='object' AND octet_length(draft::text)<=4096
    AND draft->>'version'='center-wallet-login-v1' AND draft->>'id'=id::text
    AND draft->>'sessionId'=session_id::text AND draft->>'rpId'=rp_id AND draft->>'flowTokenHash'=flow_token_hash
    AND jsonb_typeof(draft->'origin')='string' AND length(draft->>'origin') BETWEEN 1 AND 2048
    AND (draft->>'origin' ~ '^https://[^/]+$' OR draft->>'origin' ~ '^http://(localhost|127\.0\.0\.1|\[::1\])(:[0-9]+)?$')
    AND (draft->>'issuedAtMs')::bigint=issued_at_ms AND (draft->>'expiresAtMs')::bigint=expires_at_ms
    AND (draft->>'retainUntilMs')::bigint=retain_until_ms AND draft->'ceremony'->>'id'=ceremony_id::text
    AND draft->'ceremony'->>'purpose'='login' AND draft->'ceremony'->>'accountId'='wallet-login:'||id::text
    AND (draft->'ceremony'->>'expiresAt')::bigint=expires_at_ms
    AND draft->'ceremony'->>'contextDigest' ~ '^[0-9a-f]{64}$'
    AND draft->'ceremony'->>'challenge' ~ '^[A-Za-z0-9_-]{43}$') IS TRUE),
  completed_at_ms bigint CHECK (completed_at_ms>=issued_at_ms AND completed_at_ms<expires_at_ms),
  proof_digest text CHECK (proof_digest ~ '^[0-9a-f]{64}$'),
  proof jsonb,
  session_token_hash text UNIQUE CHECK (session_token_hash ~ '^[0-9a-f]{64}$'),
  account_id text REFERENCES rest_wallet_authority(account_id),
  enrollment_id uuid REFERENCES rest_wallet_enrollments(id),
  credential_id text,
  user_handle text,
  authority_epoch bigint CHECK (authority_epoch>0),
  session_epoch bigint CHECK (session_epoch>0),
  binding_id text CHECK (binding_id ~ '^0x[0-9a-f]{64}$'),
  binding_authorization_digest text CHECK (binding_authorization_digest ~ '^0x[0-9a-f]{64}$'),
  authority_identity_digest text CHECK (authority_identity_digest ~ '^0x[0-9a-f]{64}$'),
  authority_identity jsonb,
  session_expires_at_ms bigint,
  revoked_at_ms bigint CHECK (revoked_at_ms>=completed_at_ms),
  session_document jsonb,
  FOREIGN KEY(rp_id,credential_id) REFERENCES rest_wallet_credentials(rp_id,credential_id),
  CONSTRAINT rest_wallet_login_completion_shape CHECK ((
    (completed_at_ms IS NULL AND proof_digest IS NULL AND proof IS NULL AND session_token_hash IS NULL
      AND account_id IS NULL AND enrollment_id IS NULL AND credential_id IS NULL AND user_handle IS NULL
      AND authority_epoch IS NULL AND session_epoch IS NULL AND binding_id IS NULL AND binding_authorization_digest IS NULL
      AND authority_identity_digest IS NULL AND authority_identity IS NULL AND session_expires_at_ms IS NULL
      AND revoked_at_ms IS NULL AND session_document IS NULL)
    OR (completed_at_ms IS NOT NULL AND proof_digest IS NOT NULL AND session_token_hash IS NOT NULL
      AND account_id IS NOT NULL AND enrollment_id IS NOT NULL AND credential_id IS NOT NULL AND user_handle IS NOT NULL
      AND authority_epoch IS NOT NULL AND session_epoch IS NOT NULL AND binding_id IS NOT NULL AND binding_authorization_digest IS NOT NULL
      AND authority_identity_digest IS NOT NULL AND session_expires_at_ms=completed_at_ms+3600000
      AND length(credential_id) BETWEEN 1 AND 1364 AND credential_id ~ '^[A-Za-z0-9_-]+$' AND user_handle ~ '^[A-Za-z0-9_-]{43}$'
      AND jsonb_typeof(proof)='object' AND octet_length(proof::text)<=4096 AND proof->>'verificationDigest'=proof_digest
      AND proof->>'credentialId'=credential_id AND proof->>'userHandle'=user_handle
      AND jsonb_typeof(proof->'backupEligible')='boolean' AND jsonb_typeof(proof->'backedUp')='boolean'
      AND (proof->>'signCount')::bigint BETWEEN 0 AND 4294967295
      AND jsonb_typeof(authority_identity)='object' AND octet_length(authority_identity::text)<=8192
      AND authority_identity->>'accountId'=account_id AND authority_identity->>'bindingId'=binding_id
      AND authority_identity->>'bindingAuthorizationDigest'=binding_authorization_digest
      AND jsonb_typeof(session_document)='object' AND octet_length(session_document::text)<=4096
      AND session_document->>'id'=session_id::text AND session_document->>'loginId'=id::text
      AND session_document->>'accountId'=account_id AND session_document->>'enrollmentId'=enrollment_id::text
      AND session_document->>'rpId'=rp_id AND session_document->>'credentialId'=credential_id
      AND session_document->>'userHandle'=user_handle AND session_document->>'authorityEpoch'=authority_epoch::text
      AND session_document->>'sessionEpoch'=session_epoch::text AND session_document->>'bindingId'=binding_id
      AND session_document->>'bindingAuthorizationDigest'=binding_authorization_digest
      AND session_document->>'authorityIdentityDigest'=authority_identity_digest
      AND (session_document->>'createdAtMs')::bigint=completed_at_ms
      AND (session_document->>'expiresAtMs')::bigint=session_expires_at_ms
      AND ((revoked_at_ms IS NULL AND session_document->'revokedAtMs'='null'::jsonb)
        OR (revoked_at_ms IS NOT NULL AND (session_document->>'revokedAtMs')::bigint=revoked_at_ms)))
  ) IS TRUE)
);
CREATE INDEX rest_wallet_logins_retention ON rest_wallet_logins(retain_until_ms,id);
CREATE INDEX rest_wallet_logins_account ON rest_wallet_logins(account_id,session_expires_at_ms,id) WHERE completed_at_ms IS NOT NULL;

CREATE FUNCTION rest_wallet_login_transition() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF TG_OP='INSERT' THEN
    IF NEW.completed_at_ms IS NOT NULL THEN
      RAISE EXCEPTION 'Wallet login must begin with an anonymous unconsumed intent' USING ERRCODE='23514';
    END IF;
    RETURN NEW;
  END IF;
  IF TG_OP='DELETE' THEN
    IF OLD.retain_until_ms>floor(extract(epoch FROM clock_timestamp())*1000)::bigint THEN
      RAISE EXCEPTION 'Wallet login receipt retention has not elapsed' USING ERRCODE='23514';
    END IF;
    RETURN OLD;
  END IF;
  IF ROW(NEW.id,NEW.session_id,NEW.ceremony_id,NEW.rp_id,NEW.flow_token_hash,NEW.issued_at_ms,NEW.expires_at_ms,NEW.retain_until_ms,NEW.draft)
    IS DISTINCT FROM ROW(OLD.id,OLD.session_id,OLD.ceremony_id,OLD.rp_id,OLD.flow_token_hash,OLD.issued_at_ms,OLD.expires_at_ms,OLD.retain_until_ms,OLD.draft)
    OR (OLD.completed_at_ms IS NOT NULL AND
      ((to_jsonb(NEW)-'revoked_at_ms'-'session_document') IS DISTINCT FROM (to_jsonb(OLD)-'revoked_at_ms'-'session_document')
        OR (NEW.session_document-'revokedAtMs') IS DISTINCT FROM (OLD.session_document-'revokedAtMs')))
    OR (OLD.revoked_at_ms IS NOT NULL AND NEW.revoked_at_ms IS DISTINCT FROM OLD.revoked_at_ms) THEN
    RAISE EXCEPTION 'Wallet login intent and completed session are immutable' USING ERRCODE='23514';
  END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER rest_wallet_login_transition BEFORE INSERT OR UPDATE OR DELETE ON rest_wallet_logins
  FOR EACH ROW EXECUTE FUNCTION rest_wallet_login_transition();

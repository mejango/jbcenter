-- Release anonymous pending capacity at challenge expiry. Completed receipts keep their original retention.
CREATE OR REPLACE FUNCTION rest_wallet_login_transition() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF TG_OP='INSERT' THEN
    IF NEW.completed_at_ms IS NOT NULL THEN
      RAISE EXCEPTION 'Wallet login must begin with an anonymous unconsumed intent' USING ERRCODE='23514';
    END IF;
    RETURN NEW;
  END IF;
  IF TG_OP='DELETE' THEN
    IF OLD.retain_until_ms>floor(extract(epoch FROM clock_timestamp())*1000)::bigint
      AND (OLD.completed_at_ms IS NOT NULL OR OLD.expires_at_ms>floor(extract(epoch FROM clock_timestamp())*1000)::bigint) THEN
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

CREATE INDEX rest_wallet_logins_pending_expiry ON rest_wallet_logins(expires_at_ms,id) WHERE completed_at_ms IS NULL;
CREATE INDEX rest_wallet_enrollment_pending_expiry ON rest_wallet_enrollments(expires_at,id) WHERE state <> 'verified';
CREATE INDEX rest_wallet_ceremonies_pending_expiry ON rest_wallet_ceremonies(expires_at,id) WHERE consumed_at IS NULL;

-- Only unproved expired recovery can be removed. Accepted proof/activation remains immutable and durable.
CREATE OR REPLACE FUNCTION rest_wallet_recovery_transition() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF TG_OP='DELETE' THEN
    IF OLD.proof IS NOT NULL OR OLD.expires_at_ms>floor(extract(epoch FROM clock_timestamp())*1000)::bigint THEN
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

CREATE INDEX rest_wallet_recoveries_pending_expiry ON rest_wallet_recoveries(expires_at_ms,id) WHERE proof IS NULL;
CREATE INDEX rest_wallet_recoveries_proved_account ON rest_wallet_recoveries(account_id,id) WHERE proof IS NOT NULL;

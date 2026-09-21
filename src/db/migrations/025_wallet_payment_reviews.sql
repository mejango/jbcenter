-- Review receipts retain the original app incarnation and exact prepared operation.
-- References are logical: bounded cleanup never cascades over payment or nonce history.
CREATE TABLE rest_wallet_payment_reviews (
  id uuid PRIMARY KEY,
  account_id text NOT NULL CHECK (account_id ~ '^eip155:8453:0x[0-9a-f]{40}$'),
  principal_id text NOT NULL CHECK (length(principal_id) BETWEEN 1 AND 60),
  operation_id text UNIQUE NOT NULL CHECK (length(operation_id) BETWEEN 1 AND 192),
  preparation_key text NOT NULL CHECK (preparation_key ~ '^[!-~]{1,128}$'),
  input_digest text NOT NULL CHECK (input_digest ~ '^[0-9a-f]{64}$'),
  ceremony_id uuid UNIQUE NOT NULL,
  created_at_ms bigint NOT NULL CHECK (created_at_ms BETWEEN 1 AND 9007199164740991),
  expires_at_ms bigint NOT NULL CHECK (expires_at_ms>created_at_ms AND expires_at_ms<=created_at_ms+300000),
  retain_until_ms bigint NOT NULL CHECK (retain_until_ms>=expires_at_ms AND retain_until_ms<=expires_at_ms+86400000),
  draft jsonb NOT NULL CHECK ((jsonb_typeof(draft)='object' AND octet_length(draft::text)<=65536
    AND draft->>'version'='center-wallet-payment-review-v1' AND draft->>'id'=id::text
    AND draft->>'operationId'=operation_id AND draft->'authority'->>'accountId'=account_id
    AND 'app:'||(draft->'grant'->>'id')||':'||(draft->'grant'->>'incarnation')=principal_id
    AND draft->'grant'->>'accountId'=account_id AND draft->'ceremony'->>'id'=ceremony_id::text
    AND draft->'ceremony'->>'purpose'='payment' AND draft->'ceremony'->>'accountId'=account_id
    AND (draft->>'createdAtMs')::bigint=created_at_ms AND (draft->>'expiresAtMs')::bigint=expires_at_ms
    AND (draft->'ceremony'->>'expiresAt')::bigint=expires_at_ms) IS TRUE),
  status text NOT NULL DEFAULT 'pending' CHECK (status IN ('pending','approved','cancelled')),
  session_id uuid,
  proof_digest text CHECK (proof_digest ~ '^[0-9a-f]{64}$'),
  signature text CHECK (signature ~ '^0x[0-9a-f]+$' AND length(signature) BETWEEN 2 AND 4700 AND length(signature)%2=0),
  signed_commitment text CHECK (signed_commitment ~ '^0x[0-9a-f]{64}$'),
  approved_at_ms bigint,
  cancelled_at_ms bigint,
  CHECK ((
    (status='pending' AND session_id IS NULL AND proof_digest IS NULL AND signature IS NULL
      AND signed_commitment IS NULL AND approved_at_ms IS NULL AND cancelled_at_ms IS NULL)
    OR (status='approved' AND session_id IS NOT NULL AND proof_digest IS NOT NULL AND signature IS NOT NULL
      AND signed_commitment IS NOT NULL AND approved_at_ms IS NOT NULL AND approved_at_ms>=created_at_ms
      AND approved_at_ms<expires_at_ms AND cancelled_at_ms IS NULL)
    OR (status='cancelled' AND session_id IS NULL AND proof_digest IS NULL AND signature IS NULL
      AND signed_commitment IS NULL AND approved_at_ms IS NULL AND cancelled_at_ms IS NOT NULL
      AND cancelled_at_ms>=created_at_ms AND cancelled_at_ms<expires_at_ms)
  ) IS TRUE),
  UNIQUE(account_id,principal_id,preparation_key)
);
CREATE INDEX rest_wallet_payment_reviews_retention ON rest_wallet_payment_reviews(retain_until_ms,id);
CREATE INDEX rest_wallet_payment_reviews_account ON rest_wallet_payment_reviews(account_id,retain_until_ms,id);
CREATE INDEX rest_wallet_payment_reviews_session ON rest_wallet_payment_reviews(session_id) WHERE session_id IS NOT NULL;
CREATE FUNCTION rest_wallet_payment_review_transition() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF TG_OP='INSERT' THEN
    IF NEW.status<>'pending' THEN
      RAISE EXCEPTION 'Payment review must begin pending' USING ERRCODE='23514';
    END IF;
    RETURN NEW;
  END IF;
  IF TG_OP='DELETE' THEN
    IF OLD.retain_until_ms>floor(extract(epoch FROM clock_timestamp())*1000)::bigint THEN
      RAISE EXCEPTION 'Payment review retention has not elapsed' USING ERRCODE='23514';
    END IF;
    RETURN OLD;
  END IF;
  IF OLD.status<>'pending' OR NEW.status NOT IN ('approved','cancelled')
    OR (to_jsonb(NEW)-ARRAY['status','session_id','proof_digest','signature','signed_commitment','approved_at_ms','cancelled_at_ms'])
      IS DISTINCT FROM (to_jsonb(OLD)-ARRAY['status','session_id','proof_digest','signature','signed_commitment','approved_at_ms','cancelled_at_ms']) THEN
    RAISE EXCEPTION 'Payment review and original approval are immutable' USING ERRCODE='23514';
  END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER rest_wallet_payment_review_transition BEFORE INSERT OR UPDATE OR DELETE ON rest_wallet_payment_reviews
  FOR EACH ROW EXECUTE FUNCTION rest_wallet_payment_review_transition();

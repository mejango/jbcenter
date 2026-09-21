-- Application request keys and PKCE bind each immutable intent. Only a hash of an issued code
-- is retained. Losing the issuance response requires a new intent; no read API returns a code.
CREATE TABLE rest_wallet_handoffs (
  id text PRIMARY KEY CHECK (id ~ '^[A-Za-z0-9_-]{43}$'),
  request_digest text UNIQUE NOT NULL CHECK (request_digest ~ '^0x[0-9a-f]{64}$'),
  request jsonb NOT NULL CHECK (jsonb_typeof(request)='object' AND octet_length(request::text)<=8192),
  origin text NOT NULL REFERENCES rest_wallet_policy_apps(origin),
  state text NOT NULL DEFAULT 'prepared' CHECK (state IN ('prepared','issued','consumed')),
  created_at_ms bigint NOT NULL CHECK (created_at_ms>0 AND created_at_ms<=9007199254740991),
  expires_at_ms bigint NOT NULL CHECK (expires_at_ms>created_at_ms AND expires_at_ms<=created_at_ms+330000),
  retain_until_ms bigint NOT NULL CHECK (retain_until_ms>=expires_at_ms AND retain_until_ms<=expires_at_ms+86400000),
  -- Logical reference: independently bounded login cleanup must never cascade over or
  -- wait on this session's retained handoffs. Admission always revalidates the parent.
  session_id uuid,
  code_hash text UNIQUE CHECK (code_hash ~ '^0x[0-9a-f]{64}$'),
  issued_at_ms bigint,
  code_expires_at_ms bigint,
  consumed_at_ms bigint,
  exchange_digest text CHECK (exchange_digest ~ '^0x[0-9a-f]{64}$'),
  receipt_until_ms bigint,
  grant_document jsonb CHECK (jsonb_typeof(grant_document)='object' AND octet_length(grant_document::text)<=8192),
  CHECK (
    (state='prepared' AND session_id IS NULL AND code_hash IS NULL AND issued_at_ms IS NULL AND code_expires_at_ms IS NULL
      AND consumed_at_ms IS NULL AND exchange_digest IS NULL AND receipt_until_ms IS NULL AND grant_document IS NULL)
    OR (state='issued' AND session_id IS NOT NULL AND code_hash IS NOT NULL AND issued_at_ms IS NOT NULL AND code_expires_at_ms IS NOT NULL AND issued_at_ms>=created_at_ms
      AND issued_at_ms<expires_at_ms AND code_expires_at_ms>issued_at_ms AND code_expires_at_ms<=issued_at_ms+60000
      AND code_expires_at_ms<=expires_at_ms AND consumed_at_ms IS NULL AND exchange_digest IS NULL
      AND receipt_until_ms IS NULL AND grant_document IS NULL)
    OR (state='consumed' AND session_id IS NOT NULL AND code_hash IS NOT NULL AND issued_at_ms IS NOT NULL AND code_expires_at_ms IS NOT NULL
      AND consumed_at_ms IS NOT NULL AND receipt_until_ms IS NOT NULL AND issued_at_ms>=created_at_ms
      AND issued_at_ms<expires_at_ms AND code_expires_at_ms>issued_at_ms AND code_expires_at_ms<=issued_at_ms+60000
      AND code_expires_at_ms<=expires_at_ms AND consumed_at_ms>=issued_at_ms AND consumed_at_ms<code_expires_at_ms
      AND exchange_digest IS NOT NULL AND receipt_until_ms>consumed_at_ms AND receipt_until_ms<=retain_until_ms
      AND grant_document IS NOT NULL)
  )
);
CREATE INDEX rest_wallet_handoffs_retention ON rest_wallet_handoffs(retain_until_ms,id);
CREATE INDEX rest_wallet_handoffs_origin ON rest_wallet_handoffs(origin,retain_until_ms,id);
CREATE INDEX rest_wallet_handoffs_session ON rest_wallet_handoffs(session_id) WHERE session_id IS NOT NULL;

CREATE FUNCTION rest_wallet_handoff_immutable() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF TG_OP='INSERT' THEN
    IF NEW.state<>'prepared' THEN
      RAISE EXCEPTION 'Wallet handoff must begin with a prepared intent' USING ERRCODE='23514';
    END IF;
    RETURN NEW;
  END IF;
  IF TG_OP='DELETE' THEN
    IF OLD.retain_until_ms>floor(extract(epoch FROM clock_timestamp())*1000)::bigint THEN
      RAISE EXCEPTION 'Wallet handoff receipt retention has not elapsed' USING ERRCODE='23514';
    END IF;
    RETURN OLD;
  END IF;
  IF (to_jsonb(NEW)-ARRAY['state','session_id','code_hash','issued_at_ms','code_expires_at_ms','consumed_at_ms','exchange_digest','receipt_until_ms','grant_document'])
       IS DISTINCT FROM
     (to_jsonb(OLD)-ARRAY['state','session_id','code_hash','issued_at_ms','code_expires_at_ms','consumed_at_ms','exchange_digest','receipt_until_ms','grant_document'])
    OR NOT ((OLD.state='prepared' AND NEW.state='issued') OR (OLD.state='issued' AND NEW.state='consumed'))
    OR (OLD.state='issued' AND (NEW.session_id,NEW.code_hash,NEW.issued_at_ms,NEW.code_expires_at_ms)
        IS DISTINCT FROM (OLD.session_id,OLD.code_hash,OLD.issued_at_ms,OLD.code_expires_at_ms)) THEN
    RAISE EXCEPTION 'Wallet handoff tuple and consumed receipt are immutable' USING ERRCODE='23514';
  END IF;
  RETURN NEW;
END;
$$;
CREATE TRIGGER rest_wallet_handoffs_immutable BEFORE INSERT OR UPDATE OR DELETE ON rest_wallet_handoffs
  FOR EACH ROW EXECUTE FUNCTION rest_wallet_handoff_immutable();

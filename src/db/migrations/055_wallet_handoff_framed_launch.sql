-- A sign-in launched into a frame the app owns has no cookie to carry its browser-launch claim
-- (Center's cookies are SameSite=Lax and a cross-site frame gets none), so the verified launch
-- signature is kept on the prepared row for the framed approval to present. Only apps the
-- operator admits to frame ever write it. A prepared row takes the claim once; nothing else
-- about the tuple changes, and issuance still moves only prepared -> issued -> consumed.
ALTER TABLE rest_wallet_handoffs ADD COLUMN launch_signature text CHECK (launch_signature ~ '^0x[0-9a-f]{130}$');
CREATE OR REPLACE FUNCTION rest_wallet_handoff_immutable() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF TG_OP='INSERT' THEN
    IF NEW.state<>'prepared' OR NEW.launch_signature IS NOT NULL THEN
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
  IF OLD.state='prepared' AND NEW.state='prepared' THEN
    IF OLD.launch_signature IS NOT NULL OR NEW.launch_signature IS NULL
      OR (to_jsonb(NEW)-'launch_signature') IS DISTINCT FROM (to_jsonb(OLD)-'launch_signature') THEN
      RAISE EXCEPTION 'Wallet handoff tuple and consumed receipt are immutable' USING ERRCODE='23514';
    END IF;
    RETURN NEW;
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

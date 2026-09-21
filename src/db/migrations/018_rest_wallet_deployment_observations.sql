-- Read-only chain observations of the immutable signed winner. None of these fields grants
-- dispatch, changes the prepared/claimed/signed phase, or releases a lane/nonce/allocation.
-- This bounded finality shape is also checked for retained history, so nullable SQL comparisons
-- cannot replace a known finalized anchor with an incomplete later JSON value.
CREATE FUNCTION rest_wallet_deployment_finality_shape(value jsonb) RETURNS boolean LANGUAGE sql IMMUTABLE AS $$
  SELECT ((value->'finality'->>'state'='unknown' AND value->'finality'->'evidence'='null'::jsonb)
    OR (value->'finality'->>'state' IN ('finalized','unfinalized')
      AND jsonb_typeof(value->'finality'->'evidence')='object'
      AND ((value->'finality'->'evidence')-'chainId'-'blockNumber'-'blockHash'-'timestamp'-'source')='{}'::jsonb
      AND value->'finality'->'evidence'->'chainId'='8453'::jsonb
      AND value->'finality'->'evidence'->>'source'='onchain'
      AND value->'finality'->'evidence'->>'blockHash' ~ '^0x[0-9a-f]{64}$'
      AND value->'finality'->'evidence'->>'blockHash'<>'0x0000000000000000000000000000000000000000000000000000000000000000'
      AND value->'finality'->'evidence'->>'blockNumber' ~ '^(0|[1-9][0-9]{0,77})$'
      AND value->'finality'->'evidence'->>'timestamp' ~ '^(0|[1-9][0-9]{0,77})$'
      AND (value->'finality'->'evidence'->>'timestamp')::numeric<=
        115792089237316195423570985008687907853269984665640564039457584007913129639935
      AND (value->'finality'->'evidence'->>'blockNumber')::numeric<=(value->'head'->>'blockNumber')::numeric
      AND ((value->'finality'->>'state'='finalized')=
        ((value->'finality'->'evidence'->>'blockNumber')::numeric>=(value->'transaction'->'receipt'->'block'->>'blockNumber')::numeric)))) IS TRUE
$$;
ALTER TABLE rest_wallet_deployments
  ADD COLUMN observation jsonb,
  ADD COLUMN observation_digest text CHECK (observation_digest ~ '^[0-9a-f]{64}$'),
  ADD COLUMN observation_saved_at bigint CHECK (observation_saved_at>0 AND observation_saved_at<=9007199254740991),
  ADD COLUMN historical_canonical_observation jsonb,
  -- High watermark of provider observations only, not a claim that this height is canonical now.
  ADD COLUMN highest_observed_head numeric(78,0) CHECK (highest_observed_head>=0 AND highest_observed_head<=
    115792089237316195423570985008687907853269984665640564039457584007913129639935),
  ADD CONSTRAINT rest_wallet_deployment_observation_shape CHECK ((
    (observation IS NULL AND observation_digest IS NULL AND observation_saved_at IS NULL
      AND historical_canonical_observation IS NULL AND highest_observed_head IS NULL)
    OR (state='signed' AND observation IS NOT NULL AND observation_digest IS NOT NULL AND observation_saved_at IS NOT NULL
      AND jsonb_typeof(observation)='object' AND octet_length(observation::text)<=16384
      AND observation->>'version'='center-wallet-deployment-observation-v1'
      AND observation->>'operationId'=id::text AND lower(observation->>'transactionHash')=transaction_hash
      AND lower(observation->>'templateCommitment')=template_commitment
      AND observation->'dispatchEligible'='false'::jsonb
      AND (observation->>'observedAt')::bigint>0 AND (observation->>'observedAt')::bigint<=observation_saved_at
      AND jsonb_typeof(observation->'transaction')='object' AND jsonb_typeof(observation->'finality')='object'
      AND jsonb_typeof(observation->'wallet')='object' AND jsonb_typeof(observation->'fees')='object'
      AND observation->'transaction'->>'state' IN ('not-observed','pending','canonical-success','canonical-revert','reorged','nonce-conflict','unknown')
      AND observation->'finality'->>'state' IN ('finalized','unfinalized','unknown')
      AND rest_wallet_deployment_finality_shape(observation)
      AND (observation->'transaction'->>'state' NOT IN ('canonical-success','canonical-revert')
        OR observation->'transaction'->'receipt'->>'status'=CASE observation->'transaction'->>'state' WHEN 'canonical-success' THEN 'success' ELSE 'reverted' END)
      AND observation->'wallet'->>'state' IN ('undeployed','verified','unknown')
      AND lower(observation->'wallet'->>'address')=lower(template->>'predictedSafe')
      AND lower(observation->'wallet'->>'initializerHash')=lower(template->>'initializerHash')
      AND ((observation->'head'='null'::jsonb) OR (jsonb_typeof(observation->'head')='object'
        AND (observation->'head'->>'chainId')::integer=8453 AND highest_observed_head IS NOT NULL
        AND (observation->'head'->>'blockNumber')::numeric<=highest_observed_head)))) IS TRUE),
  ADD CONSTRAINT rest_wallet_deployment_historical_observation_shape CHECK ((
    historical_canonical_observation IS NULL OR (state='signed'
      AND jsonb_typeof(historical_canonical_observation)='object' AND octet_length(historical_canonical_observation::text)<=16384
      AND historical_canonical_observation->>'version'='center-wallet-deployment-observation-v1'
      AND historical_canonical_observation->>'operationId'=id::text
      AND lower(historical_canonical_observation->>'transactionHash')=transaction_hash
      AND lower(historical_canonical_observation->>'templateCommitment')=template_commitment
      AND historical_canonical_observation->'dispatchEligible'='false'::jsonb
      AND historical_canonical_observation->'transaction'->>'state' IN ('canonical-success','canonical-revert')
      AND historical_canonical_observation->'transaction'->'receipt'->>'status'=
        CASE historical_canonical_observation->'transaction'->>'state' WHEN 'canonical-success' THEN 'success' ELSE 'reverted' END
      AND rest_wallet_deployment_finality_shape(historical_canonical_observation)
      AND jsonb_typeof(historical_canonical_observation->'transaction'->'receipt')='object'
      AND jsonb_typeof(historical_canonical_observation->'head')='object' AND highest_observed_head IS NOT NULL
      AND (historical_canonical_observation->'head'->>'blockNumber')::numeric<=highest_observed_head
      AND (historical_canonical_observation->>'observedAt')::bigint<=(observation->>'observedAt')::bigint)) IS TRUE);

CREATE INDEX rest_wallet_deployment_unresolved_recovery ON rest_wallet_deployments(created_at,id)
  WHERE state IN ('claimed','signed');

-- Protect the observation CAS and retained evidence against accidental later SQL paths too.
CREATE FUNCTION rest_wallet_deployment_observation_transition() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE
  canonical boolean;
  positive boolean;
  prior_finalized boolean;
BEGIN
  IF (NEW.observation,NEW.observation_digest,NEW.observation_saved_at,NEW.historical_canonical_observation,NEW.highest_observed_head)
    IS NOT DISTINCT FROM (OLD.observation,OLD.observation_digest,OLD.observation_saved_at,OLD.historical_canonical_observation,OLD.highest_observed_head)
    THEN
      IF OLD.state='signed' AND NEW.state='signed' AND NEW.revision<>OLD.revision
        THEN RAISE EXCEPTION 'Signed revision changes only with a new observation' USING ERRCODE='23514'; END IF;
      RETURN NEW;
    END IF;
  IF OLD.state<>'signed' OR NEW.state<>'signed' OR NEW.revision<>OLD.revision+1
    OR NEW.observation IS NULL OR NEW.observation IS NOT DISTINCT FROM OLD.observation
    OR (OLD.observation IS NOT NULL AND ((NEW.observation->>'observedAt')::bigint<(OLD.observation->>'observedAt')::bigint
      OR NEW.observation_saved_at<OLD.observation_saved_at))
    OR NEW.highest_observed_head IS DISTINCT FROM greatest(OLD.highest_observed_head,(NEW.observation->'head'->>'blockNumber')::numeric)
    THEN RAISE EXCEPTION 'Deployment observation must advance by an exact signed revision' USING ERRCODE='23514'; END IF;
  canonical := NEW.observation->'transaction'->>'state' IN ('canonical-success','canonical-revert');
  positive := canonical OR NEW.observation->'wallet'->>'state'='verified' OR NEW.observation->'finality'->>'state'='finalized';
  IF positive AND OLD.highest_observed_head IS NOT NULL
    AND (NEW.observation->'head'->>'blockNumber')::numeric<OLD.highest_observed_head
    THEN RAISE EXCEPTION 'Lower provider head cannot replace stronger receipt evidence as success' USING ERRCODE='23514'; END IF;
  IF OLD.historical_canonical_observation IS NOT NULL AND NEW.historical_canonical_observation IS NULL
    THEN RAISE EXCEPTION 'Historical canonical receipt must be retained' USING ERRCODE='23514'; END IF;
  IF NOT canonical AND NEW.historical_canonical_observation IS DISTINCT FROM OLD.historical_canonical_observation
    THEN RAISE EXCEPTION 'Unknown observation cannot rewrite historical receipt evidence' USING ERRCODE='23514'; END IF;
  prior_finalized := OLD.historical_canonical_observation->'finality'->>'state'='finalized';
  IF prior_finalized AND NEW.observation->'transaction'->>'state'='nonce-conflict'
    THEN RAISE EXCEPTION 'Finalized nonce contradiction must remain unknown' USING ERRCODE='23514'; END IF;
  IF canonical AND prior_finalized THEN
    IF NEW.observation->'transaction'->>'state' IS DISTINCT FROM OLD.historical_canonical_observation->'transaction'->>'state'
      OR NEW.observation->'transaction'->'receipt'
      IS DISTINCT FROM OLD.historical_canonical_observation->'transaction'->'receipt'
      OR NEW.observation->'finality'->>'state'='unfinalized'
      OR (NEW.observation->'finality'->>'state'='finalized' AND
        ((NEW.observation->'finality'->'evidence'->>'blockNumber')::numeric>=(OLD.historical_canonical_observation->'finality'->'evidence'->>'blockNumber')::numeric
        AND ((NEW.observation->'finality'->'evidence'->>'blockNumber')::numeric<>(OLD.historical_canonical_observation->'finality'->'evidence'->>'blockNumber')::numeric
          OR NEW.observation->'finality'->'evidence' IS NOT DISTINCT FROM OLD.historical_canonical_observation->'finality'->'evidence')) IS NOT TRUE)
      THEN RAISE EXCEPTION 'Finalized receipt contradiction must remain unknown' USING ERRCODE='23514'; END IF;
    IF NEW.observation->'finality'->>'state'='unknown' AND NEW.historical_canonical_observation IS DISTINCT FROM OLD.historical_canonical_observation
      THEN RAISE EXCEPTION 'Missing finality cannot erase historical finalized evidence' USING ERRCODE='23514'; END IF;
  END IF;
  IF canonical AND (prior_finalized IS NOT TRUE OR NEW.observation->'finality'->>'state'='finalized')
    AND NEW.historical_canonical_observation IS DISTINCT FROM NEW.observation
    THEN RAISE EXCEPTION 'Canonical observation must retain its latest strongest receipt' USING ERRCODE='23514'; END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER rest_wallet_deployment_observation_transition BEFORE UPDATE ON rest_wallet_deployments
  FOR EACH ROW EXECUTE FUNCTION rest_wallet_deployment_observation_transition();

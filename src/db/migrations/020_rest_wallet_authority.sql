-- Canonical authority readiness extends the existing epoch row. No login, public issuance,
-- worker, deployment dispatch or funding capability is introduced here.
ALTER TABLE rest_wallet_authority
  ADD COLUMN revision bigint NOT NULL DEFAULT 0 CHECK (revision>=0),
  ADD COLUMN snapshot jsonb,
  ADD COLUMN observation_digest text CHECK (observation_digest ~ '^[0-9a-f]{64}$'),
  ADD COLUMN ready_until_ms bigint CHECK (ready_until_ms BETWEEN 1 AND 9007199254740991),
  ADD COLUMN binding_id text CHECK (binding_id ~ '^0x[0-9a-f]{64}$'),
  ADD COLUMN binding_authorization_digest text CHECK (binding_authorization_digest ~ '^0x[0-9a-f]{64}$'),
  ADD CONSTRAINT rest_wallet_authority_snapshot_shape CHECK ((
    (snapshot IS NULL AND observation_digest IS NULL AND ready_until_ms IS NULL
      AND binding_id IS NULL AND binding_authorization_digest IS NULL)
    OR (jsonb_typeof(snapshot)='object' AND octet_length(snapshot::text)<=32768
      AND snapshot->>'version'='center-wallet-authority-snapshot-v1'
      AND snapshot->>'accountId'=account_id AND snapshot->>'revision'=revision::text
      AND snapshot->>'authorityEpoch'=authority_epoch::text AND snapshot->>'sessionEpoch'=session_epoch::text
      AND jsonb_typeof(snapshot->'bootstrapRequired')='boolean'
      AND snapshot->>'readiness' IN ('verified','changed','unknown','fenced')
      AND (snapshot->>'updatedAtMs')::bigint BETWEEN 1 AND 9007199254740991
      AND (snapshot->'highestObservedBlock'='null'::jsonb OR
        (jsonb_typeof(snapshot->'highestObservedBlock')='string'
          AND snapshot->>'highestObservedBlock' ~ '^(0|[1-9][0-9]{0,77})$'
          AND (snapshot->>'highestObservedBlock')::numeric<=
            115792089237316195423570985008687907853269984665640564039457584007913129639935))
      AND (snapshot->'latestObservation'='null'::jsonb AND observation_digest IS NULL
        OR (jsonb_typeof(snapshot->'latestObservation')='object' AND observation_digest IS NOT NULL
          AND snapshot->'latestObservation'->>'version'='center-wallet-authority-observation-v1'
          AND snapshot->'latestObservation'->>'accountId'=account_id
          AND snapshot->'latestObservation'->>'contextDigest' ~ '^0x[0-9a-f]{64}$'
          AND (snapshot->'latestObservation'->>'observedAtMs')::bigint BETWEEN 1 AND (snapshot->>'updatedAtMs')::bigint))
      AND (snapshot->'identity'='null'::jsonb AND binding_id IS NULL AND binding_authorization_digest IS NULL
        OR (jsonb_typeof(snapshot->'identity')='object' AND snapshot->'identity'->>'accountId'=account_id
          AND binding_id IS NOT NULL AND binding_authorization_digest IS NOT NULL
          AND snapshot->'identity'->>'bindingId'=binding_id
          AND snapshot->'identity'->>'bindingAuthorizationDigest'=binding_authorization_digest))
      AND (snapshot->'historicalVerifiedIdentity'='null'::jsonb OR
        (jsonb_typeof(snapshot->'historicalVerifiedIdentity')='object' AND snapshot->'historicalVerifiedIdentity'->>'accountId'=account_id))
      AND (snapshot->'activeFence'='null'::jsonb OR
        (jsonb_typeof(snapshot->'activeFence')='object' AND snapshot->>'readiness'='fenced'))
      AND (snapshot->'lastClosedFence'='null'::jsonb OR jsonb_typeof(snapshot->'lastClosedFence')='object')
      AND ((snapshot->>'readiness'='verified' AND snapshot->'bootstrapRequired'='false'::jsonb
          AND snapshot->'activeFence'='null'::jsonb AND jsonb_typeof(snapshot->'identity')='object'
          AND jsonb_typeof(snapshot->'acceptedAnchor')='object'
          AND snapshot->'acceptedAnchor'->'chainId'='8453'::jsonb
          AND snapshot->'acceptedAnchor'->>'source'='onchain'
          AND snapshot->'acceptedAnchor'->>'blockHash' ~ '^0x[0-9a-f]{64}$'
          AND snapshot->'acceptedAnchor'->>'blockNumber' ~ '^(0|[1-9][0-9]{0,77})$'
          AND snapshot->'acceptedAnchor'->>'timestamp' ~ '^(0|[1-9][0-9]{0,77})$'
          AND snapshot->'identity'=snapshot->'historicalVerifiedIdentity'
          AND snapshot->'identity'=snapshot->'latestObservation'->'identity'
          AND snapshot->'acceptedAnchor'=snapshot->'latestObservation'->'head'
          AND snapshot->'latestObservation'->>'eligibility'='matched'
          AND ready_until_ms IS NOT NULL AND (snapshot->>'validUntilMs')::bigint=ready_until_ms
          AND ready_until_ms=(snapshot->'latestObservation'->>'validUntilMs')::bigint
          AND ready_until_ms>(snapshot->'latestObservation'->>'observedAtMs')::bigint
          AND ready_until_ms<=(snapshot->'latestObservation'->>'observedAtMs')::bigint+30000
          AND ready_until_ms<=(snapshot->'acceptedAnchor'->>'timestamp')::numeric*1000+300000)
        OR (snapshot->>'readiness'<>'verified' AND ready_until_ms IS NULL AND snapshot->'validUntilMs'='null'::jsonb))
    )) IS TRUE);

-- Existing epoch-only rows remain unready. Their first complete bootstrap must preserve and
-- advance both positive epochs; a NULL document is never verified authority.
CREATE FUNCTION rest_wallet_authority_transition() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE
  epochs_changed boolean;
  saved_ms bigint;
BEGIN
  IF TG_OP='DELETE' THEN
    RAISE EXCEPTION 'Wallet authority epochs and history are retained' USING ERRCODE='23514';
  END IF;
  IF NEW.account_id<>OLD.account_id OR NEW.authority_epoch<OLD.authority_epoch OR NEW.session_epoch<OLD.session_epoch
    OR NEW.updated_at<OLD.updated_at THEN
    RAISE EXCEPTION 'Wallet authority identity and epochs cannot move backwards' USING ERRCODE='23514';
  END IF;
  epochs_changed := NEW.authority_epoch<>OLD.authority_epoch OR NEW.session_epoch<>OLD.session_epoch;
  IF epochs_changed AND NEW.snapshot IS NOT DISTINCT FROM OLD.snapshot THEN
    -- Compatibility with the existing account-locked advanceEpochs primitive. It never invents
    -- a chain observation or renews readiness. Revision fences any in-flight canonical refresh.
    IF NEW.revision<>OLD.revision OR NEW.observation_digest IS DISTINCT FROM OLD.observation_digest
      OR NEW.ready_until_ms IS DISTINCT FROM OLD.ready_until_ms OR NEW.binding_id IS DISTINCT FROM OLD.binding_id
      OR NEW.binding_authorization_digest IS DISTINCT FROM OLD.binding_authorization_digest THEN
      RAISE EXCEPTION 'Epoch-only updates cannot rewrite canonical evidence' USING ERRCODE='23514';
    END IF;
    NEW.revision := OLD.revision+1;
    IF NEW.snapshot IS NOT NULL THEN
      saved_ms := GREATEST((OLD.snapshot->>'updatedAtMs')::bigint,floor(extract(epoch FROM clock_timestamp())*1000)::bigint);
      NEW.snapshot := jsonb_set(jsonb_set(jsonb_set(jsonb_set(NEW.snapshot,
        '{revision}',to_jsonb(NEW.revision::text)),'{authorityEpoch}',to_jsonb(NEW.authority_epoch::text)),
        '{sessionEpoch}',to_jsonb(NEW.session_epoch::text)),'{updatedAtMs}',to_jsonb(saved_ms));
      IF NEW.authority_epoch<>OLD.authority_epoch THEN
        NEW.snapshot := jsonb_set(jsonb_set(NEW.snapshot,'{readiness}',
          to_jsonb(CASE WHEN NEW.snapshot->'activeFence'='null'::jsonb THEN 'unknown'::text ELSE 'fenced'::text END)),
          '{validUntilMs}','null'::jsonb);
        NEW.ready_until_ms := NULL;
      END IF;
    END IF;
    RETURN NEW;
  END IF;
  IF NEW.snapshot IS NOT DISTINCT FROM OLD.snapshot THEN
    IF NEW.revision<>OLD.revision OR NEW.observation_digest IS DISTINCT FROM OLD.observation_digest
      OR NEW.ready_until_ms IS DISTINCT FROM OLD.ready_until_ms OR NEW.binding_id IS DISTINCT FROM OLD.binding_id
      OR NEW.binding_authorization_digest IS DISTINCT FROM OLD.binding_authorization_digest THEN
      RAISE EXCEPTION 'Authority evidence metadata cannot change independently' USING ERRCODE='23514';
    END IF;
    RETURN NEW;
  END IF;
  IF NEW.snapshot IS NULL OR NEW.revision<>OLD.revision+1
    OR NEW.observation_digest IS NOT DISTINCT FROM OLD.observation_digest
    OR (OLD.snapshot IS NOT NULL AND (NEW.snapshot->>'updatedAtMs')::bigint<(OLD.snapshot->>'updatedAtMs')::bigint)
    OR (OLD.snapshot->'bootstrapRequired'='false'::jsonb AND NEW.snapshot->'bootstrapRequired'<>'false'::jsonb)
    OR (OLD.snapshot->'historicalVerifiedIdentity'<>'null'::jsonb AND NEW.snapshot->'historicalVerifiedIdentity'='null'::jsonb)
    OR (OLD.snapshot->'lastClosedFence'<>'null'::jsonb AND NEW.snapshot->'lastClosedFence'='null'::jsonb) THEN
    RAISE EXCEPTION 'Canonical authority requires a fresh exact revision and retained evidence' USING ERRCODE='23514';
  END IF;
  IF (OLD.snapshot IS NULL OR OLD.snapshot->'bootstrapRequired'='true'::jsonb)
    AND NEW.snapshot->'bootstrapRequired'='false'::jsonb
    AND (NEW.authority_epoch<>OLD.authority_epoch+1 OR NEW.session_epoch<>OLD.session_epoch+1) THEN
    RAISE EXCEPTION 'Authority bootstrap advances both existing epochs exactly once' USING ERRCODE='23514';
  END IF;
  IF jsonb_typeof(OLD.snapshot->'highestObservedBlock')='string' AND
    (jsonb_typeof(NEW.snapshot->'highestObservedBlock') IS DISTINCT FROM 'string'
      OR (NEW.snapshot->>'highestObservedBlock')::numeric<(OLD.snapshot->>'highestObservedBlock')::numeric) THEN
    RAISE EXCEPTION 'Observed authority height cannot be erased or lowered' USING ERRCODE='23514';
  END IF;
  IF jsonb_typeof(OLD.snapshot->'acceptedAnchor')='object'
    AND jsonb_typeof(NEW.snapshot->'acceptedAnchor') IS DISTINCT FROM 'object' THEN
    RAISE EXCEPTION 'Accepted authority anchor must remain available for rechecking' USING ERRCODE='23514';
  END IF;
  IF jsonb_typeof(OLD.snapshot->'activeFence')='object' THEN
    IF NEW.snapshot->'activeFence'='null'::jsonb THEN
      IF NEW.snapshot->>'readiness'<>'verified' OR NEW.snapshot->'lastClosedFence' IS DISTINCT FROM OLD.snapshot->'activeFence' THEN
        RAISE EXCEPTION 'Fence recovery retains the exact closed episode' USING ERRCODE='23514';
      END IF;
    ELSIF ((NEW.snapshot->'activeFence')-'recoveryAnchor') IS DISTINCT FROM ((OLD.snapshot->'activeFence')-'recoveryAnchor') THEN
      RAISE EXCEPTION 'Active authority fence episode is latched until verified recovery' USING ERRCODE='23514';
    END IF;
  END IF;
  IF OLD.snapshot IS NOT NULL AND NEW.snapshot->'lastClosedFence' IS DISTINCT FROM OLD.snapshot->'lastClosedFence'
    AND (jsonb_typeof(OLD.snapshot->'activeFence')='object' AND NEW.snapshot->'activeFence'='null'::jsonb
      AND NEW.snapshot->'lastClosedFence' IS NOT DISTINCT FROM OLD.snapshot->'activeFence'
      AND NEW.snapshot->>'readiness'='verified') IS NOT TRUE THEN
    RAISE EXCEPTION 'Closed authority fence history changes only when a new episode closes' USING ERRCODE='23514';
  END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER rest_wallet_authority_transition BEFORE UPDATE OR DELETE ON rest_wallet_authority
  FOR EACH ROW EXECUTE FUNCTION rest_wallet_authority_transition();

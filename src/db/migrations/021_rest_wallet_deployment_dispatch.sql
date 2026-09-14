-- Explicit experimental local-Anvil delivery attempts for the existing immutable signed winner.
-- Accepted means only that the transport returned the exact hash. No row releases the sender lane,
-- permanent allocation, reserved nonce or retained receipt history; Base dispatch remains closed.
CREATE TABLE rest_wallet_deployment_dispatches (
  operation_id uuid PRIMARY KEY REFERENCES rest_wallet_deployments(id) ON DELETE RESTRICT,
  transaction_hash text NOT NULL CHECK (transaction_hash ~ '^0x[0-9a-f]{64}$'),
  template_commitment text NOT NULL CHECK (template_commitment ~ '^0x[0-9a-f]{64}$'),
  revision bigint NOT NULL CHECK (revision>0 AND revision<=9007199254740991),
  attempts integer NOT NULL CHECK (attempts BETWEEN 1 AND 8),
  status text NOT NULL CHECK (status IN ('in-flight','accepted','unknown')),
  lease_token uuid NOT NULL,
  lease_until bigint NOT NULL,
  admission jsonb NOT NULL,
  admission_digest text NOT NULL CHECK (admission_digest ~ '^[0-9a-f]{64}$'),
  claimed_at bigint NOT NULL CHECK (claimed_at>0 AND claimed_at<=9007199254740991),
  settled_at bigint,
  next_attempt_at bigint NOT NULL CHECK (next_attempt_at<=9007199254740991),
  CHECK (lease_until>claimed_at AND lease_until<=claimed_at+15000 AND next_attempt_at=lease_until+1000),
  CHECK ((status='in-flight' AND settled_at IS NULL) OR
    (status IN ('accepted','unknown') AND settled_at IS NOT NULL AND settled_at>=claimed_at AND settled_at<lease_until)),
  CHECK ((jsonb_typeof(admission)='object' AND octet_length(admission::text)<=4096
    AND (admission-'version'-'operationId'-'poolConfigurationDigest'-'templateCommitment'-'transactionHash'-'operationRevision'
      -'observationDigest'-'environment'-'observedAt'-'expiresAt'-'balanceWei'-'maximumExecutionCost'-'feeScope'-'baseTotalAffordability')='{}'::jsonb
    AND admission->>'version'='center-wallet-deployment-local-admission-v1'
    AND admission->>'operationId'=operation_id::text AND admission->>'transactionHash'=transaction_hash
    AND admission->>'templateCommitment'=template_commitment
    AND admission->>'feeScope'='local-execution-only' AND admission->>'baseTotalAffordability'='unknown'
    AND admission->>'poolConfigurationDigest' ~ '^[0-9a-f]{64}$' AND admission->>'observationDigest' ~ '^[0-9a-f]{64}$'
    AND (admission->>'operationRevision')::bigint>0 AND (admission->>'operationRevision')::bigint<=9007199254740991
    AND jsonb_typeof(admission->'environment')='object'
    AND ((admission->'environment')-'kind'-'genesisHash'-'head')='{}'::jsonb
    AND admission->'environment'->>'kind'='unforked-anvil'
    AND admission->'environment'->>'genesisHash' ~ '^0x[0-9a-f]{64}$'
    AND admission->'environment'->>'genesisHash'<>'0x0000000000000000000000000000000000000000000000000000000000000000'
    AND jsonb_typeof(admission->'environment'->'head')='object'
    AND (admission->>'observedAt')::bigint>0 AND (admission->>'observedAt')::bigint<=claimed_at
    AND (admission->>'expiresAt')::bigint>claimed_at AND (admission->>'expiresAt')::bigint>=lease_until
    AND (admission->>'expiresAt')::bigint<=(admission->>'observedAt')::bigint+5000
    AND admission->>'balanceWei' ~ '^(0|[1-9][0-9]{0,77})$'
    AND admission->>'maximumExecutionCost' ~ '^[1-9][0-9]{0,77}$'
    AND (admission->>'balanceWei')::numeric<2::numeric^256
    AND (admission->>'maximumExecutionCost')::numeric<2::numeric^256) IS TRUE)
);

CREATE FUNCTION rest_wallet_deployment_dispatch_transition() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE
  operation rest_wallet_deployments%ROWTYPE;
  allocation rest_wallet_deployment_pools%ROWTYPE;
  now_ms bigint := floor(extract(epoch FROM clock_timestamp())*1000)::bigint;
BEGIN
  IF TG_OP='DELETE' THEN RAISE EXCEPTION 'Dispatch liability is permanent' USING ERRCODE='23514'; END IF;
  IF TG_OP='UPDATE' AND NEW IS NOT DISTINCT FROM OLD THEN RETURN NEW; END IF;
  IF TG_OP='UPDATE' AND (NEW.operation_id,NEW.transaction_hash,NEW.template_commitment)
    IS DISTINCT FROM (OLD.operation_id,OLD.transaction_hash,OLD.template_commitment)
    THEN RAISE EXCEPTION 'Dispatch signed winner is immutable' USING ERRCODE='23514'; END IF;
  IF TG_OP='INSERT' AND (NEW.revision<>1 OR NEW.attempts<>1 OR NEW.status<>'in-flight')
    THEN RAISE EXCEPTION 'Dispatch begins with one fenced attempt' USING ERRCODE='23514'; END IF;
  IF TG_OP='UPDATE' AND NEW.revision<>OLD.revision+1
    THEN RAISE EXCEPTION 'Dispatch revision must advance exactly once' USING ERRCODE='23514'; END IF;
  IF NEW.status='in-flight' THEN
    IF TG_OP='UPDATE' AND (OLD.next_attempt_at>now_ms OR NEW.attempts<>OLD.attempts+1
      OR NEW.lease_token=OLD.lease_token OR NEW.admission_digest=OLD.admission_digest OR NEW.claimed_at<OLD.next_attempt_at)
      THEN RAISE EXCEPTION 'Dispatch retry requires a new bounded lease after cooldown' USING ERRCODE='23514'; END IF;
    SELECT * INTO operation FROM rest_wallet_deployments WHERE id=NEW.operation_id;
    SELECT * INTO allocation FROM rest_wallet_deployment_pools WHERE id=operation.pool_id;
    IF (operation.state='signed' AND allocation.state='active' AND allocation.active_operation_id=operation.id
      AND operation.transaction_hash=NEW.transaction_hash AND operation.template_commitment=NEW.template_commitment
      AND NEW.admission->>'poolConfigurationDigest'=allocation.configuration_digest
      AND (NEW.admission->>'operationRevision')::bigint=operation.revision
      AND NEW.admission->>'observationDigest'=operation.observation_digest
      AND NEW.admission->'environment'->'head'=operation.observation->'head'
      AND (operation.observation->'head'->>'blockNumber')::numeric>=operation.highest_observed_head
      AND operation.observation->'transaction'->>'state'='not-observed'
      AND operation.observation->'wallet'->>'state'='undeployed'
      AND operation.observation->'transaction'->'nonce'->>'confirmed'=operation.nonce::text
      AND operation.observation->'transaction'->'nonce'->>'pending'=operation.nonce::text
      AND operation.observation->'finality'->>'state'='unknown'
      AND (operation.historical_canonical_observation IS NULL OR operation.historical_canonical_observation->'finality'->>'state'<>'finalized')
      AND (NEW.admission->>'observedAt')::bigint>=(operation.observation->>'observedAt')::bigint
      AND (NEW.admission->>'expiresAt')::bigint<=(operation.observation->>'observedAt')::bigint+
        (allocation.configuration->'policy'->>'maximumObservationAgeMs')::bigint
      AND (NEW.admission->>'expiresAt')::numeric<=((operation.observation->'head'->>'timestamp')::numeric+300)*1000
      AND (NEW.admission->>'balanceWei')::numeric>=allocation.allocation_wei
      AND (NEW.admission->>'maximumExecutionCost')::numeric=operation.maximum_execution_cost
      AND operation.maximum_execution_cost<=allocation.allocation_wei
      AND NEW.claimed_at<=now_ms AND NEW.lease_until>now_ms) IS NOT TRUE
      THEN RAISE EXCEPTION 'Dispatch requires fresh matching internal local admission' USING ERRCODE='23514'; END IF;
  ELSE
    IF TG_OP<>'UPDATE' OR OLD.status<>'in-flight' OR OLD.lease_until<=now_ms OR NEW.settled_at>now_ms
      OR (NEW.attempts,NEW.lease_token,NEW.lease_until,NEW.admission,NEW.admission_digest,NEW.claimed_at,NEW.next_attempt_at)
      IS DISTINCT FROM (OLD.attempts,OLD.lease_token,OLD.lease_until,OLD.admission,OLD.admission_digest,OLD.claimed_at,OLD.next_attempt_at)
      THEN RAISE EXCEPTION 'Only the current live dispatch fence can settle a transport response' USING ERRCODE='23514'; END IF;
  END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER rest_wallet_deployment_dispatch_transition BEFORE INSERT OR UPDATE OR DELETE ON rest_wallet_deployment_dispatches
  FOR EACH ROW EXECUTE FUNCTION rest_wallet_deployment_dispatch_transition();

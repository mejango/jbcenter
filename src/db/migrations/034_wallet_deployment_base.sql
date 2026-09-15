-- Hosted Base creation: a qualified Base environment beside the local one, complete verified
-- receipt fees, a reserved admission, and an allocation-exceeded fence that retains an actual
-- finalized debit above the allocation instead of hiding it. No lane is released without a receipt.
CREATE FUNCTION rest_wallet_deployment_environment_shape(e jsonb) RETURNS boolean LANGUAGE sql IMMUTABLE AS $$
 SELECT (jsonb_typeof(e)='object' AND e->>'genesisHash' ~ '^0x[0-9a-f]{64}$'
  AND (((e-'kind'-'genesisHash'-'instanceId')='{}'::jsonb AND e->>'kind'='unforked-anvil' AND e->>'instanceId' ~ '^0x[0-9a-f]{64}$')
    OR ((e-'kind'-'genesisHash')='{}'::jsonb AND e->>'kind'='base-mainnet'))) IS TRUE
$$;
CREATE OR REPLACE FUNCTION rest_wallet_deployment_accounting_shape(a jsonb, allocation numeric) RETURNS boolean LANGUAGE sql IMMUTABLE AS $$
 SELECT (a IS NULL OR (jsonb_typeof(a)='object' AND octet_length(a::text)<=4096
  AND (a-'version'-'environment'-'initialHead'-'initialNonce'-'spentWei'-'sequence'-'nextNonce'-'lastSettlementId'-'lastSettlementAnchor'-'fence')='{}'::jsonb
  AND a->>'version'='center-wallet-deployment-accounting-v1'
  AND rest_wallet_deployment_environment_shape(a->'environment')
  AND jsonb_typeof(a->'initialHead')='object' AND a->'initialHead'->'chainId'='8453'::jsonb
  AND a->'initialHead'->>'blockNumber' ~ '^(0|[1-9][0-9]{0,77})$'
  AND a->'initialHead'->>'blockHash' ~ '^0x[0-9a-f]{64}$'
  AND a->>'initialNonce' ~ '^(0|[1-9][0-9]{0,15})$' AND a->>'nextNonce' ~ '^(0|[1-9][0-9]{0,15})$'
  AND a->>'spentWei' ~ '^(0|[1-9][0-9]{0,77})$' AND a->>'sequence' ~ '^(0|[1-9][0-9]{0,15})$'
  AND (a->>'nextNonce')::numeric=(a->>'initialNonce')::numeric+(a->>'sequence')::numeric
  AND (a->>'nextNonce')::numeric<=9007199254740991
  AND ((a->>'spentWei')::numeric<=allocation OR a->'fence'->>'reason'='allocation-exceeded')
  AND (((a->>'sequence')::numeric=0 AND a->>'spentWei'='0' AND a->'lastSettlementId'='null'::jsonb AND a->'lastSettlementAnchor'='null'::jsonb)
    OR ((a->>'sequence')::numeric>0 AND (a->>'spentWei')::numeric>0
      AND a->>'lastSettlementId' ~ '^[0-9a-f-]{36}$' AND jsonb_typeof(a->'lastSettlementAnchor')='object'
      AND a->'lastSettlementAnchor'->'chainId'='8453'::jsonb AND a->'lastSettlementAnchor'->>'source'='onchain'
      AND a->'lastSettlementAnchor'->>'blockHash' ~ '^0x[0-9a-f]{64}$'
      AND (a->'lastSettlementAnchor'->>'blockNumber')::numeric>=(a->'initialHead'->>'blockNumber')::numeric))
  AND (a->'fence'='null'::jsonb OR (jsonb_typeof(a->'fence')='object' AND ((a->'fence')-'reason'-'evidenceDigest'-'recordedAt')='{}'::jsonb
    AND a->'fence'->>'reason' IN ('restore-required','environment-changed','finalized-anchor-replaced','nonce-conflict','balance-deficit','allocation-exceeded')
    AND (a->'fence'->>'reason'<>'allocation-exceeded' OR (a->>'spentWei')::numeric>allocation)
    AND a->'fence'->>'evidenceDigest' ~ '^[0-9a-f]{64}$' AND (a->'fence'->>'recordedAt')::numeric>0
    AND (a->'fence'->>'recordedAt')::numeric<=9007199254740991)))) IS TRUE
$$;

-- Versioned admission: a Base admission binds the pricing deposit and a margin reservation.
CREATE FUNCTION rest_wallet_deployment_admission_accounting_shape(a jsonb) RETURNS boolean LANGUAGE sql IMMUTABLE AS $$
 SELECT (jsonb_typeof(a)='object' AND (a-'digest'-'remainingWei'-'nextNonce')='{}'::jsonb
  AND a->>'digest' ~ '^[0-9a-f]{64}$' AND a->>'remainingWei' ~ '^(0|[1-9][0-9]{0,77})$' AND (a->>'remainingWei')::numeric<2::numeric^256
  AND a->>'nextNonce' ~ '^(0|[1-9][0-9]{0,15})$' AND (a->>'nextNonce')::numeric<=9007199254740991) IS TRUE
$$;
ALTER TABLE rest_wallet_deployment_dispatches DROP CONSTRAINT rest_wallet_deployment_dispatch_admission_v2;
ALTER TABLE rest_wallet_deployment_dispatches
ADD CONSTRAINT rest_wallet_deployment_dispatch_admission_v3 CHECK ((jsonb_typeof(admission)='object' AND octet_length(admission::text)<=4096
    AND (admission-'version'-'operationId'-'poolConfigurationDigest'-'templateCommitment'-'transactionHash'-'operationRevision'
      -'observationDigest'-'environment'-'observedAt'-'expiresAt'-'balanceWei'-'maximumExecutionCost'-'feeScope'-'baseTotalAffordability'-'accounting'-'reservation')='{}'::jsonb
    AND ((admission->>'version'='center-wallet-deployment-local-admission-v1' AND NOT admission ? 'accounting' AND NOT admission ? 'reservation'
        AND admission->>'feeScope'='local-execution-only' AND admission->>'baseTotalAffordability'='unknown' AND admission->'environment'->>'kind'='unforked-anvil')
      OR (admission->>'version'='center-wallet-deployment-local-admission-v2' AND rest_wallet_deployment_admission_accounting_shape(admission->'accounting')
        AND NOT admission ? 'reservation'
        AND admission->>'feeScope'='local-execution-only' AND admission->>'baseTotalAffordability'='unknown' AND admission->'environment'->>'kind'='unforked-anvil')
      OR (admission->>'version'='center-wallet-deployment-base-admission-v1' AND rest_wallet_deployment_admission_accounting_shape(admission->'accounting')
        AND admission->>'feeScope'='base-execution-l1-operator-reserved' AND admission->>'baseTotalAffordability'='reserved' AND admission->'environment'->>'kind'='base-mainnet'
        AND jsonb_typeof(admission->'reservation')='object'
        AND ((admission->'reservation')-'attributesTransaction'-'parametersDigest'-'l1WeiAtParameters'-'operatorMaximumWei'-'totalWei')='{}'::jsonb
        AND admission->'reservation'->>'attributesTransaction' ~ '^0x[0-9a-f]{64}$'
        AND admission->'reservation'->>'attributesTransaction'<>'0x0000000000000000000000000000000000000000000000000000000000000000'
        AND admission->'reservation'->>'parametersDigest' ~ '^[0-9a-f]{64}$'
        AND admission->'reservation'->>'l1WeiAtParameters' ~ '^(0|[1-9][0-9]{0,77})$'
        AND admission->'reservation'->>'operatorMaximumWei' ~ '^(0|[1-9][0-9]{0,77})$'
        AND admission->'reservation'->>'totalWei' ~ '^[1-9][0-9]{0,77}$'
        AND (admission->'reservation'->>'totalWei')::numeric=(admission->>'maximumExecutionCost')::numeric
          +2*((admission->'reservation'->>'l1WeiAtParameters')::numeric+(admission->'reservation'->>'operatorMaximumWei')::numeric)
        AND (admission->>'balanceWei')::numeric>=(admission->'reservation'->>'totalWei')::numeric))
    AND admission->>'operationId'=operation_id::text AND admission->>'transactionHash'=transaction_hash
    AND admission->>'templateCommitment'=template_commitment
    AND admission->>'poolConfigurationDigest' ~ '^[0-9a-f]{64}$' AND admission->>'observationDigest' ~ '^[0-9a-f]{64}$'
    AND (admission->>'operationRevision')::bigint>0 AND (admission->>'operationRevision')::bigint<=9007199254740991
    AND jsonb_typeof(admission->'environment')='object'
    AND ((admission->'environment')-'kind'-'genesisHash'-'head')='{}'::jsonb
    AND admission->'environment'->>'genesisHash' ~ '^0x[0-9a-f]{64}$'
    AND admission->'environment'->>'genesisHash'<>'0x0000000000000000000000000000000000000000000000000000000000000000'
    AND jsonb_typeof(admission->'environment'->'head')='object'
    AND (admission->>'observedAt')::bigint>0 AND (admission->>'observedAt')::bigint<=claimed_at
    AND (admission->>'expiresAt')::bigint>claimed_at AND (admission->>'expiresAt')::bigint>=lease_until
    AND (admission->>'expiresAt')::bigint<=(admission->>'observedAt')::bigint+20000
    AND admission->>'balanceWei' ~ '^(0|[1-9][0-9]{0,77})$'
    AND admission->>'maximumExecutionCost' ~ '^[1-9][0-9]{0,77}$'
    AND (admission->>'balanceWei')::numeric<2::numeric^256
    AND (admission->>'maximumExecutionCost')::numeric<2::numeric^256) IS TRUE);
CREATE OR REPLACE FUNCTION rest_wallet_deployment_dispatch_transition() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE
  operation rest_wallet_deployments%ROWTYPE;
  allocation rest_wallet_deployment_pools%ROWTYPE;
  remaining numeric;
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
  SELECT * INTO operation FROM rest_wallet_deployments WHERE id=NEW.operation_id;
  IF operation.settlement_id IS NOT NULL THEN RAISE EXCEPTION 'Settled artifact cannot acquire or settle a dispatch lease' USING ERRCODE='23514'; END IF;
  IF NEW.status='in-flight' THEN
    IF TG_OP='UPDATE' AND (OLD.next_attempt_at>now_ms OR NEW.attempts<>OLD.attempts+1
      OR NEW.lease_token=OLD.lease_token OR NEW.admission_digest=OLD.admission_digest OR NEW.claimed_at<OLD.next_attempt_at)
      THEN RAISE EXCEPTION 'Dispatch retry requires a new bounded lease after cooldown' USING ERRCODE='23514'; END IF;
    SELECT * INTO allocation FROM rest_wallet_deployment_pools WHERE id=operation.pool_id;
    remaining := allocation.allocation_wei-COALESCE((allocation.accounting->>'spentWei')::numeric,0);
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
      AND ((allocation.accounting IS NULL AND NEW.admission->>'version'='center-wallet-deployment-local-admission-v1')
        OR (allocation.accounting IS NOT NULL AND allocation.accounting->'fence'='null'::jsonb
          AND ((NEW.admission->>'version'='center-wallet-deployment-local-admission-v2' AND allocation.accounting->'environment'->>'kind'='unforked-anvil')
            OR (NEW.admission->>'version'='center-wallet-deployment-base-admission-v1' AND allocation.accounting->'environment'->>'kind'='base-mainnet'
              AND (NEW.admission->'reservation'->>'totalWei')::numeric<=remaining))
          AND (NEW.admission->'accounting'->>'remainingWei')::numeric=remaining
          AND NEW.admission->'accounting'->>'nextNonce'=allocation.accounting->>'nextNonce'
          AND operation.nonce::text=allocation.accounting->>'nextNonce'
          AND NEW.admission->'environment'->>'genesisHash'=allocation.accounting->'environment'->>'genesisHash'))
      AND (NEW.admission->>'balanceWei')::numeric>=remaining
      AND (NEW.admission->>'maximumExecutionCost')::numeric=operation.maximum_execution_cost
      AND operation.maximum_execution_cost<=remaining
      AND NEW.claimed_at<=now_ms AND NEW.lease_until>now_ms) IS NOT TRUE
      THEN RAISE EXCEPTION 'Dispatch requires fresh matching internal admission' USING ERRCODE='23514'; END IF;
  ELSE
    IF TG_OP<>'UPDATE' OR OLD.status<>'in-flight' OR OLD.lease_until<=now_ms OR NEW.settled_at>now_ms
      OR (NEW.attempts,NEW.lease_token,NEW.lease_until,NEW.admission,NEW.admission_digest,NEW.claimed_at,NEW.next_attempt_at)
      IS DISTINCT FROM (OLD.attempts,OLD.lease_token,OLD.lease_until,OLD.admission,OLD.admission_digest,OLD.claimed_at,OLD.next_attempt_at)
      THEN RAISE EXCEPTION 'Only the current live dispatch fence can settle a transport response' USING ERRCODE='23514'; END IF;
  END IF;
  RETURN NEW;
END $$;

-- Settlement receipts: complete Base fees beside local execution-only fees. The receipt's own
-- spent total may exceed the allocation; the accounting shape then requires the incident fence.
DO $$ DECLARE constraint_name text; BEGIN
 SELECT conname INTO STRICT constraint_name FROM pg_constraint WHERE conrelid='rest_wallet_deployment_settlements'::regclass
  AND contype='c' AND pg_get_constraintdef(oid) LIKE '%jsonb_typeof(receipt)%';
 EXECUTE format('ALTER TABLE rest_wallet_deployment_settlements DROP CONSTRAINT %I',constraint_name);
END $$;
ALTER TABLE rest_wallet_deployment_settlements ADD CONSTRAINT rest_wallet_deployment_settlement_receipt_v2
 CHECK ((jsonb_typeof(receipt)='object' AND octet_length(receipt::text)<=32768
  AND (receipt-'version'-'id'-'poolId'-'operationId'-'evidenceDigest'-'evidence'-'nonce'-'priorSequence'-'sequence'-'spentWei'-'nextNonce'-'settledAt')='{}'::jsonb
  AND receipt->>'version'='center-wallet-deployment-settlement-receipt-v1' AND receipt->>'id'=id::text
  AND receipt->>'operationId'=id::text AND receipt->>'poolId'=pool_id::text AND receipt->>'evidenceDigest'=evidence_digest
  AND (receipt->>'sequence')::bigint=sequence AND (receipt->>'priorSequence')::bigint=sequence-1
  AND receipt->>'nonce' ~ '^(0|[1-9][0-9]{0,15})$' AND (receipt->>'nextNonce')::numeric=(receipt->>'nonce')::numeric+1
  AND (receipt->>'nextNonce')::numeric<=9007199254740991 AND receipt->>'spentWei' ~ '^[1-9][0-9]{0,77}$'
  AND (receipt->>'settledAt')::numeric>0 AND (receipt->>'settledAt')::numeric<=9007199254740991
  AND jsonb_typeof(receipt->'evidence')='object'
  AND receipt->'evidence'->>'version'='center-wallet-deployment-settlement-evidence-v1'
  AND receipt->'evidence'->>'operationId'=id::text
  AND ((receipt->'evidence'->'fees'->>'profile'='unforked-anvil-execution-fees-v1'
      AND ((receipt->'evidence'->'fees')-'profile'-'executionWei'-'totalWei')='{}'::jsonb
      AND receipt->'evidence'->'fees'->>'executionWei'=receipt->'evidence'->'fees'->>'totalWei')
    OR (receipt->'evidence'->'fees'->>'profile'='base-fjord-jovian-receipt-v1'
      AND ((receipt->'evidence'->'fees')-'profile'-'executionWei'-'l1Wei'-'operatorWei'-'totalWei')='{}'::jsonb
      AND receipt->'evidence'->'fees'->>'l1Wei' ~ '^(0|[1-9][0-9]{0,77})$'
      AND receipt->'evidence'->'fees'->>'operatorWei' ~ '^(0|[1-9][0-9]{0,77})$'
      AND (receipt->'evidence'->'fees'->>'totalWei')::numeric=(receipt->'evidence'->'fees'->>'executionWei')::numeric
        +(receipt->'evidence'->'fees'->>'l1Wei')::numeric+(receipt->'evidence'->'fees'->>'operatorWei')::numeric))
  AND receipt->'evidence'->'fees'->>'executionWei' ~ '^[1-9][0-9]{0,77}$'
  AND (receipt->'evidence'->'fees'->>'executionWei')::numeric=
   (receipt->'evidence'->'observation'->'transaction'->'receipt'->>'gasUsed')::numeric*
   (receipt->'evidence'->'observation'->'transaction'->'receipt'->>'effectiveGasPrice')::numeric
  AND receipt->'evidence'->'observation'->'fees'->>'executionWei'=receipt->'evidence'->'fees'->>'executionWei'
  AND receipt->'evidence'->'observation'->'fees'->'totalWei'='null'::jsonb
  AND receipt->'evidence'->'observation'->'dispatchEligible'='false'::jsonb
  AND receipt->'evidence'->'observation'->'finality'->>'state'='finalized'
  AND rest_wallet_deployment_finality_shape(receipt->'evidence'->'observation')
  AND receipt->'evidence'->'observation'->'transaction'->>'state' IN ('canonical-success','canonical-revert')
  AND receipt->'evidence'->'observation'->'transaction'->'receipt'->>'status'=
   CASE receipt->'evidence'->'observation'->'transaction'->>'state' WHEN 'canonical-success' THEN 'success' ELSE 'reverted' END
  AND receipt->'evidence'->>'finalizedNonce'=receipt->>'nextNonce'
  AND receipt->'evidence'->'funding'->>'confirmedNonce'=receipt->>'nextNonce'
  AND receipt->'evidence'->'funding'->>'pendingNonce'=receipt->>'nextNonce'
  AND receipt->'evidence'->'funding'->'head'=receipt->'evidence'->'observation'->'head') IS TRUE);

CREATE OR REPLACE FUNCTION rest_wallet_deployment_settlement_transition() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE p rest_wallet_deployment_pools%ROWTYPE; d rest_wallet_deployments%ROWTYPE; cost numeric; overspent boolean;
 now_ms bigint := floor(extract(epoch FROM clock_timestamp())*1000)::bigint;
BEGIN
 IF TG_TABLE_NAME='rest_wallet_deployment_settlements' THEN
  IF TG_OP<>'INSERT' THEN RAISE EXCEPTION 'Settlement receipt is permanent' USING ERRCODE='23514'; END IF;
  SELECT * INTO d FROM rest_wallet_deployments WHERE id=NEW.id;
  SELECT * INTO p FROM rest_wallet_deployment_pools WHERE id=d.pool_id;
  cost := (NEW.receipt->'evidence'->'fees'->>'totalWei')::numeric;
  IF (d.state='signed' AND d.settlement_id IS NULL AND p.id=NEW.pool_id AND p.active_operation_id=d.id
    AND p.state='active' AND p.accounting IS NOT NULL AND p.accounting->'fence'='null'::jsonb
    AND NEW.sequence=(p.accounting->>'sequence')::bigint+1 AND NEW.receipt->>'nonce'=d.nonce::text
    AND NEW.receipt->>'nonce'=p.accounting->>'nextNonce'
    AND (NEW.receipt->>'spentWei')::numeric=(p.accounting->>'spentWei')::numeric+cost
    AND ((NEW.receipt->'evidence'->'fees'->>'profile'='unforked-anvil-execution-fees-v1' AND p.accounting->'environment'->>'kind'='unforked-anvil')
      OR (NEW.receipt->'evidence'->'fees'->>'profile'='base-fjord-jovian-receipt-v1' AND p.accounting->'environment'->>'kind'='base-mainnet'))
    AND NEW.receipt->'evidence'->>'transactionHash'=d.transaction_hash
    AND NEW.receipt->'evidence'->>'templateCommitment'=d.template_commitment
    AND (NEW.receipt->'evidence'->>'operationRevision')::bigint=d.revision
    AND NEW.receipt->'evidence'->'observation'->>'transactionHash'=d.transaction_hash
    AND NEW.receipt->'evidence'->'observation'->>'templateCommitment'=d.template_commitment
    AND (NEW.receipt->'evidence'->'funding'->>'poolRevision')::bigint=p.revision
    AND NEW.receipt->'evidence'->'funding'->>'configurationDigest'=p.configuration_digest
    AND NEW.receipt->'evidence'->'funding'->'environment'=p.accounting->'environment'
    AND NEW.receipt->'evidence'->'funding'->'previousAnchor'=p.accounting->'lastSettlementAnchor'
    AND (NEW.receipt->'evidence'->'funding'->>'balanceWei')::numeric>=p.allocation_wei-(NEW.receipt->>'spentWei')::numeric
    AND (NEW.receipt->'evidence'->'fees'->>'executionWei')::numeric<=d.maximum_execution_cost
    AND (NEW.receipt->'evidence'->'funding'->>'observedAt')::bigint<=(NEW.receipt->>'settledAt')::bigint
    AND (NEW.receipt->>'settledAt')::bigint<=now_ms
    AND (NEW.receipt->'evidence'->'funding'->>'expiresAt')::bigint>now_ms
    AND (NEW.receipt->'evidence'->'funding'->'head'->>'timestamp')::numeric*1000+300000>now_ms
    AND (NEW.receipt->'evidence'->'funding'->>'expiresAt')::numeric<=
      (NEW.receipt->'evidence'->'funding'->'head'->>'timestamp')::numeric*1000+300000
    AND (NEW.receipt->'evidence'->'funding'->'head'->>'timestamp')::numeric*1000<=now_ms+30000
    AND (NEW.receipt->'evidence'->'observation'->>'observedAt')::bigint<=(NEW.receipt->'evidence'->'funding'->>'observedAt')::bigint
    AND (NEW.receipt->'evidence'->'funding'->>'expiresAt')::bigint<=(NEW.receipt->'evidence'->'observation'->>'observedAt')::bigint+60000
    AND (NEW.receipt->'evidence'->'funding'->>'expiresAt')::bigint>(NEW.receipt->>'settledAt')::bigint
    AND (NEW.receipt->'evidence'->'funding'->>'expiresAt')::bigint<=
      (NEW.receipt->'evidence'->'funding'->>'observedAt')::bigint+60000
    AND NOT EXISTS(SELECT 1 FROM rest_wallet_deployment_dispatches WHERE operation_id=d.id
      AND lease_until>floor(extract(epoch FROM clock_timestamp())*1000)::bigint)) IS NOT TRUE
    THEN RAISE EXCEPTION 'Settlement requires exact finality and accounting' USING ERRCODE='23514'; END IF;
 ELSIF TG_TABLE_NAME='rest_wallet_deployments' THEN
  IF OLD.settlement_id IS NOT NULL AND NEW IS DISTINCT FROM OLD
    THEN RAISE EXCEPTION 'Settled deployment history is immutable' USING ERRCODE='23514'; END IF;
  IF NEW.settlement_id IS DISTINCT FROM OLD.settlement_id AND
    (OLD.settlement_id IS NOT NULL OR NEW.settlement_id IS NULL OR (to_jsonb(NEW)-'settlement_id') IS DISTINCT FROM (to_jsonb(OLD)-'settlement_id'))
    THEN RAISE EXCEPTION 'Settlement changes only its one-way marker' USING ERRCODE='23514'; END IF;
 ELSE
  IF OLD.accounting IS NOT NULL AND NEW IS DISTINCT FROM OLD AND
    (NEW.revision<>OLD.revision+1 OR (to_jsonb(NEW)-'revision') IS NOT DISTINCT FROM (to_jsonb(OLD)-'revision'))
    THEN RAISE EXCEPTION 'Initialized accounting CAS advances with a real transition only' USING ERRCODE='23514'; END IF;
  IF OLD.accounting IS NULL THEN
   IF NEW.accounting IS NOT NULL AND (OLD.active_operation_id IS NOT NULL OR NEW.active_operation_id IS NOT NULL
     OR NEW.accounting->>'sequence'<>'0' OR NEW.accounting->>'spentWei'<>'0' OR NEW.accounting->'fence'<>'null'::jsonb
     OR NEW.revision<>OLD.revision+1)
    THEN RAISE EXCEPTION 'Initialize only an unused explicitly qualified pool' USING ERRCODE='23514'; END IF;
  ELSIF NEW.accounting IS DISTINCT FROM OLD.accounting THEN
   IF NEW.accounting IS NULL OR NEW.revision<>OLD.revision+1
    OR (NEW.accounting->'environment',NEW.accounting->'initialHead',NEW.accounting->'initialNonce')
      IS DISTINCT FROM (OLD.accounting->'environment',OLD.accounting->'initialHead',OLD.accounting->'initialNonce')
    OR OLD.accounting->'fence'<>'null'::jsonb
    THEN RAISE EXCEPTION 'Accounting identity and fences cannot be replaced' USING ERRCODE='23514'; END IF;
   IF NEW.accounting->'fence'<>'null'::jsonb AND (NEW.accounting-'fence') IS NOT DISTINCT FROM (OLD.accounting-'fence') THEN
    IF NEW.active_operation_id IS DISTINCT FROM OLD.active_operation_id
      THEN RAISE EXCEPTION 'A fence retains every liability' USING ERRCODE='23514'; END IF;
   ELSE
    -- A settlement may add only the allocation-exceeded fence, and only for an actual debit above the allocation.
    overspent := (NEW.accounting->>'spentWei')::numeric>OLD.allocation_wei;
    IF (NEW.accounting->'fence'<>'null'::jsonb AND (NEW.accounting->'fence'->>'reason'<>'allocation-exceeded' OR NOT overspent))
      OR (overspent AND NEW.accounting->'fence'='null'::jsonb)
      OR (NEW.accounting->>'sequence')::bigint<>(OLD.accounting->>'sequence')::bigint+1
      OR OLD.active_operation_id IS NULL OR NEW.active_operation_id IS NOT NULL
      OR NEW.accounting->>'lastSettlementId'<>OLD.active_operation_id::text
      OR (NEW.accounting->>'nextNonce')::numeric<>(OLD.accounting->>'nextNonce')::numeric+1
      OR (NEW.accounting->>'spentWei')::numeric<=(OLD.accounting->>'spentWei')::numeric
      OR (OLD.accounting->'lastSettlementAnchor'<>'null'::jsonb AND
        ((NEW.accounting->'lastSettlementAnchor'->>'blockNumber')::numeric>=(OLD.accounting->'lastSettlementAnchor'->>'blockNumber')::numeric
         AND ((NEW.accounting->'lastSettlementAnchor'->>'blockNumber')<>(OLD.accounting->'lastSettlementAnchor'->>'blockNumber')
          OR NEW.accounting->'lastSettlementAnchor'=OLD.accounting->'lastSettlementAnchor')) IS NOT TRUE)
    THEN RAISE EXCEPTION 'Settlement advances actual debit and one nonce' USING ERRCODE='23514'; END IF;
   END IF;
  END IF;
  IF OLD.accounting IS NOT NULL AND OLD.active_operation_id IS DISTINCT FROM NEW.active_operation_id AND
    (OLD.accounting->'fence'<>'null'::jsonb OR (OLD.active_operation_id IS NOT NULL AND NEW.accounting IS NOT DISTINCT FROM OLD.accounting))
    THEN RAISE EXCEPTION 'No lane release without a qualified settlement' USING ERRCODE='23514'; END IF;
 END IF;
 RETURN NEW;
END $$;

-- Sequential claims share the widened funding-evidence lifetime with settlement.
CREATE OR REPLACE FUNCTION rest_wallet_deployment_funding_claim() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE p rest_wallet_deployment_pools%ROWTYPE; now_ms bigint := floor(extract(epoch FROM clock_timestamp())*1000)::bigint;
BEGIN
 IF TG_OP='INSERT' THEN
  IF NEW.claim_funding IS NOT NULL THEN RAISE EXCEPTION 'Prepared operation has no spending admission' USING ERRCODE='23514'; END IF;
  RETURN NEW;
 END IF;
 IF OLD.state<>'prepared' AND NEW.claim_funding IS DISTINCT FROM OLD.claim_funding
  THEN RAISE EXCEPTION 'Claimed funding evidence is immutable' USING ERRCODE='23514'; END IF;
 IF OLD.state='prepared' AND NEW.state='claimed' THEN
  SELECT * INTO p FROM rest_wallet_deployment_pools WHERE id=NEW.pool_id;
  IF p.accounting IS NULL THEN
   IF NEW.claim_funding IS NOT NULL THEN RAISE EXCEPTION 'Legacy pool cannot adopt a sequential admission' USING ERRCODE='23514'; END IF;
  ELSIF (p.accounting->'fence'='null'::jsonb AND jsonb_typeof(NEW.claim_funding)='object'
    AND octet_length(NEW.claim_funding::text)<=4096
    AND NEW.claim_funding->>'version'='center-wallet-deployment-funding-v1'
    AND NEW.claim_funding->>'poolId'=p.id::text AND NEW.claim_funding->>'configurationDigest'=p.configuration_digest
    AND (NEW.claim_funding->>'poolRevision')::bigint=p.revision
    AND NEW.claim_funding->>'accountingDigest' ~ '^[0-9a-f]{64}$'
    AND NEW.claim_funding->'environment'=p.accounting->'environment'
    AND NEW.claim_funding->'previousAnchor'=p.accounting->'lastSettlementAnchor'
    AND NEW.claim_funding->>'confirmedNonce'=p.accounting->>'nextNonce'
    AND NEW.claim_funding->>'pendingNonce'=p.accounting->>'nextNonce'
    AND NEW.nonce::text=p.accounting->>'nextNonce'
    AND NEW.claim_funding->'head'->>'blockNumber'=NEW.admission->>'blockNumber'
    AND NEW.claim_funding->'head'->>'blockHash'=NEW.admission->>'blockHash'
    AND (NEW.claim_funding->>'balanceWei')::numeric>=p.allocation_wei-(p.accounting->>'spentWei')::numeric
    AND (NEW.template->'transaction'->>'gas')::numeric*(NEW.template->'transaction'->>'maxFeePerGas')::numeric<=p.allocation_wei-(p.accounting->>'spentWei')::numeric
    AND (NEW.claim_funding->>'observedAt')::bigint<=now_ms AND (NEW.claim_funding->>'expiresAt')::bigint>now_ms
    AND (NEW.claim_funding->>'expiresAt')::bigint<=(NEW.claim_funding->>'observedAt')::bigint+60000) IS NOT TRUE
    THEN RAISE EXCEPTION 'Sequential claim requires current exact funding evidence' USING ERRCODE='23514'; END IF;
 END IF;
 RETURN NEW;
END $$;

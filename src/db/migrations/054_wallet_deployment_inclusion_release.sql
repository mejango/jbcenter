-- The sender lane is released at canonical inclusion instead of L1 finality. A released operation
-- joins a bounded queue (at most eight) that reserves its admitted maximum cost against the
-- allocation until its finalized settlement debits the actual fee, in nonce order. One operation is
-- in flight at a time; a released inclusion that stops being canonical fences the pool for review.
ALTER TABLE rest_wallet_deployments ADD COLUMN released_at bigint, ADD COLUMN reserved_wei numeric(78,0);
ALTER TABLE rest_wallet_deployments ADD CONSTRAINT rest_wallet_deployment_release_shape
 CHECK ((released_at IS NULL AND reserved_wei IS NULL) OR (state='signed' AND released_at>0 AND released_at<=9007199254740991
   AND reserved_wei>=maximum_execution_cost AND reserved_wei<2::numeric^256));
DROP INDEX rest_wallet_deployment_unsettled_pool;
CREATE UNIQUE INDEX rest_wallet_deployment_unsettled_pool ON rest_wallet_deployments(pool_id)
 WHERE state IN ('claimed','signed') AND settlement_id IS NULL AND released_at IS NULL;
CREATE INDEX rest_wallet_deployment_released_queue ON rest_wallet_deployments(pool_id,nonce)
 WHERE released_at IS NOT NULL AND settlement_id IS NULL;
CREATE FUNCTION rest_wallet_deployment_reserved_wei(pool uuid) RETURNS numeric LANGUAGE sql STABLE AS $$
 SELECT COALESCE(sum(reserved_wei),0) FROM rest_wallet_deployments WHERE pool_id=pool AND released_at IS NOT NULL AND settlement_id IS NULL
$$;
CREATE FUNCTION rest_wallet_deployment_released_count(pool uuid) RETURNS bigint LANGUAGE sql STABLE AS $$
 SELECT count(*) FROM rest_wallet_deployments WHERE pool_id=pool AND released_at IS NOT NULL AND settlement_id IS NULL
$$;

-- nextNonce advances at release; sequence and spentWei only at settlement. Their gap is the queue.
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
  AND (a->>'nextNonce')::numeric>=(a->>'initialNonce')::numeric+(a->>'sequence')::numeric
  AND (a->>'nextNonce')::numeric<=(a->>'initialNonce')::numeric+(a->>'sequence')::numeric+8
  AND (a->>'nextNonce')::numeric<=9007199254740991
  AND ((a->>'spentWei')::numeric<=allocation OR a->'fence'->>'reason'='allocation-exceeded')
  AND (((a->>'sequence')::numeric=0 AND a->>'spentWei'='0' AND a->'lastSettlementId'='null'::jsonb AND a->'lastSettlementAnchor'='null'::jsonb)
    OR ((a->>'sequence')::numeric>0 AND (a->>'spentWei')::numeric>0
      AND a->>'lastSettlementId' ~ '^[0-9a-f-]{36}$' AND jsonb_typeof(a->'lastSettlementAnchor')='object'
      AND a->'lastSettlementAnchor'->'chainId'='8453'::jsonb AND a->'lastSettlementAnchor'->>'source'='onchain'
      AND a->'lastSettlementAnchor'->>'blockHash' ~ '^0x[0-9a-f]{64}$'
      AND (a->'lastSettlementAnchor'->>'blockNumber')::numeric>=(a->'initialHead'->>'blockNumber')::numeric))
  AND (a->'fence'='null'::jsonb OR (jsonb_typeof(a->'fence')='object' AND ((a->'fence')-'reason'-'evidenceDigest'-'recordedAt')='{}'::jsonb
    AND a->'fence'->>'reason' IN ('restore-required','environment-changed','finalized-anchor-replaced','nonce-conflict','balance-deficit','allocation-exceeded','inclusion-reorged')
    AND (a->'fence'->>'reason'<>'allocation-exceeded' OR (a->>'spentWei')::numeric>allocation)
    AND a->'fence'->>'evidenceDigest' ~ '^[0-9a-f]{64}$' AND (a->'fence'->>'recordedAt')::numeric>0
    AND (a->'fence'->>'recordedAt')::numeric<=9007199254740991)))) IS TRUE
$$;

-- A settlement's funding read may see later inclusions: its nonces bound the receipt's, not equal it.
ALTER TABLE rest_wallet_deployment_settlements DROP CONSTRAINT rest_wallet_deployment_settlement_receipt_v2;
ALTER TABLE rest_wallet_deployment_settlements ADD CONSTRAINT rest_wallet_deployment_settlement_receipt_v3
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
  AND receipt->'evidence'->>'finalizedNonce' ~ '^(0|[1-9][0-9]{0,15})$'
  AND (receipt->'evidence'->>'finalizedNonce')::numeric>=(receipt->>'nextNonce')::numeric
  AND (receipt->'evidence'->'funding'->>'confirmedNonce')::numeric>=(receipt->'evidence'->>'finalizedNonce')::numeric
  AND (receipt->'evidence'->'funding'->>'pendingNonce')::numeric>=(receipt->'evidence'->'funding'->>'confirmedNonce')::numeric
  AND receipt->'evidence'->'funding'->'head'=receipt->'evidence'->'observation'->'head') IS TRUE);

CREATE OR REPLACE FUNCTION rest_wallet_deployment_settlement_transition() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE p rest_wallet_deployment_pools%ROWTYPE; d rest_wallet_deployments%ROWTYPE; cost numeric; overspent boolean; others numeric; window_ int;
 now_ms bigint := floor(extract(epoch FROM clock_timestamp())*1000)::bigint;
BEGIN
 IF TG_TABLE_NAME='rest_wallet_deployment_settlements' THEN
  IF TG_OP<>'INSERT' THEN RAISE EXCEPTION 'Settlement receipt is permanent' USING ERRCODE='23514'; END IF;
  SELECT * INTO d FROM rest_wallet_deployments WHERE id=NEW.id;
  SELECT * INTO p FROM rest_wallet_deployment_pools WHERE id=d.pool_id;
  cost := (NEW.receipt->'evidence'->'fees'->>'totalWei')::numeric;
  -- Reservations of the other released operations stay ahead of the balance floor.
  others := rest_wallet_deployment_reserved_wei(p.id)-COALESCE(d.reserved_wei,0);
  window_ := CASE WHEN p.active_operation_id IS NULL THEN 0 ELSE 1 END;
  IF (d.state='signed' AND d.settlement_id IS NULL AND d.released_at IS NOT NULL AND p.id=NEW.pool_id
    AND p.active_operation_id IS DISTINCT FROM d.id
    AND p.state='active' AND p.accounting IS NOT NULL AND p.accounting->'fence'='null'::jsonb
    AND NEW.sequence=(p.accounting->>'sequence')::bigint+1 AND NEW.receipt->>'nonce'=d.nonce::text
    AND (NEW.receipt->>'nonce')::numeric=(p.accounting->>'initialNonce')::numeric+(p.accounting->>'sequence')::numeric
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
    AND (NEW.receipt->'evidence'->'funding'->>'balanceWei')::numeric>=p.allocation_wei-(NEW.receipt->>'spentWei')::numeric-others
    AND (NEW.receipt->'evidence'->'funding'->>'confirmedNonce')::numeric<=(p.accounting->>'nextNonce')::numeric+window_
    AND (NEW.receipt->'evidence'->'funding'->>'pendingNonce')::numeric<=(p.accounting->>'nextNonce')::numeric+window_
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
  IF (NEW.released_at,NEW.reserved_wei) IS DISTINCT FROM (OLD.released_at,OLD.reserved_wei) THEN
   SELECT * INTO p FROM rest_wallet_deployment_pools WHERE id=OLD.pool_id;
   -- Release is a one-way marker over the saved canonical observation of the active operation,
   -- with the sender nonce advanced past it, no live dispatch lease and room in the queue.
   IF (OLD.released_at IS NULL AND OLD.reserved_wei IS NULL AND OLD.state='signed' AND OLD.settlement_id IS NULL
     AND NEW.released_at>0 AND NEW.released_at<=now_ms
     AND (to_jsonb(NEW)-'released_at'-'reserved_wei') IS NOT DISTINCT FROM (to_jsonb(OLD)-'released_at'-'reserved_wei')
     AND p.state='active' AND p.active_operation_id=OLD.id AND p.accounting IS NOT NULL AND p.accounting->'fence'='null'::jsonb
     AND OLD.nonce::text=p.accounting->>'nextNonce'
     AND OLD.observation->'transaction'->>'state' IN ('canonical-success','canonical-revert')
     AND jsonb_typeof(OLD.observation->'head')='object' AND OLD.historical_canonical_observation IS NOT NULL
     AND (OLD.observation->'transaction'->'nonce'->>'confirmed')::numeric=OLD.nonce+1
     AND (OLD.observation->'transaction'->'nonce'->>'pending')::numeric=OLD.nonce+1
     AND NEW.reserved_wei=GREATEST(OLD.maximum_execution_cost,COALESCE((SELECT (admission->'reservation'->>'totalWei')::numeric
       FROM rest_wallet_deployment_dispatches WHERE operation_id=OLD.id),0))
     AND NOT EXISTS(SELECT 1 FROM rest_wallet_deployment_dispatches WHERE operation_id=OLD.id AND lease_until>now_ms)
     AND rest_wallet_deployment_released_count(OLD.pool_id)<8) IS NOT TRUE
    THEN RAISE EXCEPTION 'Release requires the canonical inclusion of the active operation' USING ERRCODE='23514'; END IF;
  END IF;
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
   ELSIF (NEW.accounting-'nextNonce') IS NOT DISTINCT FROM (OLD.accounting-'nextNonce') THEN
    -- Release: one nonce forward, the lane empty, the released operation marked in this transaction.
    IF ((NEW.accounting->>'nextNonce')::numeric=(OLD.accounting->>'nextNonce')::numeric+1
      AND OLD.active_operation_id IS NOT NULL AND NEW.active_operation_id IS NULL
      AND EXISTS(SELECT 1 FROM rest_wallet_deployments q WHERE q.id=OLD.active_operation_id AND q.pool_id=OLD.id
        AND q.released_at IS NOT NULL AND q.settlement_id IS NULL AND q.nonce::text=OLD.accounting->>'nextNonce')) IS NOT TRUE
     THEN RAISE EXCEPTION 'Lane release follows the released operation' USING ERRCODE='23514'; END IF;
   ELSE
    -- Settlement: the lowest released nonce debits its actual fee; the lane and nextNonce are untouched.
    overspent := (NEW.accounting->>'spentWei')::numeric>OLD.allocation_wei;
    IF (NEW.accounting->'fence'<>'null'::jsonb AND (NEW.accounting->'fence'->>'reason'<>'allocation-exceeded' OR NOT overspent))
      OR (overspent AND NEW.accounting->'fence'='null'::jsonb)
      OR (NEW.accounting->>'sequence')::bigint<>(OLD.accounting->>'sequence')::bigint+1
      OR NEW.accounting->>'nextNonce'<>OLD.accounting->>'nextNonce'
      OR NEW.active_operation_id IS DISTINCT FROM OLD.active_operation_id
      OR (NEW.accounting->>'spentWei')::numeric<=(OLD.accounting->>'spentWei')::numeric
      OR NOT EXISTS(SELECT 1 FROM rest_wallet_deployments q WHERE q.id=(NEW.accounting->>'lastSettlementId')::uuid AND q.pool_id=OLD.id
        AND q.released_at IS NOT NULL AND q.nonce=(OLD.accounting->>'initialNonce')::numeric+(OLD.accounting->>'sequence')::numeric)
      OR (OLD.accounting->'lastSettlementAnchor'<>'null'::jsonb AND
        ((NEW.accounting->'lastSettlementAnchor'->>'blockNumber')::numeric>=(OLD.accounting->'lastSettlementAnchor'->>'blockNumber')::numeric
         AND ((NEW.accounting->'lastSettlementAnchor'->>'blockNumber')<>(OLD.accounting->'lastSettlementAnchor'->>'blockNumber')
          OR NEW.accounting->'lastSettlementAnchor'=OLD.accounting->'lastSettlementAnchor')) IS NOT TRUE)
    THEN RAISE EXCEPTION 'Settlement advances actual debit and one sequence' USING ERRCODE='23514'; END IF;
   END IF;
  END IF;
  IF OLD.accounting IS NOT NULL AND OLD.active_operation_id IS DISTINCT FROM NEW.active_operation_id AND
    (OLD.accounting->'fence'<>'null'::jsonb
     OR (OLD.active_operation_id IS NOT NULL AND (NEW.accounting IS NOT DISTINCT FROM OLD.accounting
       OR (NEW.accounting->>'nextNonce')::numeric<>(OLD.accounting->>'nextNonce')::numeric+1))
     OR (OLD.active_operation_id IS NULL AND NEW.accounting IS DISTINCT FROM OLD.accounting))
    THEN RAISE EXCEPTION 'No lane release without canonical inclusion' USING ERRCODE='23514'; END IF;
 END IF;
 RETURN NEW;
END $$;

-- Every unsettled operation is the one active operation (nonce = nextNonce) or a released one whose
-- nonce lies in [initialNonce+sequence, nextNonce); the released count equals that gap.
CREATE OR REPLACE FUNCTION rest_wallet_deployment_lane_consistent() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE p rest_wallet_deployment_pools%ROWTYPE; target uuid; latest rest_wallet_deployment_settlements%ROWTYPE;
BEGIN
 IF TG_TABLE_NAME='rest_wallet_deployment_pools' THEN target := COALESCE(NEW.id,OLD.id); ELSE target := COALESCE(NEW.pool_id,OLD.pool_id); END IF;
 SELECT * INTO p FROM rest_wallet_deployment_pools WHERE id=target;
 IF NOT FOUND THEN RETURN NULL; END IF;
 IF EXISTS(SELECT 1 FROM rest_wallet_deployments d WHERE d.pool_id=p.id AND d.state IN ('claimed','signed') AND d.settlement_id IS NULL
   AND (p.sender<>d.sender OR p.chain_id<>d.chain_id OR p.configuration_digest<>d.pool_configuration_digest
     OR (d.released_at IS NULL AND (p.active_operation_id IS DISTINCT FROM d.id
       OR (p.accounting IS NOT NULL AND d.nonce::text<>p.accounting->>'nextNonce')))
     OR (d.released_at IS NOT NULL AND (p.accounting IS NULL OR d.state<>'signed' OR d.historical_canonical_observation IS NULL
       OR d.nonce<(p.accounting->>'initialNonce')::numeric+(p.accounting->>'sequence')::numeric
       OR d.nonce>=(p.accounting->>'nextNonce')::numeric))))
  OR (p.active_operation_id IS NOT NULL AND NOT EXISTS(SELECT 1 FROM rest_wallet_deployments d WHERE d.id=p.active_operation_id
    AND d.pool_id=p.id AND d.state IN ('claimed','signed') AND d.settlement_id IS NULL AND d.released_at IS NULL))
  OR (p.accounting IS NOT NULL AND rest_wallet_deployment_released_count(p.id)<>
    (p.accounting->>'nextNonce')::numeric-(p.accounting->>'initialNonce')::numeric-(p.accounting->>'sequence')::numeric)
  THEN RAISE EXCEPTION 'Unsettled nonces own one sender lane and a bounded released queue' USING ERRCODE='23514'; END IF;
 IF p.accounting IS NOT NULL AND (p.accounting->>'sequence')::bigint>0 THEN
  SELECT * INTO latest FROM rest_wallet_deployment_settlements WHERE id=(p.accounting->>'lastSettlementId')::uuid;
  IF (latest.pool_id=p.id AND latest.sequence=(p.accounting->>'sequence')::bigint
    AND latest.receipt->>'spentWei'=p.accounting->>'spentWei'
    AND (latest.receipt->>'nextNonce')::numeric=(p.accounting->>'initialNonce')::numeric+(p.accounting->>'sequence')::numeric
    AND latest.receipt->'evidence'->'observation'->'finality'->'evidence'=p.accounting->'lastSettlementAnchor') IS NOT TRUE
    THEN RAISE EXCEPTION 'Accounting must retain the immutable latest receipt' USING ERRCODE='23514'; END IF;
 END IF;
 IF TG_TABLE_NAME='rest_wallet_deployment_settlements' THEN
  IF ((NEW.receipt->'evidence'->'funding'->>'expiresAt')::bigint>floor(extract(epoch FROM clock_timestamp())*1000)::bigint) IS NOT TRUE
    THEN RAISE EXCEPTION 'Settlement evidence expired before commit' USING ERRCODE='23514'; END IF;
  IF NOT EXISTS(SELECT 1 FROM rest_wallet_deployments WHERE id=NEW.id AND settlement_id=NEW.id)
    OR p.accounting IS NULL OR (p.accounting->>'sequence')::bigint<NEW.sequence
    THEN RAISE EXCEPTION 'Receipt, marker and debit commit together' USING ERRCODE='23514'; END IF;
 END IF;
 RETURN NULL;
END $$;

-- Claims and dispatches spend only what the released queue has not reserved, and no claim starts
-- while the queue is full or one of its inclusions is no longer known to be canonical.
CREATE OR REPLACE FUNCTION rest_wallet_deployment_funding_claim() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE p rest_wallet_deployment_pools%ROWTYPE; remaining numeric; now_ms bigint := floor(extract(epoch FROM clock_timestamp())*1000)::bigint;
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
  ELSE
   remaining := p.allocation_wei-(p.accounting->>'spentWei')::numeric-rest_wallet_deployment_reserved_wei(p.id);
   IF (p.accounting->'fence'='null'::jsonb AND jsonb_typeof(NEW.claim_funding)='object'
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
    AND (NEW.claim_funding->>'balanceWei')::numeric>=remaining
    AND (NEW.template->'transaction'->>'gas')::numeric*(NEW.template->'transaction'->>'maxFeePerGas')::numeric<=remaining
    AND (NEW.claim_funding->>'observedAt')::bigint<=now_ms AND (NEW.claim_funding->>'expiresAt')::bigint>now_ms
    AND (NEW.claim_funding->>'expiresAt')::bigint<=(NEW.claim_funding->>'observedAt')::bigint+60000
    AND rest_wallet_deployment_released_count(p.id)<8
    AND NOT EXISTS(SELECT 1 FROM rest_wallet_deployments q WHERE q.pool_id=p.id AND q.released_at IS NOT NULL AND q.settlement_id IS NULL
      AND q.observation->'transaction'->>'state' NOT IN ('canonical-success','canonical-revert'))) IS NOT TRUE
    THEN RAISE EXCEPTION 'Sequential claim requires current exact funding evidence' USING ERRCODE='23514'; END IF;
  END IF;
 END IF;
 RETURN NEW;
END $$;

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
    remaining := allocation.allocation_wei-COALESCE((allocation.accounting->>'spentWei')::numeric,0)-rest_wallet_deployment_reserved_wei(allocation.id);
    IF (operation.state='signed' AND operation.released_at IS NULL AND allocation.state='active' AND allocation.active_operation_id=operation.id
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

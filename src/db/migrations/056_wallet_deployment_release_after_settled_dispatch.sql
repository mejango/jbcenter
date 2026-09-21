-- A settled dispatch attempt holds nothing: once its process recorded the provider's answer
-- (accepted, or unknown) that attempt can send no more, so the lane's release no longer waits
-- for the attempt's lease to run out (15 s on Base) once the inclusion is canonical. An attempt
-- still in flight keeps the lane, as before. Same function as migration 054 otherwise.
CREATE OR REPLACE FUNCTION rest_wallet_deployment_settlement_transition() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE p rest_wallet_deployment_pools%ROWTYPE; d rest_wallet_deployments%ROWTYPE; cost numeric; overspent boolean; others numeric; window_ int;
 now_ms bigint := floor(extract(epoch FROM clock_timestamp())*1000)::bigint;
BEGIN
 IF TG_TABLE_NAME='rest_wallet_deployment_settlements' THEN
  IF TG_OP<>'INSERT' THEN RAISE EXCEPTION 'Settlement receipt is permanent' USING ERRCODE='23514'; END IF;
  SELECT * INTO d FROM rest_wallet_deployments WHERE id=NEW.id;
  SELECT * INTO p FROM rest_wallet_deployment_pools WHERE id=d.pool_id;
  cost := (NEW.receipt->'evidence'->'fees'->>'totalWei')::numeric;
  -- Reservations of the other released operations stay ahead of the balance floor, and so does the
  -- active operation's: it may already be included (and paid) without being released yet.
  others := rest_wallet_deployment_reserved_wei(p.id)-COALESCE(d.reserved_wei,0)
    +COALESCE((SELECT GREATEST(a.maximum_execution_cost,COALESCE((SELECT (admission->'reservation'->>'totalWei')::numeric
      FROM rest_wallet_deployment_dispatches WHERE operation_id=a.id),0)) FROM rest_wallet_deployments a WHERE a.id=p.active_operation_id AND a.state='signed'),0);
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
   -- with the sender nonce advanced past it, no dispatch attempt still in flight and room in the queue.
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
     AND NOT EXISTS(SELECT 1 FROM rest_wallet_deployment_dispatches WHERE operation_id=OLD.id AND status='in-flight' AND lease_until>now_ms)
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

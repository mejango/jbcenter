-- One permanent prepaid allocation and exclusive sender lane for the initial Base pilot.
-- No signing transport, broadcast, fee settlement or lane-release authority is installed here.
-- 'signed' means durable executable bytes, not a terminal chain outcome. Adding dispatch/finality
-- states and releasing lanes requires an explicit later migration of these checks and triggers.
CREATE TABLE rest_wallet_deployment_pools (
  id uuid PRIMARY KEY,
  singleton boolean NOT NULL DEFAULT true UNIQUE CHECK (singleton),
  chain_id integer NOT NULL CHECK (chain_id = 8453),
  sender text NOT NULL CHECK (sender ~ '^0x[0-9a-f]{40}$' AND sender > '0x0000000000000000000000000000000000000001'),
  allocation_wei numeric(78,0) NOT NULL CHECK (allocation_wei > 0),
  global_allocation_limit_wei numeric(78,0) NOT NULL CHECK (global_allocation_limit_wei >= allocation_wei
    AND global_allocation_limit_wei <= 115792089237316195423570985008687907853269984665640564039457584007913129639935),
  configuration jsonb NOT NULL CHECK ((jsonb_typeof(configuration)='object' AND octet_length(configuration::text)<=4096
    AND configuration->>'id'=id::text AND (configuration->>'chainId')::integer=chain_id
    AND configuration->>'sender'=sender AND configuration->>'allocationWei'=allocation_wei::text
    AND configuration->>'globalAllocationLimitWei'=global_allocation_limit_wei::text
    AND jsonb_typeof(configuration->'policy')='object') IS TRUE),
  configuration_digest text NOT NULL CHECK (configuration_digest ~ '^[0-9a-f]{64}$'),
  state text NOT NULL DEFAULT 'active' CHECK (state IN ('active','paused')),
  active_operation_id uuid,
  created_at bigint NOT NULL CHECK (created_at>0),
  revision bigint NOT NULL DEFAULT 0 CHECK (revision>=0 AND revision<=9007199254740991),
  UNIQUE(chain_id,sender)
);

CREATE TABLE rest_wallet_deployments (
  id uuid PRIMARY KEY,
  pool_id uuid NOT NULL REFERENCES rest_wallet_deployment_pools(id) ON DELETE RESTRICT,
  enrollment_id uuid NOT NULL REFERENCES rest_wallet_enrollments(id) ON DELETE RESTRICT,
  pool_configuration_digest text NOT NULL CHECK (pool_configuration_digest ~ '^[0-9a-f]{64}$'),
  approval jsonb NOT NULL CHECK ((jsonb_typeof(approval)='object' AND octet_length(approval::text)<=4096
    AND approval->>'version'='center-wallet-deployment-v1' AND approval->>'id'=id::text
    AND approval->>'enrollmentId'=enrollment_id::text AND approval->'ceremony'->>'id'=id::text
    AND approval->'ceremony'->>'purpose'='deploy' AND (approval->>'expiresAt')::bigint=expires_at
    AND (approval->'ceremony'->>'expiresAt')::bigint=expires_at) IS TRUE),
  state text NOT NULL DEFAULT 'prepared' CHECK (state IN ('prepared','claimed','signed')),
  created_at bigint NOT NULL CHECK (created_at>0),
  expires_at bigint NOT NULL CHECK (expires_at>created_at AND expires_at<=created_at+300000),
  retain_until bigint NOT NULL CHECK (retain_until=expires_at+86400000),
  claimed_at bigint CHECK (claimed_at>=created_at AND claimed_at<expires_at),
  proof_digest text CHECK (proof_digest ~ '^[0-9a-f]{64}$'),
  admission jsonb CHECK (jsonb_typeof(admission)='object' AND octet_length(admission::text)<=4096),
  chain_id integer CHECK (chain_id=8453),
  sender text CHECK (sender ~ '^0x[0-9a-f]{40}$'),
  nonce numeric(16,0) CHECK (nonce>=0 AND nonce<=9007199254740991),
  template jsonb CHECK (jsonb_typeof(template)='object' AND octet_length(template::text)<=65536),
  template_commitment text CHECK (template_commitment ~ '^0x[0-9a-f]{64}$'),
  signing_lease_token uuid,
  signing_lease_until bigint,
  raw_transaction text CHECK (length(raw_transaction)<=262146 AND raw_transaction ~ '^0x02([0-9a-fA-F]{2})+$'),
  transaction_hash text CHECK (transaction_hash ~ '^0x[0-9a-f]{64}$'),
  maximum_execution_cost numeric(78,0) CHECK (maximum_execution_cost>0),
  revision bigint NOT NULL DEFAULT 0 CHECK (revision>=0 AND revision<=9007199254740991),
  UNIQUE(id,pool_id),
  UNIQUE(chain_id,sender,nonce),
  CHECK ((signing_lease_token IS NULL AND signing_lease_until IS NULL)
    OR (state='claimed' AND signing_lease_token IS NOT NULL AND signing_lease_until IS NOT NULL AND signing_lease_until>claimed_at)),
  CHECK ((
    (state='prepared' AND claimed_at IS NULL AND proof_digest IS NULL AND admission IS NULL
      AND chain_id IS NULL AND sender IS NULL AND nonce IS NULL AND template IS NULL AND template_commitment IS NULL
      AND signing_lease_token IS NULL AND raw_transaction IS NULL AND transaction_hash IS NULL AND maximum_execution_cost IS NULL)
    OR
    (state IN ('claimed','signed') AND claimed_at IS NOT NULL AND proof_digest IS NOT NULL AND admission IS NOT NULL
      AND chain_id IS NOT NULL AND sender IS NOT NULL AND nonce IS NOT NULL AND template IS NOT NULL AND template_commitment IS NOT NULL
      AND template->>'version'='center-wallet-deployment-transaction-v1' AND template->>'sender'=sender
      AND template->>'enrollmentCommitment'=approval->>'enrollmentCommitment'
      AND template->'transaction'->>'type'='eip1559' AND (template->'transaction'->>'chainId')::integer=chain_id
      AND template->'transaction'->>'nonce'=nonce::text AND template->'transaction'->>'value'='0'
      AND template->'transaction'->'accessList'='[]'::jsonb
      AND admission->>'version'='center-wallet-deployment-admission-v1' AND (admission->>'chainId')::integer=chain_id
      AND admission->>'sender'=sender AND admission->>'confirmedNonce'=nonce::text AND admission->>'pendingNonce'=nonce::text
      AND admission->>'enrollmentCommitment'=approval->>'enrollmentCommitment'
      AND admission->>'blockHash' ~ '^0x[0-9a-f]{64}$' AND admission->>'blockNumber' ~ '^(0|[1-9][0-9]{0,77})$'
      AND (admission->>'observedAt')::bigint<=claimed_at
      AND admission->>'gas'=template->'transaction'->>'gas'
      AND admission->>'maxFeePerGas'=template->'transaction'->>'maxFeePerGas'
      AND admission->>'maxPriorityFeePerGas'=template->'transaction'->>'maxPriorityFeePerGas'
      AND ((state='claimed' AND raw_transaction IS NULL AND transaction_hash IS NULL AND maximum_execution_cost IS NULL)
        OR (state='signed' AND raw_transaction IS NOT NULL AND transaction_hash IS NOT NULL AND maximum_execution_cost IS NOT NULL
          AND signing_lease_token IS NULL)))) IS TRUE)
);
CREATE UNIQUE INDEX rest_wallet_deployment_enrollment_lane ON rest_wallet_deployments(enrollment_id) WHERE state IN ('claimed','signed');
CREATE INDEX rest_wallet_deployment_prepared_retention ON rest_wallet_deployments(retain_until,id) WHERE state='prepared';
ALTER TABLE rest_wallet_deployment_pools ADD CONSTRAINT rest_wallet_deployment_pool_operation
  FOREIGN KEY(active_operation_id,id) REFERENCES rest_wallet_deployments(id,pool_id) DEFERRABLE INITIALLY DEFERRED;

-- The original allocation and nonce-bearing history cannot be reset or repriced by later store paths.
CREATE FUNCTION rest_wallet_deployment_immutable() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF TG_TABLE_NAME='rest_wallet_deployment_pools' THEN
    IF TG_OP='DELETE' THEN RAISE EXCEPTION 'Deployment pool allocation is permanent' USING ERRCODE='23514'; END IF;
    IF (NEW.id,NEW.chain_id,NEW.sender,NEW.allocation_wei,NEW.global_allocation_limit_wei,NEW.configuration,NEW.configuration_digest,NEW.created_at)
      IS DISTINCT FROM (OLD.id,OLD.chain_id,OLD.sender,OLD.allocation_wei,OLD.global_allocation_limit_wei,OLD.configuration,OLD.configuration_digest,OLD.created_at)
      THEN RAISE EXCEPTION 'Deployment pool allocation is immutable' USING ERRCODE='23514'; END IF;
  ELSE
    IF TG_OP='INSERT' THEN
      IF NEW.state<>'prepared' THEN RAISE EXCEPTION 'Deployment must begin prepared' USING ERRCODE='23514'; END IF;
      RETURN NEW;
    END IF;
    IF TG_OP='DELETE' THEN
      IF OLD.state<>'prepared' THEN RAISE EXCEPTION 'Deployment nonce history is permanent' USING ERRCODE='23514'; END IF;
      RETURN OLD;
    END IF;
    IF NEW.state<>OLD.state AND NOT ((OLD.state='prepared' AND NEW.state='claimed') OR (OLD.state='claimed' AND NEW.state='signed'))
      THEN RAISE EXCEPTION 'Deployment phase cannot be skipped or reversed' USING ERRCODE='23514'; END IF;
    IF (NEW.id,NEW.pool_id,NEW.enrollment_id,NEW.pool_configuration_digest,NEW.approval,NEW.created_at,NEW.expires_at,NEW.retain_until)
      IS DISTINCT FROM (OLD.id,OLD.pool_id,OLD.enrollment_id,OLD.pool_configuration_digest,OLD.approval,OLD.created_at,OLD.expires_at,OLD.retain_until)
      THEN RAISE EXCEPTION 'Deployment approval is immutable' USING ERRCODE='23514'; END IF;
    IF OLD.state<>'prepared' AND (NEW.claimed_at,NEW.proof_digest,NEW.admission,NEW.chain_id,NEW.sender,NEW.nonce,NEW.template,NEW.template_commitment)
      IS DISTINCT FROM (OLD.claimed_at,OLD.proof_digest,OLD.admission,OLD.chain_id,OLD.sender,OLD.nonce,OLD.template,OLD.template_commitment)
      THEN RAISE EXCEPTION 'Deployment nonce and template are immutable' USING ERRCODE='23514'; END IF;
    IF OLD.state='signed' AND (NEW.state,NEW.raw_transaction,NEW.transaction_hash,NEW.maximum_execution_cost)
      IS DISTINCT FROM (OLD.state,OLD.raw_transaction,OLD.transaction_hash,OLD.maximum_execution_cost)
      THEN RAISE EXCEPTION 'Deployment signed winner is immutable' USING ERRCODE='23514'; END IF;
  END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER rest_wallet_deployment_pool_immutable BEFORE UPDATE OR DELETE ON rest_wallet_deployment_pools
  FOR EACH ROW EXECUTE FUNCTION rest_wallet_deployment_immutable();
CREATE TRIGGER rest_wallet_deployment_operation_immutable BEFORE INSERT OR UPDATE OR DELETE ON rest_wallet_deployments
  FOR EACH ROW EXECUTE FUNCTION rest_wallet_deployment_immutable();

-- A claimed nonce and its sole sender lane must commit together, in either statement order.
-- Singleton plus the lane invariant allows only one unresolved row. Any later multi-lane/nonce
-- pipeline must replace this pilot scan with bounded indexed validation and retained reorg history.
CREATE FUNCTION rest_wallet_deployment_lane_consistent() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF EXISTS (SELECT 1 FROM rest_wallet_deployments d JOIN rest_wallet_deployment_pools p ON p.id=d.pool_id
    WHERE d.state IN ('claimed','signed') AND (p.active_operation_id IS DISTINCT FROM d.id
      OR p.sender<>d.sender OR p.chain_id<>d.chain_id OR p.configuration_digest<>d.pool_configuration_digest))
    OR EXISTS (SELECT 1 FROM rest_wallet_deployment_pools p LEFT JOIN rest_wallet_deployments d ON d.id=p.active_operation_id
      WHERE p.active_operation_id IS NOT NULL AND (d.id IS NULL OR d.pool_id<>p.id OR d.state NOT IN ('claimed','signed')))
    THEN RAISE EXCEPTION 'Deployment lane and nonce must commit together' USING ERRCODE='23514'; END IF;
  RETURN NULL;
END $$;
CREATE CONSTRAINT TRIGGER rest_wallet_deployment_pool_lane AFTER INSERT OR UPDATE OR DELETE ON rest_wallet_deployment_pools
  DEFERRABLE INITIALLY DEFERRED FOR EACH ROW EXECUTE FUNCTION rest_wallet_deployment_lane_consistent();
CREATE CONSTRAINT TRIGGER rest_wallet_deployment_operation_lane AFTER INSERT OR UPDATE OR DELETE ON rest_wallet_deployments
  DEFERRABLE INITIALLY DEFERRED FOR EACH ROW EXECUTE FUNCTION rest_wallet_deployment_lane_consistent();

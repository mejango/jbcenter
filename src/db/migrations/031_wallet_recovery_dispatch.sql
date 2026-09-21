-- Experimental unforked-Anvil relay only. Reservations never recycle: a lost send
-- response is a retained liability, including after a local chain reset.
CREATE TABLE rest_wallet_recovery_lanes (
  sender text PRIMARY KEY CHECK (sender ~ '^0x[0-9a-f]{40}$'),
  configuration jsonb NOT NULL CHECK (octet_length(configuration::text)<=16384),
  environment jsonb NOT NULL CHECK (octet_length(environment::text)<=1024),
  next_nonce bigint NOT NULL CHECK (next_nonce>=0),
  operations integer NOT NULL DEFAULT 0 CHECK (operations>=0),
  reserved_wei numeric(78,0) NOT NULL DEFAULT 0 CHECK (reserved_wei>=0),
  active_recovery uuid REFERENCES rest_wallet_recoveries(id) ON DELETE RESTRICT,
  anchor jsonb NOT NULL CHECK (octet_length(anchor::text)<=1024),
  fence text CHECK (length(fence)<=128),
  CHECK ((configuration->>'sender'=sender AND configuration->>'version'='unforked-anvil-recovery-v1'
    AND (configuration->>'maximumOperations')::integer BETWEEN 1 AND 1000
    AND operations<=(configuration->>'maximumOperations')::integer
    AND reserved_wei<=(configuration->>'maximumCostWei')::numeric) IS TRUE)
);
CREATE TABLE rest_wallet_recovery_dispatch (
  recovery_id uuid PRIMARY KEY REFERENCES rest_wallet_recoveries(id) ON DELETE RESTRICT,
  sender text NOT NULL REFERENCES rest_wallet_recovery_lanes(sender) ON DELETE RESTRICT,
  review jsonb NOT NULL CHECK (octet_length(review::text)<=16384 AND review->>'recoveryId'=recovery_id::text),
  creation_transaction text NOT NULL CHECK (creation_transaction ~ '^0x[0-9a-f]{64}$'),
  approval jsonb CHECK (octet_length(approval::text)<=16384),
  created_at_ms bigint NOT NULL,
  approved_at_ms bigint,
  CHECK ((approval IS NULL)=(approved_at_ms IS NULL))
);
CREATE TABLE rest_wallet_recovery_transactions (
  recovery_id uuid NOT NULL REFERENCES rest_wallet_recovery_dispatch(recovery_id) ON DELETE RESTRICT,
  step integer NOT NULL CHECK (step IN (0,1)),
  sender text NOT NULL REFERENCES rest_wallet_recovery_lanes(sender) ON DELETE RESTRICT,
  nonce bigint NOT NULL CHECK (nonce>=0),
  hash text NOT NULL UNIQUE CHECK (hash ~ '^0x[0-9a-f]{64}$'),
  raw_transaction text NOT NULL CHECK (raw_transaction ~ '^0x02[0-9a-f]+$' AND length(raw_transaction)<=32768),
  attempted_at_ms bigint,
  receipt jsonb CHECK (octet_length(receipt::text)<=4096),
  PRIMARY KEY(recovery_id,step), UNIQUE(sender,nonce),
  CHECK (receipt IS NULL OR attempted_at_ms IS NOT NULL)
);
CREATE FUNCTION rest_wallet_recovery_dispatch_immutable() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE r rest_wallet_recoveries; d rest_wallet_recovery_dispatch;
BEGIN
  IF TG_OP='INSERT' THEN
    IF TG_TABLE_NAME='rest_wallet_recovery_dispatch' THEN
      SELECT * INTO r FROM rest_wallet_recoveries WHERE id=NEW.recovery_id FOR KEY SHARE;
      IF r.proof IS NULL OR (NEW.review->>'candidateDigest') IS DISTINCT FROM (r.proof->>'candidateDigest')
        OR (NEW.review->>'initializerHash') IS DISTINCT FROM (r.intent->>'initializerHash')
        OR NEW.approval IS NOT NULL THEN RAISE EXCEPTION 'An accepted candidate precedes the immutable review' USING ERRCODE='23514'; END IF;
    ELSIF TG_TABLE_NAME='rest_wallet_recovery_transactions' THEN
      SELECT * INTO d FROM rest_wallet_recovery_dispatch WHERE recovery_id=NEW.recovery_id FOR KEY SHARE;
      IF d.approval IS NULL OR NEW.sender<>d.sender OR NEW.attempted_at_ms IS NOT NULL OR NEW.receipt IS NOT NULL THEN
        RAISE EXCEPTION 'Durable approval and exact bytes precede an attempt' USING ERRCODE='23514'; END IF;
    END IF;
    RETURN NEW;
  END IF;
  IF TG_OP='DELETE' THEN RAISE EXCEPTION 'Recovery dispatch liabilities cannot be deleted' USING ERRCODE='23514'; END IF;
  IF TG_TABLE_NAME='rest_wallet_recovery_lanes' THEN
    IF NEW.sender<>OLD.sender OR NEW.configuration<>OLD.configuration OR NEW.environment<>OLD.environment
      OR NEW.next_nonce<OLD.next_nonce OR NEW.operations<OLD.operations OR NEW.reserved_wei<OLD.reserved_wei
      OR (OLD.fence IS NOT NULL AND NEW.fence IS DISTINCT FROM OLD.fence)
      OR (NEW.anchor->>'blockNumber')::numeric<(OLD.anchor->>'blockNumber')::numeric THEN
      RAISE EXCEPTION 'Recovery lane history is monotonic' USING ERRCODE='23514'; END IF;
  ELSIF TG_TABLE_NAME='rest_wallet_recovery_dispatch' THEN
    IF (to_jsonb(NEW)-'approval'-'approved_at_ms') IS DISTINCT FROM (to_jsonb(OLD)-'approval'-'approved_at_ms')
      OR (OLD.approval IS NOT NULL AND (NEW.approval IS DISTINCT FROM OLD.approval OR NEW.approved_at_ms IS DISTINCT FROM OLD.approved_at_ms)) THEN
      RAISE EXCEPTION 'Recovery review and approval are immutable' USING ERRCODE='23514'; END IF;
  ELSE
    IF (to_jsonb(NEW)-'attempted_at_ms'-'receipt') IS DISTINCT FROM (to_jsonb(OLD)-'attempted_at_ms'-'receipt')
      OR (OLD.attempted_at_ms IS NOT NULL AND NEW.attempted_at_ms IS DISTINCT FROM OLD.attempted_at_ms)
      OR (OLD.receipt IS NOT NULL AND NEW.receipt IS DISTINCT FROM OLD.receipt) THEN
      RAISE EXCEPTION 'Recovery signed bytes and broadcast attempts are immutable' USING ERRCODE='23514'; END IF;
  END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER rest_wallet_recovery_lane_immutable BEFORE UPDATE OR DELETE ON rest_wallet_recovery_lanes FOR EACH ROW EXECUTE FUNCTION rest_wallet_recovery_dispatch_immutable();
CREATE TRIGGER rest_wallet_recovery_dispatch_immutable BEFORE INSERT OR UPDATE OR DELETE ON rest_wallet_recovery_dispatch FOR EACH ROW EXECUTE FUNCTION rest_wallet_recovery_dispatch_immutable();
CREATE TRIGGER rest_wallet_recovery_transaction_immutable BEFORE INSERT OR UPDATE OR DELETE ON rest_wallet_recovery_transactions FOR EACH ROW EXECUTE FUNCTION rest_wallet_recovery_dispatch_immutable();

CREATE FUNCTION rest_wallet_recovery_distinct_sender() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  PERFORM pg_advisory_xact_lock(hashtextextended(current_schema()||'wallet-local-sender:'||NEW.sender,0));
  IF (TG_TABLE_NAME='rest_wallet_recovery_lanes' AND EXISTS(SELECT 1 FROM rest_wallet_deployment_pools WHERE sender=NEW.sender))
    OR (TG_TABLE_NAME='rest_wallet_deployment_pools' AND EXISTS(SELECT 1 FROM rest_wallet_recovery_lanes WHERE sender=NEW.sender)) THEN
    RAISE EXCEPTION 'Recovery and signup have separate sender lanes' USING ERRCODE='23514'; END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER rest_wallet_recovery_distinct_sender BEFORE INSERT ON rest_wallet_recovery_lanes FOR EACH ROW EXECUTE FUNCTION rest_wallet_recovery_distinct_sender();
CREATE TRIGGER rest_wallet_deployment_distinct_sender BEFORE INSERT ON rest_wallet_deployment_pools FOR EACH ROW EXECUTE FUNCTION rest_wallet_recovery_distinct_sender();

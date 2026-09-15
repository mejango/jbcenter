-- Hosted Base recovery lanes beside the local relay: a Base configuration version, actual
-- complete fees retained as a monotonic spend, and an allocation-exceeded fence when the
-- actual spend passes the reviewed budget. Reservations still never recycle.
ALTER TABLE rest_wallet_recovery_lanes ADD COLUMN spent_wei numeric(78,0) NOT NULL DEFAULT 0 CHECK (spent_wei>=0);
DO $$ DECLARE constraint_name text; BEGIN
 SELECT conname INTO STRICT constraint_name FROM pg_constraint WHERE conrelid='rest_wallet_recovery_lanes'::regclass
  AND contype='c' AND pg_get_constraintdef(oid) LIKE '%unforked-anvil-recovery-v1%';
 EXECUTE format('ALTER TABLE rest_wallet_recovery_lanes DROP CONSTRAINT %I',constraint_name);
END $$;
ALTER TABLE rest_wallet_recovery_lanes ADD CONSTRAINT rest_wallet_recovery_lane_configuration_v2 CHECK ((configuration->>'sender'=sender
  AND configuration->>'version' IN ('unforked-anvil-recovery-v1','base-mainnet-recovery-v1')
  AND (configuration->>'maximumOperations')::integer BETWEEN 1 AND 1000
  AND operations<=(configuration->>'maximumOperations')::integer
  AND reserved_wei<=(configuration->>'maximumCostWei')::numeric
  AND (spent_wei<=(configuration->>'maximumCostWei')::numeric OR fence='allocation-exceeded')) IS TRUE);
CREATE FUNCTION rest_wallet_recovery_spend_monotonic() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF NEW.spent_wei<OLD.spent_wei THEN RAISE EXCEPTION 'Recovery lane spend is monotonic' USING ERRCODE='23514'; END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER rest_wallet_recovery_spend_monotonic BEFORE UPDATE ON rest_wallet_recovery_lanes FOR EACH ROW EXECUTE FUNCTION rest_wallet_recovery_spend_monotonic();

-- Adding a device: a second passkey for an existing account, approved by its primary passkey.
-- The lane, dispatch and transaction shapes mirror recovery (031): reservations never recycle.
CREATE TABLE rest_wallet_devices (
  id uuid PRIMARY KEY,
  account_id text NOT NULL REFERENCES rest_accounts(id) ON DELETE RESTRICT,
  enrollment_id uuid NOT NULL REFERENCES rest_wallet_enrollments(id) ON DELETE RESTRICT,
  token_hash text NOT NULL UNIQUE CHECK (token_hash ~ '^[0-9a-f]{64}$'),
  session_id uuid NOT NULL,
  created_at_ms bigint NOT NULL,
  expires_at_ms bigint NOT NULL CHECK (expires_at_ms > created_at_ms AND expires_at_ms <= created_at_ms+300000),
  retain_until_ms bigint NOT NULL CHECK (retain_until_ms=expires_at_ms+86400000),
  passkey_name text CHECK (octet_length(passkey_name) BETWEEN 1 AND 120),
  intent jsonb NOT NULL CHECK ((jsonb_typeof(intent)='object' AND octet_length(intent::text)<=65536
    AND intent->>'id'=id::text AND intent->>'accountId'=account_id AND intent->>'enrollmentId'=enrollment_id::text
    AND (intent->>'issuedAtMs')::bigint=created_at_ms AND (intent->>'expiresAtMs')::bigint=expires_at_ms) IS TRUE),
  candidate jsonb CHECK (jsonb_typeof(candidate)='object' AND octet_length(candidate::text)<=98304),
  proof jsonb CHECK (proof IS NULL OR (jsonb_typeof(proof)='object' AND octet_length(proof::text)<=4096
    AND proof->>'deviceId'=id::text AND proof->>'accountId'=account_id
    AND proof->>'verificationDigest' ~ '^[0-9a-f]{64}$'
    AND (proof->>'verifiedAtMs')::bigint>=created_at_ms AND (proof->>'verifiedAtMs')::bigint<expires_at_ms) IS TRUE),
  activation jsonb CHECK (activation IS NULL OR (proof IS NOT NULL AND jsonb_typeof(activation)='object' AND octet_length(activation::text)<=16384
    AND activation->>'version'='center-wallet-device-v1' AND activation->>'id'=id::text AND activation->>'accountId'=account_id) IS TRUE),
  CHECK (candidate IS NULL OR (candidate->'intent'=intent) IS TRUE),
  CHECK (proof IS NULL OR candidate IS NOT NULL)
);
CREATE INDEX rest_wallet_devices_account ON rest_wallet_devices(account_id,created_at_ms,id);
CREATE INDEX rest_wallet_devices_pending_expiry ON rest_wallet_devices(expires_at_ms,id) WHERE proof IS NULL;

ALTER TABLE rest_wallet_recovery_lanes ADD COLUMN active_device uuid REFERENCES rest_wallet_devices(id) ON DELETE RESTRICT;
ALTER TABLE rest_wallet_recovery_lanes ADD CONSTRAINT rest_wallet_recovery_lane_one_active CHECK (active_recovery IS NULL OR active_device IS NULL);

CREATE TABLE rest_wallet_device_dispatch (
  device_id uuid PRIMARY KEY REFERENCES rest_wallet_devices(id) ON DELETE RESTRICT,
  sender text NOT NULL REFERENCES rest_wallet_recovery_lanes(sender) ON DELETE RESTRICT,
  review jsonb NOT NULL CHECK (octet_length(review::text)<=16384 AND review->>'deviceId'=device_id::text),
  creation_transaction text NOT NULL CHECK (creation_transaction ~ '^0x[0-9a-f]{64}$'),
  approval jsonb CHECK (octet_length(approval::text)<=16384),
  created_at_ms bigint NOT NULL,
  approved_at_ms bigint,
  CHECK ((approval IS NULL)=(approved_at_ms IS NULL))
);
CREATE TABLE rest_wallet_device_transactions (
  device_id uuid NOT NULL REFERENCES rest_wallet_device_dispatch(device_id) ON DELETE RESTRICT,
  step integer NOT NULL CHECK (step IN (0,1)),
  sender text NOT NULL REFERENCES rest_wallet_recovery_lanes(sender) ON DELETE RESTRICT,
  nonce bigint NOT NULL CHECK (nonce>=0),
  hash text NOT NULL UNIQUE CHECK (hash ~ '^0x[0-9a-f]{64}$'),
  raw_transaction text NOT NULL CHECK (raw_transaction ~ '^0x02[0-9a-f]+$' AND length(raw_transaction)<=32768),
  attempted_at_ms bigint,
  receipt jsonb CHECK (octet_length(receipt::text)<=4096),
  PRIMARY KEY(device_id,step), UNIQUE(sender,nonce),
  CHECK (receipt IS NULL OR attempted_at_ms IS NOT NULL)
);
CREATE FUNCTION rest_wallet_device_dispatch_immutable() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE r rest_wallet_devices; d rest_wallet_device_dispatch;
BEGIN
  IF TG_OP='INSERT' THEN
    IF TG_TABLE_NAME='rest_wallet_device_dispatch' THEN
      SELECT * INTO r FROM rest_wallet_devices WHERE id=NEW.device_id FOR KEY SHARE;
      IF r.proof IS NULL OR (NEW.review->>'candidateDigest') IS DISTINCT FROM (r.proof->>'candidateDigest')
        OR (NEW.review->>'initializerHash') IS DISTINCT FROM (r.intent->>'initializerHash')
        OR NEW.approval IS NOT NULL THEN RAISE EXCEPTION 'A proved device precedes the immutable review' USING ERRCODE='23514'; END IF;
    ELSIF TG_TABLE_NAME='rest_wallet_device_transactions' THEN
      SELECT * INTO d FROM rest_wallet_device_dispatch WHERE device_id=NEW.device_id FOR KEY SHARE;
      IF d.approval IS NULL OR NEW.sender<>d.sender OR NEW.attempted_at_ms IS NOT NULL OR NEW.receipt IS NOT NULL THEN
        RAISE EXCEPTION 'Durable approval and exact bytes precede an attempt' USING ERRCODE='23514'; END IF;
    END IF;
    RETURN NEW;
  END IF;
  IF TG_OP='DELETE' THEN RAISE EXCEPTION 'Device dispatch liabilities cannot be deleted' USING ERRCODE='23514'; END IF;
  IF TG_TABLE_NAME='rest_wallet_device_dispatch' THEN
    IF (to_jsonb(NEW)-'approval'-'approved_at_ms') IS DISTINCT FROM (to_jsonb(OLD)-'approval'-'approved_at_ms')
      OR (OLD.approval IS NOT NULL AND (NEW.approval IS DISTINCT FROM OLD.approval OR NEW.approved_at_ms IS DISTINCT FROM OLD.approved_at_ms)) THEN
      RAISE EXCEPTION 'Device review and approval are immutable' USING ERRCODE='23514'; END IF;
  ELSE
    IF (to_jsonb(NEW)-'attempted_at_ms'-'receipt') IS DISTINCT FROM (to_jsonb(OLD)-'attempted_at_ms'-'receipt')
      OR (OLD.attempted_at_ms IS NOT NULL AND NEW.attempted_at_ms IS DISTINCT FROM OLD.attempted_at_ms)
      OR (OLD.receipt IS NOT NULL AND NEW.receipt IS DISTINCT FROM OLD.receipt) THEN
      RAISE EXCEPTION 'Device signed bytes and broadcast attempts are immutable' USING ERRCODE='23514'; END IF;
  END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER rest_wallet_device_dispatch_immutable BEFORE INSERT OR UPDATE OR DELETE ON rest_wallet_device_dispatch FOR EACH ROW EXECUTE FUNCTION rest_wallet_device_dispatch_immutable();
CREATE TRIGGER rest_wallet_device_transaction_immutable BEFORE INSERT OR UPDATE OR DELETE ON rest_wallet_device_transactions FOR EACH ROW EXECUTE FUNCTION rest_wallet_device_dispatch_immutable();

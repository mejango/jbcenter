-- App grants remain outside legacy bot storage, including for old running readers/writers.
CREATE TABLE rest_grant_ids (
  id text PRIMARY KEY CHECK (id ~ '^[a-zA-Z0-9:_-]{1,192}$'),
  kind text NOT NULL CHECK (kind IN ('bot','wallet-app')),
  account_id text NOT NULL REFERENCES rest_accounts(id),
  UNIQUE(id,kind,account_id)
);
INSERT INTO rest_grant_ids(id,kind,account_id) SELECT id,'bot',account_id FROM rest_bot_grants;
ALTER TABLE rest_bot_grants ADD COLUMN grant_kind text NOT NULL DEFAULT 'bot' CHECK (grant_kind='bot');
ALTER TABLE rest_bot_grants ADD CONSTRAINT rest_bot_grants_namespace
  FOREIGN KEY(id,grant_kind,account_id) REFERENCES rest_grant_ids(id,kind,account_id) DEFERRABLE INITIALLY DEFERRED;

CREATE TABLE rest_wallet_authority (
  account_id text PRIMARY KEY REFERENCES rest_accounts(id) CHECK (account_id ~ '^eip155:8453:0x[0-9a-f]{40}$'),
  authority_epoch bigint NOT NULL CHECK (authority_epoch>0),
  session_epoch bigint NOT NULL CHECK (session_epoch>0),
  updated_at bigint NOT NULL CHECK (updated_at BETWEEN 1 AND 9007199168340)
);
-- No automatic initialization: a future canonical wallet observation must establish this row.
CREATE TABLE rest_wallet_app_grants (
  id text PRIMARY KEY CHECK (id ~ '^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$'),
  grant_kind text NOT NULL DEFAULT 'wallet-app' CHECK (grant_kind='wallet-app'),
  incarnation bigint GENERATED ALWAYS AS IDENTITY (NO CYCLE) UNIQUE CHECK (incarnation>0),
  account_id text NOT NULL REFERENCES rest_wallet_authority(account_id),
  signer_address text NOT NULL CHECK (signer_address ~ '^0x[0-9a-f]{40}$'),
  origin text NOT NULL REFERENCES rest_wallet_policy_apps(origin),
  callback_uri text NOT NULL CHECK (octet_length(callback_uri) BETWEEN 1 AND 2048),
  audience text NOT NULL CHECK (octet_length(audience) BETWEEN 1 AND 2048),
  app_generation bigint NOT NULL CHECK (app_generation BETWEEN 1 AND 9007199254740991),
  authority_epoch bigint NOT NULL CHECK (authority_epoch>0),
  session_epoch bigint NOT NULL CHECK (session_epoch>0),
  created_at bigint NOT NULL CHECK (created_at BETWEEN 1 AND 9007199168340),
  expires_at bigint NOT NULL CHECK (expires_at>created_at AND expires_at<=created_at+3600 AND expires_at<=9007199168340),
  revoked_at bigint CHECK (revoked_at>=created_at AND revoked_at<=9007199168340),
  retain_until bigint NOT NULL CHECK (retain_until=expires_at+86400),
  FOREIGN KEY(id,grant_kind,account_id) REFERENCES rest_grant_ids(id,kind,account_id) DEFERRABLE INITIALLY DEFERRED
);
CREATE INDEX rest_wallet_app_grants_account ON rest_wallet_app_grants(account_id,origin,created_at,id);
CREATE INDEX rest_wallet_app_grants_retention ON rest_wallet_app_grants(retain_until,account_id,id);

-- AFTER INSERT preserves old INSERT ... ON CONFLICT DO NOTHING behavior. A namespace collision
-- aborts the inserted row and the entire transaction. Schema identity follows the actual table.
CREATE FUNCTION rest_reserve_grant_id() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  EXECUTE format('INSERT INTO %I.rest_grant_ids(id,kind,account_id) VALUES($1,$2,$3)',TG_TABLE_SCHEMA)
    USING NEW.id,TG_ARGV[0],NEW.account_id;
  RETURN NEW;
END;
$$;
CREATE TRIGGER rest_bot_grants_reserve_id AFTER INSERT ON rest_bot_grants
  FOR EACH ROW EXECUTE FUNCTION rest_reserve_grant_id('bot');
CREATE TRIGGER rest_wallet_app_grants_reserve_id AFTER INSERT ON rest_wallet_app_grants
  FOR EACH ROW EXECUTE FUNCTION rest_reserve_grant_id('wallet-app');

CREATE FUNCTION rest_wallet_app_grant_immutable() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF (to_jsonb(NEW)-'revoked_at') IS DISTINCT FROM (to_jsonb(OLD)-'revoked_at')
    OR (OLD.revoked_at IS NOT NULL AND NEW.revoked_at IS DISTINCT FROM OLD.revoked_at) THEN
    RAISE EXCEPTION 'Wallet app grant authority is immutable' USING ERRCODE='23514';
  END IF;
  RETURN NEW;
END;
$$;
CREATE TRIGGER rest_wallet_app_grants_immutable BEFORE UPDATE ON rest_wallet_app_grants
  FOR EACH ROW EXECUTE FUNCTION rest_wallet_app_grant_immutable();

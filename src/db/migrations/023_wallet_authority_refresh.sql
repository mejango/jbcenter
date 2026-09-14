-- Internal scheduling only. No readiness, credential, grant or authority epoch is created here.
CREATE TABLE rest_wallet_authority_refresh_control (
  id smallint PRIMARY KEY CHECK (id=1),
  window_start_ms bigint NOT NULL CHECK (window_start_ms BETWEEN 0 AND 9007199254740991),
  starts_in_window integer NOT NULL CHECK (starts_in_window BETWEEN 0 AND 30),
  configuration jsonb
);
INSERT INTO rest_wallet_authority_refresh_control(id,window_start_ms,starts_in_window) VALUES(1,0,0);

CREATE TABLE rest_wallet_authority_refresh_jobs (
  account_id text PRIMARY KEY REFERENCES rest_accounts(id) ON DELETE CASCADE
    CHECK (account_id ~ '^eip155:8453:0x[0-9a-f]{40}$'),
  interested_until_ms bigint NOT NULL CHECK (interested_until_ms BETWEEN 1 AND 9007199254740991),
  due_at_ms bigint NOT NULL CHECK (due_at_ms BETWEEN 1 AND 9007199254740991),
  lease_token uuid,
  lease_until_ms bigint CHECK (lease_until_ms BETWEEN 1 AND 9007199254740991),
  failures smallint NOT NULL DEFAULT 0 CHECK (failures BETWEEN 0 AND 16),
  CHECK ((lease_token IS NULL) = (lease_until_ms IS NULL))
);
CREATE INDEX rest_wallet_authority_refresh_due ON rest_wallet_authority_refresh_jobs(due_at_ms,account_id);
CREATE INDEX rest_wallet_authority_refresh_interest ON rest_wallet_authority_refresh_jobs(interested_until_ms,account_id);

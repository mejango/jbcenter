CREATE TABLE rest_accounts (
  id text PRIMARY KEY CHECK (id ~ '^[a-zA-Z0-9:_-]{1,192}$'),
  owner_address text NOT NULL CHECK (owner_address ~ '^0x[0-9a-f]{40}$'),
  authority_chain_id bigint NOT NULL CHECK (authority_chain_id > 0 AND authority_chain_id <= 9007199254740991),
  display_name text NOT NULL CHECK (octet_length(display_name) <= 120),
  bio text NOT NULL CHECK (octet_length(bio) <= 2000),
  avatar_uri text CHECK (octet_length(avatar_uri) <= 2048),
  created_at bigint NOT NULL CHECK (created_at >= 0 AND created_at <= 9007199254740991),
  updated_at bigint NOT NULL CHECK (updated_at >= created_at AND updated_at <= 9007199254740991),
  UNIQUE (authority_chain_id, owner_address)
);

-- Grant generations are immutable. Revoked and expired records count toward the
-- per-account quota so a previously revoked grant identifier cannot be revived.
CREATE TABLE rest_bot_grants (
  id text PRIMARY KEY CHECK (id ~ '^[a-zA-Z0-9:_-]{1,192}$'),
  account_id text NOT NULL REFERENCES rest_accounts(id),
  bot_address text NOT NULL CHECK (bot_address ~ '^0x[0-9a-f]{40}$'),
  scopes text[] NOT NULL CHECK (
    scopes = ARRAY['read']::text[]
    OR scopes = ARRAY['read', 'plan']::text[]
    OR scopes = ARRAY['read', 'plan', 'relay']::text[]
  ),
  label text NOT NULL CHECK (octet_length(label) <= 120),
  created_at bigint NOT NULL CHECK (created_at >= 0 AND created_at <= 9007199254740991),
  expires_at bigint NOT NULL CHECK (expires_at > created_at AND expires_at <= 9007199254740991),
  revoked_at bigint CHECK (revoked_at >= created_at AND revoked_at <= 9007199254740991)
);
CREATE INDEX rest_bot_grants_account_idx ON rest_bot_grants (account_id, created_at, id);

CREATE TABLE rest_request_nonces (
  account_id text NOT NULL REFERENCES rest_accounts(id),
  nonce text NOT NULL CHECK (nonce ~ '^0x[0-9a-f]{64}$'),
  expires_at bigint NOT NULL CHECK (expires_at >= 0 AND expires_at <= 9007199254740991),
  PRIMARY KEY (account_id, nonce)
);
CREATE INDEX rest_request_nonces_expiry_idx ON rest_request_nonces (expires_at, account_id, nonce);

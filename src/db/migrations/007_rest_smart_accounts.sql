-- Smart-account links are owner-threshold proofs, not delegated execution authority.
CREATE TABLE rest_smart_account_bindings (
  account_id text NOT NULL REFERENCES rest_accounts(id),
  id text NOT NULL CHECK (id ~ '^0x[0-9a-f]{64}$'),
  chain_id bigint NOT NULL CHECK (chain_id BETWEEN 1 AND 9007199254740991),
  wallet_address text NOT NULL CHECK (wallet_address ~ '^0x[0-9a-f]{40}$'),
  authorization_digest text NOT NULL CHECK (authorization_digest ~ '^0x[0-9a-f]{64}$'),
  revoked_at bigint CHECK (revoked_at >= 0),
  created_at bigint NOT NULL CHECK (created_at >= 0),
  updated_at bigint NOT NULL CHECK (updated_at >= created_at),
  document jsonb NOT NULL CHECK (
    jsonb_typeof(document) = 'object'
    AND octet_length(document::text) <= 65536
    AND document->>'id' = id
    AND document->>'ownerAccountId' = account_id
    AND (document->'wallet'->>'chainId')::bigint = chain_id
    AND lower(document->'wallet'->>'address') = wallet_address
    AND document->'authorization'->>'digest' = authorization_digest
    AND document->'authorization'->>'method' = 'safe-current-owner-threshold'
  ),
  PRIMARY KEY(account_id,id),
  UNIQUE(account_id,chain_id,wallet_address)
);
CREATE INDEX rest_smart_account_bindings_active_idx ON rest_smart_account_bindings(account_id,id) WHERE revoked_at IS NULL;
CREATE TABLE rest_smart_account_binding_nonces (
  account_id text NOT NULL REFERENCES rest_accounts(id),
  nonce text NOT NULL CHECK (nonce ~ '^0x[0-9a-f]{64}$'),
  digest text NOT NULL CHECK (digest ~ '^0x[0-9a-f]{64}$'),
  expires_at bigint NOT NULL CHECK (expires_at BETWEEN 1 AND 9007199254740991),
  PRIMARY KEY(account_id,nonce)
);
CREATE INDEX rest_smart_account_binding_nonces_expiry_idx ON rest_smart_account_binding_nonces(account_id,expires_at);

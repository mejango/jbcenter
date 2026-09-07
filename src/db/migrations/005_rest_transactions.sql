-- Exact transaction plans are immutable apart from their revisioned step observations.
-- Epoch timestamps here are milliseconds; account/grant timestamps are Unix seconds.
CREATE TABLE rest_transaction_plans (
  id text PRIMARY KEY CHECK (octet_length(id) BETWEEN 1 AND 192),
  account_id text NOT NULL REFERENCES rest_accounts(id),
  principal_id text NOT NULL CHECK (octet_length(principal_id) BETWEEN 1 AND 256),
  account_address text NOT NULL CHECK (account_address ~ '^0x[0-9a-f]{40}$'),
  created_at bigint NOT NULL CHECK (created_at >= 0 AND created_at <= 9007199254740991),
  expires_at bigint NOT NULL CHECK (expires_at > created_at AND expires_at <= 9007199254740991),
  revision bigint NOT NULL CHECK (revision >= 0 AND revision < 9007199254740991),
  document jsonb NOT NULL CHECK (
    jsonb_typeof(document) = 'object'
    AND document ?& ARRAY['id', 'actor', 'draft', 'commitment', 'createdAt', 'expiresAt', 'revision', 'steps']
    AND jsonb_typeof(document->'steps') = 'array'
    AND jsonb_array_length(document->'steps') BETWEEN 1 AND 32
    AND jsonb_typeof(document->'draft'->'calls') = 'array'
    AND jsonb_array_length(document->'draft'->'calls') = jsonb_array_length(document->'steps')
    AND octet_length(document::text) <= 2097152
    AND document->>'id' = id
    AND document->'actor'->>'accountId' = account_id
    AND document->'actor'->>'principalId' = principal_id
    AND lower(document->'draft'->>'account') = account_address
    AND document->>'commitment' ~ '^0x[0-9a-fA-F]{64}$'
    AND (document->>'createdAt')::bigint = created_at
    AND (document->>'expiresAt')::bigint = expires_at
    AND (document->>'revision')::bigint = revision
  ),
  UNIQUE (id, account_id, principal_id)
);
CREATE INDEX rest_transaction_plans_actor_page_idx ON rest_transaction_plans (account_id, principal_id, created_at DESC, id COLLATE "C" DESC);
CREATE INDEX rest_transaction_plans_account_page_idx ON rest_transaction_plans (account_id, principal_id, account_address, created_at DESC, id COLLATE "C" DESC);
CREATE INDEX rest_transaction_plans_recovery_idx ON rest_transaction_plans (created_at, id COLLATE "C")
  WHERE jsonb_path_exists(document, '$.steps[*] ? (exists(@.attempt) && (@.state == "reserved" || @.state == "submitted" || @.state == "unknown" || @.state == "confirming" || @.state == "reorged"))');

CREATE TABLE rest_transaction_idempotency (
  account_id text NOT NULL,
  principal_id text NOT NULL,
  key text NOT NULL CHECK (octet_length(key) BETWEEN 1 AND 128),
  request_hash text NOT NULL CHECK (octet_length(request_hash) BETWEEN 1 AND 192),
  operation text NOT NULL CHECK (octet_length(operation) BETWEEN 1 AND 128),
  plan_id text NOT NULL,
  step_index integer CHECK (step_index BETWEEN 0 AND 31),
  PRIMARY KEY (account_id, principal_id, key),
  FOREIGN KEY (plan_id, account_id, principal_id) REFERENCES rest_transaction_plans(id, account_id, principal_id)
);

-- A nonce reservation is never deleted or transferred, including after failures or grant revocation.
CREATE TABLE rest_transaction_nonces (
  chain_id bigint NOT NULL CHECK (chain_id > 0 AND chain_id <= 9007199254740991),
  sender text NOT NULL CHECK (sender ~ '^0x[0-9a-f]{40}$'),
  nonce numeric(78, 0) NOT NULL CHECK (nonce >= 0 AND nonce < 115792089237316195423570985008687907853269984665640564039457584007913129639936),
  transaction_hash text NOT NULL CHECK (transaction_hash ~ '^0x[0-9a-f]{64}$'),
  plan_id text NOT NULL REFERENCES rest_transaction_plans(id),
  step_index integer NOT NULL CHECK (step_index BETWEEN 0 AND 31),
  PRIMARY KEY (chain_id, sender, nonce),
  UNIQUE (plan_id, step_index)
);

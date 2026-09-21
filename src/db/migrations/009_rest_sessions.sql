-- Session documents preserve complete immutable owner-approved policy generations.
-- Document/created/updated timestamps use milliseconds. Policy windows use Unix seconds.
-- This migration is deliberately independent of user-operation persistence (008).
CREATE TABLE rest_sessions (
  id text PRIMARY KEY CHECK (octet_length(id) BETWEEN 1 AND 192),
  account_id text NOT NULL REFERENCES rest_accounts(id),
  principal_id text NOT NULL CHECK (octet_length(principal_id) BETWEEN 1 AND 256),
  binding_id text NOT NULL CHECK (binding_id ~ '^0x[0-9a-f]{64}$'),
  grant_id text NOT NULL REFERENCES rest_bot_grants(id),
  chain_id bigint NOT NULL CHECK (chain_id BETWEEN 1 AND 9007199254740991),
  wallet_address text NOT NULL CHECK (wallet_address ~ '^0x[0-9a-f]{40}$'),
  session_key text NOT NULL CHECK (session_key ~ '^0x[0-9a-f]{40}$'),
  generation numeric(78,0) NOT NULL CHECK (generation > 0 AND generation < 115792089237316195423570985008687907853269984665640564039457584007913129639936),
  permission_id text NOT NULL CHECK (permission_id ~ '^0x[0-9a-f]{64}$'),
  salt text NOT NULL CHECK (salt ~ '^0x[0-9a-f]{64}$' AND salt <> '0x0000000000000000000000000000000000000000000000000000000000000000'),
  policy_nonce text NOT NULL CHECK (policy_nonce ~ '^0x[0-9a-f]{64}$' AND policy_nonce <> '0x0000000000000000000000000000000000000000000000000000000000000000'),
  policy_hash text NOT NULL CHECK (policy_hash ~ '^0x[0-9a-f]{64}$'),
  compiled_hash text NOT NULL CHECK (compiled_hash ~ '^0x[0-9a-f]{64}$'),
  allocation_manifest_hash text NOT NULL CHECK (allocation_manifest_hash ~ '^0x[0-9a-f]{64}$'),
  valid_after bigint NOT NULL CHECK (valid_after BETWEEN 0 AND 9007199254740991),
  valid_until bigint NOT NULL CHECK (valid_until <= 9007199254740991 AND valid_until - valid_after IN (604800,2592000)),
  created_at bigint NOT NULL CHECK (created_at BETWEEN 0 AND 9007199254740991),
  updated_at bigint NOT NULL CHECK (updated_at BETWEEN created_at AND 9007199254740991),
  revision bigint NOT NULL CHECK (revision BETWEEN 0 AND 9007199254740990),
  state text NOT NULL CHECK (state IN ('prepared','installing','active','revoking','revoked','expired','stale')),
  reservations_released boolean NOT NULL,
  document jsonb NOT NULL CHECK ((
    jsonb_typeof(document) = 'object'
    AND document ?& ARRAY['id','actor','compiled','preparedAdministration','allocationGroups','allocationManifestHash','createdAt','updatedAt','revision','state','reservationsReleased']
    AND jsonb_typeof(document->'preparedAdministration')='object'
    AND document->'preparedAdministration' ?& ARRAY['epoch','hash']
    AND document->'preparedAdministration'->>'epoch' ~ '^(0|[1-9][0-9]{0,77})$'
    AND (document->'preparedAdministration'->>'epoch')::numeric<115792089237316195423570985008687907853269984665640564039457584007913129639936
    AND document->'preparedAdministration'->>'hash' ~ '^0x[0-9a-fA-F]{64}$'
    AND jsonb_typeof(document->'actor') = 'object'
    AND document->'actor' ?& ARRAY['accountId','principalId']
    AND jsonb_typeof(document->'compiled') = 'object'
    AND document->'compiled' ?& ARRAY['ownerAccountId','bindingId','grantId','chainId','wallet','sessionKey','generation','permissionId','salt','nonce','policyHash','compiledHash','validAfter','validUntil']
    AND jsonb_typeof(document->'allocationGroups') = 'array'
    AND jsonb_array_length(document->'allocationGroups') BETWEEN 0 AND 16
    AND octet_length(document::text) <= 1048576
    AND document->>'id' = id
    AND document->'actor'->>'accountId' = account_id
    AND document->'actor'->>'principalId' = principal_id
    AND document->'compiled'->>'ownerAccountId' = account_id
    AND lower(document->'compiled'->>'bindingId') = binding_id
    AND document->'compiled'->>'grantId' = grant_id
    AND (document->'compiled'->>'chainId')::bigint = chain_id
    AND lower(document->'compiled'->>'wallet') = wallet_address
    AND lower(document->'compiled'->>'sessionKey') = session_key
    AND document->'compiled'->>'generation' ~ '^[1-9][0-9]{0,77}$'
    AND (document->'compiled'->>'generation')::numeric = generation
    AND lower(document->'compiled'->>'permissionId') = permission_id
    AND lower(document->'compiled'->>'salt') = salt
    AND lower(document->'compiled'->>'nonce') = policy_nonce
    AND lower(document->'compiled'->>'policyHash') = policy_hash
    AND lower(document->'compiled'->>'compiledHash') = compiled_hash
    AND lower(document->>'allocationManifestHash') = allocation_manifest_hash
    AND (document->'compiled'->>'validAfter')::bigint = valid_after
    AND (document->'compiled'->>'validUntil')::bigint = valid_until
    AND (document->>'createdAt')::bigint = created_at
    AND (document->>'updatedAt')::bigint = updated_at
    AND (document->>'revision')::bigint = revision
    AND document->>'state' = state
    AND (document->>'reservationsReleased')::boolean = reservations_released
  ) IS TRUE),
  FOREIGN KEY (account_id,binding_id) REFERENCES rest_smart_account_bindings(account_id,id),
  UNIQUE (id,account_id),
  UNIQUE (chain_id,wallet_address,permission_id),
  UNIQUE (chain_id,wallet_address,salt),
  UNIQUE (chain_id,wallet_address,policy_nonce),
  UNIQUE (chain_id,wallet_address,session_key,generation)
);
CREATE INDEX rest_sessions_actor_page_idx ON rest_sessions(account_id,grant_id,created_at DESC,id COLLATE "C" DESC);
CREATE INDEX rest_sessions_wallet_idx ON rest_sessions(chain_id,wallet_address);

-- One key namespace spans creation, activation and revocation. Never recycle it.
CREATE TABLE rest_session_idempotency (
  account_id text NOT NULL REFERENCES rest_accounts(id),
  principal_id text NOT NULL CHECK (octet_length(principal_id) BETWEEN 1 AND 256),
  key text NOT NULL CHECK (octet_length(key) BETWEEN 1 AND 128),
  request_hash text NOT NULL CHECK (octet_length(request_hash) BETWEEN 1 AND 192),
  operation text NOT NULL CHECK (operation IN ('create','activate','revoke')),
  session_id text NOT NULL,
  PRIMARY KEY (account_id,principal_id,key),
  FOREIGN KEY (session_id,account_id) REFERENCES rest_sessions(id,account_id)
);

-- Admission reservations are not balances. Prepared reviews do not reserve authority.
-- At most one admitted generation per physical wallet remains reserved, even
-- across disjoint time windows, different keys/assets, and policies without assets.
-- Wallet advisory locks make admission atomic across API-account aliases.
-- Only finalized canonical retirement may release these rows; retain all history.
CREATE TABLE rest_session_reservations (
  session_id text NOT NULL REFERENCES rest_sessions(id),
  chain_id bigint NOT NULL CHECK (chain_id BETWEEN 1 AND 9007199254740991),
  wallet_address text NOT NULL CHECK (wallet_address ~ '^0x[0-9a-f]{40}$'),
  kind text NOT NULL CHECK (kind IN ('key','asset')),
  coordinate text NOT NULL CHECK (coordinate ~ '^0x[0-9a-f]{40}$'),
  valid_after bigint NOT NULL CHECK (valid_after BETWEEN 0 AND 9007199254740991),
  valid_until bigint NOT NULL CHECK (valid_until <= 9007199254740991 AND valid_until > valid_after),
  released_at bigint CHECK (released_at BETWEEN 0 AND 9007199254740991),
  PRIMARY KEY(session_id,kind,coordinate)
);
CREATE INDEX rest_session_reservations_wallet_idx ON rest_session_reservations(chain_id,wallet_address) WHERE released_at IS NULL;

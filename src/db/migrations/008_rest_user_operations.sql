-- A plan step selects one permanent execution transport, including EntryPoint v0.7.
ALTER TABLE rest_transaction_transports DROP CONSTRAINT rest_transaction_transports_transport_check;
ALTER TABLE rest_transaction_transports ADD CONSTRAINT rest_transaction_transports_transport_check
  CHECK (transport IN ('direct','relayr','erc4337'));

CREATE TABLE rest_user_operations (
  id text PRIMARY KEY CHECK (octet_length(id) BETWEEN 1 AND 192),
  account_id text NOT NULL REFERENCES rest_accounts(id),
  principal_id text NOT NULL CHECK (octet_length(principal_id) BETWEEN 1 AND 256),
  plan_id text NOT NULL REFERENCES rest_transaction_plans(id),
  preparation_key text NOT NULL CHECK (octet_length(preparation_key) BETWEEN 1 AND 128),
  submission_key text CHECK (octet_length(submission_key) BETWEEN 1 AND 128),
  created_at bigint NOT NULL CHECK (created_at BETWEEN 0 AND 9007199254740991),
  revision bigint NOT NULL CHECK (revision BETWEEN 0 AND 9007199254740991),
  document jsonb NOT NULL CHECK (
    jsonb_typeof(document)='object' AND octet_length(document::text)<=2097152
    AND document->>'id'=id AND document->'actor'->>'accountId'=account_id
    AND document->'actor'->>'principalId'=principal_id AND document->>'planId'=plan_id
    AND document->>'preparationKey'=preparation_key AND (document->>'revision')::bigint=revision
    AND document->>'state' IN ('prepared','submitting','submission_unknown','pending','unknown','confirming','confirmed','reverted')
  ),
  UNIQUE(account_id,principal_id,preparation_key),
  UNIQUE(account_id,principal_id,submission_key)
);
CREATE INDEX rest_user_operations_account_idx ON rest_user_operations(account_id);
CREATE INDEX rest_user_operations_recovery_idx ON rest_user_operations(created_at,id COLLATE "C")
  WHERE document->>'state' IN ('submitting','submission_unknown','pending','unknown','confirming');

-- Full uint256 includes nonce-key and sequence. Identity is global across API accounts,
-- entrypoint aliases, grants and plans; an unknown publication never frees it.
CREATE TABLE rest_user_operation_nonces (
  chain_id bigint NOT NULL CHECK (chain_id BETWEEN 1 AND 9007199254740991),
  sender text NOT NULL CHECK (sender ~ '^0x[0-9a-f]{40}$'),
  nonce text NOT NULL CHECK (nonce ~ '^(0|[1-9][0-9]{0,77})$'
    AND nonce::numeric < 115792089237316195423570985008687907853269984665640564039457584007913129639936),
  entry_point text NOT NULL CHECK (entry_point ~ '^0x[0-9a-f]{40}$'),
  operation_hash text NOT NULL CHECK (operation_hash ~ '^0x[0-9a-f]{64}$'),
  signed_commitment text NOT NULL CHECK (signed_commitment ~ '^0x[0-9a-f]{64}$'),
  user_operation_id text NOT NULL REFERENCES rest_user_operations(id),
  PRIMARY KEY(chain_id,sender,nonce)
);
CREATE INDEX rest_user_operation_nonces_record_idx ON rest_user_operation_nonces(user_operation_id);

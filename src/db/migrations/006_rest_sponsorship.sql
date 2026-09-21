-- One original plan step can select only one execution transport. Reservations
-- survive ambiguous publication, expired signatures and account-grant revocation.
CREATE TABLE rest_transaction_transports (
  plan_id text NOT NULL REFERENCES rest_transaction_plans(id),
  step_index integer NOT NULL CHECK (step_index BETWEEN 0 AND 31),
  transport text NOT NULL CHECK (transport IN ('direct', 'relayr')),
  binding_id text NOT NULL CHECK (octet_length(binding_id) BETWEEN 1 AND 192),
  PRIMARY KEY (plan_id, step_index)
);
INSERT INTO rest_transaction_transports(plan_id,step_index,transport,binding_id)
SELECT plan_id,step_index,'direct',transaction_hash FROM rest_transaction_nonces;
CREATE INDEX rest_transaction_transports_relayr_idx ON rest_transaction_transports(plan_id) WHERE transport='relayr';
DROP INDEX rest_transaction_plans_recovery_idx;
CREATE INDEX rest_transaction_plans_recovery_idx ON rest_transaction_plans(created_at,id COLLATE "C")
  WHERE jsonb_path_exists(document, '$.steps[*] ? ((exists(@.attempt) || exists(@.externalExecution)) && (@.state == "reserved" || @.state == "submitted" || @.state == "unknown" || @.state == "confirming" || @.state == "reorged"))');

CREATE TABLE rest_sponsorships (
  id text PRIMARY KEY CHECK (octet_length(id) BETWEEN 1 AND 192),
  account_id text NOT NULL REFERENCES rest_accounts(id),
  principal_id text NOT NULL CHECK (octet_length(principal_id) BETWEEN 1 AND 256),
  plan_id text NOT NULL REFERENCES rest_transaction_plans(id),
  preparation_key text NOT NULL CHECK (octet_length(preparation_key) BETWEEN 1 AND 128),
  submission_key text CHECK (octet_length(submission_key) BETWEEN 1 AND 128),
  created_at bigint NOT NULL CHECK (created_at >= 0 AND created_at <= 9007199254740991),
  revision bigint NOT NULL CHECK (revision >= 0 AND revision < 9007199254740991),
  document jsonb NOT NULL CHECK (
    jsonb_typeof(document) = 'object'
    AND jsonb_typeof(document->'requests') = 'array'
    AND jsonb_array_length(document->'requests') BETWEEN 1 AND 4
    AND octet_length(document::text) <= 1048576
    AND document->>'id' = id
    AND document->'actor'->>'accountId' = account_id
    AND document->'actor'->>'principalId' = principal_id
    AND document->>'planId' = plan_id
    AND document->>'preparationKey' = preparation_key
    AND (document->>'revision')::bigint = revision
    AND document->>'state' IN ('prepared', 'submitting', 'submission_unknown', 'quoted')
  ),
  UNIQUE(account_id, principal_id, preparation_key),
  UNIQUE(account_id, principal_id, submission_key)
);
CREATE INDEX rest_sponsorships_account_idx ON rest_sponsorships(account_id);
CREATE INDEX rest_sponsorships_recovery_idx ON rest_sponsorships(created_at, id COLLATE "C")
  WHERE document->>'state' IN ('submitting', 'submission_unknown', 'quoted');

-- Forwarder nonce identity is global even when the same wallet uses different
-- API accounts/principals or plans. An uncertain publication remains reserved:
-- only an observed onchain nonce progression permits a different key.
CREATE TABLE rest_sponsorship_nonces (
  chain_id bigint NOT NULL CHECK (chain_id > 0 AND chain_id <= 9007199254740991),
  forwarder text NOT NULL CHECK (forwarder ~ '^0x[0-9a-f]{40}$'),
  sender text NOT NULL CHECK (sender ~ '^0x[0-9a-f]{40}$'),
  nonce text NOT NULL CHECK (
    nonce ~ '^(0|[1-9][0-9]{0,77})$'
    AND nonce::numeric < 115792089237316195423570985008687907853269984665640564039457584007913129639936
  ),
  sponsorship_id text NOT NULL REFERENCES rest_sponsorships(id),
  PRIMARY KEY (chain_id, forwarder, sender, nonce)
);
CREATE INDEX rest_sponsorship_nonces_binding_idx ON rest_sponsorship_nonces(sponsorship_id);

-- Compound owner setup consent persists in the existing bounded binding and nonce records.
ALTER TABLE rest_smart_account_bindings DROP CONSTRAINT rest_smart_account_bindings_check1;
ALTER TABLE rest_smart_account_bindings ADD CONSTRAINT rest_smart_account_bindings_document_check CHECK (
  jsonb_typeof(document) = 'object'
  AND octet_length(document::text) <= 65536
  AND document->>'id' = id
  AND document->>'ownerAccountId' = account_id
  AND (document->'wallet'->>'chainId')::bigint = chain_id
  AND lower(document->'wallet'->>'address') = wallet_address
  AND document->'authorization'->>'digest' = authorization_digest
  AND (
    document->'authorization'->>'method' = 'safe-current-owner-threshold'
    OR (
      document->'authorization'->>'method' = 'safe-current-owner-threshold-and-api-grant'
      AND (jsonb_typeof(document->'authorization'->'setup') = 'object') IS TRUE
    )
  )
);

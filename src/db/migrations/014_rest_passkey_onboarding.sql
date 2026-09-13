-- Existing owner bindings keep their wire meaning. The opt-in passkey profile uses the Base Safe as principal.
ALTER TABLE rest_smart_account_bindings DROP CONSTRAINT rest_smart_account_bindings_document_check;
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
    OR (
      document->'authorization'->>'method' = 'safe-passkey-owner-threshold-and-api-grant'
      AND (
        jsonb_typeof(document->'authorization'->'setup') = 'object'
        AND chain_id = 8453
        AND account_id = 'eip155:8453:' || wallet_address
        AND lower(document->>'ownerAddress') = wallet_address
        AND (document->'state'->>'chainId')::bigint = 8453
        AND lower(document->'state'->>'address') = wallet_address
        AND document->'state'->'ownerProfile'->>'version' = 'center-passkey-v1'
        AND document->'state'->'ownerProfile'->'signer'->>'kind' = 'contract'
        AND document->'state'->'ownerProfile'->'recoveryOwner'->>'kind' = 'ecdsa'
        AND lower(document->'state'->'ownerProfile'->'signer'->>'address') <> wallet_address
        AND lower(document->'state'->'ownerProfile'->'recoveryOwner'->>'address') <> wallet_address
        AND (document->'state'->>'threshold')::bigint = 1
      ) IS TRUE
    )
  )
);

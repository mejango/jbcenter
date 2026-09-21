-- Trusted inspector checkpoints, revalidated against canonical chain headers on every use.
-- Keep latest evidence in each 128-block bucket. Application retention is bounded per key.
CREATE TABLE rest_smart_account_checkpoints (
  key text NOT NULL CHECK (key ~ '^[1-9][0-9]{0,15}:0x[0-9a-f]{40}:0x[0-9a-f]{64}:0x[0-9a-f]{64}$'),
  bucket numeric(78,0) NOT NULL CHECK (bucket>=0),
  last_block numeric(78,0) NOT NULL CHECK (last_block>=0 AND last_block<115792089237316195423570985008687907853269984665640564039457584007913129639936),
  document jsonb NOT NULL CHECK ((
    jsonb_typeof(document)='object' AND octet_length(document::text)<=16384
    AND document ?& ARRAY['schemaVersion','key','creationBlock','creationHash','creationTransaction','initializerHash','lastBlock','lastHash','authorityHash','lifecycleChanges','sessionAdministration']
    AND document->>'schemaVersion'='2' AND document->>'key'=key
    AND jsonb_typeof(document->'sessionAdministration')='object'
    AND document->'sessionAdministration' ?& ARRAY['epoch','hash']
    AND document->'sessionAdministration'->>'epoch' ~ '^(0|[1-9][0-9]{0,77})$'
    AND (document->'sessionAdministration'->>'epoch')::numeric<115792089237316195423570985008687907853269984665640564039457584007913129639936
    AND document->'sessionAdministration'->>'hash' ~ '^0x[0-9a-fA-F]{64}$'
    AND document->>'lastBlock' ~ '^(0|[1-9][0-9]{0,77})$'
    AND (document->>'lastBlock')::numeric=last_block
    AND bucket=floor(last_block/128)
    AND document->>'creationBlock' ~ '^(0|[1-9][0-9]{0,77})$'
    AND (document->>'creationBlock')::numeric<=last_block
    AND document->>'creationHash' ~ '^0x[0-9a-fA-F]{64}$'
    AND document->>'creationTransaction' ~ '^0x[0-9a-fA-F]{64}$'
    AND document->>'initializerHash' ~ '^0x[0-9a-fA-F]{64}$'
    AND document->>'lastHash' ~ '^0x[0-9a-fA-F]{64}$'
    AND document->>'authorityHash' ~ '^0x[0-9a-fA-F]{64}$'
    AND document->>'lifecycleChanges' ~ '^(0|[1-9][0-9]*)$'
    AND (document->>'lifecycleChanges')::numeric<=9007199254740991
  ) IS TRUE),
  updated_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  PRIMARY KEY(key,bucket)
);
CREATE INDEX rest_smart_account_checkpoints_latest_idx ON rest_smart_account_checkpoints(key,last_block DESC);

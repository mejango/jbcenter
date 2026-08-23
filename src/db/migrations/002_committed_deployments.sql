ALTER TABLE intents
  ADD COLUMN envelope_version smallint NOT NULL DEFAULT 1
    CHECK (envelope_version IN (1, 2)),
  ADD COLUMN deployment_calls jsonb NOT NULL DEFAULT '[]'::jsonb
    CHECK (jsonb_typeof(deployment_calls) = 'array');

ALTER TABLE intents DROP CONSTRAINT intents_jb_bytes_check;
ALTER TABLE intents
  ADD CONSTRAINT intents_jb_bytes_check
  CHECK (jb_bytes > 0 AND jb_bytes <= 16800000);

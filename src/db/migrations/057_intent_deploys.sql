CREATE TABLE intent_deploys (
  intent_id uuid NOT NULL REFERENCES intents(id) ON DELETE CASCADE,
  chain_id bigint NOT NULL,
  requester text NOT NULL,
  status text NOT NULL DEFAULT 'queued' CHECK (status IN ('queued', 'sent', 'confirmed', 'failed')),
  bundle_uuid text,
  transaction_hash text,
  error text,
  attempts integer NOT NULL DEFAULT 0,
  reserved_wei numeric(78, 0) NOT NULL DEFAULT 0,
  spent_wei numeric(78, 0) NOT NULL DEFAULT 0,
  lease_until timestamptz,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (intent_id, chain_id)
);
CREATE INDEX intent_deploys_open_idx ON intent_deploys (created_at) WHERE status IN ('queued', 'sent');
CREATE INDEX intent_deploys_created_at_idx ON intent_deploys (created_at DESC);

CREATE TABLE intents (
  id uuid PRIMARY KEY,
  content_hash text NOT NULL,
  format text NOT NULL,
  deployment_version text NOT NULL,
  chain_ids bigint[] NOT NULL,
  jb jsonb NOT NULL,
  publisher text NOT NULL,
  signature text NOT NULL,
  name text NOT NULL,
  description text,
  tagline text,
  tags text[] NOT NULL DEFAULT '{}',
  logo_uri text,
  owner text,
  submitted_by text NOT NULL,
  jb_bytes integer NOT NULL CHECK (jb_bytes > 0 AND jb_bytes <= 2100000),
  created_at timestamptz NOT NULL DEFAULT now(),
  search_vector tsvector NOT NULL,
  UNIQUE (publisher, content_hash)
);

CREATE INDEX intents_search_idx ON intents USING gin (search_vector);
CREATE INDEX intents_created_at_idx ON intents (created_at DESC);
CREATE INDEX intents_submitted_by_idx ON intents (submitted_by);

CREATE TABLE rate_limits (
  client_name text NOT NULL,
  window_start timestamptz NOT NULL,
  request_count integer NOT NULL CHECK (request_count > 0),
  PRIMARY KEY (client_name, window_start)
);

CREATE INDEX rate_limits_window_idx ON rate_limits (window_start);

CREATE TABLE deployments (
  intent_id uuid NOT NULL REFERENCES intents(id) ON DELETE CASCADE,
  chain_id bigint NOT NULL,
  project_id numeric(78, 0) NOT NULL,
  transaction_hash text NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (intent_id, chain_id),
  UNIQUE (chain_id, project_id),
  UNIQUE (transaction_hash)
);

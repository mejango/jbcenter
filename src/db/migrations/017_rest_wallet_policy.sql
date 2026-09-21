-- Explicit operator activation only. These tables convey eligibility, never session or spending authority.
CREATE TABLE rest_wallet_policy (
  id smallint PRIMARY KEY CHECK (id = 1),
  revision bigint NOT NULL CHECK (revision BETWEEN 1 AND 9007199254740991),
  configuration_hash text NOT NULL CHECK (configuration_hash ~ '^[0-9a-f]{64}$'),
  -- Compact, validated JSON bytes preserve the same 32 KiB bound used by the canonical hash.
  configuration text NOT NULL CHECK (octet_length(configuration) <= 32768 AND jsonb_typeof(configuration::jsonb) = 'object'),
  activated_at bigint NOT NULL CHECK (activated_at BETWEEN 1 AND 9007199254740991)
);
CREATE TABLE rest_wallet_policy_apps (
  origin text PRIMARY KEY CHECK (octet_length(origin) BETWEEN 1 AND 512),
  policy_id smallint NOT NULL DEFAULT 1 REFERENCES rest_wallet_policy(id) CHECK (policy_id = 1),
  wallet_callbacks text[] NOT NULL CHECK (cardinality(wallet_callbacks) <= 4 AND array_position(wallet_callbacks, NULL) IS NULL),
  generation bigint NOT NULL CHECK (generation BETWEEN 1 AND 9007199254740991),
  enabled boolean NOT NULL,
  CHECK (enabled OR cardinality(wallet_callbacks) = 0)
);
-- Removed origins remain disabled tombstones. Re-adding one must never revive its former generation.

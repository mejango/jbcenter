-- The account on more chains: one Relayr bundle per family, funded by Center's payer for the
-- chains it covers, and one row per chain recording what the chain shows.
CREATE TABLE rest_wallet_network_bundles (
  id uuid PRIMARY KEY,
  account_id text NOT NULL,
  family text NOT NULL CHECK (family IN ('mainnet','testnet')),
  state text NOT NULL CHECK (state IN ('quoted','paying','paid','settled','failed')),
  bundle_uuid text NOT NULL UNIQUE,
  document jsonb NOT NULL CHECK (jsonb_typeof(document) = 'object' AND octet_length(document::text) <= 65536),
  created_at_ms bigint NOT NULL CHECK (created_at_ms > 0),
  updated_at_ms bigint NOT NULL CHECK (updated_at_ms >= created_at_ms)
);
CREATE INDEX rest_wallet_network_bundles_account ON rest_wallet_network_bundles(account_id, created_at_ms);
CREATE TABLE rest_wallet_networks (
  account_id text NOT NULL,
  chain_id bigint NOT NULL CHECK (chain_id > 0),
  state text NOT NULL CHECK (state IN ('quoted','pending','deployed','failed')),
  bundle_id uuid REFERENCES rest_wallet_network_bundles(id),
  tx_hash text CHECK (tx_hash IS NULL OR tx_hash ~ '^0x[0-9a-f]{64}$'),
  updated_at_ms bigint NOT NULL CHECK (updated_at_ms > 0),
  PRIMARY KEY (account_id, chain_id)
);

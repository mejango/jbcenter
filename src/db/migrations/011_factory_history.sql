CREATE TABLE IF NOT EXISTS rest_factory_history (
  chain_id bigint NOT NULL,
  factory text NOT NULL,
  through_block bigint NOT NULL,
  block_hash text NOT NULL,
  PRIMARY KEY(chain_id,factory)
);
CREATE TABLE IF NOT EXISTS rest_factory_creations (
  chain_id bigint NOT NULL,
  factory text NOT NULL,
  proxy text NOT NULL,
  block_number bigint NOT NULL,
  log_index bigint NOT NULL,
  PRIMARY KEY(chain_id,factory,block_number,log_index)
);
CREATE INDEX IF NOT EXISTS rest_factory_creations_proxy ON rest_factory_creations(chain_id,factory,proxy,block_number);
